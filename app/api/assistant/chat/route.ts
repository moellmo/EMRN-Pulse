import { NextRequest, NextResponse } from "next/server";
import { createCart, normalizeCommonSearchTypos, removeMcpCartItem, searchBySKU, searchProducts, updateMcpCartItem } from "@/lib/assistant/catalog";
import { createB2BQuoteCheckout, lookupB2BInvoice, lookupB2BQuote } from "@/lib/assistant/b2b";
import { logAnalyticsEvent, logQuoteRequest, logSupportRequest } from "@/lib/assistant/analytics";
import { sendOrderStatusEmail, sendQuoteLinkEmail, sendQuoteRequestEmail, sendSupportEmail } from "@/lib/assistant/email";
import { allowsMultipleCartItems, buildOrderStatusDraft, buildQuoteDraft, buildSupportDraft, extractOrdinalSelection, extractQuantity, extractSkuCandidates, hasExplicitQuantity, inferSearchQuery, isAccountIntent, isAvailabilityIntent, isCartIntent, isContactIntent, isFindProductPrompt, isMedicalAdviceRequest, isNegativeSearchFeedback, isOrderStatusIntent, isProductCapabilityIntent, isProductDetailIntent, isProductSearchIntent, isQuickActionPrompt, isQuoteIntent, isSupportYes, priorAssistantRequestedQuoteDetails, quantityForProductSelection, selectProductsForCart } from "@/lib/assistant/intent";
import { detectCustomerLanguage } from "@/lib/assistant/language";
import { getOrderDetails, getOrderStatus, getRecentOrdersByEmail } from "@/lib/assistant/orders";
import { lookupExternalKnowledge, planCatalogSearch, streamAssistantResponse } from "@/lib/assistant/openai";
import { buildKnowledgeEvidence, knowledgeShadowEnabled, shouldCheckKnowledgeEvidence } from "@/lib/assistant/knowledge";
import { matchingApprovedKnowledgeForQuery, saveKnowledgeMemoryItem, taughtIntentRouteForQuery } from "@/lib/assistant/knowledge-memory";
import { assistantFeatureEnabledAsync } from "@/lib/assistant/admin-config";
import { answerCacheEligibility, getCachedAnswer, saveCachedAnswer, type AnswerCacheEligibility, type CacheSaveResult } from "@/lib/assistant/answer-cache";
import { normalizeSearchText } from "@/lib/search-language";
import { buildSmartSearchQuery } from "@/lib/smart-search-translator";
import type { AssistantLanguage, AssistantMessage, CatalogProduct, ProductPageContext, QuoteRequest, SupportRequest } from "@/lib/assistant/types";
import type { CatalogSearchPlan, ExternalKnowledgeLookup } from "@/lib/assistant/openai";

export const runtime = "nodejs";

type TrackedCartItem = {
  itemId?: string;
  sku: string;
  productId: number;
  variantId?: number;
  quantity: number;
  name: string;
};

type TrackedCart = {
  items: TrackedCartItem[];
  checkoutUrl?: string;
};

const trackedCarts = new Map<string, TrackedCart>();

function textStream(text: string) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function answerPreviewText(text: string) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

function cacheSaveStatus(result: CacheSaveResult) {
  if (!result.cached) return "skipped";
  return result.durableSaved ? "saved durable" : "saved memory only";
}

function cacheStatusWithoutSave(answerCacheEnabled: boolean, cacheEligibility: AnswerCacheEligibility, hasAnswerPreview: boolean) {
  if (!answerCacheEnabled) return "off";
  if (!cacheEligibility.eligible) return "not eligible";
  if (!hasAnswerPreview) return "no answer preview";
  return "not attempted";
}

function stableMemoryId(prefix: string, value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return `${prefix}-${Math.abs(hash).toString(36)}`;
}

async function saveSuccessfulAiSearchRewrite(input: {
  latest: string;
  searchQuery: string;
  products: CatalogProduct[];
  openAiMs?: number;
}) {
  const normalizedLatest = normalizeSearchText(input.latest);
  const normalizedSearch = normalizeSearchText(input.searchQuery);
  if (!input.products.length) return;
  if (!input.openAiMs || input.openAiMs <= 0) return;
  if (!normalizedLatest || !normalizedSearch || normalizedLatest === normalizedSearch) return;
  if (extractSkuCandidates(input.latest).length) return;
  if (isQuoteIntent(input.latest) || isOrderStatusIntent(input.latest) || isContactIntent(input.latest) || isCartIntent(input.latest) || isNegativeSearchFeedback(input.latest)) return;

  try {
    await saveKnowledgeMemoryItem({
      id: stableMemoryId("auto-search", `${normalizedLatest}->${normalizedSearch}`),
      type: "alias",
      status: "approved",
      query: input.latest,
      correctSearchTerms: input.searchQuery,
      correctSku: input.products.length === 1 ? input.products[0].sku : "",
      note: `Auto-saved OpenAI search rewrite after EMRN returned ${input.products.length} product${input.products.length === 1 ? "" : "s"}.`,
    });
  } catch (error) {
    console.warn("[EMRN Pulse] auto search rewrite memory save skipped", error);
  }
}

async function streamToText(stream: ReadableStream<Uint8Array>) {
  return new Response(stream).text();
}

function quoteMissingText(missing: string[], language: "en" | "fr" | "unknown") {
  const fields =
    language === "fr"
      ? missing
          .map((field) =>
            ({
              name: "nom",
              email: "courriel",
              products: "produits ou description de ce que vous cherchez",
              quantities: "quantites",
            })[field] || field
          )
          .join(", ")
      : missing.join(", ");

  return language === "fr"
    ? `Bien sûr. Je peux envoyer votre demande de devis ou de recherche d’article à notre équipe ici dans le chat. Pour les achats en volume, hôpitaux, écoles, entreprises ou recherche, indiquez l’organisation et les quantités; les rabais doivent être révisés et ne sont pas garantis. Vous pouvez aussi demander un devis directement depuis une page produit en cliquant « Add to Quote », puis « My Quote » en haut du site. Pour l’envoyer ici, il me manque: ${fields}.`
    : `Of course. I can send your quote or item-sourcing request to our team here in chat. For hospital, school, business, research, or other volume purchasing, include the organization and quantities; discounts must be reviewed and are not guaranteed. You can also request a quote directly from a product page by clicking “Add to Quote”, then “My Quote” at the top of the site. To send it here, I still need: ${fields}.`;
}

function orderStatusMissingText(missing: string[], language: "en" | "fr" | "unknown") {
  const fields =
    language === "fr"
      ? missing.map((field) => ({ email: "courriel", "order number": "numero de commande" })[field] || field).join(", ")
      : missing.join(", ");

  const onlyEmailMissing = missing.length === 1 && missing[0] === "email";
  if (onlyEmailMissing) {
    return language === "fr"
      ? "Je peux vérifier le statut de la commande dans BigCommerce. Pour protéger les détails de la commande, envoyez le courriel utilisé pour cette commande."
      : "I can check the order status in BigCommerce first. To protect the order details, please send the email used for that order.";
  }

  return language === "fr"
    ? `Je peux vérifier le statut de la commande dans BigCommerce d’abord. Il me manque: ${fields}.`
    : `I can check the order status in BigCommerce first. I still need: ${fields}.`;
}

function isShippingTimingQuestion(text: string) {
  return /\b(ship|shipped|shipping|shipment|exp[eé]di[eé]|exp[eé]dition)\b/i.test(text) &&
    /\b(when|check|status|update|where|will|would|has|not|quand|v[eé]rifier|statut|mise à jour|mise a jour)\b/i.test(text);
}

function hasOrderReferenceInConversation(messages: AssistantMessage[]) {
  return messages.some((message) =>
    /\b(?:order|commande)\s*(?:number|#|no\.?|num[eé]ro)?\s*[:#-]?\s*[A-Z0-9-]{4,30}\b/i.test(message.content) ||
    /\border\s*#\s*[A-Z0-9-]{4,30}\b/i.test(message.content) ||
    /\b(order|commande|tracking|shipment|exp[eé]dition|suivi)\b/i.test(message.content)
  );
}

function shippingTimingClarifierText(language: "en" | "fr" | "unknown") {
  return language === "fr"
    ? "Bien sûr. Est-ce pour une commande déjà passée ou pour savoir quand un produit sera expédié?\n\nPour une commande: envoyez le numéro de commande et le courriel utilisé.\nPour un produit: envoyez le SKU ou le nom du produit, et je vérifierai la disponibilité/le délai."
    : "Sure. Is this for an order you already placed, or are you checking when a product can ship?\n\nFor an order: send the order number and the email used for the order.\nFor a product: send the SKU or product name, and I’ll check the availability/lead time.";
}

function isExistingOrderShippingReply(text: string) {
  return /\b(i ordered|already ordered|placed an order|my order|has not been shipped|hasn.t shipped|not shipped yet|not been shipped|je l.ai command[eé]|commande d[eé]j[aà]|ma commande|pas encore exp[eé]di[eé]|n.a pas [eé]t[eé] exp[eé]di[eé])\b/i.test(text);
}

function recentSkuFromConversation(messages: AssistantMessage[]) {
  return messages
    .slice()
    .reverse()
    .flatMap((message) => extractSkuCandidates(message.content))
    .find(Boolean) || "";
}

function invoiceMissingText(hasOrderOrInvoice: boolean, hasEmail: boolean, language: "en" | "fr" | "unknown") {
  if (hasOrderOrInvoice && !hasEmail) {
    return language === "fr"
      ? "J’ai le numéro. Il me manque seulement le courriel utilisé pour la commande."
      : "I have the number. I just need the email used for the order.";
  }
  if (!hasOrderOrInvoice && hasEmail) {
    return language === "fr"
      ? "J’ai le courriel. Il me manque seulement le numéro de commande ou de facture."
      : "I have the email. I just need the order or invoice number.";
  }
  return language === "fr"
    ? "Bien sûr. Pour la recherche de facture, envoyez-moi le numéro de commande et le courriel utilisé pour la commande."
    : "Sure. For invoice lookup, please send the order number and the email used for the order.";
}

function quoteLookupMissingText(hasQuoteNumber: boolean, hasEmail: boolean, language: "en" | "fr" | "unknown") {
  if (hasQuoteNumber && !hasEmail) {
    return language === "fr"
      ? "J’ai le numéro du devis. Je peux le rechercher maintenant; si vous voulez vérifier l’identité, envoyez aussi le courriel utilisé pour le devis."
      : "I have the quote number. I can look it up now; if you want identity verification, also send the email used for the quote.";
  }
  if (!hasQuoteNumber && hasEmail) {
    return language === "fr"
      ? "J’ai le courriel. Il me manque seulement le numéro du devis."
      : "I have the email. I just need the quote number.";
  }
  return language === "fr"
    ? "Bien sûr. Pour rechercher un devis, envoyez-moi le numéro du devis ou le courriel utilisé pour le devis."
    : "Sure. For quote lookup, please send the quote number or the email used for the quote.";
}

function isOrderHistoryIntent(text: string) {
  return /\b(order history|purchase history|recent orders|previous orders|past orders|last order|what did i order|what have i ordered|reorder|re-order|order again|same as last|usual order|mes commandes|historique|derni[eè]re commande|commander de nouveau)\b/i.test(text);
}

function priorAssistantRequestedOrderHistory(messages: AssistantMessage[]) {
  return messages
    .slice(-4, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /email (?:was )?used for the orders|courriel (?:a été |a ete |)?utilisé pour les commandes|courriel (?:a été |a ete |)?utilise pour les commandes/i.test(message.content)
    );
}

function priorAssistantRequestedInvoiceLookup(messages: AssistantMessage[]) {
  return messages
    .slice(-4, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /invoice lookup|receipt lookup|look up the invoice|find my invoice|invoice or receipt|facture|reçu|recu|rechercher la facture/i.test(message.content)
    );
}

function priorAssistantRequestedQuoteLookup(messages: AssistantMessage[]) {
  return messages
    .slice(-4, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /quote lookup|look up the quote|quote number|numéro du devis|numero du devis|devis/i.test(message.content)
    );
}

function priorAssistantRequestedReorderLookup(messages: AssistantMessage[]) {
  return messages
    .slice(-4, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /reorder lookup|order to reorder|email used for the order|commande à recommander|commande a recommander/i.test(message.content)
    );
}

function priorAssistantOfferedOrderStatusSupport(messages: AssistantMessage[]) {
  return messages
    .slice(-4, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /ask support for an update|send this order status request to support|demande au support pour une mise à jour|envoyer cette demande de statut au support/i.test(
          message.content
        )
    );
}

function priorAssistantAskedQuoteLinkEmail(messages: AssistantMessage[]) {
  return messages
    .slice(-4, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /email.*quote.*link|email.*payment.*link|courriel.*lien.*devis|courriel.*lien.*paiement|lien.*paiement.*courriel|envoyer.*lien.*courriel/i.test(message.content)
    );
}

function quoteLinkEmailIntent(text: string) {
  return /\b(email|send|mail)\b.*\b(quote|payment|checkout)?\s*link\b|\b(send|email)\b.*\bquote\b|\benvoie.*courriel.*devis\b|\bcourriel.*lien.*devis\b|\benvoie.*lien.*courriel\b|\benvoyer.*lien.*courriel\b/i.test(text);
}

function recentQuotePaymentLink(messages: AssistantMessage[]) {
  const assistantMessage = messages
    .slice()
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" &&
        /(?:Purchase link|Lien de paiement):\s*https?:\/\/|secure checkout link for quote\s+\S+:\s*https?:\/\/|lien de paiement sécurisé pour le devis\s+\S+:\s*https?:\/\//i.test(
          message.content
        )
    );
  const content = assistantMessage?.content || "";
  const checkoutUrl =
    content.match(/(?:Purchase link|Lien de paiement):\s*(https?:\/\/\S+)/i)?.[1]?.replace(/[),.;]+$/g, "") ||
    content.match(/(?:secure checkout link for quote\s+\S+|lien de paiement sécurisé pour le devis\s+\S+):\s*(https?:\/\/\S+)/i)?.[1]?.replace(/[),.;]+$/g, "") ||
    "";
  const quoteNumber = content.match(/\b(?:quote|devis)\s+(QN[A-Z0-9-]+)/i)?.[1] || content.match(/\b(QN[A-Z0-9-]+)\b/i)?.[1] || "";
  return { quoteNumber, checkoutUrl };
}

function supportSummaryFromMessages(messages: AssistantMessage[]): SupportRequest["summary"] {
  const lastUserQuestion =
    messages
      .slice()
      .reverse()
      .find((message) => message.role === "user" && !isSupportYes(message.content))?.content || "";
  const assistantText = messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n\n");
  const productLines = Array.from(assistantText.matchAll(/(?:\*\*)?([^。\n]*?)\s+—\s+SKU:\s*([A-Z0-9+._-]{3,40})[^\n]*(https?:\/\/\S+)?/gi))
    .slice(0, 5)
    .map((match) => `${match[1]?.replace(/\*/g, "").trim()} — SKU: ${match[2]}${match[3] ? ` — ${match[3]}` : ""}`);
  const urls = Array.from(new Set((assistantText.match(/https?:\/\/\S+/g) || []).map((url) => url.replace(/[),.;]+$/g, "")))).slice(0, 5);
  const confidence: NonNullable<SupportRequest["summary"]>["confidence"] = /\bConfirmed compatible:/i.test(assistantText)
    ? "confirmed"
    : /\bNot compatible:/i.test(assistantText)
      ? "not_compatible"
      : /\bCan.t confirm:|I can.t confirm|Je ne peux pas confirmer/i.test(assistantText)
        ? "cant_confirm"
        : "unknown";
  const emrnDataFound =
    assistantText.match(/(?:Based on the EMRN product details|Selon les détails du produit EMRN|I found this item|J’ai trouvé cet article)[\s\S]{0,500}/i)?.[0] ||
    productLines.join("\n") ||
    "Not captured";
  const externalDataFound =
    assistantText.match(/(?:manufacturer|fabricant|source URL|supporting product info|not on EMRN|product\/manufacturer info)[\s\S]{0,500}/i)?.[0] ||
    "Not used or not captured";

  return {
    customerQuestion: lastUserQuestion,
    productContext: [...productLines, ...urls].filter(Boolean).join("\n") || "Not captured",
    emrnDataFound,
    externalDataFound,
    confidence,
    transcriptSnippet: messages.slice(-8).map((message) => `${message.role.toUpperCase()}: ${message.content.slice(0, 700)}`),
  };
}

function supportCategoryFromMessages(messages: AssistantMessage[]): NonNullable<SupportRequest["category"]> {
  const text = messages.map((message) => message.content).join("\n").toLowerCase();
  if (/can.t confirm|can't confirm|compatible|compatibility|fit|fits|go with|works with|not compatible|manufacturer info/.test(text)) {
    return "compatibility";
  }
  if (/could not confirm.*(?:sku|part number|item|product)|photo, brand, model number|manual search|missing product/.test(text)) {
    return "product_missing";
  }
  if (/\bquote|devis|payment link|purchase link|checkout link\b/.test(text)) return "quote";
  if (/\binvoice|receipt|facture|print invoice\b/.test(text)) return "invoice";
  if (/\border status|tracking|shipment|commande|suivi\b/.test(text)) return "order_status";
  if (/\bcart|panier|add to cart|remove from cart|checkout\b/.test(text)) return "cart";
  return "other";
}

function priorAssistantAskedMissingProductInfo(messages: AssistantMessage[]) {
  return messages
    .slice(-4, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /could not confirm.*(?:sku|part number|item|product)|photo, brand, model number|photo, la marque, le modèle|manual search|recherche manuelle/i.test(
          message.content
        )
    );
}

function missingProductFollowUpQuery(messages: AssistantMessage[], latest: string) {
  const prior = messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant" && /could not confirm|je n’ai pas pu confirmer/i.test(message.content))?.content || "";
  const priorSku = prior.match(/\b(?:SKU\/part number|sku\/numéro de pièce|part number)\s+([A-Z0-9+._-]{3,40})/i)?.[1] || "";
  return [priorSku, latest].filter(Boolean).join(" ");
}

function orderHistoryEmail(messages: AssistantMessage[]) {
  return messages.map((message) => message.content).join("\n").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
}

function orderNumberFromText(text: string) {
  return (
    text.match(/\b(?:order|commande)\s*(?:number|#|no\.?|num[eé]ro)?\s*[:#-]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9-]{4,30})\b/i)?.[1] ||
    text.match(/\border\s*#\s*([A-Z0-9-]{4,30})\b/i)?.[1] ||
    ""
  );
}

function standaloneOrderNumberFromText(text: string) {
  return String(text || "").match(/\b\d{3,12}\b/)?.[0] || "";
}

function recentStandaloneOrderNumber(messages: AssistantMessage[]) {
  return messages
    .slice()
    .reverse()
    .find((message) => message.role === "user" && standaloneOrderNumberFromText(message.content))
    ?.content.match(/\b\d{3,12}\b/)?.[0] || "";
}

function quoteNumberFromText(text: string) {
  return (
    text.match(/\b(?:quote|devis|rfq)\s+(?:status|lookup|look\s+up|number|#|no\.?|statut|numero|num[eé]ro)\s*[:#-]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9-]{3,30})\b/i)?.[1] ||
    text.match(/\b(?:quote|devis|rfq)\s*(?:number|#|no\.?)?\s*[:#-]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9-]{3,30})\b/i)?.[1] ||
    text.match(/\b(?:QN|Q|RFQ)-?\d{3,}\b/i)?.[0] ||
    ""
  );
}

function standaloneQuoteNumberFromText(text: string) {
  return String(text || "").match(/\b(?:QN|Q|RFQ)-?\d{3,}\b/i)?.[0] || "";
}

function recentAssistantQuoteNumber(messages: AssistantMessage[]) {
  const assistantMessage = messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant" && /\b(?:quote|devis)\s+[A-Z0-9-]{3,30}\b/i.test(message.content));
  return assistantMessage ? quoteNumberFromText(assistantMessage.content) : "";
}

function invoiceNumberFromText(text: string) {
  return (
    text.match(/\b(?:invoice|receipt|facture|recu|reçu)\s*(?:number|#|no\.?)?\s*[:#-]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9-]{3,30})\b/i)?.[1] ||
    text.match(/\b(?:INV)-?\d{3,}\b/i)?.[0] ||
    ""
  );
}

function isInvoiceLookupIntent(text: string) {
  return /\b(invoice|receipt|copy of invoice|send.*invoice|invoice copy|facture|recu|reçu)\b/i.test(text);
}

function isQuoteLookupIntent(text: string) {
  return /\b(quote status|find.*quote|look up.*quote|lookup.*quote|my quote|saved quote|quote #|quote number|rfq|statut.*devis|trouver.*devis|mon devis)\b/i.test(text);
}

function isQuotePurchaseIntent(text: string) {
  return /\b(?:buy|purchase|pay|checkout|complete|place|order)\s+(?:the\s+|my\s+|this\s+)?(?:quote|rfq)\b|\b(?:quote|rfq)\s+(?:checkout|payment|purchase|pay|buy)\b|\b(?:payer|acheter|commander|finaliser)\s+(?:le\s+|mon\s+|ce\s+)?devis\b|\bdevis\s+(?:paiement|achat|checkout)\b/i.test(text);
}

function isReorderIntent(text: string) {
  return /\b(reorder|re-order|order again|same as last|usual order|buy again|purchase again|commander de nouveau|recommander)\b/i.test(text);
}

function isCurrentCartQuestion(text: string) {
  return /\b(what(?:'| i)?s in my cart|what is in my cart|show my cart|cart total|how much is my cart|current cart|panier actuel|mon panier|total du panier)\b/i.test(text);
}

function currentCartText(pageContext: ProductPageContext, language: "en" | "fr" | "unknown") {
  const cart = pageContext.currentCart;
  if (!cart) {
    return language === "fr"
      ? "Je peux lire le panier sur le site EMRN lorsque le widget est ouvert sur la boutique. Ouvrez le panier ou ajoutez un article avec Meri, puis redemandez-moi."
      : "I can read the live cart when the widget is open on the EMRN storefront. Open the cart or add an item with Meri, then ask me again.";
  }
  if (!cart.items.length) {
    return language === "fr" ? "Votre panier semble vide." : "Your cart looks empty.";
  }

  const lines = cart.items.slice(0, 8).map((item, index) => {
    const sku = item.sku ? ` (SKU: ${item.sku})` : "";
    const price = item.price ? ` — $${item.price.toFixed(2)}` : "";
    return `${index + 1}. ${item.quantity} x ${item.name}${sku}${price}`;
  });
  const total = cart.subtotal ? `\n${language === "fr" ? "Sous-total" : "Subtotal"}: $${cart.subtotal.toFixed(2)}` : "";
  const link = cart.cartUrl || "https://emrn.ca/cart.php";
  return language === "fr"
    ? `Voici ce que je vois dans votre panier:\n${lines.join("\n")}${total}\n\nPanier: ${link}`
    : `Here is what I see in your cart:\n${lines.join("\n")}${total}\n\nCart: ${link}`;
}

function recentOrdersText(
  result: Awaited<ReturnType<typeof getRecentOrdersByEmail>>,
  language: "en" | "fr" | "unknown"
) {
  if (!result.verified || !result.orders.length) {
    return language === "fr"
      ? "Je n’ai pas trouvé de commandes récentes pour ce courriel. Je peux envoyer la demande au support si vous voulez."
      : "I did not find recent orders for that email. I can send this to support if you want.";
  }

  const lines = result.orders.slice(0, 5).map((order, index) => {
    const products = order.products.slice(0, 4).map((product) => {
      const sku = product.sku ? `SKU: ${product.sku}` : "SKU unavailable";
      return `${product.quantity || 1} x ${product.name || product.sku} (${sku})`;
    });
    const more = order.products.length > 4 ? language === "fr" ? "; autres articles inclus" : "; more items included" : "";
    const total = order.total ? ` — ${order.currencyCode} ${order.total.toFixed(2)}` : "";
    return `${index + 1}. Order ${order.orderNumber} — ${order.status}${total}${order.createdAt ? ` — ${order.createdAt}` : ""}\n   ${products.join("; ")}${more}`;
  });

  return language === "fr"
    ? `J’ai trouvé ces commandes récentes:\n${lines.join("\n")}\n\nDites-moi quel SKU ou numéro de commande vous voulez recommander, et je peux chercher les articles disponibles.`
    : `I found these recent orders:\n${lines.join("\n")}\n\nTell me which SKU or order number you want to reorder, and I can look up the available items.`;
}

async function reorderFromOrderText(
  orderNumber: string,
  email: string,
  sessionId: string,
  language: "en" | "fr" | "unknown"
) {
  const orderDetails = await getOrderDetails({ orderNumber, email });
  if (!orderDetails.verified || !orderDetails.order?.products.length) {
    return language === "fr"
      ? "Je n’ai pas pu confirmer cette commande avec ce courriel, ou aucun article recommandable n’a été trouvé. Je peux envoyer cette demande au support."
      : "I could not verify that order with this email, or I could not find reorderable items. I can send this to support.";
  }

  const lookedUpProducts = (
    await Promise.all(
      orderDetails.order.products.map(async (item) => {
        if (!item.sku) return null;
        const [product] = await searchBySKU(item.sku);
        return product ? { product, quantity: Math.max(1, item.quantity || 1) } : null;
      })
    )
  ).filter((item): item is { product: CatalogProduct; quantity: number } => Boolean(item));

  const purchasableProducts = lookedUpProducts.filter((item) => item.product.purchasable && !item.product.quoteOnly);
  const blockedProducts = lookedUpProducts.filter((item) => item.product.quoteOnly || !item.product.purchasable);
  if (!purchasableProducts.length) {
    return language === "fr"
      ? "J’ai trouvé la commande, mais je ne peux pas ajouter automatiquement ses articles au panier. Je peux préparer une demande de devis/support avec les articles."
      : "I found the order, but I cannot automatically add its items to cart. I can prepare a quote/support request with the items.";
  }

  const cart = await createCart({
    sessionId,
    items: purchasableProducts.slice(0, 8).map(({ product, quantity }) => ({
      productId: product.productId,
      variantId: product.variantId || undefined,
      quantity,
    })),
  });
  const lineItems =
    cart.lineItems ||
    purchasableProducts.slice(0, 8).map(({ product, quantity }) => ({
      productId: product.productId,
      variantId: product.variantId || undefined,
      quantity,
    }));
  rememberCartState(sessionId, purchasableProducts, lineItems, cart.checkoutUrl);
  const browserLineItems = purchasableProducts.slice(0, 8).map(({ product, quantity }) => ({
    productId: product.productId,
    variantId: product.variantId || undefined,
    quantity,
  }));

  return `${cartReadyText(purchasableProducts.length, lineItems, language, purchasableProducts, cart.checkoutUrl, browserLineItems)}${quoteSplitText(blockedProducts.map((item) => item.product), language)}`;
}

function invoiceLookupText(
  orderNumber: string,
  invoice: Awaited<ReturnType<typeof lookupB2BInvoice>>,
  language: "en" | "fr" | "unknown"
) {
  if (invoice.found && (invoice.pdfUrl || invoice.invoiceUrl)) {
    const link = invoice.pdfUrl || invoice.invoiceUrl;
    return language === "fr"
      ? `J’ai trouvé la facture${invoice.invoiceNumber ? ` ${invoice.invoiceNumber}` : ""} pour la commande ${orderNumber}. Lien: ${link}`
      : `I found invoice${invoice.invoiceNumber ? ` ${invoice.invoiceNumber}` : ""} for order ${orderNumber}. Link: ${link}`;
  }

  const printableOrderUrl = orderNumber
    ? `https://emrn.ca/account.php?action=view_order&order_id=${encodeURIComponent(orderNumber)}`
    : "https://emrn.ca/account.php?action=order_status";
  return language === "fr"
    ? `J’ai confirmé la commande ${orderNumber}, mais je ne vois pas de PDF de facture B2B disponible automatiquement. Vous pouvez ouvrir la page de la commande et utiliser « Print Invoice » si vous êtes connecté: ${printableOrderUrl}\n\nJe peux aussi envoyer cette demande au support.`
    : `I confirmed order ${orderNumber}, but I do not see an automatic B2B invoice PDF available. You can open the order page and use “Print Invoice” if you are signed in: ${printableOrderUrl}\n\nI can also send this request to support.`;
}

function quoteStatusText(
  status: string | undefined,
  language: "en" | "fr" | "unknown",
  allowCheckout?: boolean
) {
  if (allowCheckout) {
    return language === "fr"
      ? "Prêt à acheter - vous pouvez utiliser le lien de paiement ci-dessous"
      : "Ready to purchase - you can use the payment link below";
  }
  const value = String(status || "").trim();
  const en: Record<string, string> = {
    "0": "Under review",
    "1": "Submitted to EMRN for review",
    "2": "Under review",
    "3": "Waiting for customer update",
    "4": "Converted to an order",
    "5": "Expired",
  };
  const fr: Record<string, string> = {
    "0": "En révision",
    "1": "Soumis à EMRN pour révision",
    "2": "En révision",
    "3": "En attente d’une mise à jour du client",
    "4": "Converti en commande",
    "5": "Expiré",
  };
  if (!value) return "";
  return (language === "fr" ? fr[value] : en[value]) || (language === "fr" ? "En révision" : "Under review");
}

function quoteLookupText(
  quote: Awaited<ReturnType<typeof lookupB2BQuote>>,
  language: "en" | "fr" | "unknown",
  purchaseUrl = ""
) {
  if (!quote.found) {
    return language === "fr"
      ? "Je n’ai pas trouvé ce devis automatiquement. Je peux envoyer cette demande au support si vous voulez."
      : "I could not find that quote automatically. I can send this to support if you want.";
  }

  const money = (value?: number) => value && value > 0 ? `${quote.currencyCode || "CAD"} ${value.toFixed(2)}` : "";
  const status = quoteStatusText(quote.status, language, quote.allowCheckout);
  const lines = quote.items.slice(0, 8).map((item, index) => {
    const itemPrice = money(item.price);
    const itemDiscount = money(item.discount);
    return `${index + 1}. ${item.quantity} x ${item.name}${item.sku ? ` (SKU: ${item.sku})` : ""}${itemPrice ? ` — ${itemPrice}` : ""}${itemDiscount ? `, ${language === "fr" ? "rabais" : "discount"} ${itemDiscount}` : ""}`;
  });
  const subtotal = money(quote.subtotal) ? `\n${language === "fr" ? "Sous-total" : "Subtotal"}: ${money(quote.subtotal)}` : "";
  const discountLabel = quote.discountType === "1" && quote.discountValue
    ? `${quote.discountValue}%${money(quote.discount) ? ` (${money(quote.discount)})` : ""}`
    : quote.discountType === "2" && quote.discountValue
      ? money(quote.discountValue)
      : money(quote.discount);
  const discount = discountLabel
    ? `\n${language === "fr" ? "Rabais" : "Discount"}: ${discountLabel}`
    : quote.subtotal || quote.total
      ? `\n${language === "fr" ? "Rabais" : "Discount"}: ${language === "fr" ? "aucun" : "none"}`
      : "";
  const shipping = money(quote.shippingTotal) ? `\n${language === "fr" ? "Livraison" : "Shipping"}: ${money(quote.shippingTotal)}` : "";
  const tax = money(quote.taxTotal) ? `\n${language === "fr" ? "Taxes" : "Tax"}: ${money(quote.taxTotal)}` : "";
  const total = money(quote.total) ? `\n${language === "fr" ? "Total" : "Total"}: ${money(quote.total)}` : "";
  const expires = quote.expiredAt
    ? `\n${language === "fr" ? "Expiration" : "Expires"}: ${formatDateLike(quote.expiredAt)}`
    : "";
  const link = quote.quoteUrl ? `\n${language === "fr" ? "Lien du devis" : "Quote link"}: ${quote.quoteUrl}` : "";
  const purchase = purchaseUrl
    ? `\n${language === "fr" ? "Lien de paiement" : "Purchase link"}: ${purchaseUrl}\n${language === "fr" ? "Voulez-vous que je vous envoie ce lien de paiement par courriel?" : "Want me to email this quote/payment link to you?"}`
    : quote.allowCheckout
      ? `\n${language === "fr" ? "Voulez-vous que je crée un lien de paiement pour ce devis?" : "Would you like a purchase link for this quote?"}`
      : "";
  return language === "fr"
    ? `J’ai trouvé le devis ${quote.quoteNumber || ""}${status ? ` — statut: ${status}` : ""}.${lines.length ? `\nArticles:\n${lines.join("\n")}` : ""}${subtotal}${discount}${shipping}${tax}${total}${expires}${link}${purchase}`
    : `I found quote ${quote.quoteNumber || ""}${status ? ` — status: ${status}` : ""}.${lines.length ? `\nItems:\n${lines.join("\n")}` : ""}${subtotal}${discount}${shipping}${tax}${total}${expires}${link}${purchase}`;
}

function formatDateLike(value: string) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  const numeric = Number(trimmed);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 100000000000 ? numeric : numeric * 1000)
    : new Date(trimmed);
  if (Number.isNaN(date.getTime())) return trimmed;
  return date.toISOString().slice(0, 10);
}

function friendlyOrderStatusText(status: string | undefined, language: "en" | "fr" | "unknown") {
  const raw = String(status || "").trim();
  const normalized = raw.toLowerCase();
  const en: Record<string, string> = {
    "awaiting payment": "Awaiting payment — payment has not been completed or confirmed yet.",
    "awaiting fulfillment": "Received and being processed — the order may be under review, picking, packing, stock allocation, or other order processing.",
    "awaiting shipment": "Being prepared for shipment — it may be in warehouse processing, waiting on stock availability or stock allocation, or awaiting carrier pickup.",
    "partially shipped": "Partially shipped — some items shipped separately while other items are still pending.",
    shipped: "Shipped — tracking should be available when the carrier has provided it.",
    completed: "Completed — the order has been processed.",
    cancelled: "Cancelled — the order is not currently active.",
    refunded: "Refunded — the order has been refunded.",
  };
  const fr: Record<string, string> = {
    "awaiting payment": "En attente de paiement — le paiement n’est pas encore complété ou confirmé.",
    "awaiting fulfillment": "Reçue et en traitement — la commande peut être en révision, préparation, emballage, allocation de stock ou autre traitement de commande.",
    "awaiting shipment": "En préparation d’expédition — elle peut être en traitement entrepôt, en attente de disponibilité ou allocation de stock, ou en attente de ramassage transporteur.",
    "partially shipped": "Partiellement expédiée — certains articles ont été expédiés séparément et d’autres sont encore en attente.",
    shipped: "Expédiée — le suivi devrait être disponible lorsque le transporteur l’a fourni.",
    completed: "Complétée — la commande a été traitée.",
    cancelled: "Annulée — la commande n’est pas active actuellement.",
    refunded: "Remboursée — la commande a été remboursée.",
  };
  return (language === "fr" ? fr[normalized] : en[normalized]) || raw || (language === "fr" ? "non disponible" : "unavailable");
}

function quoteCheckoutText(
  quoteNumber: string,
  checkout: Awaited<ReturnType<typeof createB2BQuoteCheckout>>,
  language: "en" | "fr" | "unknown"
) {
  if (checkout.created && checkout.checkoutUrl) {
    return language === "fr"
      ? `J’ai créé un lien de paiement sécurisé pour le devis ${quoteNumber}: ${checkout.checkoutUrl}\nVoulez-vous que je vous envoie ce lien de paiement par courriel?`
      : `I created a secure checkout link for quote ${quoteNumber}: ${checkout.checkoutUrl}\nWant me to email this quote/payment link to you?`;
  }

  return language === "fr"
    ? `Je n’ai pas pu créer automatiquement un lien de paiement pour le devis ${quoteNumber}. Je peux envoyer cette demande au support.`
    : `I could not automatically create a checkout link for quote ${quoteNumber}. I can send this to support.`;
}

function orderTrackingText(
  order: { orderNumber: string; status?: string; trackingNumbers: string[]; trackingLinks: string[] },
  language: "en" | "fr" | "unknown"
) {
  const tracking = order.trackingLinks.length
    ? order.trackingLinks.join("\n")
    : order.trackingNumbers.join(", ");
  const status = friendlyOrderStatusText(order.status, language);

  return language === "fr"
    ? `J’ai trouvé votre commande ${order.orderNumber}. Statut: ${status}\n\nSuivi: ${tracking}`
    : `I found your order ${order.orderNumber}. Status: ${status}\n\nTracking: ${tracking}`;
}

function checkoutSkusFromConversation(messages: AssistantMessage[]) {
  const skus = new Map<string, number>();
  const cartResetIndex = messages.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      /\b(cart is now empty|cleared the cart|panier est maintenant vide|vidé le panier|vide le panier)\b/i.test(message.content)
  );
  const text = messages.slice(cartResetIndex + 1).map((message) => message.content).join("\n");
  for (const match of text.matchAll(/[?&]products=([^&\s]+)/g)) {
    const value = decodeURIComponent(match[1] || "");
    for (const item of value.split(",")) {
      const [sku, quantity] = item.split(":");
      if (sku) skus.set(sku.toUpperCase(), Math.max(Number(quantity || 1), skus.get(sku.toUpperCase()) || 0));
    }
  }
  return skus;
}

function rememberCartState(
  sessionId: string,
  cartProducts: Array<{ product: CatalogProduct; quantity: number }>,
  lineItems: Array<{ itemId?: string; sku?: string; productId: number; variantId?: number; quantity: number }>,
  checkoutUrl?: string
) {
  const previous = trackedCarts.get(sessionId);
  const byKey = new Map<string, TrackedCartItem>();

  for (const item of previous?.items || []) {
    byKey.set(`${item.productId}:${item.variantId || 0}`, item);
  }

  for (const cartProduct of cartProducts) {
    const product = cartProduct.product;
    const key = `${product.productId}:${product.variantId || 0}`;
    const lineItem =
      lineItems.find((item) => Number(item.productId) === product.productId && Number(item.variantId || 0) === Number(product.variantId || 0)) ||
      lineItems.find((item) => normalizeSku(item.sku || "") === normalizeSku(product.sku));
    byKey.set(key, {
      itemId: lineItem?.itemId || byKey.get(key)?.itemId,
      sku: product.sku,
      productId: product.productId,
      variantId: product.variantId || undefined,
      quantity: cartProduct.quantity,
      name: product.name,
    });
  }

  trackedCarts.set(sessionId, {
    items: Array.from(byKey.values()).slice(0, 8),
    checkoutUrl,
  });
}

function cartProductsFromTrackedCart(cart: TrackedCart) {
  return cart.items.map((item) => ({
    product: {
      id: String(item.variantId || item.productId || item.sku),
      productId: item.productId,
      variantId: item.variantId || 0,
      name: item.name,
      parentName: item.name,
      sku: item.sku,
      brand: "",
      manufacturer: "",
      categories: [],
      description: "",
      price: 0,
      image: "",
      url: "",
      inventoryLevel: 0,
      availability: "",
      availabilityDescription: "",
      purchasable: true,
      quoteOnly: false,
      purchaseAction: "cart" as const,
      purchaseMessage: "",
    },
    quantity: item.quantity,
  }));
}

function updateTrackedCartFromResult(sessionId: string, cart: TrackedCart, result: { checkoutUrl?: string; lineItems?: Array<{ itemId?: string; sku?: string; productId: number; variantId?: number; quantity: number }> }) {
  const returnedLineItems = result.lineItems || [];
  if (!returnedLineItems.length) {
    trackedCarts.set(sessionId, {
      ...cart,
      checkoutUrl: result.checkoutUrl || cart.checkoutUrl,
    });
    return;
  }

  const nextItems = cart.items
    .map((item): TrackedCartItem | null => {
      const lineItem =
        returnedLineItems.find((current) => current.itemId && current.itemId === item.itemId) ||
        returnedLineItems.find((current) => normalizeSku(current.sku || "") === normalizeSku(item.sku)) ||
        returnedLineItems.find((current) => Number(current.productId) === item.productId && Number(current.variantId || 0) === Number(item.variantId || 0));
      if (!lineItem) return null;
      return {
        ...item,
        itemId: lineItem.itemId || item.itemId,
        sku: item.sku || lineItem.sku || "",
        quantity: lineItem.quantity || item.quantity,
      };
    })
    .filter((item): item is TrackedCartItem => Boolean(item));

  trackedCarts.set(sessionId, {
    items: nextItems,
    checkoutUrl: result.checkoutUrl || cart.checkoutUrl,
  });
}

function recentAssistantProductSkus(messages: AssistantMessage[]) {
  const skus: string[] = [];
  const seen = new Set<string>();
  const assistantMessages = messages
    .slice(0, -1)
    .filter((message) => message.role === "assistant")
    .slice(-4)
    .reverse();

  const addSku = (value: string) => {
    const sku = normalizeSku(value);
    if (!sku || seen.has(sku)) return;
    seen.add(sku);
    skus.push(sku);
  };

  for (const message of assistantMessages) {
    const content = message.content || "";
    const looksProductRelated =
      /products I found|produits que j’ai trouvés|I found this item|J’ai trouvé cet article|which one would you like added|laquelle voulez-vous ajouter|SKU\s*:/i.test(
        content
      );
    if (!looksProductRelated) continue;

    for (const match of content.matchAll(/\bSKU\s*:?\s*(?:\*\*)?([A-Z0-9+/-]{3,40})(?:\*\*)?/gi)) addSku(match[1] || "");
    for (const match of content.matchAll(/\bSKU\s+(?:\*\*)?([A-Z0-9+/-]{3,40})(?:\*\*)?\b/gi)) addSku(match[1] || "");
    for (const match of content.matchAll(/\b(?:item|article)\s+for\s+[“"']?([A-Z0-9+/-]{3,40})[”"']?/gi)) addSku(match[1] || "");
    for (const match of content.matchAll(/\b(?:for|pour)\s+[“"']([A-Z0-9+/-]{3,40})[”"']/gi)) addSku(match[1] || "");
    for (const match of content.matchAll(/\(([A-Z]{1,10}\s*-?\s*\d{3,}[A-Z0-9-]*\+?)\)/gi)) addSku(match[1] || "");
    if (skus.length) break;
  }

  return skus.slice(0, 8);
}

function recentAssistantProductNames(messages: AssistantMessage[]) {
  const assistantMessages = messages
    .slice(0, -1)
    .filter((message) => message.role === "assistant")
    .slice(-4)
    .reverse();
  const names: string[] = [];
  for (const message of assistantMessages) {
    for (const match of message.content.matchAll(/(?:^|\n)\s*(?:\d+\.\s*)?\*\*([^*\n]{3,140})\*\*\s+[—-]\s+SKU\b/gi)) {
      const name = match[1]?.trim();
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names.slice(0, 4);
}

async function recentAssistantProducts(messages: AssistantMessage[]) {
  const skus = recentAssistantProductSkus(messages);
  let products = (
    await Promise.all(
      skus.map(async (sku) => {
        const [product] = await searchBySKU(sku);
        return product || null;
      })
    )
  ).filter((product): product is CatalogProduct => Boolean(product));

  if (!products.length) {
    products = (
      await Promise.all(
        recentAssistantProductNames(messages).map(async (name) => {
          const result = await searchProducts({ query: name, limit: 3 });
          return result.products.find((product) =>
            normalizeSearchText(`${product.name} ${product.parentName}`).includes(normalizeSearchText(name))
          ) || null;
        })
      )
    ).filter((product): product is CatalogProduct => Boolean(product));
  }

  const seen = new Set<string>();
  return products.filter((product) => {
    const key = `${product.productId}:${product.variantId}:${normalizeSku(product.sku)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function refreshProductsBySku(products: CatalogProduct[]) {
  return Promise.all(
    products.map(async (product) => {
      if (!product.sku) return product;
      const [freshProduct] = await searchBySKU(product.sku);
      return freshProduct || product;
    })
  );
}

function priorAssistantAskedCartChoice(messages: AssistantMessage[]) {
  return messages
    .slice(-4, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /which one would you like added to cart|laquelle voulez-vous ajouter au panier/i.test(message.content)
    );
}

function priorAssistantOfferedCartAdd(messages: AssistantMessage[]) {
  return messages
    .slice(-4, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /would you like me to add it to your cart|voulez-vous que je l’ajoute au panier/i.test(message.content)
    );
}

function priorAssistantAskedCartQuantity(messages: AssistantMessage[]) {
  return messages
    .slice(-4, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /how many would you like|quelle quantite voulez-vous|quelle quantité voulez-vous/i.test(message.content)
    );
}

function isContextProductSelectionReply(text: string) {
  return /\b(?:it|them|these|those|this|that|the first|the second|the third|the item|the product|ones?)\b/i.test(text) ||
    /\b(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|#?\s*[1-5]|number\s+[1-5]|option\s+[1-5])(?:\s+(?:one|item|product))?\b/i.test(text) ||
    /\b\d{1,5}\s+(?:of\s+)?(?:#|number|no\.?|option|item)\s*[1-5]\b/i.test(text) ||
    /^\s*(?:add\s+(?:to\s+(?:my\s+)?)?(?:cart|catt|cartt|crt)|add\s+it\s+to\s+(?:my\s+)?(?:cart|catt|cartt|crt)|add\s+this\s+to\s+(?:my\s+)?(?:cart|catt|cartt|crt)|buy\s+it|purchase\s+it)\s*$/i.test(text);
}

function isGenericContextProductReply(text: string) {
  const normalized = String(text || "").toLowerCase();
  if (!/\b(it|this|that|the item|the product|ce produit|cet article)\b/i.test(normalized)) return false;
  if (extractSkuCandidates(normalized).length) return false;
  if (extractOrdinalSelection(normalized, 20) !== null) return false;
  if (/\b(all|both|these|those|them|first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|#?\s*[1-5]|number\s+[1-5]|option\s+[1-5])\b/i.test(normalized)) return false;
  if (/\b(black|blue|green|orange|pink|purple|red|white|yellow|noir|bleu|vert|rouge|blanc|jaune)\b/i.test(normalized)) return false;
  return true;
}

function selectContextProducts(text: string, products: CatalogProduct[]) {
  if (!products.length) return [];
  if (isGenericContextProductReply(text)) return [products[0]];
  return selectProductsForCart(text, products);
}

function isSelectionWithoutQuantity(text: string) {
  return !hasExplicitQuantity(text) &&
    (/\b(?:take|get|buy|order|purchase|want|need|choose|pick|go with)\s+(?:the\s+)?(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|#?\s*[1-5]|number\s+[1-5]|option\s+[1-5])(?:\s+(?:one|item|product))?\b/i.test(text) ||
      /^\s*(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|#?\s*[1-5]|number\s+[1-5]|option\s+[1-5])\s*$/i.test(text));
}

function isLiveCartEditIntent(text: string) {
  return /\b(remove|delete|take out|clear cart|empty cart|clear the cart|clear it|change (?:that|it|this|the|quantity)|make (?:that|it|this|the).*\b\d{1,5}\b|set (?:that|it|this|the).*\b\d{1,5}\b|enlever|retirer|supprimer|vider le panier|changer|mettre|mettez)\b/i.test(text);
}

function priorAssistantCreatedCart(messages: AssistantMessage[]) {
  return messages
    .slice(-6, -1)
    .some((message) => message.role === "assistant" && /\bopen your cart when you(?:’|')?re ready|ouvrir votre panier|Cart:\n/i.test(message.content));
}

function priorAssistantAskedClearCartConfirmation(messages: AssistantMessage[]) {
  return messages
    .slice(-3, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /clear the Meri-created cart|vider le panier cree par Meri|vider le panier créé par Meri/i.test(message.content)
    );
}

function quantityFromChangeReply(text: string) {
  return Number(String(text || "").match(/\b(?:change|make|set|changer|mettre|mettez)\b[\s\S]{0,60}?\b(\d{1,5})\b/i)?.[1] || 0);
}

function cartItemsToken(items: Array<{ productId: number; variantId?: number; quantity: number }>) {
  const payload = Buffer.from(JSON.stringify(items), "utf8").toString("base64");
  return `\n\n[[EMRN_CART_ITEMS:${payload}]]`;
}

function cartActionToken(action: Record<string, unknown>) {
  const payload = Buffer.from(JSON.stringify(action), "utf8").toString("base64");
  return `\n\n[[EMRN_CART_ACTION:${payload}]]`;
}

function isClearCartIntent(text: string) {
  return /\b(clear cart|empty cart|clear the cart|clear it|vider le panier)\b/i.test(text);
}

function isRemoveCartIntent(text: string) {
  return /\b(remove|delete|take out|enlever|retirer|supprimer)\b/i.test(text);
}

function isSetQuantityCartIntent(text: string) {
  return quantityFromChangeReply(text) > 0;
}

function mcpCartEditText(
  action: "remove" | "set_quantity" | "clear",
  language: "en" | "fr" | "unknown",
  checkoutUrl?: string,
  browserAction?: Record<string, unknown>
) {
  const token = browserAction ? cartActionToken(browserAction) : "";
  if (action === "clear") {
    return language === "fr"
      ? `D’accord, j’ai vidé le panier.${token}`
      : `Okay, I cleared the cart.${token}`;
  }

  const link = checkoutUrl || "https://emrn.ca/cart.php";
  if (action === "remove") {
    return language === "fr"
      ? `D’accord, j’ai retiré cet article du panier. Vous pouvez continuer à magasiner ici, ou ouvrir votre panier quand vous êtes prêt: ${link}${token}`
      : `Okay, I removed that item from the cart. You can keep shopping here, or open your cart when you’re ready: ${link}${token}`;
  }

  return language === "fr"
    ? `D’accord, j’ai changé cette quantité dans le panier. Vous pouvez continuer à magasiner ici, ou ouvrir votre panier quand vous êtes prêt: ${link}${token}`
    : `Okay, I updated that quantity in the cart. You can keep shopping here, or open your cart when you’re ready: ${link}${token}`;
}

function mcpCartEmptyAfterRemoveText(language: "en" | "fr" | "unknown", browserAction?: Record<string, unknown>) {
  const token = browserAction ? cartActionToken(browserAction) : "";
  return language === "fr"
    ? `D’accord, j’ai retiré cet article du panier. Le panier est maintenant vide.${token}`
    : `Okay, I removed that item from the cart. The cart is now empty.${token}`;
}

function normalizeSku(value: string) {
  return String(value || "").replace(/[^a-z0-9+]/gi, "").toUpperCase();
}

function normalizeSkuBase(value: string) {
  return normalizeSku(value).replace(/\++$/g, "");
}

function skuMatchesWithSellableSuffix(left: string, right: string) {
  const leftSku = normalizeSku(left);
  const rightSku = normalizeSku(right);
  if (!leftSku || !rightSku) return false;
  return leftSku === rightSku || normalizeSkuBase(leftSku) === normalizeSkuBase(rightSku);
}

function skuZeroInsertionCandidates(sku: string) {
  const value = String(sku || "").trim().toUpperCase();
  if (!value || value.includes("0")) return [];
  const candidates = new Set<string>();
  for (let index = 1; index < value.length; index += 1) {
    const previous = value[index - 1];
    const current = value[index];
    if (!/[A-Z0-9]/.test(previous) || !/[A-Z0-9]/.test(current)) continue;
    candidates.add(`${value.slice(0, index)}0${value.slice(index)}`);
  }
  return Array.from(candidates).slice(0, 18);
}

function skuEditDistance(a: string, b: string) {
  const left = normalizeSku(a);
  const right = normalizeSku(b);
  if (left === right) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const before = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
      diagonal = before;
    }
  }
  return previous[right.length];
}

function isCloseSkuMatch(requestedSku: string, productSku: string) {
  const requested = normalizeSku(requestedSku);
  const actual = normalizeSku(productSku);
  if (!requested || !actual || requested === actual) return false;
  if (!requested.includes("0") && actual.length === requested.length + 1 && actual.replace(/0/g, "") === requested) return true;
  if (Math.abs(actual.length - requested.length) > 1) return false;
  return skuEditDistance(requested, actual) <= 1;
}

async function closeSkuSuggestion(skuCandidates: string[], language: "en" | "fr" | "unknown") {
  for (const originalSku of skuCandidates) {
    const suggestedSkus = skuZeroInsertionCandidates(originalSku);
    for (const suggestedSku of suggestedSkus) {
      const matches = (await searchBySKU(suggestedSku)).filter((product) => isCloseSkuMatch(originalSku, product.sku || ""));
      if (matches.length) {
        return {
          originalSku,
          suggestedSku: matches[0].sku || suggestedSku,
          products: dedupeCatalogProductsBySku(matches).slice(0, 3),
        };
      }
    }

    const fuzzyMatches = (await searchProducts({ query: originalSku, language, limit: 10 })).products
      .filter((product) => isCloseSkuMatch(originalSku, product.sku || ""));
    if (fuzzyMatches.length) {
      return {
        originalSku,
        suggestedSku: fuzzyMatches[0].sku || originalSku,
        products: dedupeCatalogProductsBySku(fuzzyMatches).slice(0, 3),
      };
    }
  }
  return null;
}

function skuSuggestionText(
  suggestion: { originalSku: string; suggestedSku: string; products: CatalogProduct[] },
  language: "en" | "fr" | "unknown"
) {
  const lines = suggestion.products.map((product) => {
    const price = product.quoteOnly
      ? language === "fr"
        ? "devis requis"
        : "quote required"
      : product.price
        ? `$${product.price.toFixed(2)}`
        : language === "fr"
          ? "prix non disponible"
          : "price unavailable";
    const availability = displayAvailability(product, language);
    return language === "fr"
      ? `- **${product.name}** — SKU **${product.sku || "non disponible"}** — ${price}. ${availability}. [Voir le produit](${product.url})`
      : `- **${product.name}** — SKU **${product.sku || "unavailable"}** — ${price}. ${availability}. [View product](${product.url})`;
  });
  if (language === "fr") {
    return `Je n’ai pas trouvé le SKU **${suggestion.originalSku}**, mais j’ai trouvé un SKU EMRN très proche: **${suggestion.suggestedSku}**.\n\n${lines.join("\n")}\n\nEst-ce l’article que vous vouliez dire? Si non, je peux envoyer une demande de sourcing/devis à EMRN.`;
  }
  return `I could not find SKU **${suggestion.originalSku}**, but I found a very close EMRN SKU: **${suggestion.suggestedSku}**.\n\n${lines.join("\n")}\n\nIs this the item you meant? If not, I can send an item-sourcing/quote request to EMRN.`;
}

function priorAssistantOfferedSkuSuggestion(messages: AssistantMessage[]) {
  return messages
    .slice(-4)
    .some(
      (message) =>
        message.role === "assistant" &&
        /very close EMRN SKU|SKU EMRN très proche|SKU EMRN tres proche/i.test(
          message.content
        )
    );
}

function recentSkuSuggestion(messages: AssistantMessage[]) {
  const assistantText = messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant" && /very close EMRN SKU|SKU EMRN très proche|SKU EMRN tres proche/i.test(message.content))
    ?.content || "";
  return (
    assistantText.match(/very close EMRN SKU:\s*\*\*([^*]+)\*\*/i)?.[1]?.trim() ||
    assistantText.match(/SKU EMRN tr[eè]s proche:\s*\*\*([^*]+)\*\*/i)?.[1]?.trim() ||
    ""
  );
}

function priorAssistantOfferedKeywordSuggestion(messages: AssistantMessage[]) {
  return messages
    .slice(-4)
    .some(
      (message) =>
        message.role === "assistant" &&
        /Did you mean “[^”]+”|Vouliez-vous dire «[^»]+»/i.test(message.content)
    );
}

function recentKeywordSuggestion(messages: AssistantMessage[]) {
  const assistantText = messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant" && /Did you mean “[^”]+”|Vouliez-vous dire «[^»]+»/i.test(message.content))
    ?.content || "";
  return (
    assistantText.match(/Did you mean “([^”]+)”/i)?.[1]?.trim() ||
    assistantText.match(/Vouliez-vous dire «([^»]+)»/i)?.[1]?.trim() ||
    ""
  );
}

async function keywordSuggestion(query: string, language: "en" | "fr" | "unknown") {
  const cleaned = cleanProductQuery(query);
  const corrected = normalizeCommonSearchTypos(cleaned);
  if (!cleaned || !corrected || corrected === normalizeSearchText(cleaned)) return null;
  if (corrected.length < 3 || extractSkuCandidates(query).length) return null;
  const result = await searchProducts({ query: corrected, language, limit: 6 });
  if (!result.products.length) return null;
  return {
    originalQuery: cleaned,
    suggestedQuery: corrected,
    products: result.products.slice(0, 5),
  };
}

function keywordSuggestionText(
  suggestion: { originalQuery: string; suggestedQuery: string; products: CatalogProduct[] },
  language: "en" | "fr" | "unknown"
) {
  const preview = productResultsText(suggestion.products.slice(0, 3), language, suggestion.suggestedQuery)
    .replace(/\n\nIf you tell me[\s\S]*$/i, "")
    .replace(/\n\nSi vous me dites[\s\S]*$/i, "");
  if (language === "fr") {
    return `Je n’ai pas trouvé de résultats EMRN pour « ${suggestion.originalQuery} ».\n\nVouliez-vous dire « ${suggestion.suggestedQuery} »?\n\n${preview}\n\nRépondez oui pour voir ces résultats, ou non et je peux envoyer une demande de sourcing/devis à EMRN.`;
  }
  return `I did not find EMRN results for “${suggestion.originalQuery}”.\n\nDid you mean “${suggestion.suggestedQuery}”?\n\n${preview}\n\nReply yes to see these results, or no and I can send an item-sourcing/quote request to EMRN.`;
}

function looksLikeSpecificProductSearch(text: string) {
  const normalized = normalizeSearchText(text);
  const hasSearchLanguage = /\b(do you have|do u have|looking for|look for|find|search|show me|i need|we need|need|want|poster|chart|diagram|image|picture|photo)\b/i.test(text);
  const hasProductNoun = /\b(posters?|charts?|diagrams?|images?|pictures?|photos?|vessels?|vascular|arter(?:y|ies)|veins?|gloves?|masks?|gauze|bandage|dressings?|manikins?|mannequins?|pads?|electrodes?|batter(?:y|ies)|regulators?|chairs?|backpacks?|bags?|kits?|cuffs?|otoscopes?|thermometers?|syringes?|needles?)\b/.test(normalized);
  return hasSearchLanguage && hasProductNoun;
}

function looksLikePlainCatalogKeywordSearch(text: string) {
  const normalized = normalizeSearchText(cleanProductQuery(text));
  if (!normalized) return false;
  if (extractSkuCandidates(text).length) return false;
  if (/\b(can|could|does|do|will|would|is|are|what|which|how|why|when|where|compatible|compatibility|fit|fits|work|works|hold|holds|come|comes|include|includes|sold|price|cost|latex[- ]?free|free of latex)\b/.test(normalized)) {
    return false;
  }
  const hasProductNoun = /\b(posters?|charts?|diagrams?|images?|pictures?|photos?|vessels?|vascular|arter(?:y|ies)|veins?|gloves?|gants?|masks?|masques?|gauze|gazes?|bandage|bandages?|dressings?|pansements?|manikins?|mannequins?|pads?|electrodes?|batter(?:y|ies)|batteries?|regulators?|regulateurs?|chairs?|chaises?|backpacks?|bags?|sacs?|kits?|trousses?|cuffs?|brassards?|otoscopes?|thermometers?|thermometres?|syringes?|seringues?|needles?|aiguilles?)\b/.test(normalized);
  const hasModifier = /\b(nitrile|latex|vinyl|exam|sterile|blue|black|purple|white|green|pink|small|medium|large|xlarge|xl|adult|pediatric|paediatric|full|torso|face|blood|vessel|nerve|wall|clinic|moyen|moyenne|grand|grande|petit|petite|bleu|noir|blanc|vert|rouge|visage|sang|sanguin|vaisseau|vaisseaux|nerf|nerfs|mur|clinique)\b/.test(normalized);
  return hasProductNoun && hasModifier;
}

function escapeRegExp(value: string) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanProductQuery(text: string) {
  return String(text || "")
    .replace(/\b(no,?\s+)?(do you have|do have|do u have|so you have|you have|do you carry|can you find|find me|find|search for|search|show me|how about|what about|i am looking for|i'm looking for|im looking for|looking for|i need|we need|i want|we want|i would like|we would like|je cherche|avez-vous|avez vous|as-tu|as tu)\b/gi, " ")
    .replace(/\b(what|which)\s+((?:adult|pediatric|paediatric|replacement|training)\s+)?(pads?|padz|electrodes?)\s+(?:work|works|fit|fits|go|goes)\s+with\b/gi, "$1 $2$3 for ")
    .replace(/\b(no|so|a|an|the|some|product|products|item|items|please|pls|svp|un|une|des|le|la|les|produit|produits|to|also|add|buy|purchase|order|get|take)\b/gi, " ")
    .replace(/[?!.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasProductWordsBeyondSku(text: string, skuCandidates: string[]) {
  if (skuCandidates.some((sku) => colorFromSkuSuffix(sku) && familySearchForMissingColorSku(sku))) return false;
  let cleaned = cleanProductQuery(text);
  for (const sku of skuCandidates) {
    cleaned = cleaned.replace(new RegExp(escapeRegExp(sku), "gi"), " ");
    cleaned = cleaned.replace(new RegExp(escapeRegExp(sku.replace(/[-\s]/g, "")), "gi"), " ");
  }

  const words = cleaned
    .replace(/[^a-z0-9]+/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .filter((word) => !/^(sku|part|item|product|produit|number|model)$/i.test(word));

  return words.length > 0;
}

function aedAccessorySkuHints(text: string) {
  const normalized = normalizeSearchText(text);
  const asksForPads = /\b(pads?|padz|electrodes?|électrodes?)\b/i.test(text);
  if (!asksForPads) return [];

  if (/\bzoll\b/.test(normalized) && /\baed\s+plus\b/.test(normalized)) {
    if (/\b(pediatric|paediatric|child|children|kid|kids|pedi)\b/.test(normalized)) return ["8900-0810-01"];
    return ["8900-0800-01", "8900-0810-01"];
  }

  if (/\bphilips\b/.test(normalized) && /\bfrx\b/.test(normalized)) {
    if (/\b(training|trainer)\b/.test(normalized)) return ["989803139291", "989803139271"];
    return ["989803139261"];
  }

  return [];
}

function looksLikeQuoteDetailsReply(text: string) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (isProductSearchIntent(trimmed) || isQuickActionPrompt(trimmed)) return false;
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(trimmed)) return true;
  if (/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/.test(trimmed)) return true;
  if (/\b(my name is|name is|i am|i'm|je m'appelle|mon nom est|company is|compagnie|entreprise)\b/i.test(trimmed)) return true;
  return /^[A-Z][A-Za-z' -]{1,40}(?:\s+[A-Z][A-Za-z' -]{1,40})?$/i.test(trimmed);
}

function isAffirmative(text: string) {
  return /^(yes|yeah|yep|sure|ok|okay|please|send it|go ahead|do it|oui|d'accord|vas-y|svp)$/i.test(
    String(text || "").trim()
  );
}

function isQuoteDraftSendConfirmation(text: string) {
  return isAffirmative(text) || /^(send|send it|submit|confirm|confirmed|that's it|thats it|that is it|done|all set|yes send|yes please|oui envoyer|envoyer)$/i.test(
    String(text || "").trim()
  );
}

function isNegative(text: string) {
  return /^(no|no thanks|not now|don'?t|do not|cancel|non|pas maintenant)$/i.test(String(text || "").trim());
}

function priorAssistantOfferedItemRequest(messages: AssistantMessage[]) {
  return messages
    .slice()
    .reverse()
    .some(
      (message) =>
        message.role === "assistant" &&
        /send your request to our team|check the item|prepare a quote request|envoyer votre demande|vérifier l’article|preparer une demande de devis|préparer une demande de devis/i.test(
          message.content
        )
    );
}

function priorAssistantPresentedQuoteDraft(messages: AssistantMessage[]) {
  return messages
    .slice()
    .reverse()
    .some(
      (message) =>
        message.role === "assistant" &&
        /review this quote request|reply (?:yes|send)|send this to sales|vérifiez cette demande de devis|envoyer cette demande/i.test(
          message.content
        )
    );
}

function quoteDraftText(request: QuoteRequest, language: "en" | "fr" | "unknown") {
  const productLines = request.products.map((product, index) => {
    const sku = product.sku ? ` — SKU: ${product.sku}` : "";
    const quantity = product.quantity > 0 ? `${product.quantity} x ` : "";
    return `${index + 1}. ${quantity}${product.name || product.description || "Item"}${sku}`;
  });

  if (language === "fr") {
    return `Vérifiez cette demande de devis avant l’envoi:\n\nNom: ${request.name}\nCourriel: ${request.email}${request.company ? `\nEntreprise: ${request.company}` : ""}${request.phone ? `\nTéléphone: ${request.phone}` : ""}\n\nArticles:\n${productLines.join("\n")}\n\nRépondez “envoyer” pour l’envoyer aux ventes, ou envoyez un autre SKU, produit ou quantité pour ajouter/modifier la demande.`;
  }

  return `Please review this quote request before I send it:\n\nName: ${request.name}\nEmail: ${request.email}${request.company ? `\nCompany: ${request.company}` : ""}${request.phone ? `\nPhone: ${request.phone}` : ""}\n\nProducts:\n${productLines.join("\n")}\n\nReply “send” or “yes” to send this to sales, or send another SKU, product, or quantity to add/change the request.`;
}

function searchQueryForLatest(messages: AssistantMessage[], latest: string, products: CatalogProduct[]) {
  const inferred = inferSearchQuery(messages, products);
  const shouldUseContext =
    /\b(more|another|same|these|those|them|it|this|that|one|ones|compatible|fit|accessor|accessory|accessories)\b/i.test(latest) ||
    (products.length > 0 && /\b(price|cost|how much|piece|each|unit|single|box|boxes|pack|package|case|count|per box|per pack)\b/i.test(latest)) ||
    /\b(plus|autre|meme|même|ceci|cela|ceux|celles|compatible|accessoire|accessoires)\b/i.test(latest);

  if (shouldUseContext && inferred) return cleanProductQuery(inferred) || inferred;
  return cleanProductQuery(latest) || latest;
}

function availabilityText(product: CatalogProduct, language: "en" | "fr" | "unknown") {
  const availability = displayAvailability(product, language);
  const price = product.quoteOnly ? "requires a quote" : product.price ? `$${product.price.toFixed(2)}` : "price unavailable";
  const purchase =
    product.quoteOnly || !product.purchasable
      ? language === "fr"
        ? "Cet article nécessite un devis de notre équipe des ventes."
        : "This item requires a quotation from our sales team."
      : language === "fr"
        ? "Cet article peut être commandé en ligne."
        : "This item can be ordered online.";

  return language === "fr"
    ? `${product.name}\nSKU: ${product.sku}\nPrix: ${price}\nDisponibilité: ${availability}\n${purchase}\n\nVoir le produit: ${product.url}`
    : `${product.name}\nSKU: ${product.sku}\nPrice: ${price}\nAvailability: ${availability}\n${purchase}\n\nView product: ${product.url}`;
}

function productAvailabilityText(product: CatalogProduct) {
  return [product.availabilityDescription, product.availability].filter(Boolean).join(" ").toLowerCase();
}

function displayAvailability(product: CatalogProduct, language: "en" | "fr" | "unknown") {
  const raw =
    product.availabilityDescription ||
    product.availability ||
    (language === "fr" ? "disponibilité à confirmer" : "availability should be confirmed");
  if (language !== "fr") return raw;

  return raw
    .replace(/\bIn stock\b/gi, "En stock")
    .replace(/\bLow stock\b/gi, "Stock faible")
    .replace(/\bAvailable to order\b/gi, "Disponible sur commande")
    .replace(/\bExtended lead time\b/gi, "Délai prolongé")
    .replace(/\bOrder soon\b/gi, "Commandez bientôt")
    .replace(/\bTypically ships within 1-3 business days\b/gi, "Expédié généralement sous 1 à 3 jours ouvrables")
    .replace(/\btypically 5-9 business days\b/gi, "généralement 5 à 9 jours ouvrables")
    .replace(/\bavailable\b/gi, "disponible");
}

function sentenceFragment(value: string) {
  return value.replace(/[.。\s]+$/g, "");
}

function hasExtendedLeadTime(product: CatalogProduct) {
  return /\b(backorder|back order|extended lead|available to order|preorder|pre-order)\b/i.test(productAvailabilityText(product));
}

function isInStockProduct(product: CatalogProduct) {
  const availability = productAvailabilityText(product);
  if (/\b(out of stock|currently unavailable|not currently available|extended lead|backorder|back order)\b/i.test(availability)) {
    return false;
  }
  return /\b(in stock|low stock)\b/i.test(availability) || product.inventoryLevel > 0;
}

function normalizedProductTokens(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !/^(the|and|with|for|this|that|shop|all|box|pack|case|bulk|sterile|non|inch|in|ml|mm|cm|sku)$/.test(token));
}

function substituteSearchQuery(product: CatalogProduct) {
  return (product.parentName || product.name)
    .replace(/\s+-\s+.*/g, " ")
    .replace(/\bSKU\s*:?\s*[A-Z0-9+._/-]{3,40}\b/gi, " ")
    .replace(/\b[A-Z]{1,10}\s*-?\s*\d{3,}[A-Z0-9-]*\+?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim() || product.name;
}

function isCloseSubstitute(candidate: CatalogProduct, product: CatalogProduct) {
  if (candidate.sku && product.sku && normalizeSku(candidate.sku) === normalizeSku(product.sku)) return false;
  if (!candidate.purchasable || candidate.quoteOnly || !isInStockProduct(candidate)) return false;

  const baseParent = substituteSearchQuery(product).toLowerCase();
  const candidateParent = substituteSearchQuery(candidate).toLowerCase();
  if (baseParent && candidateParent && baseParent === candidateParent) return true;

  const baseTokens = new Set(normalizedProductTokens(`${product.parentName} ${product.name}`));
  const candidateTokens = new Set(normalizedProductTokens(`${candidate.parentName} ${candidate.name}`));
  const shared = Array.from(baseTokens).filter((token) => candidateTokens.has(token));
  const brandMatch = Boolean(
    (product.brand && candidate.brand && product.brand.toLowerCase() === candidate.brand.toLowerCase()) ||
      (product.manufacturer && candidate.manufacturer && product.manufacturer.toLowerCase() === candidate.manufacturer.toLowerCase())
  );

  return shared.length >= (brandMatch ? 2 : 3);
}

async function closeInStockSubstitutes(product: CatalogProduct, language: "en" | "fr" | "unknown") {
  if (!hasExtendedLeadTime(product)) return [];
  const result = await searchProducts({ query: substituteSearchQuery(product), language, limit: 10 });
  const seen = new Set<string>();
  return result.products
    .filter((candidate) => isCloseSubstitute(candidate, product))
    .filter((candidate) => {
      const key = normalizeSku(candidate.sku) || `${candidate.productId}:${candidate.variantId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

function substitutesText(substitutes: CatalogProduct[], language: "en" | "fr" | "unknown") {
  if (!substitutes.length) return "";
  const lines = substitutes.map((product, index) => {
    const price = product.price ? `$${product.price.toFixed(2)}` : language === "fr" ? "prix non disponible" : "price unavailable";
    const availability = sentenceFragment(displayAvailability(product, language));
    const link = language === "fr" ? "Voir le produit" : "View product";
    return `${index + 1}. **${product.name}** — SKU: ${product.sku} — ${price}. ${availability}. [${link}](${product.url})`;
  });
  const intro =
    language === "fr"
      ? "L’article original peut toujours être commandé. Si le délai est important, j’ai aussi trouvé ces options EMRN proches en stock:"
      : "The original item can still be ordered. If timing matters, I also found these close in-stock EMRN options:";
  return `\n\n${intro}\n\n${lines.join("\n")}`;
}

async function availabilityTextWithSubstitutes(product: CatalogProduct, language: "en" | "fr" | "unknown") {
  const text = availabilityText(product, language);
  const substitutes = await closeInStockSubstitutes(product, language);
  return `${text}${substitutesText(substitutes, language)}`;
}

function smartSearchResultsUrl(query: string) {
  const url = new URL("/search.php", process.env.EMRN_STORE_URL || "https://emrn.ca");
  url.searchParams.set("search_query", query);
  url.searchParams.set("emrn-smart-results", "1");
  return url.toString();
}

function productResultsText(
  products: CatalogProduct[],
  language: "en" | "fr" | "unknown",
  query: string,
  options: { includeFullSearchLink?: boolean } = {}
) {
  const shown = products.slice(0, 5);
  const lines = shown.map((product, index) => {
    const price = product.quoteOnly ? (language === "fr" ? "devis requis" : "quote required") : product.price ? `$${product.price.toFixed(2)}` : language === "fr" ? "prix non disponible" : "price unavailable";
    const availability = sentenceFragment(displayAvailability(product, language));
    const action = product.quoteOnly || !product.purchasable
      ? language === "fr"
        ? "Demander un devis"
        : "Request a quote"
      : language === "fr"
        ? "Peut être commandé en ligne"
        : "Can be ordered online";

    return language === "fr"
      ? `${index + 1}. **${product.name}** — SKU: ${product.sku || "non disponible"} — ${price}. ${availability}. ${action}. [Voir le produit](${product.url})`
      : `${index + 1}. **${product.name}** — SKU: ${product.sku || "unavailable"} — ${price}. ${availability}. ${action}. [View product](${product.url})`;
  });

  const kitQueryLabel = kitQuerySubject(query);
  const intro =
    isKitQuery(query) && !hasCompleteKitForQuery(shown, query)
      ? language === "fr"
        ? `Je ne vois pas de trousse complète ${kitQueryLabel ? `pour ${kitQueryLabel} ` : ""}dans les résultats EMRN. Voici des articles EMRN liés qui peuvent aider à composer une trousse :`
        : `I do not see a complete ${kitQueryLabel ? `${kitQueryLabel} ` : ""}kit in the EMRN results. Here are related EMRN items that may help build one:`
      : language === "fr"
        ? `Voici les produits que j’ai trouvés pour « ${query} » :`
        : `Here are the products I found for “${query}”:`;
  const outro =
    language === "fr"
      ? "Si vous me dites la taille, la marque, l’usage ou la quantité souhaitée, je peux réduire la liste ou vous aider à l’ajouter au panier."
      : "If you tell me the size, brand, use, or quantity you need, I can narrow this down or help add the right item to your cart.";
  const fullSearchLink =
    options.includeFullSearchLink && products.length > shown.length
      ? language === "fr"
        ? `\n\n[Voir tous les résultats EMRN](${smartSearchResultsUrl(query)})`
        : `\n\n[View all matching EMRN products](${smartSearchResultsUrl(query)})`
      : "";

  return `${intro}\n\n${lines.join("\n")}${fullSearchLink}\n\n${outro}`;
}

function productIntentText(product: CatalogProduct) {
  return normalizeSearchText(
    [
      product.name,
      product.parentName,
      product.sku,
      product.brand,
      product.manufacturer,
      product.categories.join(" "),
      product.description,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function productNameCategoryText(product: CatalogProduct) {
  return normalizeSearchText(
    [
      product.name,
      product.parentName,
      product.sku,
      product.brand,
      product.manufacturer,
      product.categories.join(" "),
    ]
      .filter(Boolean)
      .join(" ")
  );
}

type ProductIntentRequirement = {
  terms: string[];
  field?: "any" | "name_category";
};

function explicitProductTypeGroups(query: string): ProductIntentRequirement[] {
  const normalized = normalizeSearchText(query);
  const groups: ProductIntentRequirement[] = [];

  if (/\b(?:replacement|spare|replica|part|parts|remplacement|pi[eè]ce|pi[eè]ces)\b/.test(normalized) && /\b(?:blade|blades|lame|lames)\b/.test(normalized)) {
    groups.push({ terms: ["blade", "blades", "lame", "lames", "cutting blade", "replacement blade"], field: "name_category" });
  }

  if (/\b(posters?|charts?|diagrams?|reference image|anatomy image|anatomical chart)\b/.test(normalized)) {
    groups.push({ terms: ["poster", "posters", "chart", "charts", "diagram"], field: "name_category" });
  }
  if (/\b(face|facial|visage)\b/.test(normalized) && /\b(vessels?|vascular|arter(?:y|ies)|veins?|vaisseaux?|sanguins?|nerfs?)\b/.test(normalized)) {
    groups.push({ terms: ["blood vessel", "blood vessels", "vessel", "vessels", "vascular", "artery", "arteries", "vein", "veins", "pathway", "pathways"], field: "name_category" });
  }
  if (/\b(otoscope|otoscopes|ear scope|ear scopes|inside ears?|earwax|ear wax)\b/.test(normalized)) {
    groups.push({ terms: ["otoscope", "otoscopes", "ri-scope", "ear scope"], field: "name_category" });
  }
  if (/\b(nitrile|latex|vinyl|exam)\b/.test(normalized) && /\b(gloves?|gants?)\b/.test(normalized)) {
    groups.push({ terms: ["glove", "gloves"], field: "name_category" });
  }
  if (/\b(cushion|cushions|lumbar support)\b/.test(normalized)) {
    groups.push({ terms: ["cushion", "cushions", "lumbar"], field: "name_category" });
  }
  if (/\b(blood pressure cuff|bp cuff|nibp cuff|cuff|cuffs)\b/.test(normalized)) {
    groups.push({ terms: ["cuff", "cuffs", "nibp", "blood pressure"], field: "name_category" });
  }
  if (/\b(backpack|backpacks|medical bag|medic bag|ems bag|trauma bag)\b/.test(normalized)) {
    groups.push({ terms: ["backpack", "backpacks", "bag", "bags"], field: "name_category" });
  }
  if (/\b(first aid)\b/.test(normalized) && /\b(posters?|charts?)\b/.test(normalized)) {
    groups.push({ terms: ["first aid"], field: "name_category" });
  }

  return groups;
}

function productsMatchingExplicitIntent(products: CatalogProduct[], latest: string, searchQuery: string) {
  const groups = explicitProductTypeGroups(`${latest} ${searchQuery}`);
  if (!groups.length && !isReplacementPartRequest(`${latest} ${searchQuery}`)) return { products, suppressed: false };

  const matching = products.filter((product) => {
    const haystack = productIntentText(product);
    const nameCategory = productNameCategoryText(product);
    return groups.every((group) => {
      const target = group.field === "name_category" ? nameCategory : haystack;
      return group.terms.some((term) => target.includes(normalizeSearchText(term)));
    }) && isExactReplacementPartProductMatch(product, `${latest} ${searchQuery}`);
  });

  if (matching.length) return { products: matching, suppressed: false };
  return { products: [] as CatalogProduct[], suppressed: true };
}

function isReplacementPartRequest(text: string) {
  return /\b(?:replacement|spare|remplacement|parts?|pi[eè]ce?s?)\b/i.test(text);
}

function isExactReplacementPartProductMatch(product: CatalogProduct, query: string) {
  if (!isReplacementPartRequest(query)) return true;
  const text = productIntentText(product);
  const requestedType = requestedProductTypeKey(query);
  if (requestedType === "blade" && !/\b(?:blade|blades|lame|lames)\b/i.test(text)) return false;

  const referenceCandidates = extractSkuCandidates(query);
  if (!referenceCandidates.length) return true;
  const compactProductText = text.replace(/[^a-z0-9]/gi, "");
  return referenceCandidates.some((reference) => {
    const compactReference = normalizeSku(reference);
    return compactReference.length >= 4 && compactProductText.includes(compactReference);
  });
}

async function recoverExplicitIntentProducts(latest: string, searchQuery: string, language: AssistantLanguage) {
  const smartQuery = await buildSmartSearchQuery(latest);
  const retryQueries = Array.from(
    new Set(
      [
        ...assistantRecoveryQueries(latest),
        smartQuery.search_query,
        smartQuery.translated_query,
        ...(smartQuery.assisted_queries || []),
        ...(smartQuery.fallback_terms || []),
        searchQuery,
      ]
        .map((query) => String(query || "").trim())
        .filter((query) => query && normalizeSearchText(query) !== normalizeSearchText(latest))
    )
  ).slice(0, 8);

  for (const query of retryQueries) {
    const retryResult = await searchProducts({ query, language, limit: 8 });
    const filtered = productsMatchingExplicitIntent(retryResult.products, latest, query);
    if (filtered.products.length) {
      return {
        products: filtered.products,
        searchQuery: query,
        timings: retryResult.timings,
        attemptedQueries: retryQueries,
      };
    }
  }

  return {
    products: [] as CatalogProduct[],
    searchQuery,
    timings: undefined,
    attemptedQueries: retryQueries,
  };
}

function assistantRecoveryQueries(query: string) {
  const normalized = normalizeSearchText(query);
  const queries: string[] = [];

  if (
    /\b(face|facial|visage)\b/.test(normalized) &&
    /\b(vessels?|vascular|arter(?:y|ies)|veins?|blood vessels?|vaisseaux?|sanguins?|nerfs?)\b/.test(normalized) &&
    /\b(posters?|charts?|diagram|reference|clinic|clinique|anatomy|anatomical|affiche|affiches|tableau|schema)\b/.test(normalized)
  ) {
    queries.push("face blood vessels anatomy poster chart", "blood vessel nerve pathways chart", "clinically important blood vessel and nerve pathways chart");
  }

  if (/\b(gants?|gloves?)\b/.test(normalized) && /\b(latex|nitrile|vinyl)\b/.test(normalized)) {
    const material = normalized.match(/\b(latex|nitrile|vinyl)\b/)?.[1] || "exam";
    const sizeMatch = normalized.match(/\b(xs|small|medium|large|xl|x-large|extra large|petit(?:e|s|es)?|moyen(?:ne|s|nes)?|grand(?:e|s|es)?)\b/)?.[1] || "";
    const colorMatch = normalized.match(/\b(blue|black|purple|white|green|pink|bleu(?:e|s|es)?|noir(?:e|s|es)?|blanc(?:he|s|hes)?)\b/)?.[1] || "";
    const sizeMap: Record<string, string> = {
      petite: "small",
      petit: "small",
      petites: "small",
      petits: "small",
      moyen: "medium",
      moyenne: "medium",
      moyens: "medium",
      moyennes: "medium",
      grand: "large",
      grande: "large",
      grands: "large",
      grandes: "large",
    };
    const colorMap: Record<string, string> = {
      bleu: "blue",
      bleue: "blue",
      bleus: "blue",
      bleues: "blue",
      noir: "black",
      noire: "black",
      noirs: "black",
      noires: "black",
      blanc: "white",
      blanche: "white",
      blancs: "white",
      blanches: "white",
    };
    const size = sizeMap[sizeMatch] || sizeMatch;
    const color = colorMap[colorMatch] || colorMatch;
    queries.push([material, "exam gloves", color, size].filter(Boolean).join(" "));
    queries.push(["gloves", color, size].filter(Boolean).join(" "));
  }

  return queries;
}

function autoKeywordMemoryId(query: string) {
  const normalized = normalizeSearchText(query).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `ai-keyword-${normalized.slice(0, 80) || crypto.randomUUID()}`;
}

function shouldUseAiKeywordRecovery(input: {
  latest: string;
  skuCandidates: string[];
  taughtQuoteIntent: boolean;
  taughtOrderStatusIntent: boolean;
  taughtContactIntent: boolean;
  taughtAvailabilityIntent: boolean;
}) {
  if (input.skuCandidates.length) return false;
  if (isQuoteIntent(input.latest) || input.taughtQuoteIntent) return false;
  if (isOrderStatusIntent(input.latest) || input.taughtOrderStatusIntent) return false;
  if (isContactIntent(input.latest) || input.taughtContactIntent) return false;
  if (isCartIntent(input.latest)) return false;
  if (isAvailabilityIntent(input.latest) || input.taughtAvailabilityIntent) return false;
  if (assistantRecoveryQueries(input.latest).length) return true;
  return isProductSearchIntent(input.latest) || looksLikeSpecificProductSearch(input.latest) || looksLikePlainCatalogKeywordSearch(input.latest);
}

function isKitQuery(query: string) {
  const normalized = normalizeSearchText(query);
  return /\b(kits?|trousse|trousses)\b/.test(normalized);
}

function kitQuerySubject(query: string) {
  const normalized = normalizeSearchText(query)
    .replace(/\b(kits?|trousse|trousses)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized;
}

function kitQueryTokens(query: string) {
  return kitQuerySubject(query)
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !/^(medical|supplies|supply|product|products|item|items|for|with|and|the|pour|avec|les|des)$/.test(token))
    .slice(0, 6);
}

function hasCompleteKitForQuery(products: CatalogProduct[], query: string) {
  const tokens = kitQueryTokens(query);
  return products.some((product) => {
    const productNameText = normalizeSearchText([product.name, product.parentName].join(" "));
    const text = normalizeSearchText([product.name, product.parentName, product.description, product.categories.join(" ")].join(" "));
    const nameHasKit = /\b(kits?|trousse|trousses)\b/.test(productNameText);
    const textHasRealKitPhrase = /\b(first aid|nursing|trauma|simulation|moulage|diagnostic|emergency|medical|training|manikin|airway|cpr|aed|oxygen|phlebotomy)\s+(kits?|trousse|trousses)\b/.test(text);
    const onlyPackageCodeKit = /\b(BT|BX|BOX|PK|PACK|CS|CASE)\s*\/\s*KIT\b/i.test([product.name, product.description].join(" "));
    if (!/\b(kits?|trousse|trousses)\b/.test(text)) return false;
    if (!nameHasKit && !textHasRealKitPhrase) return false;
    if (onlyPackageCodeKit && !nameHasKit) return false;
    if (/\b(replacement|replacements|skin and vein|repackaging|refill|parts?|accessor(?:y|ies)|not for human|training purposes only)\b/.test(text)) return false;
    if (!tokens.length) return true;
    return tokens.some((token) => text.includes(token));
  });
}

function rankKitProducts(products: CatalogProduct[], query: string) {
  const tokens = kitQueryTokens(query);
  const isPhlebotomy = tokens.includes("phlebotomy") || tokens.includes("venipuncture");
  const score = (product: CatalogProduct) => {
    const nameText = normalizeSearchText([product.name, product.parentName].join(" "));
    const categoryText = normalizeSearchText(product.categories.join(" "));
    const text = normalizeSearchText([product.name, product.parentName, product.description, product.categories.join(" "), product.sku].join(" "));
    let value = 0;
    const tokenMatches = tokens.reduce((sum, token) => sum + (text.includes(token) ? 1 : 0), 0);
    const nameTokenMatches = tokens.reduce((sum, token) => sum + (nameText.includes(token) ? 1 : 0), 0);
    const categoryTokenMatches = tokens.reduce((sum, token) => sum + (categoryText.includes(token) ? 1 : 0), 0);

    value += tokenMatches * 700;
    value += nameTokenMatches * 1200;
    value += categoryTokenMatches * 350;
    if (/\b(kits?|trousse|trousses)\b/.test(text)) value += 350;
    if (tokens.length && tokenMatches === 0) value -= 1000;
    if (isPhlebotomy && /\b(arm wedge|task trainer|training arm|tote caddy|sharps collector|sharps container|blood collection|multi sample needle)\b/.test(text)) value += 650;
    if (isPhlebotomy && text.includes("venipuncture")) value += 350;
    if (isPhlebotomy && /\bneedle|needles\b/.test(nameText) && !nameText.includes("phlebotomy")) value -= 450;
    if (/\b(replacement|skin and vein|iv hand replacement|veins only|vaccine|mmr|repackaging|geri|keri|refill|accessory only)\b/.test(text)) value -= 900;
    if (text.includes("not for human or animal use")) value -= 100;
    return value;
  };
  return [...products].sort((a, b) => score(b) - score(a));
}

const colorTerms = [
  "black",
  "blue",
  "brown",
  "clear",
  "gray",
  "green",
  "grey",
  "orange",
  "pink",
  "purple",
  "red",
  "silver",
  "tan",
  "white",
  "yellow",
  "bleu",
  "noir",
  "noire",
  "orange",
  "rouge",
  "vert",
  "verte",
  "jaune",
  "gris",
  "grise",
  "blanc",
  "blanche",
];

function requestedColorFromText(text: string) {
  const normalized = String(text || "").toLowerCase();
  return colorTerms.find((color) => new RegExp(`\\b${escapeRegExp(color)}\\b`, "i").test(normalized)) || "";
}

function stripColorFromQuery(text: string, color: string) {
  return String(text || "")
    .replace(new RegExp(`\\b${escapeRegExp(color)}\\b`, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

function colorAliases(color: string) {
  const normalized = color.toLowerCase();
  const aliases: Record<string, string[]> = {
    bleu: ["bleu", "blue"],
    noir: ["noir", "black"],
    noire: ["noire", "black"],
    rouge: ["rouge", "red"],
    vert: ["vert", "green"],
    verte: ["verte", "green"],
    jaune: ["jaune", "yellow"],
    gris: ["gris", "gray", "grey"],
    grise: ["grise", "gray", "grey"],
    blanc: ["blanc", "white"],
    blanche: ["blanche", "white"],
    blue: ["blue", "bleu"],
    black: ["black", "noir", "noire"],
    red: ["red", "rouge"],
    green: ["green", "vert", "verte"],
    yellow: ["yellow", "jaune"],
    gray: ["gray", "grey", "gris", "grise"],
    grey: ["grey", "gray", "gris", "grise"],
    white: ["white", "blanc", "blanche"],
  };
  return aliases[normalized] || [normalized];
}

function productMentionsColor(product: CatalogProduct, color: string) {
  if (!color) return false;
  const text = `${product.name} ${product.description} ${product.sku}`;
  return colorAliases(color).some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(text));
}

function meaningfulColorFallbackTokens(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !/^(and|for|the|with|need|want|show|find|product|item|color|colour|couleur)$/.test(token));
}

function looksRelevantToColorFallback(product: CatalogProduct, strippedQuery: string) {
  const tokens = meaningfulColorFallbackTokens(strippedQuery);
  if (!tokens.length) return false;
  const haystack = `${product.name} ${product.parentName} ${product.sku} ${product.brand} ${product.manufacturer}`.toLowerCase();
  const matched = tokens.filter((token) => haystack.includes(token));
  return matched.length >= Math.min(2, tokens.length);
}

async function colorFallbackSearch({
  latest,
  searchQuery,
  products,
  language,
}: {
  latest: string;
  searchQuery: string;
  products: CatalogProduct[];
  language: "en" | "fr" | "unknown";
}) {
  const requestedColor = requestedColorFromText(`${latest} ${searchQuery}`);
  if (!requestedColor) return null;

  const baseQuery = new RegExp(`\\b${escapeRegExp(requestedColor)}\\b`, "i").test(searchQuery) ? searchQuery : latest;
  const strippedQuery = stripColorFromQuery(baseQuery || latest, requestedColor);
  if (!strippedQuery || strippedQuery === baseQuery) return null;
  if (products.some((product) => productMentionsColor(product, requestedColor) && looksRelevantToColorFallback(product, strippedQuery))) {
    return null;
  }

  const fallback = await searchProducts({ query: strippedQuery, language, limit: 8 });
  const fallbackProducts = fallback.products.filter((product) => looksRelevantToColorFallback(product, strippedQuery));
  if (!fallbackProducts.length) return null;

  return {
    requestedColor,
    strippedQuery,
    products: fallbackProducts,
  };
}

function rankRequestedColorProducts(products: CatalogProduct[], text: string) {
  const requestedColor = requestedColorFromText(text);
  if (!requestedColor) return products;

  return [...products].sort((a, b) => {
    const aMatch = productMentionsColor(a, requestedColor) ? 1 : 0;
    const bMatch = productMentionsColor(b, requestedColor) ? 1 : 0;
    return bMatch - aMatch;
  });
}

function missingRequestedColorProducts(products: CatalogProduct[], text: string) {
  const requestedColor = requestedColorFromText(text);
  if (!requestedColor) return null;
  const strippedQuery = stripColorFromQuery(text, requestedColor);
  const relevantProducts = products.filter((product) => looksRelevantToColorFallback(product, strippedQuery));
  if (!relevantProducts.length) return null;
  if (relevantProducts.some((product) => productMentionsColor(product, requestedColor))) return null;
  return {
    requestedColor,
    strippedQuery,
    products: relevantProducts,
  };
}

function colorFallbackText(products: CatalogProduct[], requestedColor: string, language: "en" | "fr" | "unknown", query: string) {
  const lines = products.slice(0, 5).map((product, index) => {
    const price = product.quoteOnly ? (language === "fr" ? "devis requis" : "quote required") : product.price ? `$${product.price.toFixed(2)}` : language === "fr" ? "prix non disponible" : "price unavailable";
    const availability = sentenceFragment(displayAvailability(product, language));
    const link = language === "fr" ? "Voir le produit" : "View product";
    return `${index + 1}. **${product.name}** — SKU: ${product.sku || "unavailable"} — ${price}. ${availability}. [${link}](${product.url})`;
  });

  const article = /^[aeiou]/i.test(requestedColor) ? "an" : "a";

  return language === "fr"
    ? `Je ne vois pas l’option ${requestedColor} pour « ${query} » dans les produits EMRN récupérés. Voici les options proches disponibles:\n\n${lines.join("\n")}\n\nJe peux aussi envoyer une demande à l’équipe EMRN pour vérifier si cette couleur peut être obtenue.`
    : `I do not see ${article} ${requestedColor} option for “${query}” in the EMRN products I found. Available close options:\n\n${lines.join("\n")}\n\nI can also send a request to EMRN to check whether that color can be sourced.`;
}

function packageInfo(product: CatalogProduct) {
  const text = [product.name, product.description].filter(Boolean).join("\n");
  const packageCode = text.match(/\b(BT|BX|BOX|PK|PACK|CS|CASE)\s*\/\s*(\d{1,5})\b/i);
  if (packageCode?.[1] && packageCode[2]) {
    const code = packageCode[1].toUpperCase();
    const count = packageCode[2];
    if (/^(BT|BX|BOX)$/.test(code)) return `box of ${count}`;
    if (/^(PK|PACK)$/.test(code)) return `pack of ${count}`;
    if (/^(CS|CASE)$/.test(code)) return `case of ${count}`;
  }
  const reversePackageCode = text.match(/\b(\d{1,5})\s*(?:\/|per)\s*(BT|BX|BOX|PK|PACK|PKG|CS|CASE)\b/i);
  if (reversePackageCode?.[1] && reversePackageCode[2]) {
    const count = reversePackageCode[1];
    const code = reversePackageCode[2].toUpperCase();
    if (/^(BT|BX|BOX)$/.test(code)) return `box of ${count}`;
    if (/^(PK|PACK|PKG)$/.test(code)) return `pack of ${count}`;
    if (/^(CS|CASE)$/.test(code)) return `case of ${count}`;
  }
  const namedPackageCode = text.match(/\b(\d{1,5})\s*(?:pkg|pkgs|pack|packs|box|boxes|case|cases)\b/i);
  if (namedPackageCode?.[1] && namedPackageCode[0]) {
    const count = namedPackageCode[1];
    const label = namedPackageCode[0].toLowerCase();
    if (/\bpkg|pack/.test(label)) return `pack of ${count}`;
    if (/\bbox/.test(label)) return `box of ${count}`;
    if (/\bcase/.test(label)) return `case of ${count}`;
  }
  const patterns = [
    /\bbox\s+of\s+(\d{1,5})\b/i,
    /\bpack\s+of\s+(\d{1,5})\b/i,
    /\bcase\s+of\s+(\d{1,5})\b/i,
    /\b(\d{1,5})\s*(?:count|ct)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0].replace(/\s+/g, " ").trim();
  }
  return "";
}

function displayPackageInfo(product: CatalogProduct, language: "en" | "fr" | "unknown") {
  const pack = packageInfo(product);
  if (language !== "fr") return pack;
  const match = pack.match(/\b(box|pack|case)\s+of\s+(\d{1,5})\b/i);
  if (!match) return pack;
  const count = match[2];
  const label = match[1].toLowerCase() === "box" ? "boîte" : match[1].toLowerCase() === "case" ? "caisse" : "paquet";
  return `${label} de ${count}`;
}

function packageCount(product: CatalogProduct) {
  const pack = packageInfo(product);
  return Number(pack.match(/\b(?:box|pack|case)\s+of\s+(\d{1,5})\b/i)?.[1] || 0);
}

function packageContainer(product: CatalogProduct, quantity: number) {
  const pack = packageInfo(product);
  const container = pack.match(/\b(box|pack|case)\s+of\s+\d{1,5}\b/i)?.[1]?.toLowerCase() || "";
  if (!container) return "";
  return quantity === 1 ? container : `${container}es`.replace("packes", "packs").replace("casees", "cases");
}

function productUnitName(product: CatalogProduct, total: number, language: "en" | "fr" | "unknown") {
  const text = `${product.name} ${product.description}`.toLowerCase();
  const frenchUnits: Record<string, [string, string]> = {
    syringe: ["seringue", "seringues"],
    needle: ["aiguille", "aiguilles"],
    glove: ["gant", "gants"],
    dressing: ["pansement", "pansements"],
    mask: ["masque", "masques"],
    pad: ["compresse", "compresses"],
    pair: ["paire", "paires"],
    strip: ["bandelette", "bandelettes"],
  };
  const unit = [
    ["syringe", "syringes"],
    ["needle", "needles"],
    ["glove", "gloves"],
    ["dressing", "dressings"],
    ["mask", "masks"],
    ["pad", "pads"],
    ["pair", "pairs"],
    ["strip", "strips"],
  ].find(([singular, plural]) => text.includes(singular) || text.includes(plural));
  if (!unit) return language === "fr" ? total === 1 ? "unité" : "unités" : total === 1 ? "unit" : "units";
  if (language === "fr") {
    const french = frenchUnits[unit[0]];
    return total === 1 ? french[0] : french[1];
  }
  return total === 1 ? unit[0] : unit[1];
}

function totalUnitsText(product: CatalogProduct, quantity: number, language: "en" | "fr" | "unknown") {
  const count = packageCount(product);
  if (!count || quantity <= 0) return "";
  const total = count * quantity;
  const container = packageContainer(product, quantity);
  const unit = productUnitName(product, total, language);
  if (!container) return "";
  if (language === "fr") {
    const frenchContainer = container
      .replace(/^boxes$/, "boîtes")
      .replace(/^box$/, "boîte")
      .replace(/^packs$/, "paquets")
      .replace(/^pack$/, "paquet")
      .replace(/^cases$/, "caisses")
      .replace(/^case$/, "caisse");
    return `${quantity} ${frenchContainer} / ${total} ${unit} au total`;
  }
  return `${quantity} ${container} / ${total} total ${unit}`;
}

function packagePriceText(product: CatalogProduct, pack: string, language: "en" | "fr" | "unknown") {
  const price = product.price ? `$${product.price.toFixed(2)}` : language === "fr" ? "prix non disponible" : "price unavailable";
  if (language === "fr") return `Le prix affiché est pour ${pack}, pas pour une seule unité. Prix: ${price}.`;
  return `The listed price is for the ${pack}, not a single piece. Price: ${price}.`;
}

function packageQuantityText(pack: string, language: "en" | "fr" | "unknown") {
  const count = Number(pack.match(/\b(?:box|pack|case|boîte|paquet|caisse)\s+(?:of|de)\s+(\d{1,5})\b/i)?.[1] || 0);
  if (!count) return language === "fr" ? `Conditionnement: ${pack}` : `Package/quantity: ${pack}`;
  if (language === "fr") return `Vendu comme ${pack}; cela contient ${count} unités.`;
  return `Sold as ${pack}; it contains ${count} units.`;
}

function looksLikePackageCode(value: string) {
  return /^(?:BT|BX|BOX|PK|PACK|CS|CASE)\s*\/\s*\d{1,5}$/i.test(String(value || "").trim());
}

function soldByInfo(product: CatalogProduct) {
  const values = [
    valueAfterLabel(product.description || "", "Sold By"),
    valueAfterLabel(product.description || "", "Manufacturer") ||
    product.manufacturer ||
      product.brand,
  ];
  return values.map((value) => String(value || "").trim()).find((value) => value && !looksLikePackageCode(value)) || "";
}

function cartSummaryLines(cartProducts: Array<{ product: CatalogProduct; quantity: number }>, language: "en" | "fr" | "unknown") {
  return cartProducts.slice(0, 8).map(({ product, quantity }, index) => {
    const pack = displayPackageInfo(product, language);
    const units = totalUnitsText(product, quantity, language);
    const packText = pack
      ? language === "fr"
        ? `; vendu comme ${pack}`
        : `; sold as ${pack}`
      : "";
    const unitsText = units ? `; ${units}` : "";
    return `${index + 1}. ${quantity} x ${product.name} (SKU: ${product.sku})${packText}${unitsText}`;
  });
}

function exactProductFoundText(product: CatalogProduct, language: "en" | "fr" | "unknown", query: string, includeNextAction = true) {
  const price = product.quoteOnly
    ? language === "fr"
      ? "devis requis"
      : "quote required"
    : product.price
      ? `$${product.price.toFixed(2)}`
      : language === "fr"
        ? "prix non disponible"
        : "price unavailable";
  const availability = displayAvailability(product, language);
  const purchaseAction =
    product.quoteOnly || !product.purchasable
      ? language === "fr"
        ? "Cet article nécessite un devis de notre équipe des ventes. Voulez-vous que je prépare une demande de devis?"
        : "This item requires a quotation from our sales team. Would you like me to prepare a quote request?"
      : language === "fr"
        ? "Voulez-vous que je l’ajoute au panier?"
        : "Would you like me to add it to your cart?";

  const foundText = language === "fr"
    ? `J’ai trouvé cet article pour « ${query} »:\n\n- **${product.name}** — SKU: ${product.sku || "non disponible"} — ${price}. ${availability}. [Voir le produit](${product.url})`
    : `I found this item for “${query}”:\n\n- **${product.name}** — SKU: ${product.sku || "unavailable"} — ${price}. ${availability}. [View product](${product.url})`;

  return includeNextAction ? `${foundText}\n\n${purchaseAction}` : foundText;
}

function cartReadyText(
  itemCount: number,
  lineItems: Array<{ productId: number; variantId?: number; quantity: number }>,
  language: "en" | "fr" | "unknown",
  cartProducts: Array<{ product: CatalogProduct; quantity: number }> = [],
  cartUrl = "https://emrn.ca/cart.php",
  browserLineItems = lineItems
) {
  const token = cartItemsToken(browserLineItems);
  const storeCartUrl = "https://emrn.ca/cart.php";
  const checkoutText =
    cartUrl && !/\/cart(?:\.php)?(?:[?#]|$)/i.test(cartUrl)
      ? language === "fr"
        ? `\nLien de paiement direct: ${cartUrl}`
        : `\nDirect checkout link: ${cartUrl}`
      : "";
  const summary = cartProducts.length
    ? `\n\n${language === "fr" ? "Panier:" : "Cart:"}\n${cartSummaryLines(cartProducts, language).join("\n")}`
    : "";
  if (language === "fr") {
    return itemCount > 1
      ? `J’ai ajouté ces articles au panier.${summary}\n\nVous pouvez continuer à chercher d’autres articles ici, ou ouvrir votre panier quand vous êtes prêt: ${storeCartUrl}${checkoutText}${token}`
      : `J’ai ajouté l’article au panier.${summary}\n\nVous pouvez continuer à chercher d’autres articles ici, ou ouvrir votre panier quand vous êtes prêt: ${storeCartUrl}${checkoutText}${token}`;
  }

  return itemCount > 1
    ? `I added those items to your cart.${summary}\n\nYou can keep looking for more items here, or open your cart when you’re ready: ${storeCartUrl}${checkoutText}${token}`
    : `I added the item to your cart.${summary}\n\nYou can keep looking for more items here, or open your cart when you’re ready: ${storeCartUrl}${checkoutText}${token}`;
}

function quoteSplitText(blockedProducts: CatalogProduct[], language: "en" | "fr" | "unknown") {
  if (!blockedProducts.length) return "";
  const lines = blockedProducts.slice(0, 5).map((product, index) => `${index + 1}. ${product.name} (SKU: ${product.sku})`);
  return language === "fr"
    ? `\n\nCes articles ne peuvent pas être ajoutés au panier en ligne et nécessitent un devis:\n${lines.join("\n")}\n\nEnvoyez-moi votre nom et courriel si vous voulez que je prépare la demande de devis.`
    : `\n\nThese items could not be added to the online cart and need a quote:\n${lines.join("\n")}\n\nSend me your name and email if you want me to prepare the quote request.`;
}

function valueAfterLabel(text: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    text.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\n\\s*([^\\n]+)`, "i"))?.[1]?.trim() ||
    text.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:?\\s+([^\\n]+)`, "i"))?.[1]?.trim() ||
    ""
  );
}

function sentenceContaining(text: string, pattern: RegExp) {
  const cleaned = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const sentenceMatch = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .find((sentence) => pattern.test(sentence))
    ?.replace(/\s+/g, " ");
  if (!sentenceMatch) return "";
  if (sentenceMatch.length <= 220) return sentenceMatch;

  const matchIndex = sentenceMatch.search(pattern);
  if (matchIndex < 0) return sentenceMatch.slice(0, 220);
  const start = Math.max(0, matchIndex - 90);
  const end = Math.min(sentenceMatch.length, matchIndex + 150);
  const snippet = sentenceMatch.slice(start, end).trim();
  return `${start > 0 ? "..." : ""}${snippet}${end < sentenceMatch.length ? "..." : ""}`;
}

function productCapabilityEvidence(text: string, question: string) {
  const cleaned = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  const questionTerms = capabilityQuestionTerms(question);
  const capabilityPattern = /\b(hold|holds|holding|carry|carries|carrying|accommodate|accommodates|fit|fits|support|supports|include|includes|come with|comes with|have|has|mount|mounts|attach|attaches|connect|connects|compatible|waterproof|water-resistant|sterile|latex|oxygen|o2|tank|cylinder|compartment|pocket|pouch|strap|sleeve|holder)\b/i;
  const candidates = cleaned
    .split(/(?<=[.!?])\s+|(?:\s{2,})|(?:\s[-•]\s)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const best = candidates
    .map((sentence) => ({
      sentence,
      overlap: questionTerms.reduce((sum, term) => sum + (sentence.toLowerCase().includes(term) ? 1 : 0), 0),
      score:
        (capabilityPattern.test(sentence) ? 6 : 0) +
        questionTerms.reduce((sum, term) => sum + (sentence.toLowerCase().includes(term) ? 2 : 0), 0),
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best || best.score < 6 || best.overlap === 0) return "";
  if (best.sentence.length <= 220) return best.sentence;
  const focusPattern = questionTerms.length ? new RegExp(questionTerms.map(escapeRegExp).join("|"), "i") : capabilityPattern;
  return sentenceContaining(best.sentence, focusPattern);
}

function oxygenStorageEvidence(text: string) {
  const cleaned = String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    cleaned.match(/\b(?:accommodates?|holds?|carries?|fits?|stores?)\s+[^.]{0,140}?(?:oxygen|o2)\s+(?:tank|cylinder)\b/i)?.[0]?.trim() ||
    cleaned.match(/\b(?:oxygen|o2)\s+(?:tank|cylinder)[^.]{0,140}?\b(?:compartment|pocket|holder|sleeve|strap|storage|carrier)\b/i)?.[0]?.trim() ||
    cleaned.match(/\b(?:compartment|pocket|holder|sleeve|strap|storage|carrier)[^.]{0,140}?\b(?:oxygen|o2)\s+(?:tank|cylinder)\b/i)?.[0]?.trim() ||
    cleaned.match(/\b(?:M6|D|E)\s+(?:oxygen\s*)?(?:tank|cylinder)[^.]{0,140}?\b(?:fits?|accommodates?|holds?|carries?|stores?|compartment|pocket|holder|sleeve|strap)\b/i)?.[0]?.trim()
  );
}

function capabilityQuestionTerms(question: string) {
  const stop = new Set([
    "can", "does", "do", "will", "would", "is", "are", "this", "that", "these", "those", "product", "item",
    "the", "a", "an", "with", "for", "and", "or", "it", "its", "sku", "peut", "peuvent", "est", "que",
    "ce", "cet", "cette", "ces", "produit", "article", "avec", "pour", "les", "des", "une", "un",
  ]);
  return Array.from(new Set(
    String(question || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3 && !stop.has(term) && !/^\d+$/.test(term) && !/^[a-z]?\d+[a-z0-9]*$/.test(term))
  )).slice(0, 8);
}

function productDetailFromCatalog(product: CatalogProduct, question: string, language: "en" | "fr" | "unknown") {
  const text = product.description || "";
  const normalizedQuestion = question.toLowerCase();
  const wantsSize = /\b(how\s+big|how\s+large|what\s+size|size|dimension|dimensions|measurement|measurements|height|width|depth|length|capacity)\b/i.test(question);
  const wantsDescription = /\b(description|details?|overview|specs?|specifications?|features?|what\s+is\s+it|tell\s+me\s+about|what\s+does\s+it\s+include|included|includes|include|comes?\s+with|décris|decris|description|détails?|details?|aperçu|apercu|spécifications?|specifications?|caractéristiques?|caracteristiques?|inclus|comprend)\b/i.test(question);
  const wantsColor = /\b(color|colour|couleur)\b/i.test(question);
  const wantsPrice = /\b(how\s+much|price|cost|prix)\b/i.test(question);
  const wantsAvailability = /\b(availability|available|in stock|stock|ships|lead time)\b/i.test(question);
  const wantsPackage = /\b(how\s+many|box|boxes|pack|package|case|count|quantity|quantities|qty|sold by|sold as|unit of sale|per box|per pack|quantit[eé]|vendu comme|vendu par)\b/i.test(question);
  const wantsPackagePrice = wantsPrice && /\b(piece|each|unit|single|box|boxes|pack|package|case|per)\b/i.test(question);
  const wantsSoldBy = /\b(who\s+makes|who\s+sells|sold\s+by|manufacturer|brand)\b/i.test(question);
  const wantsOxygenStorage = /\b(hold|holds|holding|carry|carries|carrying|accommodate|accommodates|fit|fits|oxygen tank|oxygen cylinder|o2 tank|o2 cylinder|tank|cylinder|réservoir d.oxygène|reservoir d.oxygene|cylindre d.oxygène|cylindre d.oxygene|oxygène|oxygene)\b/i.test(question) &&
    /\b(oxygen|o2|tank|cylinder|oxygène|oxygene|réservoir|reservoir|cylindre)\b/i.test(question);
  const wantsCapability = isProductCapabilityIntent(question);
  const specificCapabilityPattern =
    /\b(latex|latex-free|latex free|material|materials|made of|disposable|reusable|single-use|single use|clean|cleaned|wash|washed|disinfect|disinfected|autoclave|autoclaved|sterilize|sterilized|sterilise|sterilised|sans latex|matériau|materiau|jetable|réutilisable|reutilisable|nettoyer|lavable|désinfecter|desinfecter|stériliser|steriliser)\b/i;
  const lines: string[] = [];

  const pack = displayPackageInfo(product, language);

  if (wantsPackagePrice && pack) {
    lines.push(packagePriceText(product, pack, language));
  } else if (wantsPrice && product.price) {
    lines.push(language === "fr" ? `Prix: $${product.price.toFixed(2)}` : `Price: $${product.price.toFixed(2)}`);
  }

  if (wantsAvailability) {
    const availability = displayAvailability(product, language);
    if (availability) lines.push(language === "fr" ? `Disponibilité: ${availability}` : `Availability: ${availability}`);
  }

  if (wantsPackage) {
    if (pack && !wantsPackagePrice) lines.push(packageQuantityText(pack, language));
  }

  if (wantsSoldBy && !(wantsPackage && pack)) {
    const soldBy = soldByInfo(product);
    if (soldBy) lines.push(language === "fr" ? `Vendu par: ${soldBy}` : `Sold by: ${soldBy}`);
  }

  if (wantsColor) {
    const color = valueAfterLabel(text, "Color") || valueAfterLabel(text, "Colour");
    if (color) lines.push(language === "fr" ? `Couleur: ${color}` : `Color: ${color}`);
  }

  if (wantsDescription) {
    const overview =
      valueAfterLabel(text, "Product Overview") ||
      valueAfterLabel(text, "Overview") ||
      sentenceContaining(text, /\b(designed|features|includes|comes with|contains|ideal|used for|conçu|comprend|inclut)\b/i);
    if (overview) lines.push(language === "fr" ? `Détail EMRN: ${overview}` : `EMRN detail: ${overview}`);
  }

  if (wantsOxygenStorage) {
    const oxygenSentence = oxygenStorageEvidence(text);
    if (oxygenSentence) {
      lines.push(
        language === "fr"
          ? `Oxygène: oui. Détail EMRN trouvé: “${oxygenSentence}”`
          : `Oxygen storage: yes. EMRN detail found: “${oxygenSentence}”`
      );
    }
  }

  if (wantsCapability && !wantsOxygenStorage) {
    const evidence = productCapabilityEvidence(text, question);
    const needsSpecificCapability = specificCapabilityPattern.test(normalizedQuestion);
    const evidenceMatchesSpecificCapability = !needsSpecificCapability || specificCapabilityPattern.test(evidence);
    if (evidence && evidenceMatchesSpecificCapability) {
      lines.push(
        language === "fr"
          ? `Détail pertinent EMRN: “${evidence}”`
          : `Relevant EMRN detail: “${evidence}”`
      );
    }
  }

  if (wantsSize) {
    const capacity = valueAfterLabel(text, "Capacity");
    const packDimensions = valueAfterLabel(text, "Pack Dimensions") || valueAfterLabel(text, "Dimensions");
    const mainCompartment = text.match(/\bMain Compartment:\s*([^\n]+)/i)?.[1]?.trim() || "";
    const sidePockets = text.match(/\bSide Pockets:\s*([^\n]+)/i)?.[1]?.trim() || "";
    const auxPocket = text.match(/\bAux Pocket:\s*([^\n]+)/i)?.[1]?.trim() || "";

    if (capacity) lines.push(language === "fr" ? `Capacité: ${capacity}` : `Capacity: ${capacity}`);
    if (packDimensions) lines.push(language === "fr" ? `Dimensions du sac: ${packDimensions}` : `Pack dimensions: ${packDimensions}`);
    if (mainCompartment || sidePockets || auxPocket) {
      if (language === "fr") {
        lines.push(
          `Dimensions des poches: ${[
            mainCompartment ? `compartiment principal ${mainCompartment}` : "",
            sidePockets ? `poches latérales ${sidePockets}` : "",
            auxPocket ? `poche auxiliaire ${auxPocket}` : "",
          ].filter(Boolean).join("; ")}`
        );
      } else {
        lines.push(
          `Pocket dimensions: ${[
            mainCompartment ? `main compartment ${mainCompartment}` : "",
            sidePockets ? `side pockets ${sidePockets}` : "",
            auxPocket ? `aux pocket ${auxPocket}` : "",
          ].filter(Boolean).join("; ")}`
        );
      }
    }
  }

  if (!lines.length) return "";

  const intro = language === "fr"
    ? `Selon les détails du produit EMRN pour **${product.name}** (SKU: ${product.sku}):`
    : `Based on the EMRN product details for **${product.name}** (SKU: ${product.sku}):`;
  const addPrompt = product.purchasable && !product.quoteOnly
    ? language === "fr"
      ? "\n\nVoulez-vous que je l’ajoute au panier?"
      : "\n\nWould you like me to add it to your cart?"
    : "";

  return `${intro}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n\n[View product](${product.url})${addPrompt}`;
}

function isPackageDetailQuestion(text: string) {
  return /\b(how\s+many|box|boxes|pack|package|case|count|quantity|quantities|qty|sold by|sold as|unit of sale|per box|per pack|quantit[eé]|vendu comme|vendu par)\b/i.test(text);
}

function isDirectCatalogDetailQuestion(text: string) {
  return isPackageDetailQuestion(text) ||
    /\b(how\s+big|how\s+large|what\s+size|size|dimension|dimensions|measurement|measurements|height|width|depth|length|capacity|color|colour|couleur|description|details?|overview|specs?|specifications?|features?|what\s+is\s+it|tell\s+me\s+about|what\s+does\s+it\s+include|included|includes|include|comes?\s+with|décris|decris|détails?|details?|aperçu|apercu|spécifications?|specifications?|caractéristiques?|caracteristiques?|inclus|comprend)\b/i.test(text);
}

function catalogDetailCandidateProducts(question: string, products: CatalogProduct[]) {
  const skuCandidates = extractSkuCandidates(question).map(normalizeSku).filter(Boolean);
  if (skuCandidates.length) {
    const exactSkuProducts = products.filter((product) => skuCandidates.includes(normalizeSku(product.sku || "")));
    if (exactSkuProducts.length) return exactSkuProducts;
  }

  const asksAccessory =
    /\b(shelving|shelf|module|oxygen module|accessor(?:y|ies)|replacement|refill|strap|pouch|insert|divider|part|parts|pi[eè]ce|accessoire|remplacement)\b/i.test(question);
  const asksColor = /\b(black|blue|green|orange|pink|purple|red|white|yellow|noir|bleu|vert|rouge|blanc|jaune)\b/i.test(question);
  const accessoryNamePattern = /\b(shelving|shelf|module|accessor(?:y|ies)|replacement|refill|strap|pouch|insert|divider|parts?)\b/i;

  return [...products].sort((a, b) => {
    const score = (product: CatalogProduct) => {
      const name = `${product.name} ${product.parentName}`.toLowerCase();
      let value = 0;
      if (productDetailFromCatalog(product, question, "en")) value += 20;
      if (product.purchasable && !product.quoteOnly) value += 2;
      if (asksColor && /\b(black|blue|green|orange|pink|purple|red|white|yellow)\b/i.test(name)) value += 8;
      if (!asksAccessory && accessoryNamePattern.test(name)) value -= 30;
      if (!asksAccessory && /\b(black|blue|green|orange|red)\b/i.test(name)) value += 4;
      if (/\bg3\+?\s+backup\b/i.test(question) && /\bg35006tk\+?\b/i.test(product.sku || "")) value += 10;
      return value;
    };
    return score(b) - score(a);
  });
}

function isCompareIntent(text: string) {
  return /\b(compare|comparison|difference|differences|which is cheaper|which one is cheaper|which costs less|versus|vs\.?|comparez|difference entre|différence entre)\b/i.test(text);
}

function isResultFilterIntent(text: string) {
  return /\b(cheaper|cheapest|least expensive|lowest price)\b/i.test(text) ||
    /\b[a-z0-9&.-]{2,}\s+only\b/i.test(text) ||
    /\b(?:only|just)\b.*\b(?:in stock|available now|low stock|brand|adult|child|pediatric|sterile|non-sterile|\d{1,4}\s*(?:ml|g|ga|gauge|inch|in)\b)/i.test(text) ||
    /\b(?:in stock|available now|low stock|adult|child|pediatric|sterile|non-sterile|\d{1,4}\s*(?:ml|g|ga|gauge|inch|in)\b)\b.*\bonly\b/i.test(text) ||
    /\bshow\s+(?:me\s+)?(?:only|just|cheaper|the cheapest|in stock|available now|low stock|adult|child|pediatric|sterile|non-sterile|\d{1,4}\s*(?:ml|g|ga|gauge|inch|in)\b)/i.test(text);
}

function availabilityBucket(product: CatalogProduct) {
  return [product.availabilityDescription, product.availability].filter(Boolean).join(" ").toLowerCase();
}

function filterProductsFromText(products: CatalogProduct[], text: string) {
  let filtered = [...products];
  const normalized = text.toLowerCase();

  if (/\b(cheaper|cheapest|least expensive|lowest price)\b/i.test(text)) {
    filtered = filtered.filter((product) => product.price > 0).sort((a, b) => a.price - b.price);
  }

  if (/\b(in stock|available now)\b/i.test(text)) {
    filtered = filtered.filter((product) => {
      const availability = availabilityBucket(product);
      return /\bin stock\b/.test(availability) || product.inventoryLevel > 0;
    });
  } else if (/\b(low stock)\b/i.test(text)) {
    filtered = filtered.filter((product) => /\blow stock\b/.test(availabilityBucket(product)));
  } else if (/\bavailable\b/i.test(text)) {
    filtered = filtered.filter((product) => {
      const availability = availabilityBucket(product);
      return availability.includes("available") || availability.includes("in stock") || product.purchasable;
    });
  }

  const brandMatch = normalized.match(/\b(?:brand\s+)?([a-z0-9&.-]{2,})\s+only\b/) || normalized.match(/\bonly\s+([a-z0-9&.-]{2,})\b/);
  const brand = brandMatch?.[1] || "";
  if (brand && !/^(in|stock|available|cheaper|adult|child|pediatric|sterile|non)$/.test(brand)) {
    filtered = filtered.filter((product) =>
      [product.brand, product.manufacturer, product.name, product.parentName, product.sku]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(brand))
    );
  }

  if (/\badult\b/i.test(text)) filtered = filtered.filter((product) => /\badult\b/i.test(`${product.name} ${product.description}`));
  if (/\b(child|pediatric|paediatric)\b/i.test(text)) filtered = filtered.filter((product) => /\b(child|pediatric|paediatric)\b/i.test(`${product.name} ${product.description}`));
  if (/\bnon[-\s]?sterile\b/i.test(text)) filtered = filtered.filter((product) => /\bnon[-\s]?sterile\b/i.test(`${product.name} ${product.description}`));
  else if (/\bsterile\b/i.test(text)) filtered = filtered.filter((product) => /\bsterile\b/i.test(`${product.name} ${product.description}`));

  const sizeMatch = normalized.match(/\b(\d{1,4})\s*(ml|g|ga|gauge|inch|in)\b/);
  if (sizeMatch) {
    const value = sizeMatch[1];
    const unit = sizeMatch[2];
    const sizePattern = new RegExp(`\\b${value}\\s*(?:${unit}|${unit === "g" ? "ga|gauge" : unit === "ga" ? "g|gauge" : unit === "in" ? "inch" : unit})\\b`, "i");
    filtered = filtered.filter((product) => sizePattern.test(`${product.name} ${product.description}`));
  }

  return filtered;
}

function comparisonDetails(product: CatalogProduct, language: "en" | "fr" | "unknown") {
  const text = `${product.name}\n${product.description}`;
  const details: string[] = [];
  const color = valueAfterLabel(product.description || "", "Color") || valueAfterLabel(product.description || "", "Colour");
  const capacity = valueAfterLabel(product.description || "", "Capacity");
  const dimensions = valueAfterLabel(product.description || "", "Pack Dimensions") || valueAfterLabel(product.description || "", "Dimensions");
  const gauge = text.match(/\b(\d{1,2})\s*(?:G|GA|gauge)\b/i)?.[0]?.replace(/\s+/g, "") || "";
  const size =
    capacity ||
    dimensions ||
    text.match(/\b\d+(?:\.\d+)?\s*(?:mL|ml|cm|mm|in|inch|˝|")\s*(?:x\s*\d+(?:\.\d+)?\s*(?:cm|mm|in|inch|˝|"))?(?:\s*x\s*\d+(?:\.\d+)?\s*(?:cm|mm|in|inch|˝|"))?/i)?.[0]?.trim() ||
    "";
  const sterile = /\bnon[-\s]?sterile\b/i.test(text)
    ? language === "fr" ? "non stérile" : "non-sterile"
    : /\bsterile\b/i.test(text)
      ? language === "fr" ? "stérile" : "sterile"
      : "";

  if (size) details.push(language === "fr" ? `taille ${size}` : `size ${size}`);
  if (gauge) details.push(language === "fr" ? `calibre ${gauge}` : `gauge ${gauge}`);
  if (color) details.push(language === "fr" ? `couleur ${color}` : `color ${color}`);
  if (sterile) details.push(sterile);

  return details.length ? ` ${details.join("; ")}.` : "";
}

function compareProductsText(products: CatalogProduct[], language: "en" | "fr" | "unknown", question: string) {
  const selected = selectProductsForCart(question, products).slice(0, 4);
  const firstCount =
    /\b(first\s+two|deux\s+premiers|deux\s+premières|les\s+deux\s+premiers|les\s+deux\s+premières)\b/i.test(question) ? 2 :
      /\b(first\s+three|trois\s+premiers|trois\s+premières|les\s+trois\s+premiers|les\s+trois\s+premières)\b/i.test(question) ? 3 :
        /\b(first\s+four|quatre\s+premiers|quatre\s+premières|les\s+quatre\s+premiers|les\s+quatre\s+premières)\b/i.test(question) ? 4 :
          0;
  const compared = firstCount ? products.slice(0, firstCount) : selected.length >= 2 ? selected : products.slice(0, 4);
  if (compared.length < 2) return "";

  const lines = compared.map((product, index) => {
    const price = product.price ? `$${product.price.toFixed(2)}` : language === "fr" ? "prix non disponible" : "price unavailable";
    const availability = displayAvailability(product, language);
    const pack = displayPackageInfo(product, language);
    const soldBy = soldByInfo(product);
    const packText = pack ? (language === "fr" ? `; vendu comme ${pack}` : `; sold as ${pack}`) : "";
    const soldByText = soldBy ? (language === "fr" ? `; vendu par ${soldBy}` : `; sold by ${soldBy}`) : "";
    const link = language === "fr" ? "Voir le produit" : "View product";
    return `${index + 1}. **${product.name}** — SKU: ${product.sku} — ${price}. ${availability}${packText}${soldByText}.${comparisonDetails(product, language)} [${link}](${product.url})`;
  });
  const cheapest = compared.filter((product) => product.price > 0).sort((a, b) => a.price - b.price)[0];
  const note = cheapest
    ? language === "fr"
      ? `\n\nLe moins cher dans cette sélection est **${cheapest.name}** à $${cheapest.price.toFixed(2)}.`
      : `\n\nThe lowest-priced option in this set is **${cheapest.name}** at $${cheapest.price.toFixed(2)}.`
    : "";
  const intro = language === "fr" ? "Voici une comparaison rapide avec les données EMRN:" : "Here’s a quick comparison from EMRN product data:";
  const next = language === "fr"
    ? "Dites-moi quel numéro vous voulez et la quantité, et je peux l’ajouter au panier."
    : "Tell me which number you want and the quantity, and I can add it to cart.";
  return `${intro}\n\n${lines.join("\n")}${note}\n\n${next}`;
}

function isPartsOrAccessoryQuestion(text: string) {
  return /\b(part|parts|replacement|replacements|accessory|accessories|go with|goes with|compatible with|fit|fits)\b/i.test(text);
}

function asksForAccessories(text: string) {
  return /\b(accessory|accessories|parts?|replacement|replacements|what goes with|what can go with|what accessories|what parts)\b/i.test(text);
}

function isCompatibilityQuestion(text: string) {
  return /\b(compatible|compatibility|fit|fits|work with|works with|go with|goes with|for this|for that|pour|compatible avec|fonctionne avec|va avec)\b/i.test(text);
}

function compatibilityTargetFromQuestion(question: string) {
  const match =
    question.match(/\b(?:compatible with|fit|fits|work with|works with|go with|goes with|for)\s+(.+)$/i) ||
    question.match(/\b(?:compatible avec|fonctionne avec|va avec|pour)\s+(.+)$/i);
  return (match?.[1] || "")
    .replace(/[?.!]+$/g, "")
    .replace(/\b(this|that|it|item|product|part|manikin|mannequin|aed|defibrillator|ce|cet|cette|produit|article|piece|pièce)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulCompatibilityTokens(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+.-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !/^(the|and|for|with|this|that|item|product|part|parts|accessory|accessories|compatible|compatibility|fit|fits|work|works|goes|manikin|mannequin|defibrillator|pour|avec|produit|article|piece|pièce)$/.test(token));
}

function catalogProductMatchesRequestedType(question: string, product: CatalogProduct) {
  const questionType = requestedProductTypeKey(question);
  if (!questionType) return true;

  const productText = `${product.name} ${product.parentName} ${product.categories.join(" ")}`.toLowerCase();
  if (questionType === "pad") return /\b(pads?|padz|electrodes?|électrodes?|smart\s*pads?)\b/i.test(productText);
  if (questionType === "battery") return /\b(batter(?:y|ies)|batterie|batteries|pile|piles|lithium|alkaline|123a|cr123)\b/i.test(productText);
  if (questionType === "lung") return /\b(lungs?)\b/i.test(productText);
  if (questionType === "airway") return /\b(airways?|voies?\s+a[eé]riennes?)\b/i.test(productText);
  return true;
}

function catalogCompatibilityAnswer(product: CatalogProduct, question: string, language: "en" | "fr" | "unknown") {
  if (!isCompatibilityQuestion(question)) return "";
  if (!catalogProductMatchesRequestedType(question, product)) return "";
  const target = compatibilityTargetFromQuestion(question);
  if (!target || /\b(this|that|it|ce|cet|cette)\b/i.test(target)) return "";

  const haystack = `${product.name}\n${product.parentName}\n${product.sku}\n${product.brand}\n${product.manufacturer}\n${product.description}`.toLowerCase();
  const targetTokens = meaningfulCompatibilityTokens(target);
  if (!targetTokens.length) return "";

  const hasNegative = /\b(not compatible|not for|does not fit|doesn't fit|not intended for|non compatible|n.est pas compatible|ne convient pas)\b/i.test(haystack);
  const matchedTokens = targetTokens.filter((token) => haystack.includes(token));
  const enoughMatch = matchedTokens.length >= Math.min(targetTokens.length, targetTokens.length >= 2 ? 2 : 1);

  if (hasNegative && enoughMatch) {
    return language === "fr"
      ? `Not compatible: Les détails du produit EMRN pour **${product.name}** (SKU: ${product.sku}) indiquent que ce n’est pas compatible avec ${target}.\n\nSource: ${product.url}\n\nVoulez-vous que j’envoie cette question au support pour vérifier?`
      : `Not compatible: EMRN product details for **${product.name}** (SKU: ${product.sku}) indicate it is not compatible with ${target}.\n\nSource: ${product.url}\n\nWould you like me to send this to support to double-check?`;
  }

  if (enoughMatch) {
    return language === "fr"
      ? `Confirmed compatible: Selon les détails du produit EMRN, **${product.name}** (SKU: ${product.sku}) correspond à ${target}.\n\nSource: ${product.url}\n\nVoulez-vous que je l’ajoute au panier ou que je prépare un devis?`
      : `Confirmed compatible: Based on EMRN product details, **${product.name}** (SKU: ${product.sku}) matches ${target}.\n\nSource: ${product.url}\n\nWould you like me to add it to cart or prepare a quote?`;
  }

  return language === "fr"
    ? `Can’t confirm: Je ne peux pas confirmer cette compatibilité à partir des détails EMRN seuls.\n\nPage produit EMRN: ${product.url}\n\nJe vais vérifier les renseignements fabricant si disponibles.`
    : `Can’t confirm: I can’t confirm this compatibility from EMRN product details alone.\n\nEMRN product page: ${product.url}\n\nI’ll check manufacturer info if available.`;
}

function catalogCompatibilityAnswerFromProducts(products: CatalogProduct[], question: string, language: "en" | "fr" | "unknown", trustedSkus: string[]) {
  if (!isCompatibilityQuestion(question)) return "";
  const trustedSkuSet = new Set(trustedSkus.map((sku) => sku.toUpperCase()).filter(Boolean));
  if (!trustedSkuSet.size) return "";

  const uniqueBySku = (items: CatalogProduct[]) => {
    const seen = new Set<string>();
    return items.filter((product) => {
      const key = product.sku || product.url || String(product.productId);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const confirmedProducts = products
    .slice(0, 10)
    .filter((product) => trustedSkuSet.has(product.sku.toUpperCase()))
    .filter((product) => catalogProductMatchesRequestedType(question, product))
    .filter((product) => /^Confirmed compatible:/i.test(catalogCompatibilityAnswer(product, question, language)));
  const negativeProducts = products
    .slice(0, 6)
    .filter((product) => trustedSkuSet.has(product.sku.toUpperCase()))
    .filter((product) => catalogProductMatchesRequestedType(question, product))
    .filter((product) => /^Not compatible:/i.test(catalogCompatibilityAnswer(product, question, language)));

  if (!confirmedProducts.length && !negativeProducts.length) return "";

  const line = (product: CatalogProduct) => {
    const trainingOnly = /\b(training|trainer)\b/i.test(`${product.name} ${product.parentName}`)
      ? language === "fr"
        ? " Formation seulement."
        : " Training only."
      : "";
    const price = product.price > 0 ? `, $${product.price.toFixed(2)}` : "";
    const availability = displayAvailability(product, language).replace(/[.。\s]+$/g, "");
    return `- **${product.name}** — SKU **${product.sku}**${price}.${trainingOnly}${availability ? ` ${availability}.` : ""}\n  ${product.url}`;
  };

  if (confirmedProducts.length) {
    const exact = uniqueBySku(confirmedProducts).slice(0, 5);
    const intro = language === "fr"
      ? "Confirmed compatible: D’après les produits EMRN correspondants, voici les options compatibles que j’ai trouvées:"
      : "Confirmed compatible: Based on matching EMRN products, these are the compatible options I found:";
    const clinical = exact.filter((product) => !/\b(training|trainer)\b/i.test(`${product.name} ${product.parentName}`));
    const training = exact.filter((product) => /\b(training|trainer)\b/i.test(`${product.name} ${product.parentName}`));
    const parts = [
      ...clinical.map(line),
      ...(training.length
        ? [
            language === "fr" ? "\nFormation seulement:" : "\nTraining only:",
            ...training.map(line),
          ]
        : []),
    ];
    const close = language === "fr"
      ? "Voulez-vous que je l’ajoute au panier ou que je prépare un devis?"
      : "Would you like me to add one to cart or prepare a quote?";
    return `${intro}\n\n${parts.join("\n")}\n\n${close}`;
  }

  const intro = language === "fr"
    ? "Not compatible: Les produits EMRN correspondants indiquent que ce n’est pas compatible:"
    : "Not compatible: The matching EMRN products indicate this is not compatible:";
  return `${intro}\n\n${uniqueBySku(negativeProducts).slice(0, 3).map(line).join("\n")}`;
}

function approvedKnowledgeAnswer(
  rules: Awaited<ReturnType<typeof matchingApprovedKnowledgeForQuery>>,
  products: CatalogProduct[],
  language: "en" | "fr" | "unknown",
  currentQuery = ""
) {
  const currentType = requestedProductTypeKey(currentQuery);
  const rule = rules.find((item) => {
    if (!item.answer || !["compatibility", "replacement_part", "preferred_product", "alias"].includes(item.type)) return false;
    const ruleType = requestedProductTypeKey(`${item.query} ${item.correctSearchTerms} ${item.note}`);
    return !currentType || !ruleType || currentType === ruleType;
  });
  if (!rule?.answer) return "";

  const requestedPartType = requestedProductTypePattern(`${rule.query} ${rule.correctSearchTerms} ${rule.note}`);
  const ruleSkus = new Set(knowledgeRuleSkus(rule).map((sku) => sku.toUpperCase()));
  const relevantProducts = products
    .filter((product) => {
      if (ruleSkus.size) return ruleSkus.has(product.sku.toUpperCase());
      if (!requestedPartType) return false;
      return requestedPartType.test(`${product.name} ${product.parentName} ${product.categories.join(" ")}`);
    })
    .slice(0, 3);
  const productLines = relevantProducts.map((product) => {
    const price = product.price > 0 ? `, $${product.price.toFixed(2)}` : "";
    const availability = displayAvailability(product, language).replace(/[.。\s]+$/g, "");
    return `- **${product.name}** — SKU **${product.sku || "N/A"}**${price}.${availability ? ` ${availability}.` : ""}\n  ${product.url}`;
  });
  const proof = (rule.note || rule.correctSearchTerms || rule.query).replace(/[.。\s]+$/g, "");

  if (rule.answer === "confirmed") {
    const intro = language === "fr"
      ? `Confirmed compatible: D’après les renseignements approuvés EMRN/fabricant, ${proof}.`
      : `Confirmed compatible: Based on approved EMRN/manufacturer information, ${proof}.`;
    const next = productLines.length
      ? language === "fr"
        ? "Voulez-vous que je l’ajoute au panier ou que je prépare un devis?"
        : "Would you like me to add it to cart or prepare a quote?"
      : language === "fr"
        ? "Je ne vois pas l’article exact dans les résultats EMRN fournis. Voulez-vous que j’envoie une demande de sourcing/devis à EMRN?"
        : "I do not see the exact item in the supplied EMRN results. Would you like me to send an EMRN item-sourcing/quote request?";
    return `${intro}${productLines.length ? `\n\n${productLines.join("\n")}` : ""}\n\n${next}`;
  }

  if (rule.answer === "not_compatible") {
    const intro = language === "fr"
      ? `Not compatible: D’après les renseignements approuvés EMRN/fabricant, ${proof}.`
      : `Not compatible: Based on approved EMRN/manufacturer information, ${proof}.`;
    return `${intro}${productLines.length ? `\n\nRelated EMRN product:\n${productLines.join("\n")}` : ""}\n\n${language === "fr" ? "Voulez-vous que je l’envoie au support pour vérifier?" : "Would you like me to send this to support to double-check?"}`;
  }

  const intro = language === "fr"
    ? `Can’t confirm: ${proof || "Je ne peux pas confirmer cette compatibilité avec les renseignements approuvés disponibles."}`
    : `Can’t confirm: ${proof || "I can’t confirm this compatibility from the approved information available."}`;
  return `${intro}${productLines.length ? `\n\n${productLines.join("\n")}` : ""}\n\n${language === "fr" ? "Répondez oui et je l’enverrai au support." : "Reply yes and I’ll send this to support."}`;
}

function knowledgeRuleSkus(rule: Awaited<ReturnType<typeof matchingApprovedKnowledgeForQuery>>[number]) {
  return [rule.correctSku, rule.relatedSku].filter(Boolean) as string[];
}

function approvedKnowledgeProductSearchQuery(rules: Awaited<ReturnType<typeof matchingApprovedKnowledgeForQuery>>) {
  const rule = rules.find((item) => item.answer && ["compatibility", "replacement_part", "preferred_product", "alias"].includes(item.type));
  if (!rule) return "";
  if (rule.answer === "not_compatible" || rule.answer === "cant_confirm") return "";
  return rule.correctSearchTerms || rule.query || "";
}

function productMatchesRequestedKnowledgeSku(query: string, product: CatalogProduct) {
  const key = requestedProductTypeKey(query);
  if (!key) return true;
  const text = `${product.name} ${product.parentName} ${product.categories.join(" ")}`.toLowerCase();
  if (key === "pad" && !/\b(pads?|padz|electrodes?)\b/i.test(text)) return false;
  if (key === "battery" && !/\b(batter(?:y|ies))\b/i.test(text)) return false;
  if (key === "airway" && !/\bairways?\b/i.test(text)) return false;
  if (key === "lung" && !/\blungs?\b/i.test(text)) return false;
  const asksTraining = /\b(training|trainer)\b/i.test(query);
  if (key === "pad" && asksTraining && !/\b(training|trainer)\b/i.test(text)) return false;
  if (key === "pad" && !asksTraining && /\b(training|trainer)\b/i.test(text)) return false;
  return true;
}

function weakProductSearchResult(products: CatalogProduct[], latest: string, searchQuery: string) {
  if (!products.length || extractSkuCandidates(latest).length) return false;
  const explicit = productsMatchingExplicitIntent(products, latest, searchQuery);
  if (explicit.suppressed) return true;
  const cleaned = cleanProductQuery(latest);
  const terms = normalizeSearchText(cleaned)
    .split(/\s+/)
    .filter((term) => term.length >= 4)
    .filter((term) => !/^(need|want|have|with|from|that|this|product|products|called|sample|impossible|carry|looking|search|find)$/.test(term));
  if (!terms.length) return false;
  const topText = products.slice(0, 3).map(productIntentText).join(" ");
  const overlap = terms.filter((term) => topText.includes(term));
  if (/\b(impossible|do not carry|dont carry|don't carry|not carry|xzyq)\b/i.test(latest) && overlap.length < 2) return true;
  return terms.length >= 3 && overlap.length === 0;
}

function searchPlanTerms(value: string[]) {
  return value
    .map((term) => normalizeSearchText(term))
    .flatMap((term) => [term, ...term.split(/\s+/)])
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

function asksForTrainingUse(query: string, plan?: CatalogSearchPlan) {
  const text = normalizeSearchText([
    query,
    ...(plan?.searchTerms || []),
    ...(plan?.mustInclude || []),
  ].join(" "));
  return /\b(training|trainer|simulation|simulator|manikin|mannequin|teaching|education|practice|demo)\b/.test(text);
}

function asksForCustomerClinicalUse(query: string) {
  const text = normalizeSearchText(query);
  return /\b(home|clinic|patient|own|myself|self|personal|use|reference|office)\b/.test(text);
}

function scoreProductForSearchPlan(product: CatalogProduct, plan: CatalogSearchPlan) {
  const text = productIntentText(product);
  const must = searchPlanTerms(plan.mustInclude);
  const avoid = searchPlanTerms(plan.avoid);
  let score = 0;

  for (const term of must) {
    if (text.includes(term)) score += term.includes(" ") ? 6 : 2;
  }
  for (const term of avoid) {
    if (text.includes(term)) score -= term.includes(" ") ? 8 : 3;
  }
  return score;
}

function productsMatchingSearchPlan(products: CatalogProduct[], plan: CatalogSearchPlan, latest: string) {
  if (!products.length) return [];
  const wantsTraining = asksForTrainingUse(latest, plan);
  const wantsClinicalUse = asksForCustomerClinicalUse(latest);
  const mustTerms = searchPlanTerms(plan.mustInclude);
  const scored = [...products]
    .map((product, index) => {
      const text = productIntentText(product);
      let score = scoreProductForSearchPlan(product, plan);
      const trainingOnly = /\b(training|trainer|simulator|simulation|manikin|mannequin|life\/form|life form|not for human|for training purposes only)\b/.test(text);
      const realClinicalItem = /\b(otoscope|diagnostic|chart|poster|glove|mask|bandage|dressing|pads?|battery|bag|backpack|monitor|instrument)\b/.test(text);
      if (!wantsTraining && trainingOnly) score -= wantsClinicalUse ? 18 : 10;
      if (!wantsTraining && wantsClinicalUse && realClinicalItem && !trainingOnly) score += 8;
      return { product, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (!mustTerms.length) return scored.map((item) => item.product);
  if (scored[0]?.score <= 0) return [];
  return scored.filter((item) => item.score > 0).map((item) => item.product);
}

function catalogPlanQueries(plan: CatalogSearchPlan, latest: string) {
  const base = Array.from(new Set(plan.searchTerms.map((query) => query.trim()).filter(Boolean))).slice(0, 5);
  const text = normalizeSearchText([latest, ...base, ...plan.mustInclude].join(" "));
  const expanded = [...base];
  const asksReferenceVisual = /\b(poster|affiche|chart|diagram|reference|wall|anatomical|anatomy)\b/.test(text);
  const asksVessels = /\b(vessel|vessels|vein|veins|artery|arteries|vascular|sanguin|sanguins|sanguine|nerve|nerves|visage|face)\b/.test(text);
  if (asksReferenceVisual && asksVessels) {
    expanded.push("blood vessels chart", "nerve pathways chart", "anatomical blood vessels chart", "vessel chart");
  } else if (asksReferenceVisual && /\b(anatomy|anatomical|body|organ|system|muscle|skeletal|heart|lung|brain)\b/.test(text)) {
    expanded.push(...base.map((query) => query.replace(/\bposter\b/g, "chart")).filter((query) => query !== query.replace(/\bposter\b/g, "chart")));
  }
  return Array.from(new Set(expanded.map((query) => query.trim()).filter(Boolean))).slice(0, 8);
}

function rankProductsForAnswer(products: CatalogProduct[], latest: string) {
  const query = normalizeSearchText(latest);
  const asksTraining = /\b(training|trainer)\b/.test(query);
  const asksPads = /\b(pads?|padz|electrodes?)\b/.test(query);
  const asksBattery = /\b(batter(?:y|ies))\b/.test(query);
  const asksOnsite = /\b(onsite|heartstart|hs1)\b/.test(query);
  const asksTorso = /\btorso\b/.test(query);

  const score = (product: CatalogProduct) => {
    const text = normalizeSearchText(`${product.name} ${product.parentName} ${product.sku} ${product.categories.join(" ")}`);
    let value = 0;
    if (asksTraining && /\b(training|trainer)\b/.test(text)) value += 9000;
    if (asksTraining && asksPads && !/\b(training|trainer)\b/.test(text)) value -= 12000;
    if (!asksTraining && asksPads && /\b(training|trainer)\b/.test(text)) value -= 5000;
    if (asksPads && /\b(pads?|padz|electrodes?)\b/.test(text)) value += 2500;
    if (asksBattery && /\b(batter(?:y|ies))\b/.test(text)) value += 3500;
    if (asksBattery && !/\b(batter(?:y|ies))\b/.test(text)) value -= 4000;
    if (asksOnsite && /\b(onsite|heartstart|hs1)\b/.test(text)) value += 3500;
    if (asksOnsite && /\bfr3\b/.test(text)) value -= 4500;
    if (asksTorso && /\bwith torso\b/.test(text)) value += 12000;
    if (asksTorso && /\bno torso\b/.test(text)) value -= 16000;
    return value;
  };

  return [...products].sort((a, b) => score(b) - score(a));
}

function dedupeCatalogProductsBySku(products: CatalogProduct[]) {
  const seen = new Set<string>();
  return products.filter((product) => {
    const key = `${product.productId}:${product.variantId}:${product.sku}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function externalLookupSearchTerms(lookup: ExternalKnowledgeLookup) {
  return Array.from(
    new Set([
      ...externalLookupPartNumbers(lookup),
      lookup.exactProductName,
      ...lookup.searchTerms,
      ...externalLookupPartNumbers(lookup).map((part) => `${lookup.exactProductName} ${part}`),
    ].map((item) => item.trim()).filter(Boolean))
  ).slice(0, 10);
}

function externalLookupPartNumbers(lookup: ExternalKnowledgeLookup) {
  return Array.from(
    new Set(
      lookup.manufacturerPartNumbers.flatMap((value) => {
        const raw = String(value || "").trim();
        const extracted = raw.match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+\b/gi) || [];
        return [raw, raw.replace(/[-\s]+/g, ""), ...extracted, ...extracted.map((part) => part.replace(/[-\s]+/g, ""))].filter(Boolean);
      })
    )
  ).slice(0, 12);
}

function externalLookupProductMatches(lookup: ExternalKnowledgeLookup, products: CatalogProduct[]) {
  const partNumbers = externalLookupPartNumbers(lookup).map((value) => normalizeSku(value)).filter(Boolean);
  const requestedPartType = requestedProductTypePattern([
    lookup.exactProductName,
    lookup.summary,
    ...lookup.searchTerms,
  ].join(" "));
  const sourceText = normalizeSearchText([
    lookup.exactProductName,
    ...lookup.searchTerms,
  ].join(" "));
  const sourceTerms = sourceText
    .split(/\s+/)
    .filter((term) => term.length >= 3)
    .filter((term) => !/^(the|and|for|with|this|that|product|item|part|parts|replacement|compatible|compatibility|work|works|fit|fits|pour|avec)$/.test(term));

  return dedupeCatalogProductsBySku(products)
    .filter((product) => {
      const haystack = `${product.name} ${product.parentName} ${product.sku} ${product.brand} ${product.manufacturer} ${product.categories.join(" ")} ${product.description}`;
      const normalizedHaystack = normalizeSearchText(haystack);
      const sku = normalizeSku(product.sku);
      if (partNumbers.length && partNumbers.some((part) => skuMatchesWithSellableSuffix(sku, part))) return true;
      if (partNumbers.length) return false;
      if (requestedPartType && !requestedPartType.test(haystack)) return false;
      if (!sourceTerms.length) return false;
      const matches = sourceTerms.filter((term) => normalizedHaystack.includes(term));
      return matches.length >= Math.min(4, sourceTerms.length);
    })
    .slice(0, 5);
}

function externalLookupContextProductMatches(lookup: ExternalKnowledgeLookup, products: CatalogProduct[]) {
  const sourceText = normalizeSearchText([
    lookup.exactProductName,
    lookup.summary,
    ...lookup.searchTerms,
  ].join(" "));
  const sourceTerms = sourceText
    .split(/\s+/)
    .filter((term) => term.length >= 3)
    .filter((term) => !/^(the|and|for|with|this|that|product|item|part|parts|replacement|compatible|compatibility|work|works|fit|fits|main|compartment|dimensions|information|manufacturer|pour|avec)$/.test(term));
  if (!sourceTerms.length) return [];

  return dedupeCatalogProductsBySku(products)
    .filter((product) => {
      const haystack = normalizeSearchText(`${product.name} ${product.parentName} ${product.sku} ${product.brand} ${product.manufacturer} ${product.categories.join(" ")} ${product.description}`);
      const matches = sourceTerms.filter((term) => haystack.includes(term));
      return matches.length >= Math.min(3, sourceTerms.length);
    })
    .slice(0, 5);
}

async function findEmrnProductsForExternalLookup(
  lookup: ExternalKnowledgeLookup,
  language: "en" | "fr" | "unknown",
  contextProducts: CatalogProduct[] = []
) {
  const partNumbers = externalLookupPartNumbers(lookup);
  const terms = Array.from(
    new Set([
      ...externalLookupSearchTerms(lookup),
      ...partNumbers.map((part) => part.replace(/^0+/, "")),
      ...lookup.searchTerms.flatMap((term) => partNumbers.map((part) => `${term} ${part}`)),
      ...brandFamilyRecoveryTerms(lookup),
    ].map((term) => term.trim()).filter(Boolean))
  ).slice(0, 18);
  const skuProducts = (
    await Promise.all(partNumbers.map((sku) => searchBySKU(sku)))
  ).flat();
  const searchProductsResults = (
    await Promise.all(terms.map((term) => searchProducts({ query: term, language, limit: 8 })))
  ).flatMap((result) => result.products);
  return externalLookupProductMatches(lookup, [...contextProducts, ...skuProducts, ...searchProductsResults]);
}

function brandFamilyRecoveryTerms(lookup: ExternalKnowledgeLookup) {
  const text = [lookup.exactProductName, lookup.summary, ...lookup.searchTerms].join(" ");
  const cleaned = text
    .replace(/\b(compatible|compatibility|replacement|works?|fits?|pads?|airways?|lungs?|battery|batteries|with|for|the|and|or|item|product|part|parts)\b/gi, " ")
    .replace(/[^a-z0-9+\-\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];
  const tokens = cleaned.split(/\s+/).filter((token) => token.length >= 3).slice(0, 6);
  return tokens.length >= 2 ? [tokens.join(" ")] : [];
}

function externalLookupCustomerAnswer(
  lookup: ExternalKnowledgeLookup,
  products: CatalogProduct[],
  language: "en" | "fr" | "unknown",
  options: { focusedProduct?: CatalogProduct; question?: string } = {}
) {
  const sourceLabel = lookup.sourceType === "manufacturer"
    ? "manufacturer information"
    : lookup.sourceType === "manual_pdf"
      ? "manufacturer manual/spec sheet information"
      : lookup.sourceType === "supplier_catalog"
        ? "supplier catalog information"
        : lookup.sourceType === "emrn"
          ? "EMRN information"
          : "approved product information";
  const partText = lookup.manufacturerPartNumbers.length
    ? ` Part number${lookup.manufacturerPartNumbers.length > 1 ? "s" : ""}: ${lookup.manufacturerPartNumbers.join(", ")}.`
    : "";
  const summary = sentenceFragment(lookup.summary || lookup.exactProductName || "the product information I found")
    .replace(/^[\s:;.,-]+/g, "")
    .replace(/\s+/g, " ")
    .trim() || "the product information I found";
  const lines = products.map((product) => {
    const price = product.price > 0 ? `, $${product.price.toFixed(2)}` : "";
    const availability = sentenceFragment(displayAvailability(product, language));
    return `- **${product.name}** — SKU **${product.sku || "N/A"}**${price}.${availability ? ` ${availability}.` : ""}\n  ${product.url}`;
  });
  const focusedProduct = options.focusedProduct;
  const focusedLine = focusedProduct
    ? (() => {
        const price = focusedProduct.price > 0 ? `, $${focusedProduct.price.toFixed(2)}` : "";
        const availability = sentenceFragment(displayAvailability(focusedProduct, language));
        return `- **${focusedProduct.name}** — SKU **${focusedProduct.sku || "N/A"}**${price}.${availability ? ` ${availability}.` : ""}\n  ${focusedProduct.url}`;
      })()
    : "";

  if (lookup.status === "confirmed") {
    const compatibilityIntro = isCompatibilityQuestion(options.question || "");
    const intro = language === "fr"
      ? `${compatibilityIntro ? "Compatibilité confirmée" : "Selon"}: ${compatibilityIntro ? `Selon ${sourceLabel}, ` : `${sourceLabel}: `}${summary}.${partText}`
      : compatibilityIntro
        ? `Confirmed compatible: Based on ${sourceLabel}, ${summary}.${partText}`
        : `Based on ${sourceLabel}, ${summary}.${partText}`;
    if (focusedLine) return `${intro}\n\n${focusedLine}\n\n${language === "fr" ? "Voulez-vous que je l’ajoute au panier ou que je prépare un devis?" : "Would you like me to add it to your cart or prepare a quote?"}`;
    if (lines.length) return `${intro}\n\n${language === "fr" ? `J’ai trouvé le produit EMRN correspondant${lines.length > 1 ? "s" : ""}:` : `I found the matching EMRN product${lines.length > 1 ? "s" : ""}:`}\n\n${lines.join("\n")}\n\n${language === "fr" ? "Voulez-vous que j’en ajoute un au panier ou que je prépare un devis?" : "Would you like me to add one to cart or prepare a quote?"}`;
    const item = cleanExternalLookupItemName(lookup.exactProductName) || lookup.manufacturerPartNumbers.join(", ") || "the exact item";
    return language === "fr"
      ? `${intro}\n\nJe ne vois pas d’article EMRN correspondant exactement après vérification du numéro de pièce et des termes du produit. Je peux envoyer une demande à EMRN pour rechercher/vérifier **${item}**. Envoyez votre nom, courriel, quantité et échéance si nécessaire.`
      : `${intro}\n\nI do not see an exact matching EMRN catalog item after checking by part number and product terms. I can send this to EMRN to source/check **${item}**. Please send your name, email, quantity, and any deadline.`;
  }

  if (lookup.status === "not_compatible") {
    return language === "fr"
      ? `Non compatible: Selon ${sourceLabel}, ${summary}.${partText}${lines.length ? `\n\nOption EMRN connexe${lines.length > 1 ? "s" : ""}:\n\n${lines.join("\n")}` : ""}\n\nVoulez-vous que j’envoie cette question au support pour vérification?`
      : `Not compatible: Based on ${sourceLabel}, ${summary}.${partText}${lines.length ? `\n\nRelated EMRN option${lines.length > 1 ? "s" : ""}:\n\n${lines.join("\n")}` : ""}\n\nWould you like me to send this to support to double-check?`;
  }

  const item = cleanExternalLookupItemName(lookup.exactProductName) || lookup.manufacturerPartNumbers.join(", ") || "this item";
  return language === "fr"
    ? `Impossible de confirmer: Je ne peux pas confirmer cette information à partir des renseignements produit/fabricant disponibles.${partText}\n\nJ’ai vérifié EMRN avec le numéro de pièce et les termes disponibles${products.length ? ` et trouvé une option EMRN connexe${products.length > 1 ? "s" : ""}:\n\n${lines.join("\n")}` : " et je n’ai pas trouvé de correspondance EMRN exacte"}.\n\nRépondez oui et j’enverrai cette question au support pour **${item}**.`
    : `Can’t confirm: I can’t confirm this from available product/manufacturer info.${partText}\n\nI checked EMRN by the available part number/product terms${products.length ? ` and found related EMRN option${products.length > 1 ? "s" : ""}:\n\n${lines.join("\n")}` : " and did not find an exact EMRN match"}.\n\nReply yes and I’ll send this to support for **${item}**.`;
}

function shouldTrustG3OxygenCylinderProof(lookup: ExternalKnowledgeLookup, product: CatalogProduct | undefined, question: string) {
  if (!product) return false;
  const productText = normalizeSearchText(`${product.name} ${product.parentName} ${product.sku} ${product.brand} ${product.manufacturer}`);
  const lookupText = normalizeSearchText(`${lookup.exactProductName} ${lookup.summary} ${lookup.searchTerms.join(" ")} ${lookup.manufacturerPartNumbers.join(" ")}`);
  const questionText = normalizeSearchText(question);
  return /\bg3\b/.test(productText) &&
    /load\s*n?\s*go/.test(productText) &&
    /\b(statpacks?|g3|load|go)\b/.test(lookupText) &&
    /\b(oxygen|o2|tank|cylinder)\b/.test(questionText) &&
    /\b(fit|fits|hold|holds|accommodate|accommodates|carry|carries|cylinder|tank)\b/.test(questionText);
}

function cleanExternalLookupItemName(value: string) {
  const cleaned = String(value || "")
    .replace(/\b(?:Confirmed compatible|Not compatible|Can.t confirm):?\b/gi, "")
    .replace(/^[\s:;.,*-]+|[\s:;.,*-]+$/g, "")
    .trim();
  return cleaned.length >= 3 ? cleaned : "";
}

function externalLookupFromAnswerText(text: string, query: string): ExternalKnowledgeLookup | null {
  const textWithoutUrls = text.replace(/https?:\/\/\S+/g, " ");
  const partNumbers = Array.from(new Set([
    ...(textWithoutUrls.match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+\b/gi) || []),
    ...(textWithoutUrls.match(/\b(?:CR|DL|BR|M|FR|AED)?\d{2,5}[A-Z]{0,4}\b/gi) || []),
  ])).filter((value) => !/^\d+$/.test(value)).slice(0, 8);
  if (!partNumbers.length) return null;
  const status = /^Not compatible:/i.test(text) || /\*\*Not compatible:?\*\*/i.test(text)
    ? "not_compatible"
    : /^Can.t confirm:/i.test(text) || /\*\*Can.t confirm:?\*\*/i.test(text)
      ? "cant_confirm"
      : "confirmed";
  const exactProductName =
    cleanExternalLookupItemName(text.match(/\*\*([^*\n]{4,160})\*\*/)?.[1] || "") ||
    query;
  const summary = textWithoutUrls
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#>`]/g, "")
    .replace(/\b(?:Confirmed compatible|Not compatible|Can.t confirm):?\b/gi, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line.length > 20 && !/^[-•]/.test(line))
    ?.slice(0, 500) || query;
  return {
    status,
    summary,
    exactProductName,
    manufacturerPartNumbers: partNumbers,
    searchTerms: [query, exactProductName, ...partNumbers],
    sourceType: /manufacturer information/i.test(text) ? "manufacturer" : "mixed",
    sourceUrls: [],
  };
}

function colorFromSkuSuffix(sku: string) {
  const normalized = normalizeSku(sku);
  const suffix = normalized.match(/([A-Z]{2})\+?$/)?.[1] || "";
  return ({
    OR: "orange",
    RE: "red",
    RD: "red",
    BU: "blue",
    BL: "blue",
    BK: "black",
    GR: "green",
    GN: "green",
    YE: "yellow",
    YL: "yellow",
    WH: "white",
    GY: "gray",
    PU: "purple",
    PK: "pink",
  } as Record<string, string>)[suffix] || "";
}

function familySearchForMissingColorSku(sku: string) {
  const normalized = normalizeSku(sku);
  if (/^G35004[A-Z]{2}\+?$/.test(normalized)) return "G3+ Load N Go Medic Backpack Blue Red Tactical Black";
  return "";
}

function requestedProductTypePattern(text: string) {
  if (/\b(blades?|lames?|cutting blades?)\b/i.test(text)) return /\b(blades?|lames?|cutting blades?)\b/i;
  if (/\b(airways?|voies?\s+a[eé]riennes?)\b/i.test(text)) return /\b(airways?|voies?\s+a[eé]riennes?)\b/i;
  if (/\b(lungs?)\b/i.test(text)) return /\b(lungs?)\b/i;
  if (/\b(pads?|electrodes?|électrodes?)\b/i.test(text)) return /\b(pads?|electrodes?|électrodes?)\b/i;
  if (/\b(batter(?:y|ies)|batterie|batteries|pile|piles)\b/i.test(text)) return /\b(batter(?:y|ies)|batterie|batteries|pile|piles)\b/i;
  return null;
}

function requestedProductTypeKey(text: string) {
  if (/\b(blades?|lames?|cutting blades?)\b/i.test(text)) return "blade";
  if (/\b(airways?|voies?\s+a[eé]riennes?)\b/i.test(text)) return "airway";
  if (/\b(lungs?)\b/i.test(text)) return "lung";
  if (/\b(pads?|padz|electrodes?|électrodes?)\b/i.test(text)) return "pad";
  if (/\b(batter(?:y|ies)|batterie|batteries|pile|piles)\b/i.test(text)) return "battery";
  return "";
}

function productFamilyForPartsSearch(product: CatalogProduct) {
  return (product.parentName || product.name)
    .replace(/\b(?:4[-\s]?pack|single|dark skin|light skin)\b/gi, " ")
    .replace(/\s+-\s+.*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function relatedPartQueries(product: CatalogProduct) {
  const family = productFamilyForPartsSearch(product);
  const normalized = `${product.name} ${product.parentName}`.toLowerCase();
  if (/\b(statpacks?|g3\+?|load[\s-]?n[\s-]?go|g3500[46])\b/i.test(normalized)) {
    return [
      "statpacks g3 accessories",
      "g3 oxygen module",
      "g3 backup shelving",
      "g3 pouches",
      "statpacks module",
      "load n go accessories",
    ];
  }
  if (normalized.includes("little junior") || normalized.includes("little jr")) {
    return ["little junior parts", "little jr qcpr accessories", "little junior qcpr replacement"];
  }
  if (normalized.includes("little anne")) {
    return ["little anne parts", "little anne qcpr accessories", "little anne qcpr replacement"];
  }
  return [`${family} parts`, `${family} accessories`, `${family} replacement`];
}

function isRelatedPartForProduct(part: CatalogProduct, baseProduct: CatalogProduct) {
  const base = `${baseProduct.name} ${baseProduct.parentName}`.toLowerCase();
  const partText = `${part.name} ${part.parentName} ${part.sku}`.toLowerCase();
  if (/\b(statpacks?|g3\+?|load[\s-]?n[\s-]?go|g3500[46])\b/i.test(base)) {
    return /\b(statpacks?|g3\+?|g3500[46]|oxygen module|shelving|module|pouch|insert|divider)\b/i.test(partText);
  }
  if (base.includes("little junior") || base.includes("little jr")) {
    return /\b(little\s+jr|little\s+junior|lb\s+qcpr)\b/i.test(partText);
  }
  if (base.includes("little anne")) {
    return /\b(little\s+anne)\b/i.test(partText);
  }
  return true;
}

function isAccessoryLikeProduct(product: CatalogProduct) {
  const text = `${product.name} ${product.parentName} ${product.sku} ${product.categories.join(" ")}`.toLowerCase();
  return /\b(accessor(?:y|ies)|replacement|parts?|module|shelving|shelf|pouch|insert|divider|strap|case|holder|mount|bracket|adapter|connector|refill|tube|tubing|key|cartridge)\b/i.test(text);
}

function isSameMainProductFamily(product: CatalogProduct, baseProduct: CatalogProduct) {
  const baseFamily = productFamilyForPartsSearch(baseProduct).toLowerCase();
  if (!baseFamily) return false;
  const productText = `${product.name} ${product.parentName}`.toLowerCase();
  return productText.includes(baseFamily) && !isAccessoryLikeProduct(product);
}

function siteSearchUrl(query: string) {
  const url = new URL("/search.php", process.env.EMRN_STORE_URL || "https://emrn.ca");
  url.searchParams.set("search_query", query);
  return url.toString();
}

function contactHelpText(language: "en" | "fr" | "unknown") {
  return language === "fr"
    ? "Bien sûr. Je peux envoyer un message à notre équipe. Veuillez m’envoyer votre nom, votre courriel et votre question. Vous pouvez aussi utiliser la page Contactez-nous: https://emrn.ca/contact-us/"
    : "Of course. I can send a message to our team. Please send your name, email, and question. You can also use the Contact Us page: https://emrn.ca/contact-us/";
}

function externalKnowledgeDisabledText(products: CatalogProduct[], language: "en" | "fr" | "unknown") {
  const product = products.find((item) => item.url);
  if (language === "fr") {
    return product
      ? `Can’t confirm: Je ne peux pas confirmer cette réponse à partir des renseignements EMRN seuls. Voici la page produit EMRN: ${product.url}\n\nJe peux envoyer cette question à notre équipe pour vérifier auprès du fabricant ou préparer une demande de devis.`
      : "Can’t confirm: Je ne peux pas confirmer cette réponse à partir des renseignements EMRN seuls. Je peux envoyer cette question à notre équipe pour vérifier auprès du fabricant ou préparer une demande de devis.";
  }
  return product
    ? `Can’t confirm: I can’t confirm this from EMRN information alone. Here’s the EMRN product page: ${product.url}\n\nI can send this to our team to verify with the manufacturer or prepare an item-sourcing/quote request.`
    : "Can’t confirm: I can’t confirm this from EMRN information alone. I can send this to our team to verify with the manufacturer or prepare an item-sourcing/quote request.";
}

function faqAnswerText(text: string, language: "en" | "fr" | "unknown") {
  const helpLink = "https://emrn.ca/faq-s/";
  const contactLink = "https://emrn.ca/contact-us/";
  const shippingReturnsLink = "https://emrn.ca/shipping-returns/";
  const privacyLink = "https://emrn.ca/privacy-policy/";
  const accountLink = "https://emrn.ca/login.php";
  const businessLink = "https://emrn.ca/business-account-application";
  const businessSolutionsLink = "https://emrn.ca/business-medical-supplies";
  const bulkOrderLink = "https://emrn.ca/bulk-orders-volume-pricing/";
  const quickOrderLink = "https://emrn.ca/bulk-orders-volume-pricing/#/purchased-products";
  const homeMedicalSuppliesLink = "https://emrn.ca/home-medical-supplies/";
  const specialPricingLink = "https://emrn.ca/my-special-pricing";
  const termsLink = "https://emrn.ca/terms-conditions/";
  const aboutLink = "https://emrn.ca/about-us/";
  const careersLink = "https://emrn.ca/Careers/";

  const answer = (en: string, fr: string) => (language === "fr" ? fr : en);
  const link = (label: string, url: string) => `[${label}](${url})`;

  if (/\b(must|have to|required to|need to|buy|purchase|order)\b.{0,50}\b(?:online|on the website)\b|\b(?:acheter|commander|oblig[eé]e?|dois)\b.{0,50}\b(?:en ligne|sur le site)\b/i.test(text)) {
    return answer(
      `No. You do not have to buy online. I can help identify the product and send a quote or sourcing request by email through EMRN. If you want to order online, eligible products can be purchased from their product pages.`,
      `Non. Vous n’êtes pas obligé(e) d’acheter en ligne. Je peux vous aider à identifier le produit et envoyer une demande de devis ou de recherche d’article par courriel à EMRN. Si vous préférez commander en ligne, les produits admissibles peuvent être achetés depuis leur page produit.`
    );
  }

  if (/\b(order statuses|order status mean|status mean|awaiting payment|awaiting fulfillment|awaiting shipment|partially shipped|completed)\b/i.test(text)) {
    return answer(
      `Order statuses show where the order is in the process. Awaiting Payment means payment is not complete or confirmed. Awaiting Fulfillment means the order is being reviewed, picked, packed, allocated, or prepared. Awaiting Shipment means it is being prepared for shipment and may be waiting on stock availability, warehouse processing, or carrier pickup. Partially Shipped means some items shipped separately. Shipped means tracking should be available by email or in your account. Completed means the order has been processed. More details: ${link("Help Center", helpLink)}`,
      `Les statuts indiquent où se trouve la commande. Awaiting Payment veut dire que le paiement n’est pas confirmé. Awaiting Fulfillment veut dire que la commande est en révision, préparation, emballage ou allocation de stock. Awaiting Shipment veut dire qu’elle est en préparation d’expédition et peut attendre la disponibilité du stock, le traitement entrepôt ou le ramassage transporteur. Partially Shipped veut dire qu’une partie a été expédiée séparément. Shipped veut dire que le suivi devrait être disponible par courriel ou dans le compte. Completed veut dire que la commande est traitée. Détails: ${link("Centre d'aide", helpLink)}`
    );
  }

  if (/\b(awaiting shipment|waiting shipment|stuck|too long|longer than expected)\b/i.test(text)) {
    return answer(
      `“Awaiting Shipment” means the order is in the shipping process but has not yet been marked shipped with tracking. It can be waiting on stock availability, warehouse processing, or carrier pickup. If it has been longer than expected, contact EMRN with your order number and the team can check the latest update: ${link("Contact EMRN", contactLink)}`,
      `« Awaiting Shipment » veut dire que la commande est en processus d’expédition, mais qu’elle n’a pas encore été marquée expédiée avec suivi. Elle peut attendre la disponibilité du stock, le traitement entrepôt ou le ramassage transporteur. Si le délai semble trop long, contactez EMRN avec votre numéro de commande: ${link("Contacter EMRN", contactLink)}`
    );
  }

  if (/\b(tracking|track my order|tracking number|where.*tracking|shipped.*tracking)\b/i.test(text)) {
    return answer(
      `Tracking is usually emailed once the order ships, and it can also be checked from My Orders after signing in. If your order says shipped but you do not see tracking, contact EMRN with your order number so the team can help locate it: ${link("Contact EMRN", contactLink)}`,
      `Le suivi est habituellement envoyé par courriel lorsque la commande est expédiée, et il peut aussi être consulté dans Mes commandes après connexion. Si votre commande est indiquée expédiée mais que vous ne voyez pas le suivi, contactez EMRN avec votre numéro de commande: ${link("Contacter EMRN", contactLink)}`
    );
  }

  if (/\b(shipping|ship across canada|free shipping|delivery time|ship time|shipping rates|oxygen cylinder|backorder)\b/i.test(text)) {
    return answer(
      `EMRN processes orders when received. Most orders ship within 1-2 business days when merchandise is available and credit/payment verification is complete. If there is a delay or backorder, EMRN will try to contact you and may offer backorder, substitution, or cancellation options. Free shipping applies to online/web orders over $150 shipped within Canada, excluding territories and remote areas. Large/overweight, hazardous, or temperature-controlled freight items do not qualify. Shipping rates are calculated by weight, size, and dimensions. Details: ${link("Shipping and returns", shippingReturnsLink)}`,
      `EMRN traite les commandes à la réception. La plupart des commandes sont expédiées en 1 à 2 jours ouvrables lorsque les articles sont disponibles et que le paiement/crédit est confirmé. En cas de délai ou rupture, EMRN tentera de vous contacter et pourra proposer de garder la commande en attente, substituer un article ou annuler. La livraison gratuite s’applique aux commandes web de plus de 150 $ expédiées au Canada, sauf territoires et régions éloignées. Les articles lourds/surdimensionnés, dangereux ou nécessitant un transport contrôlé en température ne sont pas admissibles. Les frais sont calculés selon poids, taille et dimensions. Détails: ${link("Livraison et retours", shippingReturnsLink)}`
    );
  }

  if (/\b(invoice|old invoice|copy.*invoice|receipt|order documents|company information)\b/i.test(text)) {
    return answer(
      `If you have an EMRN account, sign in and check My Orders for invoices and order details. For an old invoice or a copy with company information, contact EMRN with the order number, company name, or email used for the order: ${link("Contact EMRN", contactLink)}`,
      `Si vous avez un compte EMRN, connectez-vous et consultez Mes commandes pour les factures et détails. Pour une ancienne facture ou une copie avec renseignements d’entreprise, contactez EMRN avec le numéro de commande, le nom de l’entreprise ou le courriel utilisé: ${link("Contacter EMRN", contactLink)}`
    );
  }

  if (/\b(stock|availability|available to order|in stock|confirm stock|not currently in stock|backorder|lead time)\b/i.test(text)) {
    return answer(
      `Availability appears on product pages near the options and cart area. “Available to order” means the item can be purchased, but may not be in the local warehouse for immediate shipment and may need extra stock or order processing time. For time-sensitive quantities, contact EMRN with the product name, SKU, and quantity before ordering: ${link("Contact EMRN", contactLink)}`,
      `La disponibilité apparaît sur les pages produit près des options et du panier. « Available to order » veut dire que l’article peut être commandé, mais qu’il n’est pas forcément en stock local pour expédition immédiate et peut nécessiter un délai supplémentaire de stock ou de traitement. Pour une commande urgente ou une quantité précise, contactez EMRN avec le nom, SKU et quantité: ${link("Contacter EMRN", contactLink)}`
    );
  }

  if (
    /\b(sell to|selling to|sell directly to|public|individuals?|individual customers?|personal customers?|consumers?|retail customers?|do you sell to people|can i buy from (?:you|emrn)|can individuals buy|can the public buy|open to the public)\b/i.test(text) ||
    /\b(vendez[-\s]?vous\s+(?:aux?\s+)?particuliers?|vente\s+(?:aux?\s+)?particuliers?|vendre\s+(?:aux?\s+)?particuliers?|clients? individuels?|grand public|consommateurs?|clientele individuelle|clientèle individuelle|acheter comme particulier)\b/i.test(text)
  ) {
    return answer(
      `Yes. EMRN sells to individuals as well as businesses, clinics, EMS, healthcare facilities, schools, government organizations, and other professional buyers. Many items can be ordered online without a business account, though some specialized products may have restrictions or require review. You can browse products on EMRN.ca or contact the team here: ${link("Contact EMRN", contactLink)}`,
      `Oui. EMRN vend aux particuliers ainsi qu’aux entreprises, cliniques, services EMS, établissements de santé, écoles, organisations gouvernementales et autres acheteurs professionnels. Plusieurs articles peuvent être commandés en ligne sans compte entreprise, mais certains produits spécialisés peuvent avoir des restrictions ou nécessiter une vérification. Vous pouvez parcourir les produits sur EMRN.ca ou contacter l’équipe ici: ${link("Contacter EMRN", contactLink)}`
    );
  }

  if (
    /\b(pick[\s-]?up|pickup|local pickup|local pick up|pick it up|collect my order|collect from|will call|curbside)\b/i.test(text) ||
    /\b(ramassage|ramasser|cueillette|collecte|venir chercher|passer chercher)\b/i.test(text)
  ) {
    return answer(
      `Local pickup depends on the item, quantity, and whether EMRN can arrange it for that order. Send the item name or SKU and quantity, and I can send it to support to check whether local pickup can be arranged.`,
      `Le ramassage local dépend de l’article, de la quantité et de la possibilité de l’organiser pour cette commande. Envoyez le nom ou SKU de l’article et la quantité, et je peux transmettre la demande au support pour vérifier si un ramassage local est possible.`
    );
  }

  if (/\b(create.*account|make.*account|register|business account|enterprise account|doctor|doctor.s office|schools|clinics|ems|government|account benefits|purchase history|reorder|compte entreprise|compte d'entreprise|demander un compte|créer un compte|creer un compte)\b/i.test(text)) {
    return answer(
      `You can apply here: ${link("Business account application", businessLink)}. Business or enterprise accounts are useful for clinics, schools, EMS departments, companies, healthcare facilities, government organizations, and larger purchasing teams. You can also review ${link("business medical supplies", businessSolutionsLink)} or ${link("sign in / register", accountLink)}. You do not need to be a doctor’s office or have a business account to purchase many items, though some specialized products may have restrictions.`,
      `Vous pouvez faire une demande ici: ${link("Demande de compte entreprise", businessLink)}. Les comptes entreprise sont utiles pour les cliniques, écoles, services EMS, entreprises, établissements de santé, organisations gouvernementales et grandes équipes d’achat. Vous pouvez aussi consulter ${link("les fournitures médicales pour entreprises", businessSolutionsLink)} ou ${link("vous connecter / créer un compte", accountLink)}. Il n’est pas nécessaire d’être un cabinet médical ou d’avoir un compte entreprise pour acheter plusieurs articles, mais certains produits spécialisés peuvent avoir des restrictions.`
    );
  }

  if (/\b(business solutions|business medical supplies|medical supplies for business|clinic supplies|school supplies|ems department|healthcare facility|enterprise purchasing|institutional purchasing)\b/i.test(text)) {
    return answer(
      `EMRN supports business, clinic, school, EMS, healthcare facility, government, and institutional purchasing. Start with ${link("Business Medical Supplies", businessSolutionsLink)}. For account setup, use the ${link("business account application", businessLink)}.`,
      `EMRN soutient les achats pour entreprises, cliniques, écoles, services EMS, établissements de santé, gouvernements et institutions. Commencez avec ${link("Business Medical Supplies", businessSolutionsLink)}. Pour créer le compte, utilisez la ${link("demande de compte entreprise", businessLink)}.`
    );
  }

  if (/\b(job|jobs|career|careers|hiring|employment|work for emrn|join.*team|emplois?|carrieres?|carrières?|recrutement|travailler chez emrn)\b/i.test(text)) {
    return answer(
      `You can view EMRN career opportunities here: ${link("Careers", careersLink)}.`,
      `Vous pouvez consulter les possibilités de carrière chez EMRN ici: ${link("Carrières", careersLink)}.`
    );
  }

  if (/\b(terms|terms and conditions|conditions|pricing error|price error|sales tax|taxes|warranty|liability|shelf life|expiration|expiry|copyright|conditions générales|conditions generales|taxes|erreur de prix|expiration)\b/i.test(text)) {
    return answer(
      `EMRN’s terms cover ordering, pricing, taxes, product information, shelf life, website use, and limitations. Prices, product details, and availability can change, and EMRN may correct pricing or product-information errors if they occur. For products with a manufacturer expiration date, EMRN aims to supply at least 6 months of remaining shelf life at shipment unless otherwise noted or agreed. Full details: ${link("Terms and conditions", termsLink)}`,
      `Les conditions d’EMRN couvrent les commandes, prix, taxes, renseignements produit, durée de conservation, utilisation du site et limitations. Les prix, détails produit et disponibilités peuvent changer, et EMRN peut corriger les erreurs de prix ou d’information produit. Pour les produits avec une date d’expiration fabricant, EMRN vise au moins 6 mois de durée restante à l’expédition, sauf indication ou accord contraire. Détails: ${link("Conditions générales", termsLink)}`
    );
  }

  if (/\b(about emrn|about us|who is emrn|what is emrn|company info|company information|mission|history|since 1989|à propos|a propos|qui est emrn|qu.est.?ce qu.?emrn|c.est quoi emrn)\b/i.test(text)) {
    return answer(
      `EMRN Medical Equipment Inc. is a Canadian distributor of medical supplies and equipment serving healthcare professionals, EMS, fire and police departments, military and government organizations, hospitals, schools, dental offices, municipalities, businesses, and institutions. EMRN has served the healthcare community since 1989 and does not provide medical advice. More: ${link("About EMRN", aboutLink)}`,
      `EMRN Medical Equipment Inc. est un distributeur canadien de fournitures et d’équipement médicaux pour professionnels de la santé, services EMS, pompiers et police, organisations militaires et gouvernementales, hôpitaux, écoles, cabinets dentaires, municipalités, entreprises et institutions. EMRN sert la communauté de la santé depuis 1989 et ne fournit pas de conseils médicaux. Détails: ${link("À propos d’EMRN", aboutLink)}`
    );
  }

  if (/\b(bulk order|bulk orders|volume pricing|bulk pricing|large quantity|large quantities|large order|facility setup|clinic setup|csv upload|bulk upload|commande en gros|commandes en gros|prix de volume|grande quantité|grandes quantités)\b/i.test(text)) {
    return answer(
      `For large quantity or repeat purchasing, EMRN offers Bulk Orders and Volume Pricing. It helps with known SKUs, larger order lists, CSV upload, previously purchased products, and business purchasing workflows. Start here: ${link("Bulk Orders & Volume Pricing", bulkOrderLink)}. If you already know the products or SKUs, use ${link("Quick Order", quickOrderLink)}.`,
      `Pour les grandes quantités ou achats répétés, EMRN propose Bulk Orders and Volume Pricing. Cela aide avec les SKUs connus, grandes listes d’articles, téléversement CSV, produits déjà achetés et processus d’achat entreprise. Commencez ici: ${link("Bulk Orders & Volume Pricing", bulkOrderLink)}. Si vous connaissez déjà les produits ou SKUs, utilisez ${link("Quick Order", quickOrderLink)}.`
    );
  }

  if (/\b(quick order|quick add|order by sku|sku order|purchased products|buyer portal|add multiple sku|multiple skus|commande rapide|commander par sku|portail acheteur)\b/i.test(text)) {
    return answer(
      `Quick Order is for approved EMRN Company buyer accounts that already know the products or SKUs they need. It supports product search, quick-add rows, CSV bulk upload, and previously purchased products. Open it here: ${link("Quick Order", quickOrderLink)}. If you need access, apply here: ${link("Business account application", businessLink)}.`,
      `Quick Order est destiné aux comptes acheteurs EMRN Company approuvés qui connaissent déjà les produits ou SKUs nécessaires. Il prend en charge la recherche de produits, les lignes d’ajout rapide, le téléversement CSV et les produits déjà achetés. Ouvrir ici: ${link("Quick Order", quickOrderLink)}. Pour demander l’accès, utilisez: ${link("Demande de compte entreprise", businessLink)}.`
    );
  }

  if (/\b(home medical supplies|home care|homecare|home product|home products|home health|home patient|dme|mobility aids|bathroom safety)\b/i.test(text)) {
    return answer(
      `EMRN has home medical supplies and home-care products here: ${link("Home medical supplies", homeMedicalSuppliesLink)}. You can search by product name, category, brand, size, or SKU, and I can help narrow options if you tell me what the item is for.`,
      `EMRN propose des fournitures médicales pour la maison et soins à domicile ici: ${link("Fournitures médicales à domicile", homeMedicalSuppliesLink)}. Vous pouvez chercher par nom, catégorie, marque, taille ou SKU, et je peux aider à réduire les options si vous me dites l’usage prévu.`
    );
  }

  if (/\b(return|returns|exchange|returnable|wrong item|damaged|damage|opened|used|special order|non-returnable)\b/i.test(text)) {
    return answer(
      `Returns require a return merchandise authorization number from Customer Service, and the RMA must be clearly written on the outside of the carton. Items are not returnable after 15 days from the date received. Shipping and handling are non-refundable, and return transport may be at your expense when the return is due to preference or customer error. Returns are not authorized for non-returnable website items, special/custom orders, discontinued items, items not in original packaging, damaged or non-saleable items, and injectable medication or pharmaceutical products. An 18% restocking fee may apply. If a shipment arrives damaged, note the damage on the delivery bill, have the driver sign it, take a photo, and contact EMRN. Details: ${link("Shipping and returns", shippingReturnsLink)}`,
      `Les retours nécessitent un numéro d’autorisation de retour du service client, et le RMA doit être clairement inscrit à l’extérieur de la boîte. Les articles ne sont pas retournables après 15 jours suivant la réception. Les frais de livraison/manutention ne sont pas remboursables, et le transport de retour peut être à vos frais si le retour est dû à une préférence ou erreur du client. Les retours ne sont pas autorisés pour les articles indiqués non retournables, commandes spéciales/personnalisées, articles discontinués, articles hors emballage original, endommagés ou non revendables, ni médicaments injectables ou produits pharmaceutiques. Des frais de restockage de 18 % peuvent s’appliquer. Si l’expédition arrive endommagée, notez les dommages sur le bon de livraison, faites signer le chauffeur, prenez une photo et contactez EMRN. Détails: ${link("Livraison et retours", shippingReturnsLink)}`
    );
  }

  if (/\b(special pricing|business pricing|my special pricing|preferred pricing|contract pricing|prix special|prix spécial|prix entreprise)\b/i.test(text)) {
    return answer(
      `For business or special pricing, sign in and check ${link("My Special Pricing", specialPricingLink)}. If your organization needs pricing reviewed or does not yet have access, apply for a ${link("business account", businessLink)}, or ${link("contact EMRN", contactLink)} for help.`,
      `Pour les prix entreprise ou prix spéciaux, connectez-vous et consultez ${link("My Special Pricing", specialPricingLink)}. Si votre organisation doit faire vérifier ses prix ou n’a pas encore accès, faites une ${link("demande de compte entreprise", businessLink)}, ou ${link("contactez EMRN", contactLink)}.`
    );
  }

  if (/\b(payment|credit card|purchase order|po\b|tax exempt|tax-exempt|tax exemption|pay by po)\b/i.test(text)) {
    return answer(
      `Payment options are shown at checkout and may include major credit cards or other online payment methods depending on the order and account type. Purchase-order billing may be available for approved business, enterprise, institutional, government, or healthcare accounts. Tax-exempt organizations should contact EMRN before ordering so documentation and account setup can be reviewed: ${link("Contact EMRN", contactLink)}`,
      `Les modes de paiement sont affichés au paiement et peuvent inclure les cartes de crédit principales ou d’autres méthodes en ligne selon la commande et le type de compte. Les bons de commande peuvent être disponibles pour comptes entreprise, institutionnels, gouvernementaux ou santé approuvés. Les organisations exemptées de taxes devraient contacter EMRN avant de commander afin de vérifier les documents et le compte: ${link("Contacter EMRN", contactLink)}`
    );
  }

  if (/\b(replacement part|compatible accessory|compatibility|right product|which product|do not know the sku|don't know the sku|photo|model number)\b/i.test(text)) {
    return answer(
      `Product pages include descriptions, images, specifications, and options when available. For help choosing the right item, replacement part, or compatible accessory, send EMRN the product name, brand, model number, SKU, photo if available, and how you plan to use it. I can also help search if you give me those details.`,
      `Les pages produit incluent descriptions, images, spécifications et options lorsque disponibles. Pour choisir le bon article, une pièce de remplacement ou un accessoire compatible, envoyez à EMRN le nom, la marque, le modèle, le SKU, une photo si disponible et l’usage prévu. Je peux aussi chercher avec ces détails.`
    );
  }

  if (/\b(help center|faq|frequently asked|customer support|still need help|centre d.aide|questions fréquentes|questions frequentes|service client)\b/i.test(text)) {
    return answer(
      `The EMRN Help Center covers quotes, order status, tracking and shipping, invoices, accounts, returns, payments, purchase orders, tax-exempt ordering, and product help: ${link("Help Center", helpLink)}. The team can also help with quotes, product questions, order updates, tracking, invoices, and account support: ${link("Contact EMRN", contactLink)}`,
      `Le centre d’aide EMRN couvre les devis, statuts de commande, suivi et livraison, factures, comptes, retours, paiements, bons de commande, exemption de taxes et aide produit: ${link("Centre d’aide", helpLink)}. L’équipe peut aussi aider avec devis, questions produit, mises à jour de commande, suivi, factures et comptes: ${link("Contacter EMRN", contactLink)}`
    );
  }

  if (
    /\b(privacy|privacy policy|personal information|data policy|confidential|confidentiality)\b/i.test(text) ||
    /politique de confidentialit|renseignements personnels|vie priv/i.test(text)
  ) {
    return answer(
      `EMRN uses customer information to support shopping, account communication, order communication, service, and EMRN-related updates. EMRN says it does not sell customer information, and secure checkout uses SSL technology. You can review the full policy here: ${link("Privacy policy", privacyLink)}. For personal information or account/order privacy questions, ${link("contact EMRN", contactLink)}.`,
      `EMRN utilise les renseignements clients pour soutenir les achats, communications de compte, communications de commande, service et mises à jour EMRN. EMRN indique ne pas vendre les renseignements clients, et le paiement sécurisé utilise la technologie SSL. Politique complète: ${link("Politique de confidentialité", privacyLink)}. Pour les questions sur les renseignements personnels ou la confidentialité du compte/de la commande, ${link("contactez EMRN", contactLink)}.`
    );
  }

  if (
    /\b(how.*quote|request.*quote|quote.*multiple|multiple.*quote|need.*account.*quote|quote.*account|how long.*quote|special pricing|large order|bulk price)\b/i.test(text) ||
    /\b(comment.*devis|demander.*devis|devis.*plusieurs|plusieurs.*devis|compte.*devis|devis.*compte|combien.*temps.*devis|prix special|prix spécial|grande commande|grosse commande)\b/i.test(text)
  ) {
    return answer(
      `To request a quote, open the product page and click “Add to Quote”. Add each item you need, then click “My Quote” at the top of the site to review and submit one quote request. You do not need an account, though an account can help with future orders and invoices. For large quantities, include the quantity needed so EMRN can review special pricing. More details: ${link("Help Center", helpLink)}`,
      `Pour demander un devis, ouvrez la page produit et cliquez « Add to Quote ». Ajoutez chaque article, puis cliquez « My Quote » en haut du site pour réviser et soumettre une seule demande. Un compte n’est pas obligatoire, mais il peut aider pour les commandes et factures futures. Pour grandes quantités, indiquez la quantité afin qu’EMRN puisse vérifier les prix spéciaux. Détails: ${link("Centre d’aide", helpLink)}`
    );
  }

  return "";
}

function isSiteInfoQuestion(text: string) {
  return /\b(business account|compte entreprise|compte d'entreprise|business solutions|business medical supplies|job|jobs|career|careers|hiring|employment|emplois?|carrieres?|carrières?|terms|terms and conditions|conditions générales|conditions generales|privacy|privacy policy|about emrn|about us|who is emrn|what is emrn|à propos|a propos|bulk order|bulk orders|volume pricing|commande en gros|quick order|commande rapide|home medical supplies|help center|faq|centre d.aide|shipping and returns|livraison et retours|return policy|politique de retour|individuals?|individual customers?|consumers?|retail customers?|particuliers?|clients? individuels?|grand public|pick[\s-]?up|pickup|local pickup|local pick up|will call|curbside|ramassage|cueillette|venir chercher|passer chercher|online|en ligne|acheter|commander)\b/i.test(text) ||
    /politique de confidentialit|renseignements personnels|vie priv/i.test(text);
}

function isProductQuestionStarterPrompt(text: string) {
  const clean = text.trim();
  return /^I have a product question about compatibility, parts, or which item fits$/i.test(clean) ||
    /^J’ai une question produit sur la compatibilité, les pièces ou le bon article$/i.test(clean) ||
    /^J'ai une question produit sur la compatibilité, les pièces ou le bon article$/i.test(clean);
}

async function runAssistantSideEffects(label: string, tasks: Array<Promise<unknown>>) {
  const results = await Promise.allSettled(tasks);
  results.forEach((result) => {
    if (result.status === "rejected") {
      console.warn(`[EMRN Pulse] ${label} side effect failed`, result.reason);
    }
  });
}

function supportEmailDeliveryText(sent: boolean, language: AssistantLanguage) {
  if (sent) {
    return language === "fr"
      ? "Merci. Votre question a été envoyée à notre équipe de support. Quelqu’un vous répondra sous peu."
      : "Thank you. Your question has been sent to our support team. Someone will respond shortly.";
  }
  return language === "fr"
    ? "Votre demande de support a été enregistrée, mais le courriel n’a pas pu être livré. Veuillez contacter EMRN directement pour un suivi rapide."
    : "Your support request was recorded, but the email could not be delivered. Please contact EMRN directly for prompt follow-up.";
}

function orderStatusEmailDeliveryText(sent: boolean, language: AssistantLanguage) {
  if (sent) {
    return language === "fr"
      ? "D’accord. J’ai envoyé cette demande de statut au support afin qu’ils vérifient la commande et vous répondent par courriel."
      : "Okay. I sent this order status request to support so they can check the order and email you back.";
  }
  return language === "fr"
    ? "Votre demande de statut a été enregistrée, mais le courriel n’a pas pu être livré. Veuillez contacter EMRN directement pour un suivi rapide."
    : "Your order-status request was recorded, but the email could not be delivered. Please contact EMRN directly for prompt follow-up.";
}

function isAiIdentityQuestion(text: string) {
  const clean = String(text || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return /\b(are you ai|are you an ai|are you artificial intelligence|are you an artificial intelligence|are you a bot|are you bot|are you a robot|is this ai|is this artificial intelligence|is this a bot|am i talking to ai|am i talking to artificial intelligence|am i talking to a bot|human or ai|real person or ai)\b/i.test(clean) ||
    /\b(es[-\s]?tu une ia|etes[-\s]?vous une ia|êtes[-\s]?vous une ia|est[-\s]?ce une ia|robot|vrai humain|vraie personne)\b/i.test(clean);
}

function shouldAskAiForBroadIntentRoute({
  latest,
  skuCandidates,
  taughtQuoteIntent,
  taughtOrderStatusIntent,
  taughtContactIntent,
  taughtAvailabilityIntent,
}: {
  latest: string;
  skuCandidates: string[];
  taughtQuoteIntent: boolean;
  taughtOrderStatusIntent: boolean;
  taughtContactIntent: boolean;
  taughtAvailabilityIntent: boolean;
}) {
  const clean = latest.trim();
  if (skuCandidates.length) return false;
  if (clean.length < 45) return false;
  if (isFindProductPrompt(clean) || isProductQuestionStarterPrompt(clean)) return false;
  if (isSiteInfoQuestion(clean)) return false;
  if (isQuoteIntent(clean) || taughtQuoteIntent) return false;
  if (isOrderStatusIntent(clean) || taughtOrderStatusIntent) return false;
  if (isContactIntent(clean) || taughtContactIntent) return false;
  if (isCartIntent(clean)) return false;
  if (isAvailabilityIntent(clean) || taughtAvailabilityIntent) return false;
  return /[?!.]|\b(i|we|my|order|help|need|looking|waiting|received|answer|reply|support|quote|product|clinic|home|customer|commande|aide|besoin|cherche|attends|réponse|reponse)\b/i.test(clean);
}

async function productsFromPageContext(pageContext: ProductPageContext, language: "en" | "fr" | "unknown") {
  if (pageContext.sku) {
    const matches = await searchBySKU(pageContext.sku);
    if (matches.length) return matches;
  }

  const title = String(pageContext.title || "").replace(/\s*[-|]\s*EMRN.*$/i, "").trim();
  if (title && !/^emrn pulse$/i.test(title)) {
    return (await searchProducts({ query: title, language, limit: 6 })).products;
  }

  return [];
}

export async function POST(req: NextRequest) {
  try {
    return await handleAssistantPost(req);
  } catch (error) {
    console.error("[EMRN Pulse] assistant chat failed", error);
    return new Response(
      textStream(
        "I’m sorry, I could not complete that request right now. Would you like me to send this to our support team?"
      ),
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
}

async function handleAssistantPost(req: NextRequest) {
  const requestStartedAt = Date.now();
  const body = await req.json().catch(() => null);
  const messages = (body?.messages || []) as AssistantMessage[];
  const sessionId = String(body?.sessionId || crypto.randomUUID());
  const requestedLanguage = body?.language;
  const detectedLanguage = detectCustomerLanguage(messages);
  const language = detectedLanguage === "fr"
    ? "fr"
    : requestedLanguage && requestedLanguage !== "unknown"
      ? requestedLanguage
      : detectedLanguage;
  const pageContext = (body?.pageContext || {}) as ProductPageContext;
  const latest = messages.at(-1)?.content || "";
  const taughtIntentRoute = await taughtIntentRouteForQuery(latest);
  const taughtContactIntent = taughtIntentRoute === "contact" || taughtIntentRoute === "support";
  const taughtQuoteIntent = taughtIntentRoute === "quote";
  const taughtOrderStatusIntent = taughtIntentRoute === "order_status";
  const taughtAvailabilityIntent = taughtIntentRoute === "availability";
  const createdAt = new Date().toISOString();
  let broadIntentPlan: CatalogSearchPlan | null | undefined;
  let searchTiming: {
    totalMs?: number;
    supabaseMs?: number;
    openAiMs?: number;
    typesenseMs?: number;
    fallbackMs?: number;
  } = {};
  let knowledgeMs = 0;

  if (!messages.length || !latest.trim()) {
    return NextResponse.json({ error: "messages are required" }, { status: 400 });
  }

  await logAnalyticsEvent({ type: "conversation_started", sessionId, language, createdAt });

  if (language === "unknown") {
    return new Response(
      textStream("Would you prefer English or French? / Préférez-vous continuer en anglais ou en français?"),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (isAiIdentityQuestion(latest)) {
    return new Response(
      textStream(
        language === "fr"
          ? "Je suis Meri, l’assistante IA d’EMRN. Je peux aider avec les produits, compatibilités, disponibilités, devis, questions de commande, photos, et je peux transmettre à l’équipe EMRN quand il faut une personne."
          : "I’m Meri, EMRN’s AI assistant. I can help with products, compatibility, availability, quotes, order questions, photos, and I can connect you with the EMRN team when a person needs to help."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (isMedicalAdviceRequest(latest)) {
    await logAnalyticsEvent({ type: "unanswered_question", sessionId, language, query: latest, createdAt });
    return new Response(
      textStream(
        language === "fr"
          ? "EMRN fournit de l’équipement et des fournitures médicales, mais nous ne pouvons pas donner de conseils médicaux, poser un diagnostic ou recommander un traitement. Pour votre sécurité, veuillez consulter un professionnel de la santé. Voulez-vous que j’envoie votre question à notre équipe de support?"
          : "EMRN supplies medical equipment and supplies, but we cannot provide medical advice, diagnose, or recommend treatment. For your safety, please consult a qualified healthcare professional. Would you like me to send this to our support team?"
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (isNegativeSearchFeedback(latest)) {
    await logAnalyticsEvent({ type: "unanswered_question", sessionId, language, query: latest, createdAt });
    return new Response(
      textStream(
        language === "fr"
          ? "Désolé, ce n’était pas le bon résultat. Je ne vais pas relancer une recherche avec ce message. Envoyez-moi un détail de plus: nom du produit, SKU/numéro de pièce, marque, modèle, usage, ou une photo, et je chercherai de nouveau. Je peux aussi l’envoyer à l’équipe EMRN pour vérification ou devis."
          : "Sorry, that was not the right result. I will not run a new product search from that message. Send me one more detail: product name, SKU/part number, brand, model, use, or a photo, and I’ll search again. I can also send it to the EMRN team to check or quote."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const priorAssistantAskedSupport = messages
    .slice(-3)
    .some(
      (message) =>
        message.role === "assistant" &&
        /support team|equipe de support|équipe de support|send a message to our team|send this to support|send it to support|envoyer.*support|nom, votre courriel et votre question|name, email, and question/i.test(
          message.content
        )
    );
  const looksLikeSupportDetailsReply = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(latest);

  // Quote collection also says "our team". Keep a quote reply in its own flow
  // rather than treating the customer's email/SKU as a new support request.
  const priorAssistantAskedQuoteDetails = priorAssistantRequestedQuoteDetails(messages);
  if (!priorAssistantAskedQuoteDetails && priorAssistantAskedSupport && (isSupportYes(latest) || (looksLikeSupportDetailsReply && !isQuickActionPrompt(latest)))) {
    const draft = buildSupportDraft(messages, language);
    if (draft.request) {
      const supportRequest = {
        ...draft.request,
        category: supportCategoryFromMessages(messages),
        summary: supportSummaryFromMessages(messages),
      };
      const supportEmailResult = await sendSupportEmail(supportRequest);
      await runAssistantSideEffects("support request", [
        logSupportRequest(supportRequest),
        Promise.resolve(supportEmailResult),
        logAnalyticsEvent({ type: "support_escalation", sessionId, language, query: latest, createdAt }),
      ]);
      return new Response(
        textStream(supportEmailDeliveryText(supportEmailResult.sent, language)),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    return new Response(
      textStream(
        language === "fr"
          ? `Bien sûr. Pour envoyer cela à notre équipe, il me manque: ${draft.missing.join(", ")}.`
          : `Of course. To send this to our team, I still need: ${draft.missing.join(", ")}.`
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const quotePaymentLink = recentQuotePaymentLink(messages);
  const priorQuoteLinkEmailOffer = priorAssistantAskedQuoteLinkEmail(messages);
  const wantsQuotePaymentEmail =
    Boolean(quotePaymentLink.checkoutUrl) &&
    (quoteLinkEmailIntent(latest) ||
      (priorQuoteLinkEmailOffer && isAffirmative(latest)) ||
      (priorQuoteLinkEmailOffer && Boolean(orderHistoryEmail(messages))));

  if (wantsQuotePaymentEmail) {
    const email = orderHistoryEmail(messages);
    if (!email) {
      return new Response(
        textStream(
          language === "fr"
            ? "Bien sûr. À quel courriel dois-je envoyer le lien de paiement du devis?"
            : "Sure. What email should I send the quote/payment link to?"
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    const quoteLinkEmailResult = await sendQuoteLinkEmail({
      to: email,
      quoteNumber: quotePaymentLink.quoteNumber || (language === "fr" ? "votre devis" : "your quote"),
      checkoutUrl: quotePaymentLink.checkoutUrl,
      language,
    });
    return new Response(
      textStream(
        quoteLinkEmailResult.sent
          ? language === "fr"
            ? `C’est envoyé à ${email}. Vous pouvez aussi ouvrir le lien ici: ${quotePaymentLink.checkoutUrl}`
            : `I sent it to ${email}. You can also open the link here: ${quotePaymentLink.checkoutUrl}`
          : language === "fr"
            ? `Je n’ai pas pu envoyer le lien de paiement par courriel. Vous pouvez tout de même l’ouvrir ici: ${quotePaymentLink.checkoutUrl}`
            : `I could not email the payment link. You can still open it here: ${quotePaymentLink.checkoutUrl}`
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const priorAssistantRequestedOrderStatus = messages
    .slice(-4)
    .some(
      (message) =>
        message.role === "assistant" &&
        /order status request|order status in BigCommerce|email used for that order|protect the order details|suivi de commande|statut de commande|statut de la commande dans BigCommerce|courriel utilisé|courriel utilise|protéger les détails de la commande|proteger les details de la commande|order number/i.test(message.content)
    );

  const looksLikeOrderDetailsReply =
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(latest) || /\border\s*#?\s*\d{3,}\b|\b\d{3,}\b/i.test(latest);
  const shouldContinueInvoiceLookup = priorAssistantRequestedInvoiceLookup(messages) &&
    !isQuickActionPrompt(latest) &&
    (looksLikeOrderDetailsReply || Boolean(invoiceNumberFromText(latest)));
  const shouldContinueMissingProductFlow = priorAssistantAskedMissingProductInfo(messages) && !isQuickActionPrompt(latest);
  const shouldContinueQuoteLookup = priorAssistantRequestedQuoteLookup(messages) &&
    !isQuickActionPrompt(latest) &&
    (Boolean(standaloneQuoteNumberFromText(latest)) || Boolean(quoteNumberFromText(latest)) || Boolean(orderHistoryEmail(messages)));
  const shouldSendOrderStatusSupport = priorAssistantOfferedOrderStatusSupport(messages) && isAffirmative(latest);

  if (isCurrentCartQuestion(latest)) {
    return new Response(textStream(currentCartText(pageContext, language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (isInvoiceLookupIntent(latest) || shouldContinueInvoiceLookup) {
    const email = orderHistoryEmail(messages);
    const conversationText = messages.map((message) => message.content).join("\n");
    const orderNumber = orderNumberFromText(conversationText) || recentStandaloneOrderNumber(messages) || standaloneOrderNumberFromText(latest);
    const invoiceNumber = invoiceNumberFromText(messages.map((message) => message.content).join("\n"));
    if (!email || (!orderNumber && !invoiceNumber)) {
      return new Response(
        textStream(invoiceMissingText(Boolean(orderNumber || invoiceNumber), Boolean(email), language)),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    if (orderNumber) {
      const orderDetails = await getOrderDetails({ orderNumber, email });
      if (!orderDetails.verified) {
        return new Response(
          textStream(
            language === "fr"
              ? "Je n’ai pas pu confirmer cette commande avec ce courriel. Je peux envoyer cette demande au support."
              : "I could not verify that order with this email. I can send this to support."
          ),
          { headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
    }

    const invoice = await lookupB2BInvoice({ orderNumber, invoiceNumber });
    return new Response(textStream(invoiceLookupText(orderNumber || invoiceNumber, invoice, language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (isQuotePurchaseIntent(latest)) {
    const conversationText = messages.map((message) => message.content).join("\n");
    const quoteNumber = quoteNumberFromText(conversationText) || standaloneQuoteNumberFromText(latest) || recentAssistantQuoteNumber(messages);
    if (!quoteNumber) {
      return new Response(
        textStream(
          language === "fr"
            ? "Bien sûr. Envoyez-moi le numéro du devis, et je vais vérifier si un lien de paiement peut être créé."
            : "Sure. Send me the quote number, and I’ll check whether a checkout link can be created."
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    const quote = await lookupB2BQuote({ quoteNumber });
    if (!quote.found) {
      return new Response(
        textStream(
          language === "fr"
            ? "Je n’ai pas trouvé ce devis automatiquement. Je peux envoyer cette demande au support si vous voulez."
            : "I could not find that quote automatically. I can send this to support if you want."
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    const checkout = await createB2BQuoteCheckout(quote.quoteId || quote.quoteNumber || quoteNumber);
    return new Response(textStream(quoteCheckoutText(quote.quoteNumber || quoteNumber, checkout, language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (isQuoteLookupIntent(latest) || shouldContinueQuoteLookup) {
    const conversationText = messages.map((message) => message.content).join("\n");
    const quoteNumber = quoteNumberFromText(conversationText) || standaloneQuoteNumberFromText(latest);
    const email = orderHistoryEmail(messages);
    if (!quoteNumber && !email) {
      return new Response(
        textStream(quoteLookupMissingText(Boolean(quoteNumber), Boolean(email), language)),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    const quote = await lookupB2BQuote({ quoteNumber, email });
    const checkout = quote.found && quote.allowCheckout
      ? await createB2BQuoteCheckout(quote.quoteId || quote.quoteNumber || quoteNumber)
      : { created: false, checkoutUrl: "" };
    await logAnalyticsEvent({
      type: "quote_lookup",
      sessionId,
      language,
      query: quoteNumber || email || latest,
      createdAt,
    });
    return new Response(textStream(quoteLookupText(quote, language, checkout.checkoutUrl || "")), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (isReorderIntent(latest) || (priorAssistantRequestedReorderLookup(messages) && !isQuickActionPrompt(latest))) {
    const conversationText = messages.map((message) => message.content).join("\n");
    const email = orderHistoryEmail(messages);
    let orderNumber = orderNumberFromText(conversationText);
    if (!email) {
      return new Response(
        textStream(
          language === "fr"
            ? "Bien sûr. Pour la recherche de recommandation, envoyez-moi le courriel utilisé pour la commande et, si vous l’avez, le numéro de commande."
            : "Sure. For reorder lookup, please send the email used for the order and, if you have it, the order number."
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    if (!orderNumber) {
      const recentOrders = await getRecentOrdersByEmail(email, 1);
      orderNumber = recentOrders.orders[0]?.orderNumber || "";
    }

    if (!orderNumber) {
      return new Response(
        textStream(
          language === "fr"
            ? "Je n’ai pas trouvé de commande récente pour ce courriel. Je peux envoyer cette demande au support."
            : "I did not find a recent order for that email. I can send this to support."
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    return new Response(textStream(await reorderFromOrderText(orderNumber, email, sessionId, language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const shippingTimingQuestion = isShippingTimingQuestion(latest);
  const recentConversationSku = recentSkuFromConversation(messages.slice(0, -1));
  const shippingTimingHasOrderContext =
    shippingTimingQuestion && (hasOrderReferenceInConversation(messages.slice(0, -1)) || /\b(order|commande|tracking|shipment|suivi)\b/i.test(latest));
  const shippingTimingHasProductContext =
    shippingTimingQuestion && (extractSkuCandidates(latest).length > 0 || Boolean(recentConversationSku) || Boolean(pageContext.sku || pageContext.title));
  const priorAssistantAskedShippingTimingClarifier = messages
    .slice(-4, -1)
    .some(
      (message) =>
        message.role === "assistant" &&
        /order you already placed|checking when a product can ship|commande déjà passée|produit sera expédié/i.test(message.content)
    );

  if (
    shippingTimingQuestion &&
    !shippingTimingHasOrderContext &&
    !shippingTimingHasProductContext &&
    !priorAssistantRequestedOrderStatus
  ) {
    return new Response(textStream(shippingTimingClarifierText(language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (priorAssistantAskedShippingTimingClarifier && isExistingOrderShippingReply(latest)) {
    return new Response(textStream(orderStatusMissingText(["order number", "email"], language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (isOrderStatusIntent(latest) || taughtOrderStatusIntent || shippingTimingHasOrderContext || shouldSendOrderStatusSupport || (priorAssistantRequestedOrderStatus && looksLikeOrderDetailsReply && !isQuickActionPrompt(latest))) {
    const draft = buildOrderStatusDraft(messages, language);
    if (draft.request) {
      if (shouldSendOrderStatusSupport) {
        const orderStatusEmailResult = await sendOrderStatusEmail(draft.request);
        await runAssistantSideEffects("order status support request", [
          Promise.resolve(orderStatusEmailResult),
          logAnalyticsEvent({ type: "support_escalation", sessionId, language, query: latest, createdAt }),
        ]);
        return new Response(
          textStream(orderStatusEmailDeliveryText(orderStatusEmailResult.sent, language)),
          { headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }

      const orderStatus = await getOrderStatus({
        orderNumber: draft.request.orderNumber,
        email: draft.request.email,
      });

      if (orderStatus.verified && (orderStatus.trackingLinks.length || orderStatus.trackingNumbers.length)) {
        return new Response(textStream(orderTrackingText(orderStatus, language)), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      return new Response(
        textStream(
          language === "fr"
            ? orderStatus.verified
              ? `J’ai trouvé votre commande ${draft.request.orderNumber}. Statut: ${friendlyOrderStatusText(orderStatus.status, language)}\n\nJe ne vois pas de numéro de suivi disponible pour le moment. Voulez-vous que je demande au support de vérifier et de vous envoyer une mise à jour?`
              : "Je n’ai pas pu confirmer le suivi automatiquement avec les renseignements fournis. Voulez-vous que j’envoie cette demande de statut au support?"
            : orderStatus.verified
              ? `I found your order ${draft.request.orderNumber}. Status: ${friendlyOrderStatusText(orderStatus.status, language)}\n\nI do not see tracking available yet. Want me to ask support for an update by email?`
              : "I could not confirm the tracking automatically with the information provided. Want me to send this order status request to support?"
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    return new Response(textStream(orderStatusMissingText(draft.missing, language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (shouldAskAiForBroadIntentRoute({
    latest,
    skuCandidates: extractSkuCandidates(latest),
    taughtQuoteIntent,
    taughtOrderStatusIntent,
    taughtContactIntent,
    taughtAvailabilityIntent,
  })) {
    broadIntentPlan = await planCatalogSearch({ messages, language, sessionId, query: latest });
    if (broadIntentPlan && broadIntentPlan.confidence >= 0.55) {
      if (broadIntentPlan.intent === "order_status") {
        const draft = buildOrderStatusDraft(messages, language);
        return new Response(textStream(orderStatusMissingText(draft.missing, language)), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      if (broadIntentPlan.intent === "contact" || broadIntentPlan.intent === "support") {
        return new Response(textStream(contactHelpText(language)), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      if (broadIntentPlan.intent === "quote") {
        const draft = buildQuoteDraft(messages, language, []);
        return new Response(textStream(quoteMissingText(draft.missing, language)), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      if (broadIntentPlan.intent === "not_shopping") {
        return new Response(
          textStream(
            language === "fr"
              ? "Je suis ici pour aider avec EMRN: produits, compatibilité, disponibilité, devis, commandes, photos ou support. Dites-moi ce que vous cherchez ou ce que vous voulez vérifier."
              : "I’m here to help with EMRN products, compatibility, availability, quotes, orders, photos, or support. Tell me what you want to find or check."
          ),
          { headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
    }
  }

  if (isOrderHistoryIntent(latest) || (priorAssistantRequestedOrderHistory(messages) && orderHistoryEmail(messages) && !isQuickActionPrompt(latest))) {
    const email = orderHistoryEmail(messages);
    if (!email) {
      return new Response(
        textStream(
          language === "fr"
            ? "Bien sûr. Quel courriel a été utilisé pour les commandes?"
            : "Sure. What email was used for the orders?"
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    const recentOrders = await getRecentOrdersByEmail(email, 5);
    return new Response(textStream(recentOrdersText(recentOrders, language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (isProductQuestionStarterPrompt(latest)) {
    return new Response(
      textStream(
        language === "fr"
          ? "Bien sûr. Quel produit ou SKU voulez-vous vérifier? Envoyez le modèle, la marque, le numéro de pièce, ou dites ce que vous essayez de faire, et je vérifierai les articles EMRN en premier."
          : "Sure. What product or SKU do you want to check? Send the model, brand, part number, or what you are trying to do, and I’ll check EMRN items first."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (isFindProductPrompt(latest)) {
    return new Response(
      textStream(
        language === "fr"
          ? "Bien sûr. Quel produit cherchez-vous? Vous pouvez me donner un nom, une marque, une catégorie, une utilisation médicale ou un SKU. Si vous ne connaissez pas le nom, vous pouvez aussi téléverser une photo avec le bouton photo."
          : "Sure. What product are you looking for? You can give me a name, brand, category, medical use, or SKU. If you don’t know the name, you can also upload a photo with the photo button."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const shouldUseProductDetailIntent = isProductDetailIntent(latest) && !looksLikePlainCatalogKeywordSearch(latest);

  if (!extractSkuCandidates(latest).length && !shouldUseProductDetailIntent && !isProductSearchIntent(latest) && !looksLikeSpecificProductSearch(latest) && !isQuoteIntent(latest) && !taughtQuoteIntent && (!isAvailabilityIntent(latest) || isSiteInfoQuestion(latest))) {
    const faqAnswer = faqAnswerText(latest, language);
    if (faqAnswer) {
      return new Response(textStream(faqAnswer), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  const priorQuoteDetailsRequested = priorAssistantRequestedQuoteDetails(messages);
  const latestCanContinueQuoteFlow =
    priorQuoteDetailsRequested && (looksLikeQuoteDetailsReply(latest) || extractSkuCandidates(latest).length > 0 || hasExplicitQuantity(latest));
  const shouldIgnorePriorQuoteFlow =
    !latestCanContinueQuoteFlow &&
    (isQuickActionPrompt(latest) || isProductSearchIntent(latest)) &&
    !isQuoteIntent(latest) &&
    !taughtQuoteIntent;
  const shouldContinuePriorQuoteFlow =
    !shouldIgnorePriorQuoteFlow && priorQuoteDetailsRequested && latestCanContinueQuoteFlow;
  const shouldContinueItemRequestFlow =
    !shouldIgnorePriorQuoteFlow && priorAssistantOfferedItemRequest(messages) && isAffirmative(latest);

  const suggestedSku = recentSkuSuggestion(messages);
  if (suggestedSku && priorAssistantOfferedSkuSuggestion(messages) && isAffirmative(latest)) {
    const products = await searchBySKU(suggestedSku);
    if (products.length) {
      const answer = products.length === 1
        ? exactProductFoundText(products[0], language, suggestedSku)
        : productResultsText(products, language, suggestedSku);
      return new Response(textStream(answer), {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  }

  const suggestedKeyword = recentKeywordSuggestion(messages);
  if (suggestedKeyword && priorAssistantOfferedKeywordSuggestion(messages) && isAffirmative(latest)) {
    const result = await searchProducts({ query: suggestedKeyword, language, limit: 8 });
    const answer = result.products.length
      ? productResultsText(result.products, language, suggestedKeyword)
      : language === "fr"
        ? "Je n’ai pas trouvé ces résultats maintenant. Je peux envoyer une demande de sourcing/devis à EMRN."
        : "I could not find those results right now. I can send an item-sourcing/quote request to EMRN.";
    return new Response(textStream(answer), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (priorAssistantOfferedSkuSuggestion(messages) && isNegative(latest)) {
    return new Response(
      textStream(
        language === "fr"
          ? "D’accord, ce n’est pas le bon article. Je peux envoyer une demande de sourcing/devis à EMRN pour vérifier l’article exact. Envoyez-moi votre nom, courriel, et toute photo, marque, modèle, SKU ou description que vous avez."
          : "No problem, that is not the right item. I can send an item-sourcing/quote request to EMRN to check the exact item. Please send your name, email, and any photo, brand, model, SKU, or description you have."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (priorAssistantOfferedKeywordSuggestion(messages) && isNegative(latest)) {
    return new Response(
      textStream(
        language === "fr"
          ? "D’accord, ce n’est pas le bon terme. Je peux envoyer une demande de sourcing/devis à EMRN. Envoyez-moi votre nom, courriel, et toute photo, marque, modèle, SKU ou description que vous avez."
          : "No problem, that is not the right search term. I can send an item-sourcing/quote request to EMRN. Please send your name, email, and any photo, brand, model, SKU, or description you have."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (priorAssistantOfferedCartAdd(messages) && isNegative(latest)) {
    return new Response(
      textStream(
        language === "fr"
          ? "D’accord, je ne l’ajouterai pas au panier. Je peux continuer à chercher ou comparer d’autres articles si vous voulez."
          : "No problem, I won’t add it to your cart. I can keep searching or compare other items if you need."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const isPlainQuantityReply = /^\s*\d{1,5}\s*$/.test(latest);
  if (isLiveCartEditIntent(latest) && priorAssistantCreatedCart(messages) && !(priorAssistantAskedCartQuantity(messages) && isPlainQuantityReply)) {
    const trackedCart = trackedCarts.get(sessionId);
    if (trackedCart?.items.length) {
      const cartProducts = cartProductsFromTrackedCart(trackedCart);
      const ordinalIndex = extractOrdinalSelection(latest, cartProducts.length);
      const selectedProducts = selectProductsForCart(latest, cartProducts.map((item) => item.product));
      const selectedProduct =
        ordinalIndex !== null
          ? cartProducts[ordinalIndex]?.product
          : selectedProducts.length === 1
            ? selectedProducts[0]
            : /\b(that|it|this|the item|the product|ce produit|cet article)\b/i.test(latest)
              ? cartProducts.at(-1)?.product
              : null;
      const selectedTrackedItem = selectedProduct
        ? trackedCart.items.find(
            (item) =>
              normalizeSku(item.sku) === normalizeSku(selectedProduct.sku) ||
              (item.productId === selectedProduct.productId && Number(item.variantId || 0) === Number(selectedProduct.variantId || 0))
          )
        : null;

      if (isClearCartIntent(latest) && !priorAssistantAskedClearCartConfirmation(messages)) {
        return new Response(
          textStream(
            language === "fr"
              ? "Juste pour confirmer: voulez-vous vider le panier créé par Meri dans cette conversation? Répondez « oui, vider » pour confirmer."
              : "Just to confirm: do you want me to clear the Meri-created cart from this conversation? Reply “yes, clear it” to confirm."
          ),
          { headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }

      if (isClearCartIntent(latest) || (priorAssistantAskedClearCartConfirmation(messages) && isAffirmative(latest))) {
        const removableItems = trackedCart.items.filter((item) => item.itemId);
        if (removableItems.length) {
          for (const item of removableItems) await removeMcpCartItem(item.itemId!);
          trackedCarts.delete(sessionId);
          return new Response(textStream(mcpCartEditText("clear", language, undefined, { action: "clear" })), {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      }

      if (selectedTrackedItem?.itemId && isRemoveCartIntent(latest)) {
        const result = await removeMcpCartItem(selectedTrackedItem.itemId);
        if (!result.blockedItems.length) {
          const browserAction = {
            action: "remove",
            sku: selectedTrackedItem.sku,
            productId: selectedTrackedItem.productId,
            variantId: selectedTrackedItem.variantId,
          };
          const nextCart = {
            ...trackedCart,
            items: trackedCart.items.filter((item) => item.itemId !== selectedTrackedItem.itemId),
            checkoutUrl: result.checkoutUrl || trackedCart.checkoutUrl,
          };
          if (nextCart.items.length) {
            trackedCarts.set(sessionId, nextCart);
            return new Response(textStream(mcpCartEditText("remove", language, result.checkoutUrl || trackedCart.checkoutUrl, browserAction)), {
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            });
          }
          trackedCarts.delete(sessionId);
          return new Response(textStream(mcpCartEmptyAfterRemoveText(language, browserAction)), {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      }

      const quantity = quantityFromChangeReply(latest);
      if (selectedTrackedItem?.itemId && quantity > 0) {
        const result = await updateMcpCartItem({
          lineItemId: selectedTrackedItem.itemId,
          productId: selectedTrackedItem.productId,
          variantId: selectedTrackedItem.variantId,
          quantity,
        });
        if (!result.blockedItems.length) {
          const browserAction = {
            action: "set_quantity",
            sku: selectedTrackedItem.sku,
            productId: selectedTrackedItem.productId,
            variantId: selectedTrackedItem.variantId,
            quantity,
          };
          updateTrackedCartFromResult(sessionId, trackedCart, result);
          const currentCart = trackedCarts.get(sessionId) || trackedCart;
          const currentItem = currentCart.items.find((item) => item.itemId === selectedTrackedItem.itemId);
          if (currentItem) currentItem.quantity = quantity;
          return new Response(textStream(mcpCartEditText("set_quantity", language, result.checkoutUrl || trackedCart.checkoutUrl, browserAction)), {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
      }

      if (isRemoveCartIntent(latest) || isSetQuantityCartIntent(latest)) {
        return new Response(
          textStream(
            language === "fr"
              ? "Je vois plusieurs articles dans le panier. Dites-moi quel numéro ou SKU vous voulez modifier."
              : "I see multiple items in the cart. Please tell me which number or SKU you want to edit."
          ),
          { headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
    }

    return new Response(
      textStream(
        language === "fr"
          ? "Je peux modifier les paniers créés dans cette conversation. Je n’ai pas trouvé l’identifiant de ligne MCP pour ce panier, alors ouvrez le lien du panier pour le modifier: https://emrn.ca/cart.php"
          : "I can edit carts created in this conversation. I could not find the MCP line item ID for this cart, so please open the cart link to edit it: https://emrn.ca/cart.php"
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (
    !priorAssistantAskedQuoteDetails &&
    priorAssistantAskedSupport &&
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(latest) &&
    !isQuickActionPrompt(latest)
  ) {
    const draft = buildSupportDraft(messages, language);
    if (draft.request) {
      const supportRequest = {
        ...draft.request,
        category: supportCategoryFromMessages(messages),
        summary: supportSummaryFromMessages(messages),
      };
      const supportEmailResult = await sendSupportEmail(supportRequest);
      await runAssistantSideEffects("support request", [
        logSupportRequest(supportRequest),
        Promise.resolve(supportEmailResult),
        logAnalyticsEvent({ type: "support_escalation", sessionId, language, query: latest, createdAt }),
      ]);
      return new Response(
        textStream(supportEmailDeliveryText(supportEmailResult.sent, language)),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }
  }

  if ((isContactIntent(latest) || taughtContactIntent) && !looksLikeSpecificProductSearch(latest)) {
    return new Response(textStream(contactHelpText(language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if ((isAvailabilityIntent(latest) || taughtAvailabilityIntent) && !isResultFilterIntent(latest)) {
    const latestSkuCandidates = extractSkuCandidates(latest);
    const skuCandidates = latestSkuCandidates.length
      ? latestSkuCandidates
      : shippingTimingQuestion && recentConversationSku
        ? [recentConversationSku]
        : [];
    const pageProducts = skuCandidates.length
      ? (await Promise.all(skuCandidates.map((sku) => searchBySKU(sku)))).flat()
      : /\b(this|it|this item|the product|ce produit|cet article)\b/i.test(latest)
        ? await productsFromPageContext(pageContext, language)
        : [];
    const rememberedProducts = !skuCandidates.length && !pageProducts.length
      ? await recentAssistantProducts(messages)
      : [];
    const availabilityPool = pageProducts.length ? pageProducts : rememberedProducts;
    const availabilityProducts = availabilityPool.length ? selectContextProducts(latest, availabilityPool) : [];

    if (availabilityProducts.length) {
      return new Response(textStream(await availabilityTextWithSubstitutes(availabilityProducts[0], language)), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return new Response(
      textStream(
        language === "fr"
          ? "Bien sûr. Donnez-moi le SKU ou le nom du produit, et je vérifierai la disponibilité."
          : "Sure. Please send me the SKU or product name, and I’ll check availability."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const pageProductsForCart =
    (isCartIntent(latest) || isQuoteIntent(latest) || taughtQuoteIntent || shouldUseProductDetailIntent) && /\b(this|it|this item|the product|ce produit|cet article)\b/i.test(latest)
      ? await productsFromPageContext(pageContext, language)
      : [];
  const skuCandidates = extractSkuCandidates(latest);
  const aedAccessorySkus = !skuCandidates.length ? aedAccessorySkuHints(latest) : [];
  const replyingToCartChoice =
    priorAssistantAskedCartChoice(messages) && !shouldUseProductDetailIntent && !isQuickActionPrompt(latest);
  const replyingToCartQuantity = priorAssistantAskedCartQuantity(messages) && /^\s*\d{1,5}\s*$/.test(latest);
  const replyingToCartQuantityChange = priorAssistantAskedCartQuantity(messages) && quantityFromChangeReply(latest) > 0;
  const shouldCompareRememberedProducts = isCompareIntent(latest);
  const shouldFilterRememberedProducts = isResultFilterIntent(latest) && !skuCandidates.length;
  const shouldHandleCart =
    isCartIntent(latest) ||
    replyingToCartChoice ||
    replyingToCartQuantity ||
    replyingToCartQuantityChange ||
    (priorAssistantOfferedCartAdd(messages) && isAffirmative(latest));
  const shouldUseRememberedCartProducts =
    shouldHandleCart &&
    !skuCandidates.length &&
    !pageProductsForCart.length &&
    (replyingToCartChoice ||
      replyingToCartQuantity ||
      replyingToCartQuantityChange ||
      isContextProductSelectionReply(latest) ||
      (priorAssistantOfferedCartAdd(messages) && isAffirmative(latest)));
  const shouldUseRememberedProducts =
    shouldUseRememberedCartProducts ||
    isQuoteIntent(latest) ||
    taughtQuoteIntent ||
    shouldContinuePriorQuoteFlow ||
    shouldContinueItemRequestFlow ||
    (shouldUseProductDetailIntent && (!skuCandidates.length || isContextProductSelectionReply(latest))) ||
    shouldCompareRememberedProducts ||
    shouldFilterRememberedProducts ||
    isContextProductSelectionReply(latest);
  const rememberedCartProducts = shouldUseRememberedCartProducts
    ? await recentAssistantProducts(messages)
    : [];
  const rememberedContextProducts = shouldUseRememberedProducts && !skuCandidates.length && !pageProductsForCart.length
    ? rememberedCartProducts.length
      ? rememberedCartProducts
      : await recentAssistantProducts(messages)
    : [];
  let searchQuery = pageProductsForCart.length
    ? pageProductsForCart[0].sku || pageProductsForCart[0].name
    : aedAccessorySkus.length
      ? aedAccessorySkus.join(", ")
      : skuCandidates.length
      ? skuCandidates.join(", ")
      : rememberedContextProducts.length
        ? searchQueryForLatest(messages, latest, rememberedContextProducts)
      : shouldContinueMissingProductFlow
        ? missingProductFollowUpQuery(messages, latest)
      : searchQueryForLatest(messages, latest, []);
  const answerCacheEnabled = await assistantFeatureEnabledAsync("answerCacheEnabled");
  const cacheEligibility = answerCacheEligibility({
    query: latest,
    messageCount: messages.length,
    hasPageSku: Boolean(pageContext.sku),
  });
  const canUseAnswerCache = answerCacheEnabled && cacheEligibility.eligible;
  if (canUseAnswerCache) {
    const cachedAnswer = await getCachedAnswer(latest, language);
    if (cachedAnswer) {
      const totalMs = Date.now() - requestStartedAt;
      await logAnalyticsEvent({
        type: "assistant_performance",
        sessionId,
        language,
        query: latest,
        productIds: cachedAnswer.productIds,
        performance: {
          totalMs,
          searchMs: 0,
          supabaseMs: 0,
          openAiMs: 0,
          knowledgeMs: 0,
          productCount: cachedAnswer.productIds.length || cachedAnswer.productSkus.length,
          searchQuery: cachedAnswer.searchQuery || searchQuery,
          answerPath: "cached_answer",
          answerPreview: answerPreviewText(cachedAnswer.answer),
          proofSearchTerms: [cachedAnswer.query, cachedAnswer.searchQuery || ""].filter(Boolean),
          emrnMatchedSkus: cachedAnswer.productSkus,
          answerCacheEligible: true,
          answerCacheHit: true,
          answerCacheKey: cachedAnswer.key,
          answerCacheSaveStatus: "hit",
          deployVersion: process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "local",
          slow: false,
          openAiUsed: false,
          supabaseUsed: false,
        },
        createdAt: new Date().toISOString(),
      });
      return new Response(textStream(cachedAnswer.answer), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
  }
  const preSearchKnowledgeStartedAt = Date.now();
  const preSearchKnowledgeMatches =
    !pageProductsForCart.length && !skuCandidates.length && !rememberedContextProducts.length
      ? await matchingApprovedKnowledgeForQuery(latest)
      : [];
  const preSearchKnowledgeMs = Date.now() - preSearchKnowledgeStartedAt;
  const preSearchSkus = Array.from(new Set(preSearchKnowledgeMatches.flatMap((item) => knowledgeRuleSkus(item)).filter(Boolean)));
  const preSearchRuleSearchQuery = approvedKnowledgeProductSearchQuery(preSearchKnowledgeMatches);
  const preSearchSkuStartedAt = Date.now();
  const preSearchSkuProducts = preSearchSkus.length
    ? (await Promise.all(preSearchSkus.map((sku) => searchBySKU(sku))))
        .flat()
        .filter((product) => productMatchesRequestedKnowledgeSku(latest, product))
    : [];
  const preSearchSkuMs = Date.now() - preSearchSkuStartedAt;
  const earlyApprovedRuleAnswer = shouldUseProductDetailIntent && !isDirectCatalogDetailQuestion(latest) && !preSearchSkuProducts.length && !preSearchRuleSearchQuery
    ? approvedKnowledgeAnswer(preSearchKnowledgeMatches, [], language, latest)
    : "";
  if (earlyApprovedRuleAnswer) {
    const totalMs = Date.now() - requestStartedAt;
    const cacheSave = canUseAnswerCache
      ? await saveCachedAnswer({
          query: latest,
          language,
          answer: earlyApprovedRuleAnswer,
          answerPath: "approved_knowledge",
          searchQuery,
          productIds: [],
          productSkus: [],
        })
      : null;
    await logAnalyticsEvent({
      type: "assistant_performance",
      sessionId,
      language,
      query: latest,
      productIds: [],
      performance: {
        totalMs,
        searchMs: 0,
        supabaseMs: preSearchKnowledgeMs,
        openAiMs: 0,
        knowledgeMs: 0,
        productCount: 0,
        searchQuery,
        answerPath: "approved_knowledge",
        answerPreview: answerPreviewText(earlyApprovedRuleAnswer),
        answerCacheEligible: canUseAnswerCache,
        answerCacheHit: false,
        answerCacheKey: cacheSave?.key,
        answerCacheSaveStatus: cacheSave ? cacheSaveStatus(cacheSave) : cacheStatusWithoutSave(answerCacheEnabled, cacheEligibility, true),
        answerCacheSkipReason: cacheSave?.skipReason || cacheEligibility.reason,
        answerCacheError: cacheSave?.durableError,
        deployVersion: process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "local",
        slow: totalMs >= 2500,
        openAiUsed: false,
        supabaseUsed: true,
      },
      createdAt: new Date().toISOString(),
    });
    return new Response(textStream(earlyApprovedRuleAnswer), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }
  let searchResult: {
    products: CatalogProduct[];
    found: number;
    searchQuery?: string;
    language?: string;
    timings?: {
      totalMs?: number;
      supabaseMs?: number;
      openAiMs?: number;
      typesenseMs?: number;
      fallbackMs?: number;
    };
  };
  let skuSuggestion: Awaited<ReturnType<typeof closeSkuSuggestion>> = null;
  if (pageProductsForCart.length) {
    searchResult = { products: pageProductsForCart, found: pageProductsForCart.length };
  } else if (aedAccessorySkus.length) {
    const skuProducts = (
      await Promise.all(
        aedAccessorySkus.map(async (sku) => {
          const matches = await searchBySKU(sku);
          return matches;
        })
      )
    ).flat();
    searchResult = skuProducts.length
      ? { products: skuProducts, found: skuProducts.length, searchQuery: aedAccessorySkus.join(", "), language }
      : await searchProducts({ query: searchQuery, language, limit: 8 });
  } else if (skuCandidates.length) {
    const skuProducts = (
      await Promise.all(
        skuCandidates.map(async (sku) => {
          const matches = await searchBySKU(sku);
          return matches;
        })
      )
    ).flat();
    if (skuProducts.length) {
      searchResult = { products: skuProducts, found: skuCandidates.length };
    } else {
      skuSuggestion = await closeSkuSuggestion(skuCandidates, language);
      if (skuSuggestion) {
        searchQuery = skuSuggestion.suggestedSku;
        searchResult = {
          products: skuSuggestion.products,
          found: skuSuggestion.products.length,
          searchQuery,
          language,
        };
      } else if (isReplacementPartRequest(latest)) {
        // A failed replacement-part reference must not fall back to a broad
        // keyword search. Broad recovery is how unrelated catalog products
        // previously got presented as a replacement blade.
        searchResult = { products: [], found: 0, searchQuery: skuCandidates.join(", "), language };
      } else if (hasProductWordsBeyondSku(latest, skuCandidates)) {
        searchQuery = searchQueryForLatest(messages, latest, []);
        searchResult = await searchProducts({ query: searchQuery, language, limit: 8 });
      } else {
        searchResult = { products: [], found: 0, searchQuery: skuCandidates.join(", "), language };
      }
    }
  } else if (rememberedContextProducts.length) {
    searchResult = { products: rememberedContextProducts, found: rememberedContextProducts.length };
  } else if (preSearchSkuProducts.length) {
    searchQuery = preSearchSkus.join(", ");
    searchResult = { products: preSearchSkuProducts, found: preSearchSkuProducts.length, searchQuery, language };
  } else if (preSearchRuleSearchQuery) {
    searchQuery = preSearchRuleSearchQuery;
    searchResult = await searchProducts({ query: searchQuery, language, limit: 12 });
  } else {
    searchResult = await searchProducts({ query: searchQuery, language, limit: 8 });
  }
  searchTiming = {
    ...(searchResult.timings || {}),
    totalMs: (searchResult.timings?.totalMs || 0) + preSearchSkuMs,
    supabaseMs: (searchResult.timings?.supabaseMs || 0) + preSearchKnowledgeMs,
  };
  let products = searchResult.products;
  const shouldSelectRememberedContextProduct =
    rememberedContextProducts.length > 0 &&
    isContextProductSelectionReply(latest) &&
    !shouldHandleCart &&
    !shouldCompareRememberedProducts &&
    !shouldFilterRememberedProducts;
  if (shouldSelectRememberedContextProduct) {
    const selectedProducts = selectContextProducts(latest, products);
    if (selectedProducts.length && selectedProducts.length < products.length) {
      products = selectedProducts;
    }
  }
  const colorFallback = await colorFallbackSearch({ latest, searchQuery, products, language });
  if (colorFallback) {
    products = colorFallback.products;
  } else {
    products = rankRequestedColorProducts(products, `${latest} ${searchQuery}`);
  }
  const intentFilteredProducts = productsMatchingExplicitIntent(products, latest, searchQuery);
  let suppressedLowConfidenceProducts = intentFilteredProducts.suppressed;
  products = intentFilteredProducts.products;

  let aiKeywordRecoveryReason = "";
  let aiKeywordRecoverySaved = false;
  let aiKeywordRecoveryAttemptedQueries: string[] = [];
  let aiKeywordPlannerMs = 0;
  let aiKeywordPlannerReason = "";
  let aiKeywordPlan: CatalogSearchPlan | null | undefined = broadIntentPlan;
  const canTryAiKeywordRecovery = shouldUseAiKeywordRecovery({
    latest,
    skuCandidates,
    taughtQuoteIntent,
    taughtOrderStatusIntent,
    taughtContactIntent,
    taughtAvailabilityIntent,
  });
  const saveAiKeywordMappingForReview = async (
    reason: string,
    resolvedSearchQuery: string,
    resolvedProducts: CatalogProduct[],
    attemptedQueries: string[]
  ) => {
    if (normalizeSearchText(resolvedSearchQuery) === normalizeSearchText(latest)) return;
    try {
      await saveKnowledgeMemoryItem({
        id: autoKeywordMemoryId(latest),
        type: "alias",
        status: "needs_review",
        query: latest,
        correctSearchTerms: resolvedSearchQuery,
        correctSku: resolvedProducts.length <= 3 ? resolvedProducts[0]?.sku || "" : "",
        note: `Auto-suggested from OpenAI keyword recovery (${reason}). Review before approving. Tried: ${attemptedQueries.join(" | ")}`,
      });
      aiKeywordRecoverySaved = true;
    } catch (error) {
      console.warn("[EMRN Pulse] AI keyword memory save skipped", error);
    }
  };
  const tryAiKeywordRecovery = async (reason: string) => {
    if (!canTryAiKeywordRecovery) return false;
    if (aiKeywordPlan === undefined) {
      const plannerStartedAt = Date.now();
      aiKeywordPlan = await planCatalogSearch({ messages, language, sessionId, query: latest });
      aiKeywordPlannerMs += Date.now() - plannerStartedAt;
    }
    const plan = aiKeywordPlan;
    if (plan && ["product_search", "product_question"].includes(plan.intent) && plan.searchTerms.length) {
      aiKeywordPlannerReason = plan.reason;
      const plannedQueries = catalogPlanQueries(plan, latest);
      aiKeywordRecoveryAttemptedQueries = plannedQueries;
      for (const plannedQuery of plannedQueries) {
        const plannedResult = await searchProducts({ query: plannedQuery, language, limit: 8 });
        searchTiming = {
          totalMs: (searchTiming.totalMs || 0) + (plannedResult.timings?.totalMs || 0),
          supabaseMs: (searchTiming.supabaseMs || 0) + (plannedResult.timings?.supabaseMs || 0),
          openAiMs: (searchTiming.openAiMs || 0) + (plannedResult.timings?.openAiMs || 0),
          typesenseMs: (searchTiming.typesenseMs || 0) + (plannedResult.timings?.typesenseMs || 0),
          fallbackMs: (searchTiming.fallbackMs || 0) + (plannedResult.timings?.fallbackMs || 0),
        };
        const plannedProducts = productsMatchingSearchPlan(plannedResult.products, plan, latest);
        const filtered = productsMatchingExplicitIntent(plannedProducts, latest, plannedQuery);
        const candidateProducts = filtered.products.length ? filtered.products : plannedProducts;
        if (candidateProducts.length) {
          products = candidateProducts;
          searchQuery = plannedQuery;
          suppressedLowConfidenceProducts = false;
          aiKeywordRecoveryReason = `OpenAI planner: ${reason}`;
          await saveAiKeywordMappingForReview(aiKeywordRecoveryReason, plannedQuery, candidateProducts, plannedQueries);
          return true;
        }
      }
    }
    const recovered = await recoverExplicitIntentProducts(latest, searchQuery, language);
    aiKeywordRecoveryAttemptedQueries = recovered.attemptedQueries || [];
    searchTiming = {
      totalMs: (searchTiming.totalMs || 0) + (recovered.timings?.totalMs || 0),
      supabaseMs: (searchTiming.supabaseMs || 0) + (recovered.timings?.supabaseMs || 0),
      openAiMs: (searchTiming.openAiMs || 0) + (recovered.timings?.openAiMs || 0),
      typesenseMs: (searchTiming.typesenseMs || 0) + (recovered.timings?.typesenseMs || 0),
      fallbackMs: (searchTiming.fallbackMs || 0) + (recovered.timings?.fallbackMs || 0),
    };
    const assistantRecoveryMatched = assistantRecoveryQueries(latest)
      .map((query) => normalizeSearchText(query))
      .includes(normalizeSearchText(recovered.searchQuery));
    if (!recovered.products.length || (!assistantRecoveryMatched && weakProductSearchResult(recovered.products, latest, recovered.searchQuery))) {
      return false;
    }
    products = recovered.products;
    searchQuery = recovered.searchQuery;
    suppressedLowConfidenceProducts = false;
    aiKeywordRecoveryReason = reason;
    await saveAiKeywordMappingForReview(reason, recovered.searchQuery, recovered.products, aiKeywordRecoveryAttemptedQueries);
    return true;
  };

  if (suppressedLowConfidenceProducts) {
    await tryAiKeywordRecovery("suppressed low-confidence product matches");
  }
  if (weakProductSearchResult(products, latest, searchQuery)) {
    products = [];
    suppressedLowConfidenceProducts = true;
    await tryAiKeywordRecovery("weak product search result");
  }
  if (!products.length) {
    await tryAiKeywordRecovery("no product search result");
  }
  const shouldRememberAiSearch =
    canTryAiKeywordRecovery &&
    !aiKeywordRecoveryReason &&
    (searchTiming.openAiMs || 0) > 0 &&
    products.length > 0 &&
    !weakProductSearchResult(products, latest, searchQuery) &&
    normalizeSearchText(searchQuery) !== normalizeSearchText(latest);
  if (shouldRememberAiSearch) {
    aiKeywordRecoveryReason = "OpenAI search helper";
    aiKeywordRecoveryAttemptedQueries = [searchQuery];
    await saveAiKeywordMappingForReview("OpenAI search helper", searchQuery, products, aiKeywordRecoveryAttemptedQueries);
  }
  products = rankProductsForAnswer(products, latest);
  const missingColorFallback = colorFallback || missingRequestedColorProducts(products, latest);

  await logAnalyticsEvent({
    type: products.length ? "product_search" : "no_result_search",
    sessionId,
    language,
    query: searchQuery,
    productIds: products.map((product) => product.productId),
    createdAt,
  });

  if (missingColorFallback) {
    return new Response(textStream(colorFallbackText(missingColorFallback.products, missingColorFallback.requestedColor, language, missingColorFallback.strippedQuery)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const knowledgeStartedAt = Date.now();
  if ((await knowledgeShadowEnabled()) && shouldCheckKnowledgeEvidence(latest)) {
    const knowledge = await buildKnowledgeEvidence(latest, products, language);
    if (knowledge.kind !== "none") {
      await logAnalyticsEvent({
        type: "knowledge_shadow",
        sessionId,
        language,
        query: latest,
        productIds: products.slice(0, 5).map((product) => product.productId),
        knowledge,
        createdAt,
      });
    }
  }
  knowledgeMs = Date.now() - knowledgeStartedAt;

  const logPerformance = async (
    answerPath: string,
    extra?: {
      openAiMs?: number;
      openAiUsed?: boolean;
      answerPreview?: string;
      proofSourceType?: string;
      proofSourceUrls?: string[];
      proofPartNumbers?: string[];
      proofSearchTerms?: string[];
      emrnMatchCount?: number;
      emrnMatchedSkus?: string[];
    }
  ) => {
    const totalMs = Date.now() - requestStartedAt;
    const answerText = extra?.answerPreview || "";
    const cacheSave = canUseAnswerCache && answerText
      ? await saveCachedAnswer({
          query: latest,
          language,
          answer: answerText,
          answerPath,
          searchQuery,
          productIds: products.slice(0, 8).map((product) => product.productId),
          productSkus: products.slice(0, 8).map((product) => product.sku).filter(Boolean),
        })
      : null;
    await logAnalyticsEvent({
      type: "assistant_performance",
      sessionId,
      language,
      query: latest,
      productIds: products.slice(0, 8).map((product) => product.productId),
      performance: {
        totalMs,
        searchMs: searchTiming.totalMs || 0,
        supabaseMs: searchTiming.supabaseMs || 0,
        openAiMs: (searchTiming.openAiMs || 0) + aiKeywordPlannerMs + (extra?.openAiMs || 0),
        knowledgeMs,
        productCount: products.length,
        searchQuery,
        answerPath,
        answerPreview: answerPreviewText(answerText),
        proofSourceType: extra?.proofSourceType,
        proofSourceUrls: extra?.proofSourceUrls?.slice(0, 8),
        proofPartNumbers: extra?.proofPartNumbers?.slice(0, 12),
        proofSearchTerms: [
          ...(extra?.proofSearchTerms || []),
          ...(aiKeywordRecoveryReason ? [`AI keyword recovery: ${aiKeywordRecoveryReason}`] : []),
          ...(aiKeywordPlannerReason ? [`AI planner reason: ${aiKeywordPlannerReason}`] : []),
          ...(aiKeywordRecoverySaved ? ["AI keyword mapping saved for review"] : []),
          ...aiKeywordRecoveryAttemptedQueries,
          ...(suppressedLowConfidenceProducts ? ["suppressed low-confidence product matches"] : []),
        ].slice(0, 12),
        emrnMatchCount: extra?.emrnMatchCount,
        emrnMatchedSkus: extra?.emrnMatchedSkus?.slice(0, 12),
        answerCacheEligible: canUseAnswerCache,
        answerCacheHit: false,
        answerCacheKey: cacheSave?.key,
        answerCacheSaveStatus: cacheSave ? cacheSaveStatus(cacheSave) : cacheStatusWithoutSave(answerCacheEnabled, cacheEligibility, Boolean(answerText)),
        answerCacheSkipReason: cacheSave?.skipReason || cacheEligibility.reason,
        answerCacheError: cacheSave?.durableError,
        deployVersion: process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || "local",
        slow: totalMs >= 2500 || (searchTiming.totalMs || 0) >= 1500 || ((searchTiming.openAiMs || 0) + aiKeywordPlannerMs + (extra?.openAiMs || 0)) >= 1200,
        openAiUsed: Boolean(extra?.openAiUsed || (searchTiming.openAiMs || 0) > 0 || aiKeywordPlannerMs > 0),
        supabaseUsed: Boolean((searchTiming.supabaseMs || 0) > 0),
      },
      createdAt: new Date().toISOString(),
    });
  };

  if (isAccountIntent(latest) && !looksLikeSpecificProductSearch(latest)) {
    const accountAnswer = language === "fr"
      ? "Vous pouvez créer ou utiliser un compte EMRN depuis la section compte du site. Pour les comptes d’entreprise, les prix spéciaux ou l’accès Buyer Portal, notre équipe doit vérifier les détails de votre organisation. Vous pouvez consulter la FAQ ici: https://emrn.ca/faq-s/ ou je peux envoyer votre demande à notre équipe. Veuillez m’envoyer votre nom, votre courriel et votre question."
      : "You can create or use an EMRN account from the account area of the site. For business accounts, preferred pricing, or Buyer Portal access, our team needs to review your organization details. You can also check the FAQ here: https://emrn.ca/faq-s/ or I can send your request to our team. Please send your name, email, and question.";
    await logPerformance("account_help", { answerPreview: accountAnswer });
    await logAnalyticsEvent({ type: "support_escalation", sessionId, language, query: latest, createdAt });
    return new Response(
      textStream(accountAnswer),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (shouldCompareRememberedProducts && products.length) {
    const comparison = compareProductsText(products, language, latest);
    if (comparison) {
      await logPerformance("compare_products", { answerPreview: comparison });
      return new Response(textStream(comparison), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  if (shouldFilterRememberedProducts && products.length) {
    const filteredProducts = filterProductsFromText(products, latest);
    if (filteredProducts.length) {
      const filteredAnswer = productResultsText(filteredProducts, language, searchQuery);
      await logPerformance("filter_results", { answerPreview: filteredAnswer });
      return new Response(textStream(filteredAnswer), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(
      textStream(
        language === "fr"
          ? "Je n’ai pas trouvé d’option correspondant à ce filtre dans les résultats affichés. Je peux essayer une nouvelle recherche si vous me donnez la marque, taille ou usage."
          : "I did not find an option matching that filter in the results shown. I can try a fresh search if you give me the brand, size, or use."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (shouldHandleCart && products.length) {
    const selectedProducts = selectProductsForCart(latest, products);
    const purchasableProducts = selectedProducts.filter((product) => product.purchasable && !product.quoteOnly);
    const blockedProducts = selectedProducts.filter((product) => product.quoteOnly || !product.purchasable);
    const requestedQuantity = replyingToCartQuantity
      ? Number(latest.trim())
      : replyingToCartQuantityChange
        ? quantityFromChangeReply(latest)
        : extractQuantity(latest);

    if (selectedProducts.length > 1 && !allowsMultipleCartItems(latest)) {
      return new Response(
        textStream(
          language === "fr"
            ? `Je vois plusieurs options. Laquelle voulez-vous ajouter au panier? ${selectedProducts
                .slice(0, 5)
                .map((product) => `${product.name} (${product.sku})`)
                .join("; ")}`
            : `I see a few options. Which one would you like added to cart? ${selectedProducts
                .slice(0, 5)
                .map((product) => `${product.name} (${product.sku})`)
                .join("; ")}`
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    if (blockedProducts.length && !purchasableProducts.length) {
      return new Response(
        textStream(
          language === "fr"
            ? "Cet article nécessite une soumission de notre équipe des ventes. Je ne peux pas l’ajouter au panier ni générer un lien de paiement. Je peux vous aider à demander un devis."
            : "This item requires a quotation from our sales team. I cannot add it to cart or generate a checkout link. I can help you request a quote."
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    if (
      isSelectionWithoutQuantity(latest) &&
      selectedProducts.length === 1 &&
      purchasableProducts.length === 1 &&
      !priorAssistantAskedCartQuantity(messages)
    ) {
      const selected = purchasableProducts[0];
      return new Response(
        textStream(
          language === "fr"
            ? `D’accord, je peux ajouter **${selected.name}** (SKU: ${selected.sku}) au panier. Quelle quantité voulez-vous?`
            : `Sure, I can add **${selected.name}** (SKU: ${selected.sku}) to your cart. How many would you like?`
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    const trackedCart = trackedCarts.get(sessionId);
    const previousCartSkus = trackedCart?.items.length ? new Map<string, number>() : checkoutSkusFromConversation(messages);
    const previousCartProducts = trackedCart?.items.length
      ? cartProductsFromTrackedCart(trackedCart)
      : (
          await Promise.all(
            Array.from(previousCartSkus.keys()).map(async (sku) => {
              const [product] = await searchBySKU(sku);
              return product ? { product, quantity: previousCartSkus.get(sku) || 1 } : null;
            })
          )
        ).filter((item): item is { product: (typeof purchasableProducts)[number]; quantity: number } => Boolean(item));
    const selectedSkuSet = new Set(purchasableProducts.map((product) => product.sku.toUpperCase()));
    const cartProducts = [
      ...previousCartProducts.filter((item) => item && !selectedSkuSet.has(item.product.sku.toUpperCase())),
      ...purchasableProducts.map((product) => ({
        product,
        quantity: quantityForProductSelection(latest, product, products.indexOf(product), requestedQuantity),
      })),
    ];
    const newCartProducts = purchasableProducts.map((product) => ({
      product,
      quantity: quantityForProductSelection(latest, product, products.indexOf(product), requestedQuantity),
    }));
    const newBrowserLineItems = newCartProducts.slice(0, 8).map(({ product, quantity }) => ({
      productId: product.productId,
      variantId: product.variantId || undefined,
      quantity,
    }));

    const cart = await createCart({
      sessionId,
      items: cartProducts.slice(0, 8).map(({ product, quantity }) => ({
        productId: product.productId,
        variantId: product.variantId || undefined,
        quantity,
      })),
    });

    if (cart.checkoutUrl) {
      const lineItems =
        cart.lineItems ||
        cartProducts.slice(0, 8).map(({ product, quantity }) => ({
          productId: product.productId,
          variantId: product.variantId || undefined,
          quantity,
        }));
      rememberCartState(sessionId, cartProducts, lineItems, cart.checkoutUrl);
      return new Response(
        textStream(`${cartReadyText(newCartProducts.length, lineItems, language, cartProducts, cart.checkoutUrl, newBrowserLineItems)}${quoteSplitText(blockedProducts, language)}`),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    return new Response(
      textStream(
        language === "fr"
          ? "Je n’ai pas pu créer le panier automatiquement pour le moment. Les articles admissibles peuvent être achetés en ligne depuis leurs pages produit, et je peux envoyer les articles non admissibles à l’équipe des ventes pour un devis."
          : "I could not create the cart automatically right now. Eligible items can still be purchased online from their product pages, and I can send any non-eligible items to sales for a quote."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  const shouldSendPriorQuoteDraft = priorAssistantPresentedQuoteDraft(messages) && isQuoteDraftSendConfirmation(latest);
  if (!shouldContinueMissingProductFlow && (isQuoteIntent(latest) || taughtQuoteIntent || shouldContinuePriorQuoteFlow || shouldContinueItemRequestFlow || shouldSendPriorQuoteDraft)) {
    const draft = buildQuoteDraft(messages, language, products);
    if (draft.request) {
      const quoteDraftAlreadyShown = priorAssistantPresentedQuoteDraft(messages);
      if (!quoteDraftAlreadyShown || !isQuoteDraftSendConfirmation(latest)) {
        const quoteDraftAnswer = quoteDraftText(draft.request, language);
        await logPerformance("quote_draft_ready", { answerPreview: quoteDraftAnswer });
        return new Response(textStream(quoteDraftAnswer), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }

      const quoteEmailResult = await sendQuoteRequestEmail(draft.request);
      await runAssistantSideEffects("quote request", [
        logQuoteRequest(draft.request),
        Promise.resolve(quoteEmailResult),
        logAnalyticsEvent({ type: "quote_request", sessionId, language, query: searchQuery, createdAt }),
      ]);
      const quoteSentAnswer = quoteEmailResult.sent
        ? language === "fr"
          ? "Merci. Votre demande a été envoyée à notre équipe des ventes. Nous vérifierons l’article et vous contacterons sous peu."
          : "Thank you. Your request has been sent to our sales team. We will check the item and contact you shortly."
        : language === "fr"
          ? "Votre demande a été enregistrée, mais le courriel n’a pas pu être envoyé. L’équipe doit vérifier la configuration du domaine de courriel avant de recevoir les demandes. Veuillez nous contacter directement pour le suivi."
          : "Your quote request was recorded, but the email could not be delivered. The team must verify the email domain configuration before receiving requests. Please contact us directly for follow-up.";
      await logPerformance(quoteEmailResult.sent ? "quote_request_sent" : "quote_request_email_failed", { answerPreview: quoteSentAnswer });
      return new Response(textStream(quoteSentAnswer), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    const quoteMissingAnswer = quoteMissingText(draft.missing, language);
    await logPerformance("quote_missing_fields", { answerPreview: quoteMissingAnswer });
    return new Response(textStream(quoteMissingAnswer), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!products.length) {
    const missingColorSku = skuCandidates.find((sku) => colorFromSkuSuffix(sku) && familySearchForMissingColorSku(sku));
    if (missingColorSku) {
      const familyProducts = (await searchProducts({ query: familySearchForMissingColorSku(missingColorSku), language, limit: 8 })).products;
      if (familyProducts.length) {
        const colorAnswer = colorFallbackText(familyProducts, colorFromSkuSuffix(missingColorSku), language, latest);
        await logPerformance("color_fallback", { answerPreview: colorAnswer });
        return new Response(textStream(colorAnswer), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }
    const fallbackKnowledgeMatches = preSearchKnowledgeMatches.length
      ? preSearchKnowledgeMatches
      : await matchingApprovedKnowledgeForQuery(latest);
    const colorKnowledge = fallbackKnowledgeMatches.find((item) => item.type === "color_option" && item.correctSearchTerms);
    if (colorKnowledge?.correctSearchTerms) {
      const colorProducts = (await searchProducts({ query: colorKnowledge.correctSearchTerms, language, limit: 8 })).products;
      const availableColorProducts = colorProducts.length ? colorProducts : products;
      const requestedColor =
        latest.match(/\b(orange|red|blue|green|yellow|black|white|purple|pink|grey|gray|brown|tan|navy)\b/i)?.[1]?.toLowerCase() ||
        colorKnowledge.query.match(/\b(orange|red|blue|green|yellow|black|white|purple|pink|grey|gray|brown|tan|navy)\b/i)?.[1]?.toLowerCase() ||
        "requested";
      if (availableColorProducts.length) {
        const colorAnswer = colorFallbackText(availableColorProducts, requestedColor, language, latest);
        await logPerformance("color_fallback", { answerPreview: colorAnswer });
        return new Response(textStream(colorAnswer), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }

    // Replacement parts require an exact catalog match. If EMRN has no exact
    // result, use the trusted AI lookup to verify the manufacturer part, but
    // never turn a related catalog result into a recommendation.
    const hasPriorProductContext = messages.slice(0, -1).some((message) =>
      message.role === "assistant" && /\b(?:SKU|product|produit|article|item|view product|voir le produit)\b/i.test(message.content)
    );
    if ((isReplacementPartRequest(latest) || (shouldUseProductDetailIntent && hasPriorProductContext)) && (await assistantFeatureEnabledAsync("externalKnowledgeEnabled"))) {
      const openAiStartedAt = Date.now();
      const externalLookup = await lookupExternalKnowledge({
        messages,
        products: [],
        language,
        sessionId,
        query: latest,
      });
      if (externalLookup) {
        const externalAnswer = externalLookupCustomerAnswer(externalLookup, [], language, { question: latest });
        await logPerformance("replacement_part_external_no_match", {
          openAiMs: Date.now() - openAiStartedAt,
          openAiUsed: true,
          answerPreview: externalAnswer,
          proofSourceType: externalLookup.sourceType,
          proofSourceUrls: externalLookup.sourceUrls,
          proofPartNumbers: externalLookupPartNumbers(externalLookup),
          proofSearchTerms: externalLookupSearchTerms(externalLookup),
          emrnMatchCount: 0,
          emrnMatchedSkus: [],
        });
        return new Response(textStream(externalAnswer), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }
    if (!skuCandidates.length && isProductSearchIntent(latest) && !isQuoteIntent(latest) && !taughtQuoteIntent && !isOrderStatusIntent(latest) && !taughtOrderStatusIntent && !isContactIntent(latest) && !taughtContactIntent) {
      const suggestion = await keywordSuggestion(latest, language);
      if (suggestion) {
        const suggestionAnswer = keywordSuggestionText(suggestion, language);
        await logPerformance("keyword_did_you_mean", {
          answerPreview: suggestionAnswer,
          proofSearchTerms: [suggestion.originalQuery, suggestion.suggestedQuery],
          emrnMatchedSkus: suggestion.products.map((product) => product.sku).filter(Boolean),
        });
        return new Response(textStream(suggestionAnswer), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }
    await logAnalyticsEvent({ type: "unanswered_question", sessionId, language, query: latest, createdAt });
    const fallbackSearchUrl = siteSearchUrl(searchQuery || latest);
    const skuText = skuCandidates.length ? ` SKU/part number ${skuCandidates.join(", ")}` : "";
    const noProductsAnswer = language === "fr"
      ? `Je n’ai pas pu confirmer${skuText ? ` le${skuText}` : " ce produit"} dans Pulse. Pouvez-vous envoyer une photo, la marque, le modèle, le numéro de pièce, ou une description de l’usage?\n\nVous pouvez aussi essayer la [recherche manuelle](${fallbackSearchUrl}).\n\nJe peux envoyer cette demande au support pour vérifier l’article ou préparer une demande de devis.`
      : `I could not confirm${skuText ? ` the${skuText}` : " this item"} in Pulse. Can you send a photo, brand, model number, part number, or what it is used for?\n\nYou can also try the [manual search](${fallbackSearchUrl}).\n\nI can send this to support to check the item or prepare a quote request.`;
    await logPerformance("no_products", { answerPreview: noProductsAnswer });
    return new Response(
      textStream(noProductsAnswer),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (products.length) {
    await logAnalyticsEvent({
      type: "product_recommended",
      sessionId,
      language,
      productIds: products.slice(0, 5).map((product) => product.productId),
      createdAt,
    });
  }

  if (skuSuggestion && products.length) {
    const suggestionAnswer = skuSuggestionText(skuSuggestion, language);
    await logPerformance("sku_did_you_mean", {
      answerPreview: suggestionAnswer,
      proofSearchTerms: [skuSuggestion.originalSku, skuSuggestion.suggestedSku],
      emrnMatchedSkus: products.map((product) => product.sku).filter(Boolean),
    });
    return new Response(textStream(suggestionAnswer), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (shouldUseProductDetailIntent) {
    const rememberedDetailProducts = await recentAssistantProducts(messages);
    const shouldUseRememberedDetailProducts =
      rememberedDetailProducts.length > 0 &&
      isContextProductSelectionReply(latest) &&
      !extractSkuCandidates(latest).length;
    const detailProducts = await refreshProductsBySku(shouldUseRememberedDetailProducts ? rememberedDetailProducts : products);
    const selectedDetailProducts = selectContextProducts(latest, detailProducts);
    const catalogDetailCandidates = catalogDetailCandidateProducts(latest, selectedDetailProducts.length ? selectedDetailProducts : detailProducts).slice(0, 8);
    for (const product of catalogDetailCandidates) {
      const catalogAnswer = productDetailFromCatalog(product, latest, language);
      if (catalogAnswer) {
        await logPerformance("catalog_detail", { answerPreview: catalogAnswer });
        return new Response(textStream(catalogAnswer), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }
    const approvedKnowledgeMatches = preSearchKnowledgeMatches.length ? preSearchKnowledgeMatches : await matchingApprovedKnowledgeForQuery(latest);
    const ruleAnswer = isDirectCatalogDetailQuestion(latest)
      ? ""
      : approvedKnowledgeAnswer(approvedKnowledgeMatches, selectedDetailProducts.length ? selectedDetailProducts : detailProducts, language, latest);
    if (ruleAnswer) {
      await logPerformance("approved_knowledge", { answerPreview: ruleAnswer });
      return new Response(textStream(ruleAnswer), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    const trustedCompatibilitySkus = Array.from(
      new Set([
        ...aedAccessorySkus,
        ...skuCandidates,
        ...approvedKnowledgeMatches
          .flatMap((item) => knowledgeRuleSkus(item))
          .filter(Boolean),
      ].map((sku) => sku.toUpperCase()))
    );
    const localCompatibilityAnswer = isDirectCatalogDetailQuestion(latest)
      ? ""
      : catalogCompatibilityAnswerFromProducts(
          selectedDetailProducts.length ? selectedDetailProducts : detailProducts,
          latest,
          language,
          trustedCompatibilitySkus
        );

    if (localCompatibilityAnswer) {
      await logPerformance("emrn_compatibility", { answerPreview: localCompatibilityAnswer });
      return new Response(textStream(localCompatibilityAnswer), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (!isDirectCatalogDetailQuestion(latest) && isCompatibilityQuestion(latest) && selectedDetailProducts.length === 1) {
      const compatibilityAnswer = catalogCompatibilityAnswer(selectedDetailProducts[0], latest, language);
      if (compatibilityAnswer && !/^Can’t confirm:|^Can.t confirm:|^Je ne peux pas confirmer/i.test(compatibilityAnswer)) {
        await logPerformance("catalog_compatibility", { answerPreview: compatibilityAnswer });
        return new Response(textStream(compatibilityAnswer), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }

    if (isPartsOrAccessoryQuestion(latest) && (!isCompatibilityQuestion(latest) || asksForAccessories(latest)) && detailProducts.length) {
      const [selectedProduct] = selectedDetailProducts;
      const baseProduct = selectedProduct || detailProducts[0];
      const partsQueries = relatedPartQueries(baseProduct);
      const partsResults = await Promise.all(partsQueries.map((query) => searchProducts({ query, language, limit: 8 })));
      const seenPartSkus = new Set<string>();
      const relatedParts = partsResults
        .flatMap((result) => result.products)
        .filter((product) => product.sku !== baseProduct.sku)
        .filter((product) => isRelatedPartForProduct(product, baseProduct))
        .filter((product) => !asksForAccessories(latest) || (isAccessoryLikeProduct(product) && !isSameMainProductFamily(product, baseProduct)))
        .filter((product) => {
          const key = product.sku || `${product.productId}:${product.variantId}`;
          if (seenPartSkus.has(key)) return false;
          seenPartSkus.add(key);
          return true;
        });
      if (relatedParts.length) {
        const intro = language === "fr"
          ? `Voici les pièces/accessoires EMRN que j’ai trouvés pour **${baseProduct.name}** (SKU: ${baseProduct.sku}):`
          : `Here are EMRN parts/accessories I found for **${baseProduct.name}** (SKU: ${baseProduct.sku}):`;
        const relatedAnswer = `${intro}\n\n${productResultsText(relatedParts.slice(0, 6), language, partsQueries[0]).replace(/^Here are the products I found for .+?:\n\n/i, "").replace(/\n\nIf you tell me[\s\S]*$/i, "")}`;
        await logPerformance("related_parts", { answerPreview: relatedAnswer });
        return new Response(textStream(relatedAnswer), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }

    const externalKnowledgeEnabled = await assistantFeatureEnabledAsync("externalKnowledgeEnabled");
    if (!externalKnowledgeEnabled) {
      const externalOffAnswer = externalKnowledgeDisabledText(detailProducts, language);
      await logPerformance("external_knowledge_off", { answerPreview: externalOffAnswer });
      return new Response(textStream(externalOffAnswer), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const openAiStartedAt = Date.now();
    const externalLookup = await lookupExternalKnowledge({
      messages,
      products: detailProducts,
      language,
      sessionId,
      query: latest,
    });
    if (externalLookup) {
      const directSkuProducts = skuCandidates.length
        ? detailProducts.filter((product) => skuCandidates.some((sku) => skuMatchesWithSellableSuffix(product.sku || "", sku)))
        : [];
      const focusedExternalProduct =
        selectedDetailProducts.length === 1
          ? selectedDetailProducts[0]
          : directSkuProducts.length === 1
            ? directSkuProducts[0]
            : undefined;
      const contextProductPool = focusedExternalProduct ? [focusedExternalProduct] : [];
      const recoveredProducts = await findEmrnProductsForExternalLookup(externalLookup, language, contextProductPool);
      const contextProducts = externalLookupContextProductMatches(externalLookup, contextProductPool);
      const emrnLookupProducts = dedupeCatalogProductsBySku([...contextProducts, ...recoveredProducts]);
      const finalExternalLookup = shouldTrustG3OxygenCylinderProof(externalLookup, focusedExternalProduct, latest)
        ? {
            ...externalLookup,
            status: "confirmed" as const,
            summary: "The G3+ Load-N-Go backpack can accommodate an M6 oxygen cylinder",
          }
        : externalLookup;
      const externalAnswer = externalLookupCustomerAnswer(finalExternalLookup, emrnLookupProducts, language, {
        focusedProduct: focusedExternalProduct,
        question: latest,
      });
      await logPerformance("external_knowledge_structured", {
        openAiMs: Date.now() - openAiStartedAt,
        openAiUsed: true,
        answerPreview: externalAnswer,
        proofSourceType: finalExternalLookup.sourceType,
        proofSourceUrls: finalExternalLookup.sourceUrls,
        proofPartNumbers: externalLookupPartNumbers(finalExternalLookup),
        proofSearchTerms: externalLookupSearchTerms(finalExternalLookup),
        emrnMatchCount: emrnLookupProducts.length,
        emrnMatchedSkus: emrnLookupProducts.map((product) => product.sku).filter(Boolean),
      });
      await logAnalyticsEvent({
        type: "conversation_completed",
        sessionId,
        language,
        messageCount: messages.length,
        createdAt: new Date().toISOString(),
      });
      return new Response(textStream(externalAnswer), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    const stream = await streamAssistantResponse({
      messages,
      products: detailProducts,
      language,
      sessionId,
      query: searchQuery,
      trustedWebSearch: true,
    });
    const fallbackText = await streamToText(stream);
    const extractedLookup = externalLookupFromAnswerText(fallbackText, latest);
    if (extractedLookup) {
      const emrnLookupProducts = await findEmrnProductsForExternalLookup(extractedLookup, language, detailProducts);
      const extractedAnswer = externalLookupCustomerAnswer(extractedLookup, emrnLookupProducts, language, { question: latest });
      await logPerformance("external_knowledge_extracted", {
        openAiMs: Date.now() - openAiStartedAt,
        openAiUsed: true,
        answerPreview: extractedAnswer,
        proofSourceType: extractedLookup.sourceType,
        proofSourceUrls: extractedLookup.sourceUrls,
        proofPartNumbers: externalLookupPartNumbers(extractedLookup),
        proofSearchTerms: externalLookupSearchTerms(extractedLookup),
        emrnMatchCount: emrnLookupProducts.length,
        emrnMatchedSkus: emrnLookupProducts.map((product) => product.sku).filter(Boolean),
      });
      await logAnalyticsEvent({
        type: "conversation_completed",
        sessionId,
        language,
        messageCount: messages.length,
        createdAt: new Date().toISOString(),
      });
      return new Response(textStream(extractedAnswer), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    await logPerformance("external_knowledge", { openAiMs: Date.now() - openAiStartedAt, openAiUsed: true, answerPreview: fallbackText });
    await logAnalyticsEvent({
      type: "conversation_completed",
      sessionId,
      language,
      messageCount: messages.length,
      createdAt: new Date().toISOString(),
    });

    return new Response(textStream(fallbackText), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (products.length === 1) {
    const exactProduct = products[0];
    const substitutes = await closeInStockSubstitutes(exactProduct, language);
    const singleProductAnswer = `${exactProductFoundText(exactProduct, language, skuCandidates[0] || searchQuery)}${substitutesText(substitutes, language)}`;
    await saveSuccessfulAiSearchRewrite({ latest, searchQuery, products, openAiMs: searchTiming.openAiMs });
    await logPerformance("single_product", { answerPreview: singleProductAnswer });
    return new Response(textStream(singleProductAnswer), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  let answerProducts = products;
  if (isKitQuery(searchQuery) && !hasCompleteKitForQuery(products.slice(0, 5), searchQuery)) {
    const subject = kitQuerySubject(searchQuery);
    const kitRecoveryQueries = subject
      ? [subject, `${subject} kit`, `${subject} supplies`, `${subject} accessories`]
      : [];
    if (/\bphlebotomy|venipuncture\b/i.test(subject)) {
      kitRecoveryQueries.push("Phlebotomy sharps container", "Phlebotomy caddy", "Phlebotomy task trainer");
    }
    const broaderKitResults = await Promise.all(
      Array.from(new Set(kitRecoveryQueries)).map((query) => searchProducts({ query, language, limit: 8 }))
    );
    const broaderKitProducts = broaderKitResults.flatMap((result) => result.products);
    answerProducts = rankKitProducts(
      dedupeCatalogProductsBySku([...broaderKitProducts, ...products]),
      searchQuery
    );
  }

  const resultsAnswer = productResultsText(answerProducts, language, searchQuery, { includeFullSearchLink: true });
  await saveSuccessfulAiSearchRewrite({ latest, searchQuery, products: answerProducts, openAiMs: searchTiming.openAiMs });
  await logPerformance("product_results", { answerPreview: resultsAnswer });
  return new Response(textStream(resultsAnswer), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

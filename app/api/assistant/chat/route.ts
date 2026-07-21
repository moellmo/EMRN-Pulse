import { NextRequest, NextResponse } from "next/server";
import { createCart, removeMcpCartItem, searchBySKU, searchProducts, updateMcpCartItem } from "@/lib/assistant/catalog";
import { logAnalyticsEvent, logQuoteRequest, logSupportRequest } from "@/lib/assistant/analytics";
import { sendOrderStatusEmail, sendQuoteRequestEmail, sendSupportEmail } from "@/lib/assistant/email";
import { allowsMultipleCartItems, buildOrderStatusDraft, buildQuoteDraft, buildSupportDraft, extractOrdinalSelection, extractQuantity, extractSkuCandidates, hasExplicitQuantity, inferSearchQuery, isAccountIntent, isAvailabilityIntent, isCartIntent, isContactIntent, isFindProductPrompt, isMedicalAdviceRequest, isOrderStatusIntent, isProductDetailIntent, isProductSearchIntent, isQuickActionPrompt, isQuoteIntent, isSupportYes, priorAssistantRequestedQuoteDetails, quantityForProductSelection, selectProductsForCart } from "@/lib/assistant/intent";
import { detectCustomerLanguage } from "@/lib/assistant/language";
import { getOrderStatus } from "@/lib/assistant/orders";
import { streamAssistantResponse } from "@/lib/assistant/openai";
import type { AssistantMessage, CatalogProduct, ProductPageContext } from "@/lib/assistant/types";

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
    ? `Bien sûr. Je peux envoyer votre demande de devis ou de recherche d’article à notre équipe ici dans le chat. Vous pouvez aussi demander un devis directement depuis une page produit en cliquant « Add to Quote », puis « My Quote » en haut du site pour réviser et soumettre la demande. Pour l’envoyer ici, il me manque: ${fields}.`
    : `Of course. I can send your quote or item-sourcing request to our team here in chat. You can also request a quote directly from a product page by clicking “Add to Quote”, then “My Quote” at the top of the site to review and submit it. To send it here, I still need: ${fields}.`;
}

function orderStatusMissingText(missing: string[], language: "en" | "fr" | "unknown") {
  const fields =
    language === "fr"
      ? missing.map((field) => ({ email: "courriel", "order number": "numero de commande" })[field] || field).join(", ")
      : missing.join(", ");

  return language === "fr"
    ? `Je peux envoyer une demande de suivi de commande à notre équipe. Il me manque: ${fields}.`
    : `I can send an order status request to our team. I still need: ${fields}.`;
}

function orderTrackingText(
  order: { orderNumber: string; status?: string; trackingNumbers: string[]; trackingLinks: string[] },
  language: "en" | "fr" | "unknown"
) {
  const tracking = order.trackingLinks.length
    ? order.trackingLinks.join("\n")
    : order.trackingNumbers.join(", ");

  return language === "fr"
    ? `J’ai trouvé votre commande ${order.orderNumber}. Statut: ${order.status || "non disponible"}.\n\nSuivi: ${tracking}`
    : `I found your order ${order.orderNumber}. Status: ${order.status || "unavailable"}.\n\nTracking: ${tracking}`;
}

function checkoutSkusFromConversation(messages: AssistantMessage[]) {
  const skus = new Map<string, number>();
  const text = messages.map((message) => message.content).join("\n");
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
      /products I found|produits que j’ai trouvés|which one would you like added|laquelle voulez-vous ajouter|SKU\s*:/i.test(
        content
      );
    if (!looksProductRelated) continue;

    for (const match of content.matchAll(/\bSKU:\s*([A-Z0-9+/-]{3,40})/gi)) addSku(match[1] || "");
    for (const match of content.matchAll(/\(([A-Z]{1,10}\s*-?\s*\d{3,}[A-Z0-9-]*\+?)\)/gi)) addSku(match[1] || "");
    if (skus.length) break;
  }

  return skus.slice(0, 8);
}

async function recentAssistantProducts(messages: AssistantMessage[]) {
  const skus = recentAssistantProductSkus(messages);
  const products = (
    await Promise.all(
      skus.map(async (sku) => {
        const [product] = await searchBySKU(sku);
        return product || null;
      })
    )
  ).filter((product): product is CatalogProduct => Boolean(product));

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
    /^\s*(?:add\s+to\s+cart|add\s+it\s+to\s+cart|add\s+this\s+to\s+cart|buy\s+it|purchase\s+it)\s*$/i.test(text);
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

function cleanProductQuery(text: string) {
  return String(text || "")
    .replace(/\b(no,?\s+)?(do you have|do have|do u have|do you carry|can you find|find me|find|search for|search|show me|i am looking for|i'm looking for|im looking for|looking for|i need|we need|i want|we want|i would like|we would like|je cherche|avez-vous|avez vous|as-tu|as tu)\b/gi, " ")
    .replace(/\b(no|a|an|the|some|product|products|item|items|please|pls|svp|un|une|des|le|la|les|produit|produits|to|also|add|buy|purchase|order|get|take)\b/gi, " ")
    .replace(/[?!.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeQuoteDetailsReply(text: string) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (isProductSearchIntent(trimmed) || isQuickActionPrompt(trimmed)) return false;
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(trimmed)) return true;
  if (/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/.test(trimmed)) return true;
  if (/\b(my name is|name is|i am|i'm|je m'appelle|mon nom est|company is|compagnie|entreprise)\b/i.test(trimmed)) return true;
  return /^[A-Z][A-Za-z' -]{1,40}\s+[A-Z][A-Za-z' -]{1,40}$/.test(trimmed);
}

function isAffirmative(text: string) {
  return /^(yes|yeah|yep|sure|ok|okay|please|send it|go ahead|do it|oui|d'accord|vas-y|svp)$/i.test(
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

function searchQueryForLatest(messages: AssistantMessage[], latest: string, products: CatalogProduct[]) {
  const inferred = inferSearchQuery(messages, products);
  const shouldUseContext =
    /\b(more|another|same|these|those|them|it|this|that|one|ones|compatible|fit|accessor|accessory|accessories)\b/i.test(latest) ||
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
    .replace(/\bTypically ships within 1-3 business days\b/gi, "Expédié généralement sous 1 à 3 jours ouvrables")
    .replace(/\btypically 5-9 business days\b/gi, "généralement 5 à 9 jours ouvrables")
    .replace(/\bavailable\b/gi, "disponible");
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
    const availability = displayAvailability(product, language);
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

function productResultsText(products: CatalogProduct[], language: "en" | "fr" | "unknown", query: string) {
  const shown = products.slice(0, 5);
  const lines = shown.map((product, index) => {
    const price = product.quoteOnly ? (language === "fr" ? "devis requis" : "quote required") : product.price ? `$${product.price.toFixed(2)}` : language === "fr" ? "prix non disponible" : "price unavailable";
    const availability = displayAvailability(product, language);
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

  const intro =
    language === "fr"
      ? `Voici les produits que j’ai trouvés pour « ${query} » :`
      : `Here are the products I found for “${query}”:`;
  const outro =
    language === "fr"
      ? "Si vous me dites la taille, la marque, l’usage ou la quantité souhaitée, je peux réduire la liste ou vous aider à l’ajouter au panier."
      : "If you tell me the size, brand, use, or quantity you need, I can narrow this down or help add the right item to your cart.";

  return `${intro}\n\n${lines.join("\n")}\n\n${outro}`;
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
  const patterns = [
    /\bbox\s+of\s+(\d{1,5})\b/i,
    /\bpack\s+of\s+(\d{1,5})\b/i,
    /\bcase\s+of\s+(\d{1,5})\b/i,
    /\b(\d{1,5})\s*(?:\/|per)\s*(?:box|pack|case)\b/i,
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
  cartUrl = "https://emrn.ca/cart.php"
) {
  const token = cartItemsToken(lineItems);
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

function productDetailFromCatalog(product: CatalogProduct, question: string, language: "en" | "fr" | "unknown") {
  const text = product.description || "";
  const wantsSize = /\b(how\s+big|how\s+large|what\s+size|size|dimension|dimensions|measurement|measurements|height|width|depth|length|capacity)\b/i.test(question);
  const wantsColor = /\b(color|colour|couleur)\b/i.test(question);
  const wantsPrice = /\b(how\s+much|price|cost|prix)\b/i.test(question);
  const wantsAvailability = /\b(availability|available|in stock|stock|ships|lead time)\b/i.test(question);
  const wantsPackage = /\b(how\s+many|box|boxes|pack|package|case|count|per box|per pack)\b/i.test(question);
  const wantsSoldBy = /\b(who\s+makes|who\s+sells|sold\s+by|manufacturer|brand)\b/i.test(question);
  const lines: string[] = [];

  if (wantsPrice && product.price) {
    lines.push(language === "fr" ? `Prix: $${product.price.toFixed(2)}` : `Price: $${product.price.toFixed(2)}`);
  }

  if (wantsAvailability) {
    const availability = displayAvailability(product, language);
    if (availability) lines.push(language === "fr" ? `Disponibilité: ${availability}` : `Availability: ${availability}`);
  }

  if (wantsPackage) {
    const pack = displayPackageInfo(product, language);
    if (pack) lines.push(language === "fr" ? `Conditionnement: ${pack}` : `Package/quantity: ${pack}`);
  }

  if (wantsSoldBy) {
    const soldBy = soldByInfo(product);
    if (soldBy) lines.push(language === "fr" ? `Vendu par: ${soldBy}` : `Sold by: ${soldBy}`);
  }

  if (wantsColor) {
    const color = valueAfterLabel(text, "Color") || valueAfterLabel(text, "Colour");
    if (color) lines.push(language === "fr" ? `Couleur: ${color}` : `Color: ${color}`);
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
  if (base.includes("little junior") || base.includes("little jr")) {
    return /\b(little\s+jr|little\s+junior|lb\s+qcpr)\b/i.test(partText);
  }
  if (base.includes("little anne")) {
    return /\b(little\s+anne)\b/i.test(partText);
  }
  return true;
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

function faqAnswerText(text: string, language: "en" | "fr" | "unknown") {
  const helpLink = "https://emrn.ca/faq-s/";
  const contactLink = "https://emrn.ca/contact-us/";
  const shippingReturnsLink = "https://emrn.ca/shipping-returns";
  const privacyLink = "https://emrn.ca/privacy-policy";
  const accountLink = "https://emrn.ca/login.php";
  const businessLink = "https://emrn.ca/business-account-application";
  const businessSolutionsLink = "https://emrn.ca/business-medical-supplies";
  const homeMedicalSuppliesLink = "https://emrn.ca/home-medical-supplies/";
  const specialPricingLink = "https://emrn.ca/my-special-pricing";

  const answer = (en: string, fr: string) => (language === "fr" ? fr : en);

  if (/\b(order statuses|order status mean|status mean|awaiting payment|awaiting fulfillment|awaiting shipment|partially shipped|completed)\b/i.test(text)) {
    return answer(
      `Order statuses show where the order is in the process. Awaiting Payment means payment is not complete or confirmed. Awaiting Fulfillment means the order is being reviewed, picked, packed, or prepared. Awaiting Shipment means it is being prepared for shipment or carrier/supplier processing. Partially Shipped means some items shipped separately. Shipped means tracking should be available by email or in your account. Completed means the order has been processed. More details: ${helpLink}`,
      `Les statuts indiquent où se trouve la commande. Awaiting Payment veut dire que le paiement n’est pas confirmé. Awaiting Fulfillment veut dire que la commande est en révision ou préparation. Awaiting Shipment veut dire qu’elle est en préparation d’expédition, chez le fournisseur ou en attente de ramassage transporteur. Partially Shipped veut dire qu’une partie a été expédiée séparément. Shipped veut dire que le suivi devrait être disponible par courriel ou dans le compte. Completed veut dire que la commande est traitée. Détails: ${helpLink}`
    );
  }

  if (/\b(awaiting shipment|waiting shipment|stuck|too long|longer than expected)\b/i.test(text)) {
    return answer(
      `“Awaiting Shipment” means the order is in the shipping process but has not yet been marked shipped with tracking. It can be waiting for warehouse processing, supplier shipment, carrier pickup, or stock. If it has been longer than expected, contact EMRN with your order number and the team can check the latest update: ${contactLink}`,
      `« Awaiting Shipment » veut dire que la commande est en processus d’expédition, mais qu’elle n’a pas encore été marquée expédiée avec suivi. Elle peut attendre le traitement entrepôt, le fournisseur, le transporteur ou le stock. Si le délai semble trop long, contactez EMRN avec votre numéro de commande: ${contactLink}`
    );
  }

  if (/\b(tracking|track my order|tracking number|where.*tracking|shipped.*tracking)\b/i.test(text)) {
    return answer(
      `Tracking is usually emailed once the order ships, and it can also be checked from My Orders after signing in. If your order says shipped but you do not see tracking, contact EMRN with your order number so the team can help locate it: ${contactLink}`,
      `Le suivi est habituellement envoyé par courriel lorsque la commande est expédiée, et il peut aussi être consulté dans Mes commandes après connexion. Si votre commande est indiquée expédiée mais que vous ne voyez pas le suivi, contactez EMRN avec votre numéro de commande: ${contactLink}`
    );
  }

  if (/\b(shipping|ship across canada|free shipping|delivery time|ship time|shipping rates|oxygen cylinder|backorder)\b/i.test(text)) {
    return answer(
      `EMRN processes orders when received. Most orders ship within 1-2 business days when merchandise is available and credit/payment verification is complete. If there is a delay or backorder, EMRN will try to contact you and may offer backorder, substitution, or cancellation options. Free shipping applies to online/web orders over $150 shipped within Canada, excluding territories and remote areas. Large/overweight, hazardous, or temperature-controlled freight items do not qualify. Shipping rates are calculated by weight, size, and dimensions. Details: ${shippingReturnsLink}`,
      `EMRN traite les commandes à la réception. La plupart des commandes sont expédiées en 1 à 2 jours ouvrables lorsque les articles sont disponibles et que le paiement/crédit est confirmé. En cas de délai ou rupture, EMRN tentera de vous contacter et pourra proposer de garder la commande en attente, substituer un article ou annuler. La livraison gratuite s’applique aux commandes web de plus de 150 $ expédiées au Canada, sauf territoires et régions éloignées. Les articles lourds/surdimensionnés, dangereux ou nécessitant un transport contrôlé en température ne sont pas admissibles. Les frais sont calculés selon poids, taille et dimensions. Détails: ${shippingReturnsLink}`
    );
  }

  if (/\b(invoice|old invoice|copy.*invoice|receipt|order documents|company information)\b/i.test(text)) {
    return answer(
      `If you have an EMRN account, sign in and check My Orders for invoices and order details. For an old invoice or a copy with company information, contact EMRN with the order number, company name, or email used for the order: ${contactLink}`,
      `Si vous avez un compte EMRN, connectez-vous et consultez Mes commandes pour les factures et détails. Pour une ancienne facture ou une copie avec renseignements d’entreprise, contactez EMRN avec le numéro de commande, le nom de l’entreprise ou le courriel utilisé: ${contactLink}`
    );
  }

  if (/\b(stock|availability|available to order|in stock|confirm stock|not currently in stock|backorder|lead time)\b/i.test(text)) {
    return answer(
      `Availability appears on product pages near the options and cart area. “Available to order” means the item can be purchased, but may not be in the local warehouse for immediate shipment and may need supplier processing. For time-sensitive quantities, contact EMRN with the product name, SKU, and quantity before ordering: ${contactLink}`,
      `La disponibilité apparaît sur les pages produit près des options et du panier. « Available to order » veut dire que l’article peut être commandé, mais qu’il n’est pas forcément en stock local pour expédition immédiate et peut nécessiter un traitement fournisseur. Pour une commande urgente ou une quantité précise, contactez EMRN avec le nom, SKU et quantité: ${contactLink}`
    );
  }

  if (/\b(create.*account|make.*account|register|business account|enterprise account|doctor|doctor.s office|schools|clinics|ems|government|account benefits|purchase history|reorder)\b/i.test(text)) {
    return answer(
      `You can create an EMRN account from Sign In / Register: ${accountLink}. Business or enterprise accounts are useful for clinics, schools, EMS departments, companies, healthcare facilities, government organizations, and larger purchasing teams. Business solutions: ${businessSolutionsLink}. Apply here: ${businessLink}. You do not need to be a doctor’s office or have a business account to purchase many items, though some specialized products may have restrictions.`,
      `Vous pouvez créer un compte EMRN depuis Connexion / Inscription: ${accountLink}. Les comptes entreprise sont utiles pour cliniques, écoles, services EMS, entreprises, établissements de santé, organisations gouvernementales et équipes d’achats. Solutions entreprise: ${businessSolutionsLink}. Demande ici: ${businessLink}. Il n’est pas nécessaire d’être un cabinet médical ou d’avoir un compte entreprise pour acheter plusieurs articles, mais certains produits spécialisés peuvent avoir des restrictions.`
    );
  }

  if (/\b(business solutions|business medical supplies|medical supplies for business|clinic supplies|school supplies|ems department|healthcare facility|enterprise purchasing|institutional purchasing)\b/i.test(text)) {
    return answer(
      `EMRN supports business, clinic, school, EMS, healthcare facility, government, and institutional purchasing. Start with Business Medical Supplies here: ${businessSolutionsLink}. For account setup, use the business account application: ${businessLink}.`,
      `EMRN soutient les achats pour entreprises, cliniques, écoles, services EMS, établissements de santé, gouvernements et institutions. Commencez avec Business Medical Supplies ici: ${businessSolutionsLink}. Pour créer le compte, utilisez la demande de compte entreprise: ${businessLink}.`
    );
  }

  if (/\b(home medical supplies|home care|homecare|home product|home products|home health|home patient|dme|mobility aids|bathroom safety|wheelchair|walker|rollator|commode|shower chair)\b/i.test(text)) {
    return answer(
      `EMRN has home medical supplies and home-care products here: ${homeMedicalSuppliesLink}. You can search by product name, category, brand, size, or SKU, and I can help narrow options if you tell me what the item is for.`,
      `EMRN propose des fournitures médicales pour la maison et soins à domicile ici: ${homeMedicalSuppliesLink}. Vous pouvez chercher par nom, catégorie, marque, taille ou SKU, et je peux aider à réduire les options si vous me dites l’usage prévu.`
    );
  }

  if (/\b(return|exchange|returnable|wrong item|damaged|damage|opened|used|sterile|special order|non-returnable)\b/i.test(text)) {
    return answer(
      `Returns require a return merchandise authorization number from Customer Service, and the RMA must be clearly written on the outside of the carton. Items are not returnable after 15 days from the date received. Shipping and handling are non-refundable, and return transport may be at your expense when the return is due to preference or customer error. Returns are not authorized for non-returnable website items, special/custom orders, discontinued items, items not in original packaging, damaged or non-saleable items, and injectable medication or pharmaceutical products. An 18% restocking fee may apply. If a shipment arrives damaged, note the damage on the delivery bill, have the driver sign it, take a photo, and contact EMRN. Details: ${shippingReturnsLink}`,
      `Les retours nécessitent un numéro d’autorisation de retour du service client, et le RMA doit être clairement inscrit à l’extérieur de la boîte. Les articles ne sont pas retournables après 15 jours suivant la réception. Les frais de livraison/manutention ne sont pas remboursables, et le transport de retour peut être à vos frais si le retour est dû à une préférence ou erreur du client. Les retours ne sont pas autorisés pour les articles indiqués non retournables, commandes spéciales/personnalisées, articles discontinués, articles hors emballage original, endommagés ou non revendables, ni médicaments injectables ou produits pharmaceutiques. Des frais de restockage de 18 % peuvent s’appliquer. Si l’expédition arrive endommagée, notez les dommages sur le bon de livraison, faites signer le chauffeur, prenez une photo et contactez EMRN. Détails: ${shippingReturnsLink}`
    );
  }

  if (/\b(special pricing|business pricing|my special pricing|preferred pricing|contract pricing|prix special|prix spécial|prix entreprise)\b/i.test(text)) {
    return answer(
      `For business or special pricing, sign in and check My Special Pricing here: ${specialPricingLink}. If your organization needs pricing reviewed or does not yet have access, apply for a business account here: ${businessLink}, or contact EMRN for help: ${contactLink}`,
      `Pour les prix entreprise ou prix spéciaux, connectez-vous et consultez My Special Pricing ici: ${specialPricingLink}. Si votre organisation doit faire vérifier ses prix ou n’a pas encore accès, faites une demande de compte entreprise ici: ${businessLink}, ou contactez EMRN: ${contactLink}`
    );
  }

  if (/\b(payment|credit card|purchase order|po\b|tax exempt|tax-exempt|tax exemption|pay by po)\b/i.test(text)) {
    return answer(
      `Payment options are shown at checkout and may include major credit cards or other online payment methods depending on the order and account type. Purchase-order billing may be available for approved business, enterprise, institutional, government, or healthcare accounts. Tax-exempt organizations should contact EMRN before ordering so documentation and account setup can be reviewed: ${contactLink}`,
      `Les modes de paiement sont affichés au paiement et peuvent inclure les cartes de crédit principales ou d’autres méthodes en ligne selon la commande et le type de compte. Les bons de commande peuvent être disponibles pour comptes entreprise, institutionnels, gouvernementaux ou santé approuvés. Les organisations exemptées de taxes devraient contacter EMRN avant de commander afin de vérifier les documents et le compte: ${contactLink}`
    );
  }

  if (/\b(replacement part|compatible accessory|compatibility|right product|which product|do not know the sku|don't know the sku|photo|model number)\b/i.test(text)) {
    return answer(
      `Product pages include descriptions, images, specifications, and options when available. For help choosing the right item, replacement part, or compatible accessory, send EMRN the product name, brand, model number, SKU, photo if available, and how you plan to use it. I can also help search if you give me those details.`,
      `Les pages produit incluent descriptions, images, spécifications et options lorsque disponibles. Pour choisir le bon article, une pièce de remplacement ou un accessoire compatible, envoyez à EMRN le nom, la marque, le modèle, le SKU, une photo si disponible et l’usage prévu. Je peux aussi chercher avec ces détails.`
    );
  }

  if (/\b(help center|faq|frequently asked|customer support|still need help)\b/i.test(text)) {
    return answer(
      `The EMRN Help Center covers quotes, order status, tracking and shipping, invoices, accounts, returns, payments, purchase orders, tax-exempt ordering, and product help: ${helpLink}. The team can also help with quotes, product questions, order updates, tracking, invoices, and account support: ${contactLink}`,
      `Le centre d’aide EMRN couvre les devis, statuts de commande, suivi et livraison, factures, comptes, retours, paiements, bons de commande, exemption de taxes et aide produit: ${helpLink}. L’équipe peut aussi aider avec devis, questions produit, mises à jour de commande, suivi, factures et comptes: ${contactLink}`
    );
  }

  if (/\b(privacy|privacy policy|personal information|data policy|confidential|confidentiality)\b/i.test(text)) {
    return answer(
      `You can review EMRN’s privacy policy here: ${privacyLink}. For questions about personal information or account/order privacy, contact EMRN directly: ${contactLink}`,
      `Vous pouvez consulter la politique de confidentialité d’EMRN ici: ${privacyLink}. Pour les questions sur les renseignements personnels ou la confidentialité du compte/de la commande, contactez EMRN directement: ${contactLink}`
    );
  }

  if (
    /\b(how.*quote|request.*quote|quote.*multiple|multiple.*quote|need.*account.*quote|quote.*account|how long.*quote|special pricing|large order|bulk price)\b/i.test(text) ||
    /\b(comment.*devis|demander.*devis|devis.*plusieurs|plusieurs.*devis|compte.*devis|devis.*compte|combien.*temps.*devis|prix special|prix spécial|grande commande|grosse commande)\b/i.test(text)
  ) {
    return answer(
      `To request a quote, open the product page and click “Add to Quote”. Add each item you need, then click “My Quote” at the top of the site to review and submit one quote request. You do not need an account, though an account can help with future orders and invoices. For large quantities, include the quantity needed so EMRN can review special pricing. Help Center: ${helpLink}`,
      `Pour demander un devis, ouvrez la page produit et cliquez « Add to Quote ». Ajoutez chaque article, puis cliquez « My Quote » en haut du site pour réviser et soumettre une seule demande. Un compte n’est pas obligatoire, mais il peut aider pour les commandes et factures futures. Pour grandes quantités, indiquez la quantité afin qu’EMRN puisse vérifier les prix spéciaux. Aide: ${helpLink}`
    );
  }

  return "";
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
  const body = await req.json().catch(() => null);
  const messages = (body?.messages || []) as AssistantMessage[];
  const sessionId = String(body?.sessionId || crypto.randomUUID());
  const language = body?.language || detectCustomerLanguage(messages);
  const pageContext = (body?.pageContext || {}) as ProductPageContext;
  const latest = messages.at(-1)?.content || "";
  const createdAt = new Date().toISOString();

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

  const priorAssistantAskedSupport = messages
    .slice(-3)
    .some(
      (message) =>
        message.role === "assistant" &&
        /support team|equipe de support|équipe de support|send a message to our team|nom, votre courriel et votre question|name, email, and question/i.test(
          message.content
        )
    );
  const looksLikeSupportDetailsReply = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(latest);

  if (priorAssistantAskedSupport && (isSupportYes(latest) || (looksLikeSupportDetailsReply && !isQuickActionPrompt(latest)))) {
    const draft = buildSupportDraft(messages, language);
    if (draft.request) {
      await Promise.all([
        logSupportRequest(draft.request),
        sendSupportEmail(draft.request),
        logAnalyticsEvent({ type: "support_escalation", sessionId, language, query: latest, createdAt }),
      ]);
      return new Response(
        textStream(
          language === "fr"
            ? "Merci. Votre question a été envoyée à notre équipe de support. Quelqu’un vous répondra sous peu."
            : "Thank you. Your question has been sent to our support team. Someone will respond shortly."
        ),
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

  const priorAssistantRequestedOrderStatus = messages
    .slice(-4)
    .some(
      (message) =>
        message.role === "assistant" &&
        /order status request|suivi de commande|statut de commande|order number/i.test(message.content)
    );

  const looksLikeOrderDetailsReply =
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(latest) || /\border\s*#?\s*\d{3,}\b|\b\d{5,}\b/i.test(latest);

  if (isOrderStatusIntent(latest) || (priorAssistantRequestedOrderStatus && looksLikeOrderDetailsReply && !isQuickActionPrompt(latest))) {
    const draft = buildOrderStatusDraft(messages, language);
    if (draft.request) {
      const orderStatus = await getOrderStatus({
        orderNumber: draft.request.orderNumber,
        email: draft.request.email,
      });

      if (orderStatus.verified && (orderStatus.trackingLinks.length || orderStatus.trackingNumbers.length)) {
        return new Response(textStream(orderTrackingText(orderStatus, language)), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      await Promise.all([
        sendOrderStatusEmail(draft.request),
        logAnalyticsEvent({ type: "support_escalation", sessionId, language, query: latest, createdAt }),
      ]);
      return new Response(
        textStream(
          language === "fr"
            ? orderStatus.verified
              ? `J’ai trouvé votre commande ${draft.request.orderNumber}, mais je ne vois pas de numéro de suivi disponible. J’ai envoyé une demande au support afin qu’ils vérifient la commande et vous répondent par courriel sous peu.`
              : "Je n’ai pas pu confirmer le suivi automatiquement avec les renseignements fournis. J’ai envoyé votre demande au support afin qu’ils la vérifient et vous répondent par courriel sous peu."
            : orderStatus.verified
              ? `I found your order ${draft.request.orderNumber}, but I do not see tracking available yet. I sent a request to support so they can check the order and email you shortly.`
              : "I could not confirm the tracking automatically with the information provided. I sent your request to support so they can review it and email you shortly."
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    return new Response(textStream(orderStatusMissingText(draft.missing, language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (isFindProductPrompt(latest)) {
    return new Response(
      textStream(
        language === "fr"
          ? "Bien sûr. Quel produit cherchez-vous? Vous pouvez me donner un nom, une marque, une catégorie, une utilisation médicale ou un SKU."
          : "Sure. What product are you looking for? You can give me a name, brand, category, medical use, or SKU."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (!extractSkuCandidates(latest).length && !isProductDetailIntent(latest) && !isAvailabilityIntent(latest)) {
    const faqAnswer = faqAnswerText(latest, language);
    if (faqAnswer) {
      return new Response(textStream(faqAnswer), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  const shouldIgnorePriorQuoteFlow = (isQuickActionPrompt(latest) || isProductSearchIntent(latest)) && !isQuoteIntent(latest);
  const shouldContinuePriorQuoteFlow =
    !shouldIgnorePriorQuoteFlow && priorAssistantRequestedQuoteDetails(messages) && looksLikeQuoteDetailsReply(latest);
  const shouldContinueItemRequestFlow =
    !shouldIgnorePriorQuoteFlow && priorAssistantOfferedItemRequest(messages) && isAffirmative(latest);

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

  if (isLiveCartEditIntent(latest) && priorAssistantCreatedCart(messages) && !priorAssistantAskedCartQuantity(messages)) {
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

  if (isContactIntent(latest)) {
    return new Response(textStream(contactHelpText(language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (isAvailabilityIntent(latest) && !isResultFilterIntent(latest)) {
    const skuCandidates = extractSkuCandidates(latest);
    const pageProducts = skuCandidates.length
      ? (await Promise.all(skuCandidates.map((sku) => searchBySKU(sku)))).flat()
      : /\b(this|it|this item|the product|ce produit|cet article)\b/i.test(latest)
        ? await productsFromPageContext(pageContext, language)
        : [];
    const rememberedProducts = !skuCandidates.length && !pageProducts.length
      ? await recentAssistantProducts(messages)
      : [];
    const availabilityPool = pageProducts.length ? pageProducts : rememberedProducts;
    const availabilityProducts = availabilityPool.length ? selectProductsForCart(latest, availabilityPool) : [];

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
    (isCartIntent(latest) || isQuoteIntent(latest) || isProductDetailIntent(latest)) && /\b(this|it|this item|the product|ce produit|cet article)\b/i.test(latest)
      ? await productsFromPageContext(pageContext, language)
      : [];
  const skuCandidates = extractSkuCandidates(latest);
  const replyingToCartChoice =
    priorAssistantAskedCartChoice(messages) && !isProductDetailIntent(latest) && !isQuickActionPrompt(latest);
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
    shouldContinuePriorQuoteFlow ||
    shouldContinueItemRequestFlow ||
    isProductDetailIntent(latest) ||
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
  const searchQuery = pageProductsForCart.length
    ? pageProductsForCart[0].sku || pageProductsForCart[0].name
    : skuCandidates.length
      ? skuCandidates.join(", ")
      : rememberedContextProducts.length
        ? searchQueryForLatest(messages, latest, rememberedContextProducts)
      : searchQueryForLatest(messages, latest, []);
  let searchResult;
  if (pageProductsForCart.length) {
    searchResult = { products: pageProductsForCart, found: pageProductsForCart.length };
  } else if (skuCandidates.length) {
    const skuProducts = (
      await Promise.all(
        skuCandidates.map(async (sku) => {
          const matches = await searchBySKU(sku);
          return matches;
        })
      )
    ).flat();
    searchResult = skuProducts.length
      ? { products: skuProducts, found: skuCandidates.length }
      : await searchProducts({ query: latest, language, limit: 8 });
  } else if (rememberedContextProducts.length) {
    searchResult = { products: rememberedContextProducts, found: rememberedContextProducts.length };
  } else {
    searchResult = await searchProducts({ query: searchQuery, language, limit: 8 });
  }
  const products = searchResult.products;

  await logAnalyticsEvent({
    type: products.length ? "product_search" : "no_result_search",
    sessionId,
    language,
    query: searchQuery,
    productIds: products.map((product) => product.productId),
    createdAt,
  });

  if (isAccountIntent(latest)) {
    await logAnalyticsEvent({ type: "support_escalation", sessionId, language, query: latest, createdAt });
    return new Response(
      textStream(
        language === "fr"
          ? "Vous pouvez créer ou utiliser un compte EMRN depuis la section compte du site. Pour les comptes d’entreprise, les prix spéciaux ou l’accès Buyer Portal, notre équipe doit vérifier les détails de votre organisation. Vous pouvez consulter la FAQ ici: https://emrn.ca/faq-s/ ou je peux envoyer votre demande à notre équipe. Veuillez m’envoyer votre nom, votre courriel et votre question."
          : "You can create or use an EMRN account from the account area on the site. For business accounts, preferred pricing, or Buyer Portal access, our team needs to review your organization details. You can also check the FAQ here: https://emrn.ca/faq-s/ or I can send your request to our team. Please send your name, email, and question."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (shouldCompareRememberedProducts && products.length) {
    const comparison = compareProductsText(products, language, latest);
    if (comparison) {
      return new Response(textStream(comparison), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  }

  if (shouldFilterRememberedProducts && products.length) {
    const filteredProducts = filterProductsFromText(products, latest);
    if (filteredProducts.length) {
      return new Response(textStream(productResultsText(filteredProducts, language, searchQuery)), {
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

    const previousCartSkus = checkoutSkusFromConversation(messages);
    const previousCartProducts = (
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
        textStream(`${cartReadyText(cartProducts.length, lineItems, language, cartProducts, cart.checkoutUrl)}${quoteSplitText(blockedProducts, language)}`),
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

  if (isQuoteIntent(latest) || shouldContinuePriorQuoteFlow || shouldContinueItemRequestFlow) {
    const draft = buildQuoteDraft(messages, language, products);
    if (draft.request) {
      await Promise.all([
        logQuoteRequest(draft.request),
        sendQuoteRequestEmail(draft.request),
        logAnalyticsEvent({ type: "quote_request", sessionId, language, query: searchQuery, createdAt }),
      ]);
      return new Response(
        textStream(
          language === "fr"
            ? "Merci. Votre demande a été envoyée à notre équipe des ventes. Nous vérifierons l’article et vous contacterons sous peu."
            : "Thank you. Your request has been sent to our sales team. We will check the item and contact you shortly."
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    return new Response(textStream(quoteMissingText(draft.missing, language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (!products.length) {
    await logAnalyticsEvent({ type: "unanswered_question", sessionId, language, query: latest, createdAt });
    const fallbackSearchUrl = siteSearchUrl(searchQuery || latest);
    return new Response(
      textStream(
        language === "fr"
          ? `Je n’ai pas pu confirmer ce produit dans Pulse. Essayez d’abord la recherche manuelle en haut du site, ou utilisez ce lien: ${fallbackSearchUrl}\n\nSi vous ne le trouvez pas, je peux envoyer votre demande à notre équipe pour vérifier l’article ou préparer une demande de devis.`
          : `I could not confirm this item in Pulse. Please try the manual search bar at the top of the site first, or use this search link: ${fallbackSearchUrl}\n\nIf you still cannot find it, I can send your request to our team to check the item or prepare a quote request.`
      ),
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

  if (isProductDetailIntent(latest)) {
    const rememberedDetailProducts = await recentAssistantProducts(messages);
    const detailProducts = await refreshProductsBySku(rememberedDetailProducts.length ? rememberedDetailProducts : products);
    const selectedDetailProducts = selectProductsForCart(latest, detailProducts);

    if (isPartsOrAccessoryQuestion(latest) && detailProducts.length) {
      const [selectedProduct] = selectedDetailProducts;
      const baseProduct = selectedProduct || detailProducts[0];
      const partsQueries = relatedPartQueries(baseProduct);
      const partsResults = await Promise.all(partsQueries.map((query) => searchProducts({ query, language, limit: 8 })));
      const seenPartSkus = new Set<string>();
      const relatedParts = partsResults
        .flatMap((result) => result.products)
        .filter((product) => product.sku !== baseProduct.sku)
        .filter((product) => isRelatedPartForProduct(product, baseProduct))
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
        return new Response(textStream(`${intro}\n\n${productResultsText(relatedParts.slice(0, 6), language, partsQueries[0]).replace(/^Here are the products I found for .+?:\n\n/i, "").replace(/\n\nIf you tell me[\s\S]*$/i, "")}`), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }

    if (selectedDetailProducts.length === 1) {
      const catalogAnswer = productDetailFromCatalog(selectedDetailProducts[0], latest, language);
      if (catalogAnswer) {
        return new Response(textStream(catalogAnswer), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }

    const stream = await streamAssistantResponse({
      messages,
      products: detailProducts,
      language,
      sessionId,
      query: searchQuery,
      trustedWebSearch: true,
    });
    await logAnalyticsEvent({
      type: "conversation_completed",
      sessionId,
      language,
      messageCount: messages.length,
      createdAt: new Date().toISOString(),
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  if (products.length === 1) {
    const exactProduct = products[0];
    const substitutes = await closeInStockSubstitutes(exactProduct, language);
    return new Response(textStream(`${exactProductFoundText(exactProduct, language, skuCandidates[0] || searchQuery)}${substitutesText(substitutes, language)}`), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(textStream(productResultsText(products, language, searchQuery)), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

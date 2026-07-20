import { NextRequest, NextResponse } from "next/server";
import { createCart, searchBySKU, searchProducts } from "@/lib/assistant/catalog";
import { logAnalyticsEvent, logQuoteRequest, logSupportRequest } from "@/lib/assistant/analytics";
import { sendOrderStatusEmail, sendQuoteRequestEmail, sendSupportEmail } from "@/lib/assistant/email";
import { allowsMultipleCartItems, buildOrderStatusDraft, buildQuoteDraft, buildSupportDraft, extractSkuCandidates, inferSearchQuery, isAccountIntent, isAvailabilityIntent, isCartIntent, isFindProductPrompt, isMedicalAdviceRequest, isOrderStatusIntent, isQuickActionPrompt, isQuoteIntent, isSupportYes, priorAssistantRequestedQuoteDetails, selectProductsForCart } from "@/lib/assistant/intent";
import { detectCustomerLanguage } from "@/lib/assistant/language";
import { getOrderStatus } from "@/lib/assistant/orders";
import { streamAssistantResponse } from "@/lib/assistant/openai";
import type { AssistantMessage, CatalogProduct, ProductPageContext } from "@/lib/assistant/types";

export const runtime = "nodejs";

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
    ? `Bien sûr. Je peux envoyer votre demande de devis à notre équipe. Il me manque: ${fields}.`
    : `Of course. I can send your quote request to our team. I still need: ${fields}.`;
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

function cartItemsToken(items: Array<{ productId: number; variantId?: number; quantity: number }>) {
  const payload = Buffer.from(JSON.stringify(items), "utf8").toString("base64");
  return `\n\n[[EMRN_CART_ITEMS:${payload}]]`;
}

function normalizeSku(value: string) {
  return String(value || "").replace(/[^a-z0-9+]/gi, "").toUpperCase();
}

function cleanProductQuery(text: string) {
  return String(text || "")
    .replace(/\b(do you have|do you carry|can you find|find me|find|show me|i am looking for|i'm looking for|im looking for|looking for|i need|we need|i want|we want|je cherche|avez-vous|avez vous|as-tu|as tu)\b/gi, " ")
    .replace(/\b(a|an|the|some|product|products|item|items|please|pls|svp|un|une|des|le|la|les|produit|produits)\b/gi, " ")
    .replace(/[?!.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  const availability = product.availabilityDescription || product.availability || "Availability should be confirmed before relying on timing.";
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
    .some((message) => message.role === "assistant" && /support team|equipe de support|équipe de support/i.test(message.content));

  if (priorAssistantAskedSupport && isSupportYes(latest)) {
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

  const shouldIgnorePriorQuoteFlow = isQuickActionPrompt(latest) && !isQuoteIntent(latest);

  if (isAvailabilityIntent(latest)) {
    const skuCandidates = extractSkuCandidates(latest);
    const pageProducts = skuCandidates.length
      ? (await Promise.all(skuCandidates.map((sku) => searchBySKU(sku)))).flat()
      : await productsFromPageContext(pageContext, language);

    if (pageProducts.length) {
      return new Response(textStream(availabilityText(pageProducts[0], language)), {
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
    isCartIntent(latest) && /\b(this|it|this item|the product|ce produit|cet article)\b/i.test(latest)
      ? await productsFromPageContext(pageContext, language)
      : [];
  const skuCandidates = isCartIntent(latest) ? extractSkuCandidates(latest) : [];
  const searchQuery = pageProductsForCart.length
    ? pageProductsForCart[0].sku || pageProductsForCart[0].name
    : skuCandidates.length
      ? skuCandidates.join(", ")
      : searchQueryForLatest(messages, latest, []);
  const searchResult = pageProductsForCart.length
    ? { products: pageProductsForCart, found: pageProductsForCart.length }
    : skuCandidates.length
    ? {
        products: (
          await Promise.all(
            skuCandidates.map(async (sku) => {
              const matches = await searchBySKU(sku);
              return matches;
            })
          )
        ).flat(),
        found: skuCandidates.length,
      }
    : await searchProducts({ query: searchQuery, language, limit: 8 });
  const products = searchResult.products;

  await logAnalyticsEvent({
    type: products.length ? "product_search" : "no_result_search",
    sessionId,
    language,
    query: searchQuery,
    productIds: products.map((product) => product.productId),
    createdAt,
  });

  if (isQuoteIntent(latest) || (!shouldIgnorePriorQuoteFlow && priorAssistantRequestedQuoteDetails(messages)) || products.some((product) => product.quoteOnly)) {
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
            ? "Merci. Votre demande de devis a été envoyée à notre équipe des ventes. Nous vous contacterons sous peu."
            : "Thank you. Your quote request has been sent to our sales team. We will contact you shortly."
        ),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    return new Response(textStream(quoteMissingText(draft.missing, language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (isAccountIntent(latest)) {
    await logAnalyticsEvent({ type: "support_escalation", sessionId, language, query: latest, createdAt });
    return new Response(
      textStream(
        language === "fr"
          ? "Je ne peux pas encore voir les informations de compte, d’expédition, de factures ou d’historique d’achat sans une intégration Buyer Portal authentifiée. Je peux toutefois envoyer votre demande à notre équipe ou vous aider à trouver les produits dans le catalogue."
          : "I cannot view account details, shipping information, invoices, or purchase history yet without an authenticated Buyer Portal integration. I can send this to our team, or help you find the products in the catalog."
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (!products.length) {
    await logAnalyticsEvent({ type: "unanswered_question", sessionId, language, query: latest, createdAt });
    return new Response(
      textStream(
        language === "fr"
          ? "Je n’ai pas trouvé de produit correspondant dans le catalogue. Voulez-vous que j’envoie votre demande à notre équipe de support pour un devis ou de l’aide?"
          : "I did not find a matching product in the catalog. Would you like me to send this to our support team for a quote or help?"
      ),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  if (isCartIntent(latest) && products.length) {
    const selectedProducts = selectProductsForCart(latest, products);
    const purchasableProducts = selectedProducts.filter((product) => product.purchasable && !product.quoteOnly);
    const blockedProducts = selectedProducts.filter((product) => product.quoteOnly || !product.purchasable);

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
      ...purchasableProducts.map((product) => ({ product, quantity: 1 })),
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
      return new Response(
        textStream(
          language === "fr"
            ? `J’ai trouvé l’article et je l’ajoute à votre panier maintenant. Si le panier ne s’ouvre pas automatiquement, vous pouvez l’ouvrir ici: https://emrn.ca/cart.php${cartItemsToken(lineItems)}`
            : `I found the item and I’m adding it to your cart now. If the cart does not open automatically, you can open it here: https://emrn.ca/cart.php${cartItemsToken(lineItems)}`
        ),
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

  if (products.length) {
    await logAnalyticsEvent({
      type: "product_recommended",
      sessionId,
      language,
      productIds: products.slice(0, 5).map((product) => product.productId),
      createdAt,
    });
  }

  const stream = await streamAssistantResponse({ messages, products, language });
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

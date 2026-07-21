import { NextRequest, NextResponse } from "next/server";
import { createCart, searchBySKU, searchProducts } from "@/lib/assistant/catalog";
import { logAnalyticsEvent, logQuoteRequest, logSupportRequest } from "@/lib/assistant/analytics";
import { sendOrderStatusEmail, sendQuoteRequestEmail, sendSupportEmail } from "@/lib/assistant/email";
import { allowsMultipleCartItems, buildOrderStatusDraft, buildQuoteDraft, buildSupportDraft, extractQuantity, extractSkuCandidates, inferSearchQuery, isAccountIntent, isAvailabilityIntent, isCartIntent, isContactIntent, isFindProductPrompt, isMedicalAdviceRequest, isOrderStatusIntent, isProductDetailIntent, isProductSearchIntent, isQuickActionPrompt, isQuoteIntent, isSupportYes, priorAssistantRequestedQuoteDetails, selectProductsForCart } from "@/lib/assistant/intent";
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

function isContextProductSelectionReply(text: string) {
  return /\b(?:it|them|these|those|this|that|the first|the second|the third|the item|the product|ones?)\b/i.test(text) ||
    /^\s*(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|#?\s*[1-5])\s*$/i.test(text);
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
    .replace(/\b(no,?\s+)?(do you have|do have|do u have|do you carry|can you find|find me|find|search for|search|show me|i am looking for|i'm looking for|im looking for|looking for|i need|we need|i want|we want|je cherche|avez-vous|avez vous|as-tu|as tu)\b/gi, " ")
    .replace(/\b(no|a|an|the|some|product|products|item|items|please|pls|svp|un|une|des|le|la|les|produit|produits)\b/gi, " ")
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

function productResultsText(products: CatalogProduct[], language: "en" | "fr" | "unknown", query: string) {
  const shown = products.slice(0, 5);
  const lines = shown.map((product) => {
    const price = product.quoteOnly ? (language === "fr" ? "devis requis" : "quote required") : product.price ? `$${product.price.toFixed(2)}` : language === "fr" ? "prix non disponible" : "price unavailable";
    const availability =
      product.availabilityDescription ||
      product.availability ||
      (language === "fr" ? "disponibilité à confirmer" : "availability should be confirmed");
    const action = product.quoteOnly || !product.purchasable
      ? language === "fr"
        ? "Demander un devis"
        : "Request a quote"
      : language === "fr"
        ? "Peut être commandé en ligne"
        : "Can be ordered online";

    return language === "fr"
      ? `- **${product.name}** — SKU: ${product.sku || "non disponible"} — ${price}. ${availability}. ${action}. [Voir le produit](${product.url})`
      : `- **${product.name}** — SKU: ${product.sku || "unavailable"} — ${price}. ${availability}. ${action}. [View product](${product.url})`;
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
  const availability =
    product.availabilityDescription ||
    product.availability ||
    (language === "fr" ? "disponibilité à confirmer" : "availability should be confirmed");
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

function cartReadyText(itemCount: number, lineItems: Array<{ productId: number; variantId?: number; quantity: number }>, language: "en" | "fr" | "unknown") {
  const token = cartItemsToken(lineItems);
  if (language === "fr") {
    return itemCount > 1
      ? `J’ai ajouté ces articles au panier. Vous pouvez continuer à chercher d’autres articles ici, ou ouvrir votre panier quand vous êtes prêt: https://emrn.ca/cart.php${token}`
      : `J’ai ajouté l’article au panier. Vous pouvez continuer à chercher d’autres articles ici, ou ouvrir votre panier quand vous êtes prêt: https://emrn.ca/cart.php${token}`;
  }

  return itemCount > 1
    ? `I added those items to your cart. You can keep looking for more items here, or open your cart when you’re ready: https://emrn.ca/cart.php${token}`
    : `I added the item to your cart. You can keep looking for more items here, or open your cart when you’re ready: https://emrn.ca/cart.php${token}`;
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

  if (!extractSkuCandidates(latest).length && !isProductDetailIntent(latest)) {
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

  if (isContactIntent(latest)) {
    return new Response(textStream(contactHelpText(language)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

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
    (isCartIntent(latest) || isQuoteIntent(latest) || isProductDetailIntent(latest)) && /\b(this|it|this item|the product|ce produit|cet article)\b/i.test(latest)
      ? await productsFromPageContext(pageContext, language)
      : [];
  const skuCandidates = extractSkuCandidates(latest);
  const replyingToCartChoice =
    priorAssistantAskedCartChoice(messages) && !isProductDetailIntent(latest) && !isQuickActionPrompt(latest);
  const shouldHandleCart =
    isCartIntent(latest) ||
    replyingToCartChoice ||
    (priorAssistantOfferedCartAdd(messages) && isAffirmative(latest));
  const shouldUseRememberedProducts =
    shouldHandleCart ||
    isQuoteIntent(latest) ||
    shouldContinuePriorQuoteFlow ||
    shouldContinueItemRequestFlow ||
    isProductDetailIntent(latest) ||
    isContextProductSelectionReply(latest);
  const rememberedCartProducts = shouldHandleCart && !skuCandidates.length && !pageProductsForCart.length
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

  if (shouldHandleCart && products.length) {
    const selectedProducts = selectProductsForCart(latest, products);
    const purchasableProducts = selectedProducts.filter((product) => product.purchasable && !product.quoteOnly);
    const blockedProducts = selectedProducts.filter((product) => product.quoteOnly || !product.purchasable);
    const requestedQuantity = extractQuantity(latest);

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
      ...purchasableProducts.map((product) => ({ product, quantity: requestedQuantity })),
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
        textStream(cartReadyText(purchasableProducts.length, lineItems, language)),
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
    const stream = await streamAssistantResponse({
      messages,
      products,
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
    const product = products[0];
    if (product.purchasable && !product.quoteOnly) {
      const cart = await createCart({
        sessionId,
        items: [{
          productId: product.productId,
          variantId: product.variantId || undefined,
          quantity: 1,
        }],
      });
      const lineItems = cart.lineItems || [{
        productId: product.productId,
        variantId: product.variantId || undefined,
        quantity: 1,
      }];
      if (cart.checkoutUrl) {
        return new Response(
          textStream(`${exactProductFoundText(product, language, skuCandidates[0] || searchQuery, false)}\n\n${cartReadyText(1, lineItems, language)}`),
          { headers: { "Content-Type": "text/plain; charset=utf-8" } }
        );
      }
    }

    return new Response(textStream(exactProductFoundText(products[0], language, skuCandidates[0] || searchQuery)), {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(textStream(productResultsText(products, language, searchQuery)), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

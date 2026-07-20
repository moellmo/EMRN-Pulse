import type { AssistantLanguage, AssistantMessage, CatalogProduct, OrderStatusRequest, QuoteRequest, SupportRequest } from "./types";

const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function userMessages(messages: AssistantMessage[]) {
  return messages.filter((message) => message.role === "user").map((message) => message.content.trim()).filter(Boolean);
}

function assistantAskedFor(messages: AssistantMessage[], field: "name" | "company" | "email") {
  const lastAssistant = messages.filter((message) => message.role === "assistant").at(-1)?.content || "";
  const normalized = lastAssistant.toLowerCase();
  if (field === "name") return /\b(name|nom)\b/.test(normalized);
  if (field === "company") return /\b(company|compagnie|entreprise)\b/.test(normalized);
  return /\b(email|courriel)\b/.test(normalized);
}

function cleanDirectReply(text: string) {
  return text
    .replace(emailPattern, "")
    .replace(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/g, "")
    .replace(/^(name|my name is|company|company is|email|courriel|nom|compagnie|entreprise)\s*[:=-]?\s*/i, "")
    .trim();
}

function directReplyFor(messages: AssistantMessage[], field: "name" | "company" | "email") {
  if (!assistantAskedFor(messages, field)) return "";
  const latest = userMessages(messages).at(-1) || "";
  if (field === "email") return latest.match(emailPattern)?.[0] || "";

  const cleaned = cleanDirectReply(latest);
  if (!cleaned || cleaned.length > 80 || /\b(quote|devis|cart|checkout|availability|available)\b/i.test(cleaned)) return "";
  return cleaned;
}

export function isMedicalAdviceRequest(text: string) {
  return /\b(should i use|what treatment|diagnose|diagnosis|symptoms|medication|dose|dosage|prescribe|wound infected|is this safe for my condition)\b/i.test(text);
}

export function isQuoteIntent(text: string) {
  return /\b(quote|pricing|formal quote|request a quote|special pricing|bulk price|company pricing|purchase order|po\b|b2b|devis|soumission|prix|devis automatique|auto quote)\b/i.test(text);
}

export function isCartIntent(text: string) {
  return /\b(add (?:the |this |that |it |one |red |blue |both |all )?.*(?:too|also)?|add to cart|cart|checkout|buy this|buy it|purchase online|order online|ajouter au panier|panier|payer|commander en ligne)\b/i.test(text);
}

export function isAccountIntent(text: string) {
  return /\b(my account|business account|create an account|make an account|open an account|register|logged in|login|shipping address|ship to|purchase history|reorder|last year|invoice|orders|company pricing|buyer portal|mon compte|compte entreprise|creer un compte|créer un compte|adresse de livraison|historique|facture|mes commandes)\b/i.test(text);
}

export function isOrderStatusIntent(text: string) {
  return /\b(order status|order update|update on my order|update for my order|order tracking|track(?:ing)?|where is my order|shipment update|shipping update|check order|check my order|commande|suivi|statut de commande|ou est ma commande|où est ma commande)\b/i.test(text);
}

export function isContactIntent(text: string) {
  return /\b(contact us|contact support|customer service|talk to support|talk to someone|human support|speak to someone|email support|help from your team|communiquer avec|contacter|parler à quelqu'un|parler a quelqu'un|support humain|service client)\b/i.test(text);
}

export function isAvailabilityIntent(text: string) {
  return /\b(availability|available|in stock|stock|check availability|lead time|ships|backorder|back order|disponibilite|disponibilité|disponible|en stock|delai|délai)\b/i.test(text);
}

export function isFindProductPrompt(text: string) {
  return /^\s*(find a product|find product|trouver un produit|je cherche un produit)\s*$/i.test(text);
}

export function isProductSearchIntent(text: string) {
  if (isQuoteIntent(text) || isCartIntent(text) || isOrderStatusIntent(text) || isContactIntent(text) || isAccountIntent(text)) {
    return false;
  }

  return /\b(do you have|do have|do u have|do you carry|carry|find|search|show me|looking for|look for|i need|we need|i want|we want|need|want|je cherche|cherche|avez-vous|avez vous|as-tu|as tu)\b/i.test(text);
}

export function isQuickActionPrompt(text: string) {
  return isFindProductPrompt(text) || isProductSearchIntent(text) || isAvailabilityIntent(text) || isQuoteIntent(text) || isOrderStatusIntent(text) || isContactIntent(text);
}

export function isSupportYes(text: string) {
  return /^(yes|yeah|please|sure|ok|oui|svp|s'il vous plait|s’il vous plaît)/i.test(text.trim());
}

export function extractSkuCandidates(text: string) {
  const candidates: string[] = [];
  const skuText = text
    .replace(/\b(?:i|we)\s+(?:want|would like|need)\s+to\s+(?:purchase|buy|order)\b/gi, " ")
    .replace(/\b(?:purchase|buy|order|add|cart|checkout|sku|item|product|produit|acheter|commander|panier)\b/gi, " ");

  for (const match of text.matchAll(/\bsku\s*[:#]?\s*([A-Z0-9]{2,}(?:\s*[/-]\s*[A-Z0-9]+)+\+?|[A-Z]{1,8}\s*-?\s*\d{3,}(?:-[A-Z0-9]+)*\+?|\d{3,}(?:-[A-Z0-9]+)*\+?)(?=\s|$|[,.!?])/gi)) {
    candidates.push(match[1]);
  }

  const matches =
    skuText.match(/\b(?:[A-Z0-9]{2,}(?:\s*[/-]\s*[A-Z0-9]+)+\+?|[A-Z]{1,10}\s*-?\s*\d{3,}[A-Z0-9]*(?:-[A-Z0-9]+)*\+?|[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+\+?|\d{4,}\+?)(?=\s|$|[,.!?])/gi) || [];
  candidates.push(...matches.filter((sku) => !/^sku\s*\d/i.test(sku)));

  for (const match of skuText.matchAll(/(?:^|[^\w/-])(?=([A-Z0-9+/-]{3,30})(?=\s|$|[,.!?]))(?=[A-Z0-9+/-]*\d)([A-Z0-9][A-Z0-9+/-]{2,29}\+?)(?=\s|$|[,.!?])/gi)) {
    const value = match[2] || match[1];
    if (!value) continue;
    if (/^\d{1,3}$/.test(value)) continue;
    candidates.push(value);
  }

  return Array.from(new Set(candidates.map((sku) => sku.replace(/\s+/g, "").toUpperCase())));
}

export function allowsMultipleCartItems(text: string) {
  return /\b(all|both|these|them|tous|les deux)\b/i.test(text) || extractSkuCandidates(text).length > 1;
}

export function extractQuantity(text: string) {
  const match = text.match(/\b(\d{1,5})\b/);
  return match ? Number(match[1]) : 1;
}

export function selectProductsForCart(text: string, products: CatalogProduct[]) {
  const normalized = text.toLowerCase();
  const skuMatch = products.filter((product) => product.sku && normalized.includes(product.sku.toLowerCase()));
  if (skuMatch.length) return skuMatch;

  const optionWords = [
    "black",
    "blue",
    "green",
    "orange",
    "pink",
    "purple",
    "red",
    "white",
    "yellow",
    "bleu",
    "rouge",
    "noir",
    "blanc",
    "vert",
    "jaune",
  ];
  const selectedOption = optionWords.find((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
  if (selectedOption) {
    const optionMatch = products.filter((product) =>
      [product.name, product.parentName, product.sku].some((value) => value.toLowerCase().includes(selectedOption))
    );
    if (optionMatch.length) return optionMatch;
  }

  const nameMatch = products.filter((product) => {
    const terms = product.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 4);
    return terms.length > 0 && terms.some((term) => normalized.includes(term));
  });

  return nameMatch.length ? nameMatch : products;
}

export function inferSearchQuery(messages: AssistantMessage[], products: CatalogProduct[]) {
  const latest = messages.at(-1)?.content || "";
  if (/^\s*i need\s+\d+\s+more/i.test(latest) && products[0]) return products[0].name;
  if (isCartIntent(latest) && /\b(it|this|that|them|those|one|the product|checkout|cart)\b/i.test(latest)) {
    const previousProductRequest = messages
      .slice(0, -1)
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .reverse()
      .find((message) => !isCartIntent(message) && !isQuoteIntent(message) && message.trim().length > 2);

    if (previousProductRequest) return inferSearchQuery([{ role: "user", content: previousProductRequest }], products);
  }

  const followUpChoice = latest.match(/\b(?:i'?ll|i will|we'?ll|we will)\s+go\s+with\s+(?:the\s+)?(.+)/i);
  if (followUpChoice?.[1]) return followUpChoice[1].replace(/[.?!]+$/, "").trim();

  const brandModel = latest.match(/\b(ferno|zoll|laerdal|philips|physio-control|prestan|nasco|ambu)(?:\s+(?:model\s*)?[A-Z0-9-]+)?\b/i);
  if (brandModel?.[0]) return brandModel[0].trim();

  return latest;
}

export function priorAssistantRequestedQuoteDetails(messages: AssistantMessage[]) {
  return messages
    .slice(-4)
    .some(
      (message) =>
        message.role === "assistant" &&
        /quote request|demande de devis|send your quote|envoyer votre demande|still need|il me manque/i.test(
          message.content
        )
    );
}

function extractRequestedProductText(messages: AssistantMessage[]) {
  const userMessages = messages.filter((message) => message.role === "user").map((message) => message.content.trim());
  const quoteMessage =
    userMessages.find((message) => isQuoteIntent(message) && message.length > 8) ||
    userMessages.find((message) => /\b(need|looking for|want|cherche|besoin|veux|voudrais)\b/i.test(message));

  return (quoteMessage || userMessages.at(-1) || "").replace(emailPattern, "").trim();
}

export function buildQuoteDraft(
  messages: AssistantMessage[],
  language: AssistantLanguage,
  products: CatalogProduct[]
): { request?: QuoteRequest; missing: string[] } {
  const text = messages.map((message) => message.content).join("\n");
  const email = text.match(emailPattern)?.[0] || "";
  const phone = text.match(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/)?.[0];
  const name =
    text.match(/(?:my name is|name is|i am|i'm|je m'appelle|mon nom est)\s+([A-Z][A-Za-z' -]{1,60})/i)?.[1]?.trim() ||
    directReplyFor(messages, "name");
  const company =
    text.match(/(?:company is|from|for|compagnie|entreprise)\s+([A-Z0-9][A-Za-z0-9&.,' -]{1,80})/i)?.[1]?.trim() ||
    directReplyFor(messages, "company");
  const quantity = extractQuantity(text);
  const requestedProducts = products.length
    ? products.slice(0, 5).map((product) => ({
        name: product.name,
        sku: product.sku,
        quantity,
        url: product.url,
      }))
    : [
        {
          name: extractRequestedProductText(messages),
          quantity,
          description: extractRequestedProductText(messages),
        },
      ].filter((product) => product.name.length >= 3);

  const missing = [
    !name ? "name" : "",
    !email ? "email" : "",
    !requestedProducts.length ? "products" : "",
    !quantity ? "quantities" : "",
  ].filter(Boolean);

  if (missing.length) return { missing };

  return {
    missing,
    request: {
      name,
      company,
      email,
      phone,
      products: requestedProducts,
      notes: "Generated by EMRN AI Assistant. Please confirm all details before quoting.",
      conversation: messages,
      language,
    },
  };
}

export function buildSupportDraft(
  messages: AssistantMessage[],
  language: AssistantLanguage
): { request?: SupportRequest; missing: string[] } {
  const text = messages.map((message) => message.content).join("\n");
  const email = text.match(emailPattern)?.[0] || "";
  const name =
    text.match(/(?:my name is|name is|i am|i'm|je m'appelle|mon nom est)\s+([A-Z][A-Za-z' -]{1,60})/i)?.[1]?.trim() ||
    directReplyFor(messages, "name");
  const question =
    messages
      .filter((message) => message.role === "user" && !isSupportYes(message.content))
      .at(-1)?.content ||
    messages.filter((message) => message.role === "user").at(-1)?.content ||
    "";
  const missing = [!name ? "name" : "", !email ? "email" : "", !question ? "question" : ""].filter(Boolean);

  if (missing.length) return { missing };
  return { missing, request: { name, email, question, conversation: messages, language } };
}

export function buildOrderStatusDraft(
  messages: AssistantMessage[],
  language: AssistantLanguage
): { request?: OrderStatusRequest; missing: string[] } {
  const text = messages.map((message) => message.content).join("\n");
  const latest = messages.at(-1)?.content || "";
  const email = text.match(emailPattern)?.[0] || "";
  const name =
    text.match(/(?:my name is|name is|i am|i'm|je m'appelle|mon nom est)\s+([A-Z][A-Za-z' -]{1,60})/i)?.[1]?.trim() ||
    directReplyFor(messages, "name");
  const explicitOrderNumber =
    text.match(/\b(?:order|commande)\s*(?:number|#|no\.?|num[eé]ro)\s*[:#-]?\s*([A-Z0-9-]{4,30})\b/i)?.[1] ||
    text.match(/\border\s*#\s*([A-Z0-9-]{4,30})\b/i)?.[1] ||
    text.match(/\bcommande\s*#\s*([A-Z0-9-]{4,30})\b/i)?.[1];
  const standaloneOrderNumber = latest.match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9-]{5,30}\b/i)?.[0] || "";
  const orderNumber = explicitOrderNumber || standaloneOrderNumber;

  const missing = [!email ? "email" : "", !orderNumber ? "order number" : ""].filter(Boolean);
  if (missing.length) return { missing };

  return {
    missing,
    request: {
      email,
      name,
      orderNumber,
      conversation: messages,
      language,
    },
  };
}

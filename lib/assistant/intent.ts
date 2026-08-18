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

function looksLikeLowercaseProductPhrase(text: string) {
  const words = text.match(/[A-Za-zÀ-ÿ]+/g) || [];
  // A short lowercase reply such as "ashley" or "ashley smith" can be a
  // name. A longer all-lowercase phrase is much more likely to be the item
  // description the customer is sourcing, and must not become their name.
  return words.length >= 3 && words.every((word) => word === word.toLowerCase());
}

function combinedLineNameCandidate(text: string) {
  const cleaned = cleanDirectReply(text);
  if (!cleaned || cleaned.length > 80) return "";
  if (/^(hi|hello|thanks|thank you|please|yes|ok|okay|oui)$/i.test(cleaned)) return "";
  if (/^(?=.*\d)[A-Z0-9+._-]{3,80}$/i.test(cleaned)) return "";
  if (/\d{3,}/.test(cleaned)) return "";
  if (looksLikeLowercaseProductPhrase(cleaned)) return "";
  return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,80}$/.test(cleaned) ? cleaned : "";
}

function contactNameFromLatestReply(messages: AssistantMessage[]) {
  const latest = userMessages(messages).at(-1) || "";
  if (!emailPattern.test(latest)) return "";

  const parts = latest.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean);
  const emailIndex = parts.findIndex((part) => emailPattern.test(part));
  const cleaned =
    (emailIndex > 0 ? combinedLineNameCandidate(parts[emailIndex - 1]) : "") ||
    combinedLineNameCandidate(parts.find((part) => !emailPattern.test(part)) || "");

  if (!cleaned || cleaned.length > 60) return "";
  if (/^(hi|hello|thanks|thank you|please|yes|ok|okay|oui)$/i.test(cleaned)) return "";
  if (/^(?=.*\d)[A-Z0-9+._-]{3,40}$/i.test(cleaned)) return "";
  return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,60}$/.test(cleaned) ? cleaned : "";
}

function plainNameCandidate(text: string) {
  const cleaned = cleanDirectReply(text);
  if (!cleaned || cleaned.length > 60) return "";
  if (emailPattern.test(cleaned)) return "";
  if (/\b(quote|quotes|devis|cart|checkout|availability|available|support|order|commande|sku|product|produit|item|article)\b/i.test(cleaned)) return "";
  if (/^(hi|hello|thanks|thank you|please|yes|ok|okay|oui)$/i.test(cleaned)) return "";
  if (/^(?=.*\d)[A-Z0-9+._-]{3,40}$/i.test(cleaned)) return "";
  if (looksLikeLowercaseProductPhrase(cleaned)) return "";
  return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' -]{1,60}$/.test(cleaned) ? cleaned : "";
}

function contactNameFromPriorNamePrompt(messages: AssistantMessage[]) {
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    const message = messages[index];
    const previous = messages[index - 1];
    if (message?.role !== "user" || previous?.role !== "assistant") continue;
    if (!/\b(name|nom)\b/i.test(previous.content)) continue;
    const candidate = plainNameCandidate(message.content);
    if (candidate) return candidate;
  }
  return "";
}

function isGenericQuoteOnlyText(message: string) {
  return /^(?:can\s+i\s+get|can\s+you\s+send|i\s+need|need|i\s+want|i\s+would\s+like|request|send|please)?\s*(?:a|an)?\s*(?:s?quotes?|devis|soumission)\s*$/i.test(
    message.replace(emailPattern, "").trim()
  );
}

function directReplyFor(messages: AssistantMessage[], field: "name" | "company" | "email") {
  if (!assistantAskedFor(messages, field)) return "";
  const latest = userMessages(messages).at(-1) || "";
  if (field === "email") return latest.match(emailPattern)?.[0] || "";
  if (field === "name" && emailPattern.test(latest)) {
    const parts = latest.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean);
    const emailIndex = parts.findIndex((part) => emailPattern.test(part));
    if (emailIndex > 0) {
      const candidate = combinedLineNameCandidate(parts[emailIndex - 1]);
      if (candidate) return candidate;
    }
    return "";
  }

  const cleaned = cleanDirectReply(latest);
  if (!cleaned || cleaned.length > 80 || /\b(quote|devis|cart|checkout|availability|available)\b/i.test(cleaned)) return "";
  if (field === "name" && /^(?=.*\d)[A-Z0-9+._-]{3,40}$/i.test(cleaned)) return "";
  if (field === "name" && looksLikeLowercaseProductPhrase(cleaned)) return "";
  if (field === "name") return plainNameCandidate(cleaned);
  return cleaned;
}

function escapeRegExp(value: string) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function intentText(text: string) {
  return String(text || "")
    .replace(/\bteh\b/gi, "the")
    .replace(/\bwhti\b/gi, "with")
    .replace(/\bwit\b/gi, "with")
    .replace(/\bsepak\b/gi, "speak")
    .replace(/\bspeek\b/gi, "speak")
    .replace(/\btlak\b/gi, "talk")
    .replace(/\brepresen(?:ta|at|taa|ata)?t(?:a|ai|ia)?ive\b/gi, "representative")
    .replace(/\brep\b/gi, "representative")
    .replace(/\bagens\b/gi, "agents")
    .replace(/\bagen\b/gi, "agent")
    .replace(/\bagnets\b/gi, "agents")
    .replace(/\bagnet\b/gi, "agent")
    .replace(/\bcostumer\b/gi, "customer")
    .replace(/\bsupprot\b/gi, "support")
    .replace(/\bsuport\b/gi, "support")
    .replace(/\bcontect\b/gi, "contact")
    .replace(/\bcontct\b/gi, "contact")
    .replace(/\boder\b/gi, "order")
    .replace(/\bordr\b/gi, "order")
    .replace(/\bstauts\b/gi, "status")
    .replace(/\bstaus\b/gi, "status")
    .replace(/\btraking\b/gi, "tracking")
    .replace(/\btrackng\b/gi, "tracking")
    .replace(/\bshipp?d\b/gi, "shipped")
    .replace(/\bshiping\b/gi, "shipping")
    .replace(/\bqoute\b/gi, "quote")
    .replace(/\bqupte\b/gi, "quote")
    .replace(/\bqutoe\b/gi, "quote")
    .replace(/\bsquote\b/gi, "quote")
    .replace(/\bavailvilty\b/gi, "availability")
    .replace(/\bavailablity\b/gi, "availability")
    .replace(/\bavail(?:a|i)?b(?:i|l)?l?ity\b/gi, "availability")
    .replace(/\bavalable\b/gi, "available")
    .replace(/\bavailble\b/gi, "available");
}

export function isMedicalAdviceRequest(text: string) {
  text = intentText(text);
  return /\b(should i use|what treatment|diagnose|diagnosis|symptoms|medication|dose|dosage|prescribe|wound infected|is this safe for my condition)\b/i.test(text);
}

export function isNegativeSearchFeedback(text: string) {
  text = intentText(text);
  const normalized = text.toLowerCase().replace(/[’']/g, "").replace(/[.!?]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (/^(this is wrong|that is wrong|thats wrong|thats not it|that is not it|that not my item|that is not my item|thats not my item|this is not my item|this isnt my item|not it|wrong|wrong one|wrong item|wrong product|incorrect|not correct|no that is not it|no thats not it|nope thats not it|nope not it|not what i need|not what i asked|not helpful|does not help|doesnt help|useless|meri useless|meringue useless)$/.test(normalized)) {
    return true;
  }
  return /\b(this is wrong|that is wrong|thats wrong|thats not it|that is not it|that not my item|that is not my item|thats not my item|this is not my item|this isnt my item|wrong item|wrong product|not what i need|not what i asked|not helpful|doesnt help|does not help|meri useless|meringue useless)\b/i.test(normalized);
}

export function isQuoteIntent(text: string) {
  text = intentText(text);
  return /\b(quotes?|pricing|formal quotes?|request (?:a )?quotes?|discounts?|special pricing|bulk price|bulk discount|bulk orders?|large orders?|volume pricing|volume discount|company pricing|business discount|academic pricing|academic discount|education pricing|school pricing|university pricing|university discount|research pricing|research discount|hospital pricing|institutional pricing|nonprofit pricing|government pricing|purchase order|po\b|b2b|devis|soumission|prix|devis automatique|auto quote)\b/i.test(text);
}

export function isCartIntent(text: string) {
  text = intentText(text);
  return /\b(add (?:the |this |that |it |one |red |blue |both |all )?.*(?:too|also)?|add to (?:my )?(?:cart|catt|cartt|crt)|(?:cart|catt|cartt|crt)|checkout|buy this|buy it|purchase online|order online|ajouter au panier|panier|payer|commander en ligne)\b/i.test(text) ||
    /\b(?:i|we)\s*(?:(?:'|’)?(?:ll|d)|will|would)?\s*(?:take|get|buy|order|purchase|want|need|choose|pick|go with)\s+(?:the\s+)?(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|#?\s*[1-5]|number\s+[1-5]|option\s+[1-5])(?:\s+(?:one|item|product))?\b/i.test(text) ||
    /\b(?:i|we)\s*(?:(?:'|’)?(?:ll|d)|will|would)?\s*(?:want|need|would like|like)\s+to\s+(?:purchase|buy|order|get|take)\s+(?:the\s+)?(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|#?\s*[1-5]|number\s+[1-5]|option\s+[1-5])(?:\s+(?:one|item|product))?\b/i.test(text) ||
    /\b(?:i|we)\s*(?:'|’)?(?:ll|d)?\s*(?:take|get|buy|order|purchase|want|need)\s+(?:it|this|that|them|these|those|one|ones?)\b/i.test(text) ||
    /\b(?:make|set|change)\s+(?:it|this|that|them|these|those|the\s+first|first|the\s+second|second|the\s+third|third|the\s+item|the\s+product)\s+(?:to\s+)?\d{1,5}\s*(?:boxes?|packs?|cases?)?\b/i.test(text) ||
    /\b(?:make|set|change)\s+.{2,60}?\s+(?:to\s+)?\d{1,5}\s*(?:boxes?|packs?|cases?)\b/i.test(text) ||
    /\b\d{1,5}\s+(?:of\s+)?(?:the\s+)?(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)(?:\s+(?:one|item|product))?\b/i.test(text) ||
    /\b\d{1,5}\s+(?:of\s+)?(?:#|number|no\.?|option|item)\s*[1-5]\b/i.test(text) ||
    /\b\d{1,5}\s+(?:du|de\s+la|de\s+l['’]?|de|des)\s+(?:premier|premiere|première|deuxieme|deuxième|troisieme|troisième|quatrieme|quatrième|cinquieme|cinquième|dernier|derniere|dernière)\b/i.test(text) ||
    /\b(?:i|we)\s+(?:want|need|will take|would like|get|take)\s+\d{1,5}\s+(?:of\s+)?(?:it|them|these|those|this|that|the first|first|the second|second|the third|third|the item|the product|each|ones?)\b/i.test(text) ||
    /^\s*\d{1,5}\s+(?:of\s+)?(?:it|them|these|those|this|that|the first|first|the second|second|the third|third|the item|the product|each|ones?)\s*$/i.test(text) ||
    /^\s*(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th|#?\s*[1-5]|number\s+[1-5]|option\s+[1-5])\s*$/i.test(text);
}

export function isProductCapabilityIntent(text: string) {
  text = intentText(text);
  if (isQuoteIntent(text) || isCartIntent(text) || isOrderStatusIntent(text) || isContactIntent(text) || isAccountIntent(text)) {
    return false;
  }
  if (/\b(?:do\s+you|do\s+u|you)\s+(?:have|carry|sell|stock|offer)\b/i.test(text)) {
    return false;
  }

  const asksCapability = /\b(can|does|do|will|would|is|are|peut|peuvent|est-ce que|es[-\s]?ce que)\b/i.test(text);
  const hasProductReference =
    /\b(this|that|it|these|those|product|item|bag|pack|device|unit|pads?|electrodes?|batter(?:y|ies)|airways?|lungs?|manikins?|monitors?|cuffs?|dressings?|gloves?|needles?|syringes?|catheters?|ce|cet|cette|ces|produit|article|sac)\b/i.test(text) ||
    /\b(?=[A-Z0-9+.-]*\d)[A-Z0-9]{3,}(?:[-+.][A-Z0-9]{1,})*\b/i.test(text);
  const capabilityTerm = /\b(hold|holds|holding|carry|carries|carrying|accommodate|accommodates|fit|fits|support|supports|include|includes|come with|comes with|mount|mounts|attach|attaches|connect|connects|use with|works? with|compatible|waterproof|water-resistant|sterile|latex|oxygen|o2|tank|cylinder|tenir|contient|contenir|transporter|supporte|inclut|compris|compatible|étanche|etanche|stérile|sterile|latex|oxygène|oxygene|réservoir|reservoir|cylindre)\b/i.test(text);
  const broadCapabilityShape = /\b(?:can|will|would|is|are|peut|peuvent|est-ce que|es[-\s]?ce que)\b.{0,90}\b(?:be|used|use|go|handle|cleaned|washed|disinfected|autoclaved|sterilized|sterilised|mounted|attached|connected|placed|stored|transported|utilis[eé]|nettoy[eé]|lav[eé]|d[eé]sinfect[eé]|autoclav[eé]|st[eé]rilis[eé]|mont[eé]|attach[eé]|connect[eé]|plac[eé]|stock[eé]|transport[eé])\b/i.test(text);

  return asksCapability && hasProductReference && (capabilityTerm || broadCapabilityShape);
}

export function isProductDetailIntent(text: string) {
  text = intentText(text);
  if (/\b(?:do\s+you|do\s+u|you)\s+(?:have|carry|sell|stock|offer)\b/i.test(text)) {
    return false;
  }
  return isProductCapabilityIntent(text) || /\b(how\s+often|between\s+(?:each\s+)?patient|after\s+(?:each\s+)?patient|change|changed|replace|replacement\s+frequency|how\s+big|how\s+large|how\s+long|how\s+much|how\s+many|who\s+makes|who\s+sells|sold\s+by|manufacturer|brand|what\s+colors?|what\s+colours?|what\s+sizes?|price|cost|compatible|compatibility|fit|fits|work with|works with|go with|goes with|hold|holds|holding|carry|carries|carrying|accommodate|accommodates|oxygen tank|oxygen cylinder|o2 tank|o2 cylinder|for this|for that|replacement part|replacement parts|accessory|accessories|part|parts|handle|handles|dimension|dimensions|measurements?|description|details?|overview|features?|what\s+is\s+it|tell\s+me\s+about|what\s+does\s+it\s+include|included|includes|include|comes?\s+with|specs?|specifications?|sizes?|sizing|height|width|depth|length|weight|diameter|capacity|box|boxes|pack|package|case|count|quantity|quantities|qty|sold as|unit of sale|waterproof|water-resistant|water resistant|water resistance|rating|ratings|latex|latex-free|latex free|material|materials|made of|disposable|reusable|single-use|single use|clean|cleaned|wash|washed|disinfect|disinfected|autoclave|autoclaved|sterilize|sterilized|sterilise|sterilised|colors?|colours?|compatible|compatibilite|compatibilité|dimensions?|mesures?|description|détails?|details?|aperçu|apercu|caractéristiques?|caracteristiques?|inclus|comprend|taille|poids|largeur|longueur|hauteur|prix|couleur|quantit[eé]|vendu comme|tenir|contient|contenir|transporter|réservoir d.oxygène|reservoir d.oxygene|cylindre d.oxygène|cylindre d.oxygene|latex|sans latex|matériau|materiau|jetable|réutilisable|reutilisable|nettoyer|lavable|désinfecter|desinfecter|autoclave|stériliser|steriliser)\b/i.test(text);
}

export function isAccountIntent(text: string) {
  text = intentText(text);
  // Common customer typo: "coount" drops the leading "a". Keep this
  // service request out of the catalog path rather than returning products.
  if (/\b(?:create|make|open)\s+(?:an?\s+)?(?:account|acount|coount)\b/i.test(text)) return true;
  return /\b(my account|business account|create an? ac{1,2}o+u?nt|make an? ac{1,2}o+u?nt|open an? ac{1,2}o+u?nt|register|logged in|login|shipping address|ship to|purchase history|reorder|last year|invoice|orders|company pricing|buyer portal|mon compte|compte entreprise|creer un compte|créer un compte|numero de membre|numéro de membre|ai[- ]?je un compte|j.?ai un compte|adresse de livraison|historique|facture|mes commandes)\b/i.test(text);
}

export function isOrderStatusIntent(text: string) {
  text = intentText(text);
  const hasOrderSupportContext = /\b(order|orders|commande|commandes|shipment|shipping|tracking|free shipping|discount code|discount|on hold|hold|support|answer|reply|email|ticket|customer service|service client|livraison|expédition|expedition|rabais|code promo|réponse|reponse|courriel|billet)\b/i.test(text);
  const looksLikeDelayedOrderOrSupport =
    /\b(?:my\s+)?orders?\b.{0,160}\b(?:hold|on hold|waiting|waited|no answer|no reply|didn'?t receive|didnt receive|not received|haven'?t received|havent received|still|delayed|delay|shipped|shipping)\b/i.test(text) ||
    /\bcommandes?\b.{0,160}\b(?:en attente|attente|attends|attend|aucune réponse|aucune reponse|pas de réponse|pas de reponse|pas reçu|pas recu|toujours|retard|expédiée|expediee|livraison)\b/i.test(text) ||
    /\b(?:waiting|waited|been waiting|still waiting|attends|attendu|j'attends|jattends|toujours en attente)\b.{0,100}\b(?:week|weeks|days|order|orders|answer|reply|support|update|email|ticket|semaine|semaines|jours|commande|commandes|réponse|reponse|courriel|billet)\b/i.test(text) ||
    /\b(?:no answer|no reply|no one answered|nobody answered|aucune réponse|aucune reponse|pas de réponse|pas de reponse|personne n.a répondu|personne n.a repondu|didn'?t receive(?:d)?\s+(?:an\s+)?answer|didnt receive(?:d)?\s+(?:an\s+)?answer|didn'?t get\s+(?:an\s+)?answer|not heard back)\b/i.test(text) ||
    /\b(?:order|orders?)\b.{0,100}\b(?:on hold|hold|stuck|delayed|delay|not shipped|hasn'?t shipped|hasnt shipped|havent shipped|haven'?t shipped)\b/i.test(text);
  const standaloneWaitingSupport =
    /\b(?:i|we)\s+(?:have\s+)?(?:been\s+)?(?:waiting|waited)\s+for\s+(?:\d+\s+)?(?:day|days|week|weeks|month|months)\b/i.test(text) ||
    /\b(?:j'attends|jattends|nous attendons|nous avons attendu|attendu)\s+(?:depuis|pour)?\s*(?:\d+\s+)?(?:jour|jours|semaine|semaines|mois)\b/i.test(text);

  return /\b(order status|order update|update on my order|update for my order|order tracking|track(?:ing)?|where is my order|shipment update|shipping update|check order|check my order|commande|suivi|statut de commande|ou est ma commande|où est ma commande)\b/i.test(text) ||
    (hasOrderSupportContext && looksLikeDelayedOrderOrSupport) ||
    standaloneWaitingSupport ||
    /\b(?:order|commande)\s*(?:number|#|no\.?|num[eé]ro)?\s*[:#-]?\s*(?=[A-Z0-9-]*\d)[A-Z0-9-]{4,30}\b/i.test(text);
}

export function isContactIntent(text: string) {
  text = intentText(text);
  // Accept French phrasing with or without the apostrophe/extra "u" and
  // standalone cancellation requests; accented final letters are not JS
  // "word" characters, so these checks intentionally avoid a trailing \b.
  if (/\bparler\s+(?:à|a)\s+quelqu(?:['’]?u)?n(?:\s|$)/i.test(text)) return true;
  if (/\b(?:je|j)\s*(?:veux|voudrais)\s+l['’]?(?:annul(?:er|é|ee|ée)|cancel(?:er)?)(?:\s|$)/i.test(text)) return true;
  return /\b(contact us|contact support|customer service|talk to support|talk to someone|talk to an agents?|talk to agents?|speak to someone|speak with someone|speak to an agents?|speak with an agents?|speak with agents?|live agents?|agents?|representatives?|human support|human agents?|email support|need (?:customer )?support|want (?:customer )?support|(?:support|help|need help) (?:with|for) (?:my |an |a )?(?:(?:damaged?|missing|wrong|defective|broken|returned?|return|refund|warranty) )?(?:order|product|item|return|quote|account)|help from your team|no answer|no reply|nobody answered|no one answered|nobody got back|no one got back|didn'?t hear back|didnt hear back|not heard back|unanswered|waiting for (?:a )?(?:response|reply|answer)|received no number|no number (?:was )?(?:given|provided|received)|lost (?:my )?order number|don't have (?:my )?order number|do not have (?:my )?order number|(?:cancel|annul(?:er|é|ee|ée|ation)?)\s+(?:my |the |ma |mon |une |la )?(?:order|commande)|(?:je|j)\s*(?:veux|voudrais)\s+l['’]?(?:annul(?:er|é|ee|ée)|cancel(?:er)?)|communiquer avec|contacter|parler (?:à|a) quelqu['’]?un|parler (?:à|a) un agents?|agents? humain|support humain|j.?ai besoin d.?aide|besoin d.?aide.*(?:commande|produit|article|retour|devis|compte)|service client|représentants?|representants?|aucune réponse|aucune reponse|pas de réponse|pas de reponse|personne (?:ne )?(?:m|ma|nous|me)?\s*a répondu|personne (?:ne )?(?:m|ma|nous|me)?\s*a repondu|personne repondu|personne répondu|sans réponse|sans reponse)\b/i.test(text);
}

export function isAvailabilityIntent(text: string) {
  text = intentText(text);
  return /\b(availability|available|in stock|stock|check availability|lead time|ship|ships|shipped|shipping date|ship date|when will.*ship|when.*shipped|backorder|back order|disponibilite|disponibilité|disponible|en stock|delai|délai|exp[eé]di[eé]|exp[eé]dition)\b/i.test(text);
}

export function isFindProductPrompt(text: string) {
  text = intentText(text);
  return /^\s*(find a product|find product|trouver un produit|je cherche un produit)\s*$/i.test(text);
}

export function isProductSearchIntent(text: string) {
  text = intentText(text);
  if (isQuoteIntent(text) || isCartIntent(text) || isOrderStatusIntent(text) || isContactIntent(text) || isAccountIntent(text)) {
    return false;
  }

  return /\b(do you have|do have|do u have|so you have|you have|do you carry|carry|find|search|show me|looking for|look for|i need|we need|i want|we want|need|want|image of|picture of|photo of|poster of|chart of|diagram of|reference for|reference image|je cherche|cherche|avez-vous|avez vous|as-tu|as tu)\b/i.test(text);
}

export function isQuickActionPrompt(text: string) {
  return isFindProductPrompt(text) || isProductSearchIntent(text) || isAvailabilityIntent(text) || isQuoteIntent(text) || isOrderStatusIntent(text) || isContactIntent(text);
}

export function isSupportYes(text: string) {
  return /^(yes|yeah|please|sure|ok|oui|svp|s'il vous plait|s’il vous plaît)/i.test(text.trim());
}

export function extractSkuCandidates(text: string) {
  const candidates: string[] = [];
  const normalizedText = String(text || "").replace(emailPattern, " ").replace(
    /\b(do\s*you\s*have|do\s*u\s*have|have|carry|find|search|show\s*me|sku|item|product|produit|avez[-\s]?vous|cherche)(?=[A-Z]{1,12}\d|[A-Z0-9]{2,}[/-][A-Z0-9]+|\d{4,})/gi,
    "$1 "
  );
  const skuText = normalizedText
    .replace(/\b(?:order|commande)\s*(?:number|#|no\.?|num[eé]ro)?\s*[:#-]?\s*(?=[A-Z0-9-]*\d)[A-Z0-9-]{4,30}\b/gi, " ")
    .replace(/\b(?:this|item|product|produit)(?=[A-Z]{1,10}\s*-?\s*\d{2,})/gi, " ")
    .replace(/\b(?:do\s+you\s+have|do\s+u\s+have|have|carry|find|search|show\s+me|looking\s+for|look\s+for|avez[-\s]?vous|cherche)\b/gi, " ")
    .replace(/\b(?:i|we)\s+(?:want|would like|need)\s+to\s+(?:purchase|buy|order)\b/gi, " ")
    .replace(/\b(?:purchase|buy|order|add|cart|catt|cartt|crt|checkout|sku|item|product|produit|acheter|commander|panier)\b/gi, " ");

  for (const match of normalizedText.matchAll(/\bsku\s*[:#]?\s*([A-Z0-9]{2,}(?:\s*[/-]\s*[A-Z0-9]+)+\+?|[A-Z]{1,8}\s*-?\s*\d{3,}(?:-[A-Z0-9]+)*\+?|\d{3,}(?:-[A-Z0-9]+)*\+?)(?=\s|$|[,.!?])/gi)) {
    candidates.push(match[1]);
  }

  const matches =
    skuText.match(/\b(?:(?=[A-Z0-9]*\d)[A-Z0-9]{2,}(?:\s*[/-]\s*[A-Z0-9]+)+\+?|[A-Z]{1,4}\s*-?\s*\d{3,}[A-Z0-9]*(?:-[A-Z0-9]+)*\+?|[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+\+?|\d{4,}\+?)(?=\s|$|[,.!?])/gi) || [];
  candidates.push(...matches.filter((sku) => !/^sku\s*\d/i.test(sku)));

  for (const match of skuText.matchAll(/(?:^|[^\w/-])(?=([A-Z0-9+/-]{3,30})(?=\s|$|[,.!?]))(?=[A-Z0-9+/-]*\d)([A-Z0-9][A-Z0-9+/-]{2,29}\+?)(?=\s|$|[,.!?])/gi)) {
    const value = match[2] || match[1];
    if (!value) continue;
    if (/^\d{1,3}$/.test(value)) continue;
    candidates.push(value);
  }

  return Array.from(new Set(candidates.map((sku) => sku.replace(/\s+/g, "").toUpperCase().replace(/^(?:THIS|ITEM|PRODUCT|PRODUIT|HAVE|CARRY|FIND|SEARCH|FOR|POUR)(?=\d)/i, "")).filter((sku) => {
    // "or 300 lb" and "and 300 ml" are ordinary alternatives or joined
    // requirements, not SKU prefixes. Treating them as OR300 / AND300 sends
    // a normal product question down the SKU-only route and can hide the
    // valid second option from the catalog.
    if (/^(?:OR|AND|OU|ET)\d+(?:ML|MM|CM|IN|LB|L)?$/i.test(sku)) return false;
    if (/^\d{1,3}G$/i.test(sku)) return false;
    if (/^OF\d{1,5}$/i.test(sku)) return false;
    if (/^X\d{1,5}$/i.test(sku)) return false;
    if (/^X\d+-\d+$/i.test(sku)) return false;
    // Do not turn a North American phone number into a quote line item.
    if (/^[2-9]\d{2}-?[2-9]\d{2}-?\d{4}$/.test(sku)) return false;
    if (!/\d/.test(sku)) return false;
    if (/^\d{1,3}(?:ML|MM|CM|IN)?$/i.test(sku)) return false;
    return true;
  })));
}

function textWithoutSkuLikeTokens(text: string) {
  let cleaned = String(text || "");
  for (const sku of extractSkuCandidates(cleaned)) {
    cleaned = cleaned.replace(new RegExp(escapeRegExp(sku), "gi"), " ");
    if (sku.includes("-")) cleaned = cleaned.replace(new RegExp(escapeRegExp(sku.replace(/-/g, "")), "gi"), " ");
  }

  return cleaned
    .replace(/\b[A-Z]{1,10}\s*-?\s*\d{3,}[A-Z0-9]*(?:-[A-Z0-9]+)*\+?\b/gi, " ")
    .replace(/\b[A-Z0-9]{2,}(?:\s*[/-]\s*[A-Z0-9]+)+\+?\b/gi, " ")
    .replace(/\b\d{4,}\+?\b/g, " ");
}

export function allowsMultipleCartItems(text: string) {
  return /\b(all|both|these|them|tous|les deux)\b/i.test(text) ||
    ordinalIndexesInText(text, 8).length > 1 ||
    extractSkuCandidates(text).length > 1;
}

export function extractQuantity(text: string) {
  const normalized = String(text || "").trim().toLowerCase();
  const selectedItem =
    "(?:it|them|these|those|this|that|the\\s+first|first|the\\s+second|second|the\\s+third|third|the\\s+item|the\\s+product|each|ones?)";
  const explicitQuantity =
    normalized.match(/\b(?:qty|quantity|x)\s*(\d{1,5})\b/i) ||
    normalized.match(new RegExp(`\\b(\\d{1,5})\\s+(?:of\\s+)?${selectedItem}\\b`, "i"));
  if (explicitQuantity) return Number(explicitQuantity[1]);

  if (
    /^\s*#?\s*[1-9]\s*$/.test(normalized) ||
    /\b(?:#|number|no\.?|option|item)\s*[1-9]\b/i.test(normalized) ||
    /\b[1-9](?:st|nd|rd|th)\b/i.test(normalized)
  ) {
    return 1;
  }

  const quantityText = textWithoutSkuLikeTokens(text);
  const match = quantityText.match(/\b(\d{1,5})\b/);
  return match ? Number(match[1]) : 1;
}

export function hasExplicitQuantity(text: string) {
  const normalized = String(text || "").trim().toLowerCase();
  const selectedItem =
    "(?:it|them|these|those|this|that|the\\s+first|first|the\\s+second|second|the\\s+third|third|the\\s+item|the\\s+product|each|ones?)";
  if (/\b(?:qty|quantity|x)\s*\d{1,5}\b/i.test(normalized)) return true;
  if (new RegExp(`\\b\\d{1,5}\\s+(?:of\\s+)?${selectedItem}\\b`, "i").test(normalized)) return true;
  if (/\b\d{1,5}\s+(?:of\s+)?(?:#|number|no\.?|option|item)\s*[1-5]\b/i.test(normalized)) return true;
  if (/\b(?:first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\b[^0-9]{0,24}\b(?:qty|quantity|x)\s*\d{1,5}\b/i.test(normalized)) return true;
  return false;
}

export function extractOrdinalSelection(text: string, productCount = 0) {
  const normalized = String(text || "").toLowerCase();
  const ordinals: Array<[RegExp, number]> = [
    [/\b(first|1st|top|the one at the top|premier|premiere|première)\b/i, 0],
    [/\b(second|2nd|deuxieme|deuxième)\b/i, 1],
    [/\b(third|3rd|troisieme|troisième)\b/i, 2],
    [/\b(fourth|4th|quatrieme|quatrième)\b/i, 3],
    [/\b(fifth|5th|cinquieme|cinquième)\b/i, 4],
  ];

  for (const [pattern, index] of ordinals) {
    if (pattern.test(normalized) && (!productCount || index < productCount)) return index;
  }

  if (/\b(last|final|dernier|derniere|dernière)\b/i.test(normalized) && productCount > 0) return productCount - 1;

  const explicitNumeric = normalized.match(/\b(?:#|number|no\.?|option|item)\s*([1-9])\b|\b([1-9])(?:st|nd|rd|th)\b/i);
  const standaloneNumeric = normalized.match(/^\s*#?\s*([1-9])\s*$/);
  const numeric = explicitNumeric?.[1] || explicitNumeric?.[2] || standaloneNumeric?.[1];
  if (numeric) {
    const index = Number(numeric) - 1;
    if (index >= 0 && (!productCount || index < productCount)) return index;
  }

  return null;
}

function ordinalIndexesInText(text: string, productCount: number) {
  const normalized = String(text || "").toLowerCase();
  const ordinals: Array<[RegExp, number]> = [
    [/\b(first|1st|top|the one at the top|premier|premiere|première)\b/i, 0],
    [/\b(second|2nd|deuxieme|deuxième)\b/i, 1],
    [/\b(third|3rd|troisieme|troisième)\b/i, 2],
    [/\b(fourth|4th|quatrieme|quatrième)\b/i, 3],
    [/\b(fifth|5th|cinquieme|cinquième)\b/i, 4],
  ];
  const indexes = new Set<number>();

  for (const [pattern, index] of ordinals) {
    if (pattern.test(normalized) && index < productCount) indexes.add(index);
  }

  for (const match of normalized.matchAll(/\b(?:#|number|no\.?|option|item)\s*([1-9])\b|\b([1-9])(?:st|nd|rd|th)\b/gi)) {
    const value = match[1] || match[2];
    const index = Number(value) - 1;
    if (index >= 0 && index < productCount) indexes.add(index);
  }

  return Array.from(indexes).sort((a, b) => a - b);
}

function normalizedTokens(value: string) {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !/^(the|and|for|with|this|that|one|add|cart|buy|get|please|item|product)$/.test(term));
}

function scoreProductForText(text: string, product: CatalogProduct) {
  const haystack = [product.name, product.parentName, product.sku, product.brand, product.manufacturer]
    .join(" ")
    .toLowerCase();
  const tokens = normalizedTokens(text);
  if (!tokens.length) return 0;

  let score = 0;
  for (const token of tokens) {
    if (product.sku && token === product.sku.toLowerCase()) score += 50;
    else if (haystack.includes(token)) score += token.length >= 5 ? 8 : 4;
    else score -= 1;
  }

  const phrase = tokens.join(" ");
  if (phrase.length >= 5 && haystack.includes(phrase)) score += 20;
  return score;
}

export function selectProductsForRequest(text: string, products: CatalogProduct[]) {
  if (/\b(all|both|these|those|them|tous|les deux)\b/i.test(text)) return products;

  const ordinalIndexes = ordinalIndexesInText(text, products.length);
  if (ordinalIndexes.length > 1) return ordinalIndexes.map((index) => products[index]).filter(Boolean);

  const ordinalIndex = extractOrdinalSelection(text, products.length);
  if (ordinalIndex !== null) return products[ordinalIndex] ? [products[ordinalIndex]] : [];

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

  const scoredMatches = products
    .map((product) => ({ product, score: scoreProductForText(text, product) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scoredMatches.length) {
    const bestScore = scoredMatches[0].score;
    const closeMatches = scoredMatches.filter((item) => item.score >= Math.max(1, bestScore - 2));
    if (bestScore >= 12 || closeMatches.length < products.length) return closeMatches.map((item) => item.product);
  }

  return products;
}

export function selectProductsForCart(text: string, products: CatalogProduct[]) {
  return selectProductsForRequest(text, products);
}

function ordinalQuantityForText(text: string, index: number) {
  const terms = [
    ["first", "1st", "top", "premier", "premiere", "première"],
    ["second", "2nd", "deuxieme", "deuxième"],
    ["third", "3rd", "troisieme", "troisième"],
    ["fourth", "4th", "quatrieme", "quatrième"],
    ["fifth", "5th", "cinquieme", "cinquième"],
  ][index];
  if (!terms) return 0;
  const termPattern = terms.map(escapeRegExp).join("|");
  const numericBefore = new RegExp(`\\b(\\d{1,5})\\s+(?:of\\s+)?(?:#|number|no\\.?|option|item)\\s*${index + 1}\\b`, "i");
  const numericQuantity = Number(text.match(numericBefore)?.[1] || 0);
  if (numericQuantity > 0) return numericQuantity;
  const before = new RegExp(`\\b(\\d{1,5})\\s+(?:(?:of|du|de\\s+la|de\\s+l['’]?|de|des)\\s+)?(?:the\\s+)?(?:${termPattern})(?:\\s+(?:one|item|product))?\\b`, "i");
  const after = new RegExp(`\\b(?:${termPattern})(?:\\s+(?:one|item|product))?\\b[^\\d]{0,24}\\b(?:qty|quantity|x)?\\s*(\\d{1,5})\\b`, "i");
  return Number(text.match(before)?.[1] || text.match(after)?.[1] || 0);
}

export function quantityForProductSelection(text: string, product: CatalogProduct, index: number, fallbackQuantity = 1) {
  const ordinalQuantity = ordinalQuantityForText(text, index);
  if (ordinalQuantity > 0) return ordinalQuantity;

  const sku = product.sku ? escapeRegExp(product.sku) : "";
  if (sku) {
    const skuBefore = new RegExp(`\\b(\\d{1,5})\\s+(?:of\\s+)?(?:sku\\s*)?${sku}\\b`, "i");
    const skuAfter = new RegExp(`\\b(?:sku\\s*)?${sku}\\b[^\\d]{0,24}\\b(?:qty|quantity|x)?\\s*(\\d{1,5})\\b`, "i");
    const skuQuantity = Number(text.match(skuBefore)?.[1] || text.match(skuAfter)?.[1] || 0);
    if (skuQuantity > 0) return skuQuantity;
  }

  return fallbackQuantity;
}

export function inferSearchQuery(messages: AssistantMessage[], products: CatalogProduct[]) {
  const latest = messages.at(-1)?.content || "";
  if (/^\s*i need\s+\d+\s+more/i.test(latest) && products[0]) return products[0].name;
  if (isCartIntent(latest) && /\b(it|this|that|them|those|one|the product|checkout|cart|catt|cartt|crt)\b/i.test(latest)) {
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

  if (/\b(?:statpacks?|g3\+?)\b/i.test(latest) && /\bbackup\b/i.test(latest)) return "G35006TK+ G3+ Backup StatPacks";
  if (/\b(?:statpacks?|g3)\b/i.test(latest) && /\b(?:load\s*n\s*go|load-n-go|loadngo)\b/i.test(latest)) return "G35004 G3 Load N Go Medic Backpack StatPacks";

  const brandModel = latest.match(/\b(ferno|zoll|laerdal|philips|physio-control|prestan|nasco|ambu|statpacks?)(?:\s+(?:model\s*)?[A-Z0-9-]+)?\b/i);
  if (brandModel?.[0]) return brandModel[0].trim();

  return latest;
}

export function priorAssistantRequestedQuoteDetails(messages: AssistantMessage[]) {
  return messages
    .slice(-4)
    .some(
      (message) => {
        if (message.role !== "assistant") return false;
        const text = message.content.toLowerCase();
        return (
          text.includes("to send it here") ||
          text.includes("pour l'envoyer ici") ||
          /quote request|demande de devis|send your quote|envoyer votre demande|(?:quote|devis)[\s\S]{0,500}(?:still need|il me manque)/i.test(message.content)
        );
      }
    );
}

function extractRequestedProductText(messages: AssistantMessage[]) {
  const userMessages = messages.filter((message) => message.role === "user").map((message) => message.content.trim());
  const productMessages = userMessages.filter((message) => {
    if (/^(yes|yeah|yep|sure|ok|okay|please|send|send it|go ahead|oui|envoyer|d'accord|vas-y)$/i.test(message)) return false;
    if (emailPattern.test(message) && message.length < 90 && !extractSkuCandidates(message).length) return false;
    if (/^(my name is|name is|i am|i'm|je m'appelle|mon nom est|company is|compagnie|entreprise)\b/i.test(message)) {
      return /\b(need|looking for|want|quote|devis|cherche|besoin|veux|voudrais|do you have|do you carry|source|find|get)\b/i.test(message);
    }
    return message.length >= 3;
  });
  const quoteMessage =
    productMessages.find((message) => isQuoteIntent(message) && message.length > 8 && !isGenericQuoteOnlyText(message)) ||
    productMessages.find(
      (message) =>
        !isGenericQuoteOnlyText(message) &&
        /\b(need|looking for|want|cherche|besoin|veux|voudrais|do you have|do you carry|avez-vous|avez vous|source|sourcing|find|get)\b/i.test(message)
    );

  const requestedText = (quoteMessage || productMessages.filter((message) => !isGenericQuoteOnlyText(message)).at(-1) || "")
    .replace(emailPattern, "")
    .replace(/^.*?\b(?:quote|devis|soumission)\s+(?:for|pour)\s*/i, "")
    .trim();
  if (isGenericQuoteOnlyText(requestedText)) return "";
  return requestedText;
}

function quoteSelectionText(messages: AssistantMessage[]) {
  const candidates = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter((message) => {
      if (!message) return false;
      if (emailPattern.test(message) && message.length < 90 && !extractSkuCandidates(message).length) return false;
      if (/^(yes|yeah|yep|sure|ok|okay|please|send|send it|go ahead|oui|envoyer|d'accord|vas-y)$/i.test(message)) return false;
      return isQuoteIntent(message) || isCartIntent(message) || /\b(all|both|these|those|them|first|second|third|fourth|fifth|last|\d{1,5}\s+of|qty|quantity|sku)\b/i.test(message);
    });

  return candidates.at(-1) || messages.filter((message) => message.role === "user").at(-1)?.content || "";
}

function quoteRelevantSkuText(messages: AssistantMessage[]) {
  return messages
    .filter((message) => {
      if (message.role !== "user") return false;
      const text = message.content.trim();
      if (/^(yes|yeah|yep|sure|ok|okay|please|send|send it|go ahead|oui|envoyer|d'accord|vas-y)$/i.test(text)) return false;
      if (isGenericQuoteOnlyText(text)) return false;
      if (emailPattern.test(text) && text.length < 90 && !extractSkuCandidates(text).length) return false;
      return isQuoteIntent(text) || priorAssistantRequestedQuoteDetails(messages) || extractSkuCandidates(text).length > 0;
    })
    .map((message) => {
      const text = message.content.trim();
      if (!emailPattern.test(text)) return text;

      const parts = text.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean);
      const emailIndex = parts.findIndex((part) => emailPattern.test(part));
      const partsAfterEmail = emailIndex >= 0 ? parts.slice(emailIndex + 1).filter((part) => !emailPattern.test(part)) : [];

      if (parts.length >= 3 && partsAfterEmail.length) return partsAfterEmail.join("\n");
      return parts.filter((part) => !emailPattern.test(part)).join("\n");
    })
    .join("\n");
}

function recentlyOfferedSkus(messages: AssistantMessage[]) {
  const assistantMessage = messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant" && /\bSKU\s*:/i.test(message.content));
  if (!assistantMessage) return [];

  const skus = Array.from(assistantMessage.content.matchAll(/\bSKU\s*:\s*([A-Z0-9+._-]{3,40})\b/gi))
    .map((match) => match[1]?.replace(/[.,;:)\]]+$/, "").toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(skus));
}

export function buildQuoteDraft(
  messages: AssistantMessage[],
  language: AssistantLanguage,
  products: CatalogProduct[]
): { request?: QuoteRequest; missing: string[] } {
  const text = messages.map((message) => message.content).join("\n");
  const userText = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
  const email = text.match(emailPattern)?.[0] || "";
  // Read contact details only from the customer. This keeps a part number in a
  // prior assistant message from becoming a phone number in the email.
  const phone = userText.match(/\b(?:phone|telephone|tel|téléphone)\s*[:#-]?\s*((?:\+?1[-.\s]?)?(?:\(?[2-9]\d{2}\)?[-.\s]?)[2-9]\d{2}[-.\s]?\d{4})\b/i)?.[1];
  const name =
    text.match(/\bName:\s*([^\n]{2,80})/i)?.[1]?.trim() ||
    text.match(/\bNom:\s*([^\n]{2,80})/i)?.[1]?.trim() ||
    text.match(/(?:my name is|name is|je m'appelle|mon nom est)\s+([A-Z][A-Za-z' -]{1,60}?)(?=\s+(?:and\s+)?my\s+email\b|\s+email\b|[,\n]|$)/i)?.[1]?.trim() ||
    text.match(/(?:I am|I'm)\s+([A-Z][A-Za-z' -]{1,60}?)(?=\s+(?:and\s+)?my\s+email\b|\s+email\b|[,\n]|$)/)?.[1]?.trim() ||
    contactNameFromLatestReply(messages) ||
    contactNameFromPriorNamePrompt(messages) ||
    directReplyFor(messages, "name");
  const company =
    userText.match(/(?:company\s*(?:is|:|-)?|organisation\s*(?:is|:|-)?|organization\s*(?:is|:|-)?|business\s*(?:is|:|-)?|compagnie\s*(?:est|:|-)?|entreprise\s*(?:est|:|-)?)\s+([A-Z0-9][A-Za-z0-9&.,' -]{1,80})/i)?.[1]?.trim() ||
    directReplyFor(messages, "company");
  const selectionText = quoteSelectionText(messages);
  // Model names frequently include numbers (for example "LCSU 4" and
  // "300 ml"). Treat a number as a quote quantity only when the customer
  // expresses one, rather than silently turning a model number into quantity.
  const explicitQuantity =
    selectionText.match(/\b(?:qty|quantity)\s*[:=]?\s*(\d{1,5})\b/i)?.[1] ||
    selectionText.match(/\b(\d{1,5})\s*x\b/i)?.[1] ||
    selectionText.match(/\b(?:need|want|require|looking for)\s+(\d{1,5})\s+(?:of\s+)?(?:the\s+)?[a-z]/i)?.[1] ||
    "";
  const fallbackQuantity = Number(explicitQuantity) || 1;
  const genericQuoteOnlySelection = isGenericQuoteOnlyText(selectionText);
  const offeredSkus = recentlyOfferedSkus(messages);
  const productPool =
    offeredSkus.length && /\b(all|both|these|those|them|tous|les deux)\b/i.test(selectionText)
      ? products.filter((product) => offeredSkus.includes(product.sku.toUpperCase()))
      : products;
  // A customer-supplied SKU/part number is authoritative. Never fall back to
  // unrelated search results merely because the catalog did not return an exact
  // row; include the requested SKU for sales to quote instead.
  const requestedSkus = Array.from(new Set(extractSkuCandidates(quoteRelevantSkuText(messages)).map((sku) => sku.toUpperCase())));
  const skuMatchedPool = requestedSkus.length
    ? productPool.filter((product) => requestedSkus.includes(product.sku.toUpperCase()))
    : productPool;
  // search results generated from a later name/email message must never be
  // inserted into a quote if they do not actually match the requested item.
  const productPoolMatchesRequest = requestedSkus.length > 0 || productPool.some((product) => scoreProductForText(selectionText, product) > 0);
  const selectedProducts = !genericQuoteOnlySelection && skuMatchedPool.length && productPoolMatchesRequest
    ? selectProductsForRequest(selectionText, skuMatchedPool).slice(0, 8)
    : [];
  const selectedProductRows = Array.from(new Map(selectedProducts.map((product) => [product.sku.toUpperCase(), {
    name: product.name,
    sku: product.sku,
    quantity: quantityForProductSelection(selectionText, product, products.indexOf(product), fallbackQuantity),
    url: product.url,
  }])).values());
  const selectedSkus = new Set(selectedProductRows.map((product) => product.sku?.toUpperCase()).filter(Boolean));
  const requestedSkuRows = requestedSkus
    .filter((sku) => !selectedSkus.has(sku))
    .map((sku) => ({
      name: `SKU ${sku}`,
      sku,
      quantity: fallbackQuantity,
      description: `SKU ${sku}`,
    }));
  const requestedProducts = selectedProductRows.length || requestedSkuRows.length
    ? [...selectedProductRows, ...requestedSkuRows]
    : [
        {
          name: extractRequestedProductText(messages),
          quantity: fallbackQuantity,
          description: extractRequestedProductText(messages),
        },
      ].filter((product) => product.name.length >= 3);

  const missing = [
    !name ? "name" : "",
    !email ? "email" : "",
    !requestedProducts.length ? "products" : "",
    !requestedProducts.every((product) => product.quantity > 0) ? "quantities" : "",
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
    text.match(/(?:my name is|name is|je m'appelle|mon nom est)\s+([A-Z][A-Za-z' -]{1,60})/i)?.[1]?.trim() ||
    text.match(/(?:I am|I'm)\s+([A-Z][A-Za-z' -]{1,60})/)?.[1]?.trim() ||
    contactNameFromLatestReply(messages) ||
    contactNameFromPriorNamePrompt(messages) ||
    directReplyFor(messages, "name");
  const question =
    messages
      .filter((message) => message.role === "user")
      .map((message) => message.content.trim())
      .find((message) =>
        Boolean(message) &&
        !isSupportYes(message) &&
        !emailPattern.test(message) &&
        !plainNameCandidate(message) &&
        !/^(?:my name is|name is|i am|i'm|je m'appelle|mon nom est)\b/i.test(message)
      ) ||
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
    text.match(/(?:my name is|name is|je m'appelle|mon nom est)\s+([A-Z][A-Za-z' -]{1,60})/i)?.[1]?.trim() ||
    text.match(/(?:I am|I'm)\s+([A-Z][A-Za-z' -]{1,60})/)?.[1]?.trim() ||
    contactNameFromLatestReply(messages) ||
    directReplyFor(messages, "name");
  const explicitOrderNumber =
    text.match(/\b(?:order|commande)\s*(?:number|#|no\.?|num[eé]ro)?\s*[:#-]?\s*((?=[A-Z0-9-]*\d)[A-Z0-9-]{4,30})\b/i)?.[1] ||
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

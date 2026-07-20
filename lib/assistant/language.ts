import type { AssistantLanguage, AssistantMessage } from "./types";

const frenchSignals = [
  "bonjour",
  "salut",
  "devis",
  "soumission",
  "prix",
  "produit",
  "commande",
  "livraison",
  "retour",
  "merci",
  "francais",
  "français",
  "je cherche",
  "j'ai besoin",
  "besoin",
];

const englishSignals = [
  "hello",
  "hi",
  "quote",
  "pricing",
  "price",
  "product",
  "order",
  "shipping",
  "return",
  "thanks",
  "i need",
  "looking for",
];

export function detectCustomerLanguage(messages: AssistantMessage[]): AssistantLanguage {
  const firstUserMessage = messages.find((message) => message.role === "user")?.content || "";
  const normalized = firstUserMessage.toLowerCase();
  const frenchScore = frenchSignals.filter((term) => normalized.includes(term)).length;
  const englishScore = englishSignals.filter((term) => normalized.includes(term)).length;

  if (frenchScore > englishScore) return "fr";
  if (englishScore > frenchScore) return "en";
  if (/[àâçéèêëîïôûùüÿœ]/i.test(firstUserMessage)) return "fr";
  if (normalized.trim()) return "en";
  return "unknown";
}

export function customerText(language: AssistantLanguage, english: string, french: string) {
  return language === "fr" ? french : english;
}

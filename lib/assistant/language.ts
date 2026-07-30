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
  "vendez-vous",
  "vendez vous",
  "particulier",
  "particuliers",
  "achetez",
  "acheter",
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
  const latestUserMessage = messages.filter((message) => message.role === "user").at(-1)?.content || "";
  const normalized = latestUserMessage.toLowerCase();
  const frenchScore = frenchSignals.filter((term) => normalized.includes(term)).length;
  const englishScore = englishSignals.filter((term) => normalized.includes(term)).length;

  if (frenchScore > englishScore) return "fr";
  if (englishScore > frenchScore) return "en";
  if (/[àâçéèêëîïôûùüÿœ]/i.test(latestUserMessage)) return "fr";
  if (normalized.trim()) return "en";
  return "unknown";
}

export function customerText(language: AssistantLanguage, english: string, french: string) {
  return language === "fr" ? french : english;
}

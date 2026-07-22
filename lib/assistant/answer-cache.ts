import type { AssistantLanguage } from "./types";

type CachedAnswer = {
  key: string;
  query: string;
  language: AssistantLanguage;
  answer: string;
  answerPath: string;
  searchQuery?: string;
  productIds: number[];
  productSkus: string[];
  createdAt: number;
  expiresAt: number;
  hits: number;
};

const cache = new Map<string, CachedAnswer>();
const MAX_CACHE_ROWS = 250;
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function ttlMs() {
  const raw = Number(process.env.EMRN_ANSWER_CACHE_TTL_MS || "");
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_TTL_MS;
}

export function answerCacheKey(query: string, language: AssistantLanguage) {
  return `${language}:${normalizeCacheQuery(query)}`;
}

export function getCachedAnswer(query: string, language: AssistantLanguage) {
  const key = answerCacheKey(query, language);
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  entry.hits += 1;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function saveCachedAnswer(input: {
  query: string;
  language: AssistantLanguage;
  answer: string;
  answerPath: string;
  searchQuery?: string;
  productIds?: number[];
  productSkus?: string[];
}) {
  if (!shouldCacheAnswer(input.answerPath, input.answer)) return null;

  const key = answerCacheKey(input.query, input.language);
  const now = Date.now();
  const entry: CachedAnswer = {
    key,
    query: input.query,
    language: input.language,
    answer: input.answer,
    answerPath: input.answerPath,
    searchQuery: input.searchQuery,
    productIds: Array.from(new Set(input.productIds || [])).slice(0, 12),
    productSkus: Array.from(new Set((input.productSkus || []).map((sku) => sku.toUpperCase()))).slice(0, 12),
    createdAt: now,
    expiresAt: now + ttlMs(),
    hits: 0,
  };

  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ROWS) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
  return entry;
}

export function shouldUseAnswerCache(input: { query: string; messageCount: number; hasPageSku?: boolean }) {
  const query = input.query.trim();
  if (!query || input.hasPageSku) return false;
  if (input.messageCount > 3 && !isStandaloneProductQuestion(query)) return false;
  if (/\b(cart|panier|quote|devis|order|commande|invoice|receipt|facture|tracking|support|email|courriel|availability|available|stock|disponible|disponibilit[eé])\b/i.test(query)) return false;
  return isStandaloneProductQuestion(query);
}

function shouldCacheAnswer(answerPath: string, answer: string) {
  if (!answer || answer.length < 40) return false;
  if (![
    "approved_knowledge",
    "emrn_compatibility",
    "catalog_compatibility",
    "catalog_detail",
    "related_parts",
    "external_knowledge_structured",
    "external_knowledge_extracted",
    "external_knowledge",
    "single_product",
    "product_results",
  ].includes(answerPath)) return false;
  if (/\b(can.t confirm|could not confirm|reply yes|send this to support|request a quote|support team|manual search)\b/i.test(answer)) return false;
  return /\b(confirmed compatible|not compatible|sku|view product|products? i found|replacement|compatible|fits?|works?)\b/i.test(answer);
}

function isStandaloneProductQuestion(query: string) {
  if (/^(?:yes|no|ok|okay|thanks|merci|oui|non)$/i.test(query.trim())) return false;
  return /\b(sku|part|model|compatible|compatibility|fit|fits|work|works|replacement|replace|pads?|electrodes?|airways?|lungs?|batter(?:y|ies)|manikins?|mannequins?|aed|defib|zoll|philips|laerdal|little|frx|g3)\b/i.test(query);
}

function normalizeCacheQuery(query: string) {
  return query
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

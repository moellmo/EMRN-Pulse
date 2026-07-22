import type { AssistantLanguage } from "./types";
import {
  readSupabaseAnswerCacheItem,
  readSupabaseAnswerCacheRows,
  saveSupabaseAnswerCacheItem,
  supabaseAdminConfigured,
} from "./supabase-admin";

export type CachedAnswer = {
  key: string;
  query: string;
  language: AssistantLanguage;
  answer: string;
  answerPath: string;
  sourceAnswerPath: string;
  searchQuery?: string;
  productIds: number[];
  productSkus: string[];
  createdAt: number;
  expiresAt: number;
  lastHitAt?: number;
  hits: number;
};

const cache = new Map<string, CachedAnswer>();
const MAX_CACHE_ROWS = 250;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
let lastDurableReadError = "";
let lastDurableWriteError = "";

function ttlMs() {
  const raw = Number(process.env.EMRN_ANSWER_CACHE_TTL_MS || "");
  return Number.isFinite(raw) && raw >= 60_000 ? raw : DEFAULT_TTL_MS;
}

export function answerCacheKey(query: string, language: AssistantLanguage) {
  return `${language}:${normalizeCacheQuery(query)}`;
}

export async function getCachedAnswer(query: string, language: AssistantLanguage) {
  const key = answerCacheKey(query, language);
  const entry = cache.get(key) || await readDurableCacheItem(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  entry.hits += 1;
  entry.lastHitAt = Date.now();
  cache.delete(key);
  cache.set(key, entry);
  void writeDurableCacheItem(entry);
  return entry;
}

export async function saveCachedAnswer(input: {
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
    sourceAnswerPath: input.answerPath,
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
  await writeDurableCacheItem(entry);
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
  if (/\b(can.t confirm|could not confirm|i do not see|i don.t see|do not see an exact|don.t see an exact|reply yes|send this to support|send this to emrn|request a quote|support team|manual search|source\/check|sourcing)\b/i.test(answer)) return false;
  return /\b(confirmed compatible|not compatible|sku|view product|products? i found|replacement|compatible|fits?|works?)\b/i.test(answer);
}

export async function readAnswerCacheSnapshot(limit = 100) {
  const memoryRows = Array.from(cache.values());
  lastDurableReadError = "";
  const durableRows = await readDurableCacheRows(limit);
  const rowsByKey = new Map<string, CachedAnswer>();
  for (const row of [...durableRows, ...memoryRows]) {
    if (row.expiresAt > Date.now()) rowsByKey.set(row.key, row);
  }
  const rows = Array.from(rowsByKey.values())
    .sort((a, b) => (b.lastHitAt || b.createdAt) - (a.lastHitAt || a.createdAt))
    .slice(0, limit);
  return {
    rows,
    metrics: {
      cachedAnswerCount: rows.length,
      cachedAnswerHits: rows.reduce((sum, row) => sum + (row.hits || 0), 0),
      cachedAnswerWithHits: rows.filter((row) => row.hits > 0).length,
      answerCacheMemoryRows: memoryRows.length,
      answerCacheDurableRows: durableRows.length,
      answerCacheSupabaseConfigured: supabaseAdminConfigured(),
      answerCacheDurableReadError: lastDurableReadError,
      answerCacheDurableWriteError: lastDurableWriteError,
    },
  };
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

async function readDurableCacheItem(key: string) {
  try {
    const item = await readSupabaseAnswerCacheItem(key);
    if (item) cache.set(key, item);
    return item;
  } catch (error) {
    lastDurableReadError = error instanceof Error ? error.message : String(error);
    console.warn("[EMRN Pulse] Supabase answer cache read skipped", error);
    return null;
  }
}

async function readDurableCacheRows(limit: number) {
  try {
    return await readSupabaseAnswerCacheRows(limit);
  } catch (error) {
    lastDurableReadError = error instanceof Error ? error.message : String(error);
    console.warn("[EMRN Pulse] Supabase answer cache list skipped", error);
    return [];
  }
}

async function writeDurableCacheItem(item: CachedAnswer) {
  try {
    await saveSupabaseAnswerCacheItem(item);
    lastDurableWriteError = "";
  } catch (error) {
    lastDurableWriteError = error instanceof Error ? error.message : String(error);
    console.warn("[EMRN Pulse] Supabase answer cache write skipped", error);
  }
}

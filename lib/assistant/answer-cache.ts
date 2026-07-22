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

export type CacheSaveResult = {
  cached: boolean;
  key: string;
  durableSaved: boolean;
  skipReason?: string;
  durableError?: string;
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
}): Promise<CacheSaveResult> {
  const key = answerCacheKey(input.query, input.language);
  const skipReason = cacheSkipReason(input.answerPath, input.answer);
  if (skipReason) {
    return { cached: false, key, durableSaved: false, skipReason };
  }

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
  const durable = await writeDurableCacheItem(entry);
  return {
    cached: true,
    key,
    durableSaved: durable.saved,
    durableError: durable.error,
  };
}

export function shouldUseAnswerCache(input: { query: string; messageCount: number; hasPageSku?: boolean }) {
  const query = input.query.trim();
  if (!query || input.hasPageSku) return false;
  if (input.messageCount > 3 && !isStandaloneProductQuestion(query)) return false;
  if (/\b(cart|panier|quote|devis|order|commande|invoice|receipt|facture|tracking|support|email|courriel|availability|available|stock|disponible|disponibilit[eé])\b/i.test(query)) return false;
  return isStandaloneProductQuestion(query);
}

function cacheSkipReason(answerPath: string, answer: string) {
  if (!answer || answer.length < 40) return "answer too short";
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
  ].includes(answerPath)) return `route not cacheable: ${answerPath}`;
  if (/\b(can.t confirm|could not confirm|i do not see|i don.t see|do not see an exact|don.t see an exact|reply yes|send this to support|send this to emrn|request a quote|support team|manual search|source\/check|sourcing)\b/i.test(answer)) return "answer asks for support/source/check or cannot confirm";
  if (!/\b(confirmed compatible|not compatible|sku|view product|products? i found|replacement|compatible|fits?|works?)\b/i.test(answer)) return "answer does not look like a reusable product answer";
  return "";
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

async function writeDurableCacheItem(item: CachedAnswer): Promise<{ saved: boolean; error?: string }> {
  if (!supabaseAdminConfigured()) {
    return { saved: false, error: "Supabase admin cache is not configured" };
  }
  try {
    await saveSupabaseAnswerCacheItem(item);
    lastDurableWriteError = "";
    return { saved: true };
  } catch (error) {
    lastDurableWriteError = error instanceof Error ? error.message : String(error);
    console.warn("[EMRN Pulse] Supabase answer cache write skipped", error);
    return { saved: false, error: lastDurableWriteError };
  }
}

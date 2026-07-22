import type { AssistantAiUsageEvent, AssistantAnalyticsEvent, QuoteRequest, SupportRequest } from "./types";
import type { AssistantRuntimeConfig } from "./admin-config";
import type { KnowledgeMemoryItem } from "./knowledge-memory";
import type { CachedAnswer } from "./answer-cache";

export type SupabaseAdminData = {
  analytics: AssistantAnalyticsEvent[];
  quotes: Array<QuoteRequest & { createdAt: string }>;
  support: Array<SupportRequest & { createdAt: string }>;
  aiUsage: AssistantAiUsageEvent[];
  readError?: string;
};

const configId = "runtime";

function supabaseUrl() {
  return process.env.EMRN_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
}

function supabaseKey() {
  return (
    process.env.EMRN_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.EMRN_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    ""
  );
}

export function supabaseAdminConfigured() {
  return Boolean(supabaseUrl() && supabaseKey());
}

export function supabaseAdminUrlHint() {
  const rawUrl = supabaseUrl();
  if (!rawUrl) return "";
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl.slice(0, 120);
  }
}

async function supabaseRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const baseUrl = supabaseUrl().replace(/\/+$/, "");
  const key = supabaseKey();
  if (!baseUrl || !key) throw new Error("Supabase admin storage is not configured.");

  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`Supabase ${path} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

function insertRow(table: string, row: unknown) {
  return supabaseRequest(`${table}`, {
    method: "POST",
    body: JSON.stringify(row),
  });
}

function payloadFromRows<T>(rows: Array<{ payload?: T }>) {
  return rows.map((row) => row.payload).filter(Boolean) as T[];
}

export async function logSupabaseAnalyticsEvent(event: AssistantAnalyticsEvent) {
  if (!supabaseAdminConfigured()) return;
  await insertRow("assistant_analytics", {
    event_type: event.type,
    session_id: "sessionId" in event ? event.sessionId : null,
    language: "language" in event ? event.language : null,
    query: "query" in event ? event.query || null : null,
    payload: event,
    created_at: event.createdAt,
  });
}

export async function logSupabaseQuoteRequest(row: QuoteRequest & { createdAt: string }) {
  if (!supabaseAdminConfigured()) return;
  await insertRow("assistant_quotes", {
    email: row.email,
    name: row.name,
    language: row.language,
    payload: row,
    created_at: row.createdAt,
  });
}

export async function logSupabaseSupportRequest(row: SupportRequest & { createdAt: string }) {
  if (!supabaseAdminConfigured()) return;
  await insertRow("assistant_support", {
    email: row.email,
    category: row.category || "other",
    language: row.language,
    payload: row,
    created_at: row.createdAt,
  });
}

export async function logSupabaseAiUsage(row: AssistantAiUsageEvent) {
  if (!supabaseAdminConfigured()) return;
  await insertRow("assistant_ai_usage", {
    feature: row.feature,
    model: row.model,
    session_id: row.sessionId || null,
    language: row.language || null,
    query: row.query || null,
    estimated_cost_usd: row.estimatedCostUsd,
    payload: row,
    created_at: row.createdAt,
  });
}

export async function readSupabaseAssistantConfig(): Promise<Partial<AssistantRuntimeConfig> | null> {
  if (!supabaseAdminConfigured()) return null;
  const rows = await supabaseRequest<Array<{ config: Partial<AssistantRuntimeConfig>; updated_at?: string }>>(
    `assistant_config?id=eq.${configId}&select=config,updated_at&limit=1`
  );
  const row = rows[0];
  if (!row?.config) return null;
  return {
    ...row.config,
    updatedAt: row.config.updatedAt || row.updated_at,
  };
}

export async function saveSupabaseAssistantConfig(config: AssistantRuntimeConfig) {
  if (!supabaseAdminConfigured()) return null;
  const rows = await supabaseRequest<Array<{ config: AssistantRuntimeConfig; updated_at?: string }>>("assistant_config?on_conflict=id", {
    method: "POST",
    body: JSON.stringify({
      id: configId,
      config,
      updated_at: config.updatedAt || new Date().toISOString(),
    }),
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
  return rows[0]?.config || config;
}

export async function readSupabaseKnowledgeMemory(): Promise<KnowledgeMemoryItem[] | null> {
  if (!supabaseAdminConfigured()) return null;
  const rows = await supabaseRequest<Array<{ payload: KnowledgeMemoryItem }>>(
    "assistant_knowledge_memory?select=payload&order=updated_at.desc&limit=1000"
  );
  return payloadFromRows(rows);
}

export async function saveSupabaseKnowledgeMemoryItem(item: KnowledgeMemoryItem) {
  if (!supabaseAdminConfigured()) return null;
  const rows = await supabaseRequest<Array<{ payload: KnowledgeMemoryItem }>>("assistant_knowledge_memory?on_conflict=id", {
    method: "POST",
    body: JSON.stringify({
      id: item.id,
      type: item.type,
      query: item.query,
      status: item.status,
      payload: item,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    }),
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
  return rows[0]?.payload || item;
}

export async function deleteSupabaseKnowledgeMemoryItem(id: string) {
  if (!supabaseAdminConfigured()) return false;
  await supabaseRequest(`assistant_knowledge_memory?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
  return true;
}

export async function readSupabaseAnswerCacheItem(key: string): Promise<CachedAnswer | null> {
  if (!supabaseAdminConfigured()) return null;
  const rows = await supabaseRequest<Array<{ payload: CachedAnswer }>>(
    `assistant_answer_cache?key=eq.${encodeURIComponent(key)}&select=payload&limit=1`
  );
  return rows[0]?.payload || null;
}

export async function readSupabaseAnswerCacheRows(limit = 100): Promise<CachedAnswer[]> {
  if (!supabaseAdminConfigured()) return [];
  const safeLimit = Math.max(10, Math.min(250, Math.round(limit)));
  const rows = await supabaseRequest<Array<{ payload: CachedAnswer }>>(
    `assistant_answer_cache?select=payload&order=last_hit_at.desc.nullslast,created_at.desc&limit=${safeLimit}`
  );
  return payloadFromRows(rows);
}

export async function saveSupabaseAnswerCacheItem(item: CachedAnswer) {
  if (!supabaseAdminConfigured()) return null;
  const rows = await supabaseRequest<Array<{ payload: CachedAnswer }>>("assistant_answer_cache?on_conflict=key", {
    method: "POST",
    body: JSON.stringify({
      key: item.key,
      language: item.language,
      query: item.query,
      answer_path: item.answerPath,
      hit_count: item.hits,
      expires_at: new Date(item.expiresAt).toISOString(),
      last_hit_at: item.lastHitAt ? new Date(item.lastHitAt).toISOString() : null,
      payload: item,
      created_at: new Date(item.createdAt).toISOString(),
      updated_at: new Date().toISOString(),
    }),
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
  return rows[0]?.payload || item;
}

export async function readSupabaseAdminData(limit = 200): Promise<SupabaseAdminData | null> {
  if (!supabaseAdminConfigured()) return null;
  const safeLimit = Math.max(25, Math.min(1000, Math.round(limit)));
  try {
    const [analyticsRows, quoteRows, supportRows, aiUsageRows] = await Promise.all([
      supabaseRequest<Array<{ payload: AssistantAnalyticsEvent }>>(`assistant_analytics?select=payload&order=created_at.desc&limit=${safeLimit}`),
      supabaseRequest<Array<{ payload: QuoteRequest & { createdAt: string } }>>(`assistant_quotes?select=payload&order=created_at.desc&limit=${safeLimit}`),
      supabaseRequest<Array<{ payload: SupportRequest & { createdAt: string } }>>(`assistant_support?select=payload&order=created_at.desc&limit=${safeLimit}`),
      supabaseRequest<Array<{ payload: AssistantAiUsageEvent }>>(`assistant_ai_usage?select=payload&order=created_at.desc&limit=${safeLimit}`),
    ]);
    return {
      analytics: payloadFromRows(analyticsRows),
      quotes: payloadFromRows(quoteRows),
      support: payloadFromRows(supportRows),
      aiUsage: payloadFromRows(aiUsageRows),
    };
  } catch (error) {
    return {
      analytics: [],
      quotes: [],
      support: [],
      aiUsage: [],
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

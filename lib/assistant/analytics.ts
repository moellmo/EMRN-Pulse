import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { AssistantAiUsageEvent, AssistantAnalyticsEvent, QuoteRequest, SupportRequest } from "./types";
import {
  logSupabaseAiUsage,
  logSupabaseAnalyticsEvent,
  logSupabaseQuoteRequest,
  logSupabaseSupportRequest,
  readSupabaseAdminData,
  supabaseAdminConfigured,
  supabaseAdminUrlHint,
} from "./supabase-admin";

const dataDir = path.join(process.cwd(), ".data", "assistant");

type SheetLogPayload = {
  kind: "analytics" | "quote" | "support" | "ai_usage";
  row: unknown;
};

type SheetMirrorResult = {
  configured: boolean;
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
};

type SheetsAdminData = {
  analytics: AssistantAnalyticsEvent[];
  quotes: Array<QuoteRequest & { createdAt: string }>;
  support: Array<SupportRequest & { createdAt: string }>;
  aiUsage: AssistantAiUsageEvent[];
  source: "local" | "google_sheets" | "local_and_google_sheets";
  readError?: string;
};

const modelPricesPerMillion: Record<string, { input: number; output: number }> = {
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
};

async function appendJsonl(fileName: string, value: unknown) {
  try {
    await mkdir(dataDir, { recursive: true });
    const filePath = path.join(dataDir, fileName);
    await writeFile(filePath, `${JSON.stringify(value)}\n`, { flag: "a" });
  } catch (error) {
    console.warn("[EMRN Pulse] analytics log skipped", fileName, error);
  }
}

async function readJsonl<T>(fileName: string): Promise<T[]> {
  try {
    const filePath = path.join(dataDir, fileName);
    const raw = await readFile(filePath, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

function googleSheetsWebhookUrl() {
  const rawUrl = cleanWebhookUrl(process.env.EMRN_GOOGLE_SHEETS_WEBHOOK_URL);
  if (!rawUrl) return "";

  const secret = process.env.EMRN_GOOGLE_SHEETS_WEBHOOK_SECRET;
  if (!secret) return rawUrl;

  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.get("secret")) url.searchParams.set("secret", secret);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function googleSheetsWebhookUrlHint() {
  const rawUrl = cleanWebhookUrl(process.env.EMRN_GOOGLE_SHEETS_WEBHOOK_URL);
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return `invalid: ${rawUrl.slice(0, 120)}`;
  }
}

function cleanWebhookUrl(value: string | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const markdownLink = raw.match(/\]\((https?:\/\/[^)\s]+)\)/);
  if (markdownLink?.[1]) return markdownLink[1];

  const directUrl = raw.match(/https?:\/\/\S+/);
  return (directUrl?.[0] || raw).replace(/^["'<]+|[>"']+$/g, "");
}

async function mirrorToGoogleSheets(payload: SheetLogPayload): Promise<SheetMirrorResult> {
  const url = googleSheetsWebhookUrl();
  if (!url) return { configured: false, ok: false };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.EMRN_GOOGLE_SHEETS_WEBHOOK_SECRET
          ? { "X-EMRN-Pulse-Secret": process.env.EMRN_GOOGLE_SHEETS_WEBHOOK_SECRET }
          : {}),
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const body = await response.text().catch(() => "");
    if (!response.ok) {
      console.warn("[EMRN Pulse] Google Sheets log skipped", response.status, payload.kind, body.slice(0, 300));
    }
    return { configured: true, ok: response.ok, status: response.status, body: body.slice(0, 1000) };
  } catch (error) {
    console.warn("[EMRN Pulse] Google Sheets log skipped", payload.kind, error);
    return {
      configured: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readGoogleSheetsAdminRows(limit = 200): Promise<Omit<SheetsAdminData, "source"> | null> {
  const baseUrl = googleSheetsWebhookUrl();
  if (!baseUrl) return null;

  try {
    const url = new URL(baseUrl);
    url.searchParams.set("action", "read");
    url.searchParams.set("limit", String(limit));

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: process.env.EMRN_GOOGLE_SHEETS_WEBHOOK_SECRET
        ? { "X-EMRN-Pulse-Secret": process.env.EMRN_GOOGLE_SHEETS_WEBHOOK_SECRET }
        : undefined,
      cache: "no-store",
    });
    const responseText = await response.text().catch(() => "");
    if (!response.ok) {
      return {
        analytics: [],
        quotes: [],
        support: [],
        aiUsage: [],
        readError: `Google Sheets read failed: ${response.status} ${responseText.slice(0, 300)}`,
      };
    }

    const payload = safeJsonParse(responseText);
    if (!payload) {
      return {
        analytics: [],
        quotes: [],
        support: [],
        aiUsage: [],
        readError: `Google Sheets read returned invalid JSON. Check that doGet is top-level and redeployed. Response: ${responseText.slice(0, 300)}`,
      };
    }
    if (typeof payload === "object" && payload && "ok" in payload && (payload as { ok?: unknown }).ok === false) {
      return {
        analytics: [],
        quotes: [],
        support: [],
        aiUsage: [],
        readError: `Google Sheets read returned error: ${String((payload as { error?: unknown }).error || "unknown")}`,
      };
    }
    return normalizeSheetsAdminPayload(payload);
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

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeSheetsAdminPayload(payload: unknown): Omit<SheetsAdminData, "source"> {
  const analytics: AssistantAnalyticsEvent[] = [];
  const quotes: Array<QuoteRequest & { createdAt: string }> = [];
  const support: Array<SupportRequest & { createdAt: string }> = [];
  const aiUsage: AssistantAiUsageEvent[] = [];

  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const rows =
    asArray(record.rows) ||
    asArray(record.data) ||
    asArray(record.logs) ||
    asArray(record.events) ||
    [];

  for (const row of rows) addSheetRow(row, analytics, quotes, support, aiUsage);
  for (const row of asArray(record.analytics) || []) addTypedSheetRow("analytics", row, analytics, quotes, support, aiUsage);
  for (const row of asArray(record.quotes) || asArray(record.quote) || []) addTypedSheetRow("quote", row, analytics, quotes, support, aiUsage);
  for (const row of asArray(record.support) || []) addTypedSheetRow("support", row, analytics, quotes, support, aiUsage);
  for (const row of asArray(record.aiUsage) || asArray(record.ai_usage) || []) addTypedSheetRow("ai_usage", row, analytics, quotes, support, aiUsage);

  return { analytics, quotes, support, aiUsage };
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : null;
}

function addSheetRow(
  value: unknown,
  analytics: AssistantAnalyticsEvent[],
  quotes: Array<QuoteRequest & { createdAt: string }>,
  support: Array<SupportRequest & { createdAt: string }>,
  aiUsage: AssistantAiUsageEvent[]
) {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const kind = String(row.kind || row.type || row.category || "").toLowerCase();
  const nested = row.row && typeof row.row === "object" ? row.row : row.payload && typeof row.payload === "object" ? row.payload : row;
  if (kind === "quote" || kind === "quotes") return addTypedSheetRow("quote", nested, analytics, quotes, support, aiUsage);
  if (kind === "support") return addTypedSheetRow("support", nested, analytics, quotes, support, aiUsage);
  if (kind === "ai_usage" || kind === "ai usage" || kind === "aiusage") return addTypedSheetRow("ai_usage", nested, analytics, quotes, support, aiUsage);
  return addTypedSheetRow("analytics", nested, analytics, quotes, support, aiUsage);
}

function addTypedSheetRow(
  kind: "analytics" | "quote" | "support" | "ai_usage",
  value: unknown,
  analytics: AssistantAnalyticsEvent[],
  quotes: Array<QuoteRequest & { createdAt: string }>,
  support: Array<SupportRequest & { createdAt: string }>,
  aiUsage: AssistantAiUsageEvent[]
) {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (kind === "quote") quotes.push(row as QuoteRequest & { createdAt: string });
  else if (kind === "support") support.push(row as SupportRequest & { createdAt: string });
  else if (kind === "ai_usage") aiUsage.push(row as AssistantAiUsageEvent);
  else analytics.push(row as AssistantAnalyticsEvent);
}

export async function testGoogleSheetsMirror() {
  return mirrorToGoogleSheets({
    kind: "analytics",
    row: {
      type: "sheets_test",
      sessionId: "admin-test",
      language: "en",
      query: "Google Sheets webhook test",
      createdAt: new Date().toISOString(),
    },
  });
}

export async function logAnalyticsEvent(event: AssistantAnalyticsEvent) {
  await appendJsonl("analytics.jsonl", event);
  void logSupabaseAnalyticsEvent(event).catch((error) => console.warn("[EMRN Pulse] Supabase analytics log skipped", error));
  void mirrorToGoogleSheets({ kind: "analytics", row: event });
}

export async function logQuoteRequest(request: QuoteRequest) {
  const row = {
    ...request,
    createdAt: new Date().toISOString(),
  };
  await appendJsonl("quotes.jsonl", row);
  void logSupabaseQuoteRequest(row).catch((error) => console.warn("[EMRN Pulse] Supabase quote log skipped", error));
  await mirrorToGoogleSheets({ kind: "quote", row });
}

export async function logSupportRequest(request: SupportRequest) {
  const row = {
    ...request,
    createdAt: new Date().toISOString(),
  };
  await appendJsonl("support.jsonl", row);
  void logSupabaseSupportRequest(row).catch((error) => console.warn("[EMRN Pulse] Supabase support log skipped", error));
  await mirrorToGoogleSheets({ kind: "support", row });
}

export function estimateOpenAiCostUsd(model: string, inputTokens = 0, outputTokens = 0) {
  const prices = modelPricesPerMillion[model] || modelPricesPerMillion[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!prices) return 0;
  return roundCurrency((inputTokens / 1_000_000) * prices.input + (outputTokens / 1_000_000) * prices.output);
}

export async function logAiUsage(event: Omit<AssistantAiUsageEvent, "createdAt" | "estimatedCostUsd"> & { estimatedCostUsd?: number }) {
  const row: AssistantAiUsageEvent = {
    ...event,
    createdAt: new Date().toISOString(),
    estimatedCostUsd:
      event.estimatedCostUsd ?? estimateOpenAiCostUsd(event.model, event.inputTokens, event.outputTokens),
  };
  await appendJsonl("ai-usage.jsonl", row);
  void logSupabaseAiUsage(row).catch((error) => console.warn("[EMRN Pulse] Supabase AI usage log skipped", error));
  await mirrorToGoogleSheets({ kind: "ai_usage", row });
}

export async function readAssistantAdminData(options: { limit?: number; full?: boolean } = {}) {
  const rowLimit = options.full ? 1000 : Math.max(25, Math.min(250, options.limit || 100));
  const [localAnalytics, localQuotes, localSupport, localAiUsage, sheets, supabase] = await Promise.all([
    readJsonl<AssistantAnalyticsEvent>("analytics.jsonl"),
    readJsonl<QuoteRequest & { createdAt: string }>("quotes.jsonl"),
    readJsonl<SupportRequest & { createdAt: string }>("support.jsonl"),
    readJsonl<AssistantAiUsageEvent>("ai-usage.jsonl"),
    readGoogleSheetsAdminRows(rowLimit),
    readSupabaseAdminData(rowLimit),
  ]);
  const analytics = dedupeRows([...localAnalytics, ...(sheets?.analytics || []), ...(supabase?.analytics || [])]) as AssistantAnalyticsEvent[];
  const quotes = dedupeRows([...localQuotes, ...(sheets?.quotes || []), ...(supabase?.quotes || [])]) as Array<QuoteRequest & { createdAt: string }>;
  const support = dedupeRows([...localSupport, ...(sheets?.support || []), ...(supabase?.support || [])]) as Array<SupportRequest & { createdAt: string }>;
  const aiUsage = dedupeRows([...localAiUsage, ...(sheets?.aiUsage || []), ...(supabase?.aiUsage || [])]) as AssistantAiUsageEvent[];
  const hasLocal = Boolean(localAnalytics.length || localQuotes.length || localSupport.length || localAiUsage.length);
  const hasSheets = Boolean(sheets && (sheets.analytics.length || sheets.quotes.length || sheets.support.length || sheets.aiUsage.length));
  const hasSupabase = Boolean(supabase && (supabase.analytics.length || supabase.quotes.length || supabase.support.length || supabase.aiUsage.length));
  const source = [hasLocal ? "local" : "", hasSupabase ? "supabase" : "", hasSheets ? "google_sheets" : ""].filter(Boolean).join("_and_") || "local";

  const searches = analytics.filter((event) => event.type === "product_search");
  const failedSearches = analytics.filter((event) => event.type === "no_result_search" || event.type === "search_failure");
  const knowledgeShadow = analytics.filter((event) => event.type === "knowledge_shadow");
  const externalKnowledgeSources = analytics.filter((event) => event.type === "external_knowledge_sources");
  const reviewedPerformanceKeys = new Set(
    analytics
      .filter((event) => event.type === "admin_reviewed_performance")
      .map((event) => "reviewedPerformanceKey" in event ? event.reviewedPerformanceKey || "" : "")
      .filter(Boolean)
  );
  const performanceEvents = analytics
    .filter(isPerformanceEvent)
    .filter((event) => !reviewedPerformanceKeys.has(performanceReviewKey(event)));
  const slowPerformanceEvents = performanceEvents.filter((event) => event.performance?.slow);
  const completedConversations = analytics.filter((event) => event.type === "conversation_completed");
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const aiUsageThisMonth = aiUsage.filter((event) => event.createdAt.startsWith(monthPrefix));
  const webSearchUsageThisMonth = aiUsageThisMonth.filter((event) => event.feature === "trusted_web_search");
  const languages = analytics.reduce<Record<string, number>>((acc, event) => {
    acc[event.language] = (acc[event.language] || 0) + 1;
    return acc;
  }, {});

  return {
    metrics: {
      totalEvents: analytics.length,
      dailyConversationCount: analytics.filter((event) => event.type === "conversation_started").length,
      quoteRequests: quotes.length,
      quoteLookups: analytics.filter((event) => event.type === "quote_lookup").length,
      supportEscalations: support.length,
      supportHandoffs: support.length,
      productSearches: searches.length,
      failedSearches: failedSearches.length,
      noResultSearches: failedSearches.length,
      unansweredQuestions: analytics.filter((event) => event.type === "unanswered_question").length,
      productsRecommended: analytics.filter((event) => event.type === "product_recommended").length,
      knowledgeShadowEvents: knowledgeShadow.length,
      externalKnowledgeSourceEvents: externalKnowledgeSources.length,
      assistantPerformanceEvents: performanceEvents.length,
      slowAssistantResponses: slowPerformanceEvents.length,
      aiCallsThisMonth: aiUsageThisMonth.length,
      webSearchCallsThisMonth: webSearchUsageThisMonth.length,
      aiInputTokensThisMonth: sum(aiUsageThisMonth.map((event) => event.inputTokens)),
      aiOutputTokensThisMonth: sum(aiUsageThisMonth.map((event) => event.outputTokens)),
      aiEstimatedCostThisMonth: roundCurrency(sum(aiUsageThisMonth.map((event) => event.estimatedCostUsd))),
      aiEstimatedCostAllTime: roundCurrency(sum(aiUsage.map((event) => event.estimatedCostUsd))),
      languages,
      mostSearchedProducts: topCounts(searches.map((event) => "query" in event ? event.query || "" : "").filter(Boolean)),
      searchFailures: topCounts(failedSearches.map((event) => "query" in event ? event.query || "" : "").filter(Boolean)),
      supportCategories: topCounts(support.map((event) => event.category || "other")),
      averageConversationLength: average(
        completedConversations.map((event) => ("messageCount" in event ? event.messageCount || 0 : 0))
      ),
      dataSource: source,
      supabaseConfigured: supabaseAdminConfigured(),
      supabaseUrl: supabaseAdminUrlHint(),
      adminHistoryMode: options.full ? "full" : "recent",
      adminRowLimit: rowLimit,
      supabaseRows: (supabase?.analytics.length || 0) + (supabase?.quotes.length || 0) + (supabase?.support.length || 0) + (supabase?.aiUsage.length || 0),
      supabaseReadError: supabase?.readError || "",
      sheetsConfigured: Boolean(sheets),
      sheetsWebhookUrl: googleSheetsWebhookUrlHint(),
      sheetsRows: (sheets?.analytics.length || 0) + (sheets?.quotes.length || 0) + (sheets?.support.length || 0) + (sheets?.aiUsage.length || 0),
      sheetsReadError: sheets?.readError || "",
    },
    failedSearches: failedSearches.slice(-100).reverse(),
    knowledgeShadow: knowledgeShadow.slice(-100).reverse(),
    externalKnowledgeSources: externalKnowledgeSources.slice(-100).reverse(),
    performance: performanceEvents.slice(-100).reverse(),
    slowPerformance: slowPerformanceEvents.slice(-100).reverse(),
    quoteLookups: analytics.filter((event) => event.type === "quote_lookup").slice(-100).reverse(),
    quotes: quotes.slice(-100).reverse(),
    support: support.slice(-100).reverse(),
    aiUsage: aiUsage.slice(-100).reverse(),
  };
}

function dedupeRows<T>(rows: T[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPerformanceEvent(event: AssistantAnalyticsEvent): event is AssistantAnalyticsEvent & {
  performance: NonNullable<Extract<AssistantAnalyticsEvent, { performance?: unknown }>["performance"]>;
} {
  return event.type === "assistant_performance" && "performance" in event;
}

export function performanceReviewKey(event: {
  createdAt?: string;
  sessionId?: string;
  query?: string;
  performance?: { answerPath?: string; searchQuery?: string; totalMs?: number };
}) {
  return [
    event.createdAt || "",
    event.sessionId || "",
    event.query || "",
    event.performance?.answerPath || "",
    event.performance?.searchQuery || "",
    String(event.performance?.totalMs || ""),
  ].join("|");
}

function topCounts(values: string[]) {
  const counts = values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
}

function average(values: number[]) {
  if (!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function roundCurrency(value: number) {
  return Math.round(Number(value || 0) * 100000) / 100000;
}

import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { AssistantAiUsageEvent, AssistantAnalyticsEvent, QuoteRequest, SupportRequest } from "./types";

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
  await mirrorToGoogleSheets({ kind: "analytics", row: event });
}

export async function logQuoteRequest(request: QuoteRequest) {
  const row = {
    ...request,
    createdAt: new Date().toISOString(),
  };
  await appendJsonl("quotes.jsonl", row);
  await mirrorToGoogleSheets({ kind: "quote", row });
}

export async function logSupportRequest(request: SupportRequest) {
  const row = {
    ...request,
    createdAt: new Date().toISOString(),
  };
  await appendJsonl("support.jsonl", row);
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
  await mirrorToGoogleSheets({ kind: "ai_usage", row });
}

export async function readAssistantAdminData() {
  const [analytics, quotes, support, aiUsage] = await Promise.all([
    readJsonl<AssistantAnalyticsEvent>("analytics.jsonl"),
    readJsonl<QuoteRequest & { createdAt: string }>("quotes.jsonl"),
    readJsonl<SupportRequest & { createdAt: string }>("support.jsonl"),
    readJsonl<AssistantAiUsageEvent>("ai-usage.jsonl"),
  ]);

  const searches = analytics.filter((event) => event.type === "product_search");
  const noResults = analytics.filter((event) => event.type === "no_result_search");
  const completedConversations = analytics.filter((event) => event.type === "conversation_completed");
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const aiUsageThisMonth = aiUsage.filter((event) => event.createdAt.startsWith(monthPrefix));
  const languages = analytics.reduce<Record<string, number>>((acc, event) => {
    acc[event.language] = (acc[event.language] || 0) + 1;
    return acc;
  }, {});

  return {
    metrics: {
      totalEvents: analytics.length,
      dailyConversationCount: analytics.filter((event) => event.type === "conversation_started").length,
      quoteRequests: quotes.length,
      supportEscalations: support.length,
      productSearches: searches.length,
      noResultSearches: noResults.length,
      unansweredQuestions: analytics.filter((event) => event.type === "unanswered_question").length,
      productsRecommended: analytics.filter((event) => event.type === "product_recommended").length,
      aiCallsThisMonth: aiUsageThisMonth.length,
      aiInputTokensThisMonth: sum(aiUsageThisMonth.map((event) => event.inputTokens)),
      aiOutputTokensThisMonth: sum(aiUsageThisMonth.map((event) => event.outputTokens)),
      aiEstimatedCostThisMonth: roundCurrency(sum(aiUsageThisMonth.map((event) => event.estimatedCostUsd))),
      aiEstimatedCostAllTime: roundCurrency(sum(aiUsage.map((event) => event.estimatedCostUsd))),
      languages,
      mostSearchedProducts: topCounts(searches.map((event) => "query" in event ? event.query || "" : "").filter(Boolean)),
      searchFailures: topCounts(noResults.map((event) => "query" in event ? event.query || "" : "").filter(Boolean)),
      averageConversationLength: average(
        completedConversations.map((event) => ("messageCount" in event ? event.messageCount || 0 : 0))
      ),
    },
    quotes: quotes.slice(-100).reverse(),
    support: support.slice(-100).reverse(),
    aiUsage: aiUsage.slice(-100).reverse(),
  };
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

import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { AssistantAnalyticsEvent, QuoteRequest, SupportRequest } from "./types";

const dataDir = path.join(process.cwd(), ".data", "assistant");

async function appendJsonl(fileName: string, value: unknown) {
  await mkdir(dataDir, { recursive: true });
  const filePath = path.join(dataDir, fileName);
  await writeFile(filePath, `${JSON.stringify(value)}\n`, { flag: "a" });
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

export async function logAnalyticsEvent(event: AssistantAnalyticsEvent) {
  await appendJsonl("analytics.jsonl", event);
}

export async function logQuoteRequest(request: QuoteRequest) {
  await appendJsonl("quotes.jsonl", {
    ...request,
    createdAt: new Date().toISOString(),
  });
}

export async function logSupportRequest(request: SupportRequest) {
  await appendJsonl("support.jsonl", {
    ...request,
    createdAt: new Date().toISOString(),
  });
}

export async function readAssistantAdminData() {
  const [analytics, quotes, support] = await Promise.all([
    readJsonl<AssistantAnalyticsEvent>("analytics.jsonl"),
    readJsonl<QuoteRequest & { createdAt: string }>("quotes.jsonl"),
    readJsonl<SupportRequest & { createdAt: string }>("support.jsonl"),
  ]);

  const searches = analytics.filter((event) => event.type === "product_search");
  const noResults = analytics.filter((event) => event.type === "no_result_search");
  const completedConversations = analytics.filter((event) => event.type === "conversation_completed");
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
      languages,
      mostSearchedProducts: topCounts(searches.map((event) => "query" in event ? event.query || "" : "").filter(Boolean)),
      searchFailures: topCounts(noResults.map((event) => "query" in event ? event.query || "" : "").filter(Boolean)),
      averageConversationLength: average(
        completedConversations.map((event) => ("messageCount" in event ? event.messageCount || 0 : 0))
      ),
    },
    quotes: quotes.slice(-100).reverse(),
    support: support.slice(-100).reverse(),
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

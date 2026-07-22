import { readAssistantAdminData } from "@/lib/assistant/analytics";
import { readAssistantConfig } from "@/lib/assistant/admin-config";
import { readKnowledgeMemory } from "@/lib/assistant/knowledge-memory";
import { readSkuConfigSync } from "@/lib/assistant/sku-config";
import { AssistantAdminTabs } from "@/components/assistant/AssistantAdminTabs";
import { AssistantConfigAdmin } from "@/components/assistant/AssistantConfigAdmin";
import { KnowledgeReviewAdmin } from "@/components/assistant/KnowledgeReviewAdmin";
import { SkuConfigAdmin } from "@/components/assistant/SkuConfigAdmin";
import type { AssistantAiUsageEvent, QuoteRequest, SupportRequest } from "@/lib/assistant/types";

export const dynamic = "force-dynamic";

type AdminRow =
  | (QuoteRequest & { createdAt: string })
  | (SupportRequest & { createdAt: string })
  | AssistantAiUsageEvent
  | { createdAt: string; type: string; query?: string; language?: string; sessionId?: string; performance?: unknown; externalSources?: Array<{ title?: string; url: string; domain?: string }> };

type PerformanceRow = AdminRow & {
  performance?: {
    totalMs?: number;
    searchMs?: number;
    supabaseMs?: number;
    openAiMs?: number;
    knowledgeMs?: number;
    productCount?: number;
    searchQuery?: string;
    answerPath?: string;
    slow?: boolean;
    openAiUsed?: boolean;
    supabaseUsed?: boolean;
  };
};

type AdminPageProps = {
  searchParams: Promise<{ token?: string | string[] }>;
};

export default async function AssistantAdminPage({ searchParams }: AdminPageProps) {
  const token = process.env.EMRN_ASSISTANT_ADMIN_TOKEN;
  const providedToken = (await searchParams).token;
  const isAuthorized =
    !token ||
    (Array.isArray(providedToken) ? providedToken.includes(token) : providedToken === token);

  if (!isAuthorized) {
    return (
      <main className="min-h-screen bg-slate-50 p-6 text-slate-950">
        <div className="mx-auto max-w-xl rounded-md border border-red-200 bg-white p-5 text-red-700">
          Admin access requires a valid token. Open this page with
          <code className="mx-1 rounded bg-red-50 px-1">?token=YOUR_ADMIN_TOKEN</code>.
        </div>
      </main>
    );
  }

  const data = await readAssistantAdminData().catch((error) => {
    console.error("[EMRN Pulse] admin page data unavailable", error);
    return null;
  });
  const assistantConfig = await readAssistantConfig();
  const knowledgeMemory = await readKnowledgeMemory();
  const skuConfig = readSkuConfigSync();
  const adminToken = Array.isArray(providedToken) ? providedToken[0] || "" : providedToken || "";

  return (
    <main className="min-h-screen bg-slate-50 p-6 text-slate-950">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-bold">EMRN Pulse Admin</h1>
        <p className="mt-2 text-slate-600">Quote requests, support escalations, and assistant metrics.</p>
        {data ? (
          <p className="mt-2 text-sm text-slate-500">
            Data source: <span className="font-semibold">{String(data.metrics.dataSource || "local").replace(/_/g, " ")}</span>
            <span className="ml-2">
              Supabase: {data.metrics.supabaseConfigured ? `configured, ${data.metrics.supabaseRows || 0} rows read` : "not configured"}
            </span>
            {data.metrics.supabaseUrl ? (
              <span className="ml-2">Supabase URL: {data.metrics.supabaseUrl}</span>
            ) : null}
            {data.metrics.supabaseReadError ? (
              <span className="ml-2 text-amber-700">Supabase read: {data.metrics.supabaseReadError}</span>
            ) : null}
            <span className="ml-2">
              Sheets: {data.metrics.sheetsConfigured ? `configured, ${data.metrics.sheetsRows || 0} rows read` : "not configured"}
            </span>
            {data.metrics.sheetsWebhookUrl ? (
              <span className="ml-2">Webhook: {data.metrics.sheetsWebhookUrl}</span>
            ) : null}
            {data.metrics.sheetsReadError ? (
              <span className="ml-2 text-amber-700">Sheets read-back: {data.metrics.sheetsReadError}</span>
            ) : null}
          </p>
        ) : null}

        {!data ? (
          <div className="mt-8 rounded-md border border-red-200 bg-white p-5 text-red-700">
            Admin data is unavailable. Set EMRN_ASSISTANT_ADMIN_TOKEN for production access.
          </div>
        ) : (
          <>
            {data.metrics.totalEvents === 0 ? (
              <div className="mt-8 rounded-md border border-amber-200 bg-white p-5 text-amber-800">
                No local admin logs are available here yet. Vercel does not keep durable local log files, so production
                history should be mirrored through the Google Sheets webhook. Set <code>EMRN_GOOGLE_SHEETS_WEBHOOK_URL</code> and
                <code className="ml-1">EMRN_GOOGLE_SHEETS_WEBHOOK_SECRET</code>, redeploy, then send a few Pulse test messages.
                This page will show local runtime logs when available and Google Sheets production logs when the Apps Script
                supports <code className="mx-1">GET?action=read</code>.
                {data.metrics.sheetsConfigured && !data.metrics.sheetsReadError ? (
                  <span className="mt-2 block">Sheets read-back is configured, but it returned 0 rows. Confirm the Apps Script is deployed and the sheets have rows below the header.</span>
                ) : null}
              </div>
            ) : (
              <AssistantAdminTabs labels={["Overview", "Performance", "Teach", "Settings", "Logs"]}>
                <div>
                  <section className="grid gap-4 md:grid-cols-4">
                    {Object.entries(data.metrics)
                      .filter(([, value]) => typeof value === "number")
                      .map(([key, value]) => (
                        <div key={key} className="rounded-md border border-slate-200 bg-white p-4">
                          <div className="text-sm text-slate-500">{key}</div>
                          <div className="mt-2 text-2xl font-bold">{String(value)}</div>
                        </div>
                      ))}
                  </section>

                  <section className="mt-8 grid gap-6 lg:grid-cols-2">
                    <MetricPanel title="Search Failures" rows={data.metrics.searchFailures || []} />
                    <MetricPanel title="Support Categories" rows={data.metrics.supportCategories || []} />
                    <Panel title="Quote Requests" rows={data.quotes} />
                    <Panel title="Support Handoffs" rows={data.support} />
                  </section>
                </div>

                <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
                  <PerformancePanel title="Slow Questions" rows={data.slowPerformance || []} emptyText="No slow questions yet." />
                  <PerformancePanel title="Recent Timings" rows={data.performance || []} emptyText="No timing records yet." compact />
                  <ExternalSourcesPanel rows={data.externalKnowledgeSources || []} />
                  <AiUsagePanel rows={data.aiUsage} />
                  <KnowledgeShadowPanel rows={data.knowledgeShadow || []} />
                </section>

                <KnowledgeReviewAdmin token={adminToken} items={knowledgeMemory} failedSearches={data.failedSearches || []} />

                <div>
                  <AssistantConfigAdmin token={adminToken} config={assistantConfig} />
                  <SkuConfigAdmin token={adminToken} prefixes={skuConfig.prefixes} suffixes={skuConfig.suffixes} />
                </div>

                <section className="grid gap-6 lg:grid-cols-2">
                  <Panel title="Recent Failed Searches" rows={data.failedSearches || []} />
                  <Panel title="Quote Lookups" rows={data.quoteLookups || []} />
                  <Panel title="Knowledge Shadow" rows={data.knowledgeShadow || []} />
                  <Panel title="AI Usage" rows={data.aiUsage} />
                </section>
              </AssistantAdminTabs>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function MetricPanel({ title, rows }: { title: string; rows: Array<{ value: string; count: number }> }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">{title}</h2>
      <div className="max-h-[520px] overflow-y-auto">
        {rows.length ? (
          rows.map((row) => (
            <div key={row.value} className="flex items-start justify-between gap-4 border-b border-slate-100 p-4">
              <div className="text-sm text-slate-700">{row.value}</div>
              <div className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{row.count}</div>
            </div>
          ))
        ) : (
          <div className="p-4 text-sm text-slate-500">No records yet.</div>
        )}
      </div>
    </div>
  );
}

function Panel({ title, rows }: { title: string; rows: AdminRow[] }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">{title}</h2>
      <div className="max-h-[520px] overflow-y-auto">
        {rows?.length ? (
          rows.map((row, index) => (
            <article key={index} className="border-b border-slate-100 p-4">
              <div className="font-semibold">{rowTitle(row)}</div>
              <div className="text-sm text-slate-500">{row.createdAt}</div>
              {"performance" in row && row.performance && typeof row.performance === "object" ? (
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  {Object.entries(row.performance as Record<string, unknown>)
                    .filter(([key]) => ["totalMs", "searchMs", "supabaseMs", "openAiMs", "knowledgeMs", "productCount", "answerPath"].includes(key))
                    .map(([key, value]) => (
                      <span key={key} className="rounded bg-slate-100 px-2 py-1 font-semibold text-slate-700">
                        {key}: {String(value)}
                      </span>
                    ))}
                </div>
              ) : null}
              <pre className="mt-3 whitespace-pre-wrap text-xs text-slate-700">
                {JSON.stringify(row, null, 2)}
              </pre>
            </article>
          ))
        ) : (
          <div className="p-4 text-sm text-slate-500">No records yet.</div>
        )}
      </div>
    </div>
  );
}

function PerformancePanel({ title, rows, emptyText, compact = false }: { title: string; rows: PerformanceRow[]; emptyText: string; compact?: boolean }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">{title}</h2>
      <div className="max-h-[620px] overflow-y-auto">
        {rows.length ? (
          rows.slice(0, compact ? 12 : 25).map((row, index) => <PerformanceCard key={index} row={row} compact={compact} />)
        ) : (
          <div className="p-4 text-sm text-slate-500">{emptyText}</div>
        )}
      </div>
    </div>
  );
}

function PerformanceCard({ row, compact }: { row: PerformanceRow; compact: boolean }) {
  const perf = row.performance || {};
  const totalMs = Number(perf.totalMs || 0);
  const searchMs = Number(perf.searchMs || 0);
  const openAiMs = Number(perf.openAiMs || 0);
  const supabaseMs = Number(perf.supabaseMs || 0);
  const knowledgeMs = Number(perf.knowledgeMs || 0);
  const route = String(perf.answerPath || "unknown");
  const rating = totalMs >= 5000 ? "Very slow" : totalMs >= 2500 ? "Slow" : totalMs >= 1200 ? "Okay" : "Fast";
  const ratingClass =
    rating === "Very slow"
      ? "bg-red-50 text-red-700"
      : rating === "Slow"
        ? "bg-amber-50 text-amber-700"
        : rating === "Okay"
          ? "bg-blue-50 text-blue-700"
          : "bg-emerald-50 text-emerald-700";
  const bottleneck = biggestBottleneck({ searchMs, openAiMs, supabaseMs, knowledgeMs });

  return (
    <article className="border-b border-slate-100 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-slate-950">{rowQuery(row) || "Unknown question"}</div>
          <div className="mt-1 text-xs text-slate-500">{formatDate(row.createdAt)} · {row.language || "unknown"}</div>
        </div>
        <span className={`rounded px-2 py-1 text-xs font-semibold ${ratingClass}`}>{rating}</span>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <HumanMetric label="Total answer time" value={formatMs(totalMs)} />
        <HumanMetric label="Answer route" value={humanAnswerPath(route)} />
        <HumanMetric label="OpenAI used" value={perf.openAiUsed ? "Yes" : "No"} />
        <HumanMetric label="Products found" value={String(perf.productCount ?? 0)} />
      </div>

      {!compact ? (
        <>
          <div className="mt-4 space-y-2">
            <TimingBar label="Search" value={searchMs} total={Math.max(totalMs, 1)} />
            <TimingBar label="Supabase" value={supabaseMs} total={Math.max(totalMs, 1)} />
            <TimingBar label="OpenAI" value={openAiMs} total={Math.max(totalMs, 1)} />
            <TimingBar label="Knowledge check" value={knowledgeMs} total={Math.max(totalMs, 1)} />
          </div>
          <div className="mt-3 rounded bg-slate-50 p-3 text-sm text-slate-700">
            {bottleneck}
          </div>
        </>
      ) : null}

      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-semibold text-slate-500">Technical details</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-3 text-xs text-slate-100">
          {JSON.stringify(row, null, 2)}
        </pre>
      </details>
    </article>
  );
}

function HumanMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-slate-50 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function TimingBar({ label, value, total }: { label: string; value: number; total: number }) {
  const width = Math.min(100, Math.round((value / total) * 100));
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span>{formatMs(value)}</span>
      </div>
      <div className="h-2 rounded bg-slate-100">
        <div className="h-2 rounded bg-slate-700" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function AiUsagePanel({ rows }: { rows: AssistantAiUsageEvent[] }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">AI Usage</h2>
      <div className="max-h-[520px] overflow-y-auto">
        {rows.length ? rows.slice(0, 20).map((row, index) => (
          <article key={index} className="border-b border-slate-100 p-4">
            <div className="font-semibold text-slate-950">{humanFeature(row.feature)} · {row.model}</div>
            <div className="mt-1 text-xs text-slate-500">{formatDate(row.createdAt)} · {row.status || "called"}</div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <HumanMetric label="Input tokens" value={String(row.inputTokens || 0)} />
              <HumanMetric label="Output tokens" value={String(row.outputTokens || 0)} />
              <HumanMetric label="Est. cost" value={`$${Number(row.estimatedCostUsd || 0).toFixed(5)}`} />
            </div>
            {row.query ? <div className="mt-3 text-sm text-slate-700">Question/search: {row.query}</div> : null}
          </article>
        )) : <div className="p-4 text-sm text-slate-500">No AI usage yet.</div>}
      </div>
    </div>
  );
}

function ExternalSourcesPanel({ rows }: { rows: AdminRow[] }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">External Source Checks</h2>
      <div className="max-h-[520px] overflow-y-auto">
        {rows.length ? rows.slice(0, 20).map((row, index) => (
          <article key={index} className="border-b border-slate-100 p-4">
            <div className="font-semibold text-slate-950">{rowQuery(row) || "External knowledge check"}</div>
            <div className="mt-1 text-xs text-slate-500">{formatDate(row.createdAt)} · customer links hidden</div>
            {"externalSources" in row && row.externalSources?.length ? (
              <div className="mt-3 space-y-2">
                {row.externalSources.map((source, sourceIndex) => (
                  <div key={`${source.url}-${sourceIndex}`} className="rounded bg-slate-50 p-3 text-sm">
                    <div className="font-semibold text-slate-900">{source.title || source.domain || "Source"}</div>
                    <div className="text-xs text-slate-500">{source.domain || "unknown domain"}</div>
                    <div className="mt-1 break-all text-xs text-slate-600">{source.url}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="mt-3 text-sm text-slate-500">No source annotations were returned by OpenAI for this answer.</div>
            )}
          </article>
        )) : <div className="p-4 text-sm text-slate-500">No external source checks yet.</div>}
      </div>
    </div>
  );
}

function KnowledgeShadowPanel({ rows }: { rows: AdminRow[] }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">Knowledge Checks</h2>
      <div className="max-h-[520px] overflow-y-auto">
        {rows.length ? rows.slice(0, 20).map((row, index) => (
          <article key={index} className="border-b border-slate-100 p-4">
            <div className="font-semibold text-slate-950">{rowQuery(row) || "Knowledge check"}</div>
            <div className="mt-1 text-xs text-slate-500">{formatDate(row.createdAt)}</div>
            {"knowledge" in row && row.knowledge && typeof row.knowledge === "object" ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <HumanMetric label="Result" value={String((row.knowledge as { status?: unknown }).status || "unknown")} />
                <HumanMetric label="Confidence" value={String((row.knowledge as { confidence?: unknown }).confidence || "unknown")} />
              </div>
            ) : null}
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-semibold text-slate-500">Technical details</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-950 p-3 text-xs text-slate-100">
                {JSON.stringify(row, null, 2)}
              </pre>
            </details>
          </article>
        )) : <div className="p-4 text-sm text-slate-500">No knowledge checks yet.</div>}
      </div>
    </div>
  );
}

function rowTitle(row: AdminRow) {
  if ("feature" in row) return `${row.feature} - ${row.model}`;
  if ("performance" in row && row.performance && "query" in row && row.query) return row.query;
  if ("name" in row && row.name) return row.name;
  if ("email" in row && row.email) return row.email;
  if ("query" in row && row.query) return row.query;
  if ("type" in row && row.type) return row.type;
  return "Admin row";
}

function rowQuery(row: AdminRow) {
  return "query" in row ? row.query || "" : "";
}

function formatMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} sec`;
  return `${Math.round(value)} ms`;
}

function formatDate(value: string) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-CA", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function humanAnswerPath(value: string) {
  const labels: Record<string, string> = {
    emrn_compatibility: "EMRN taught/catalog answer",
    approved_knowledge: "Approved taught answer",
    openai_detail: "OpenAI verified answer",
    external_knowledge: "External knowledge verified",
    external_knowledge_off: "External knowledge off",
    product_results: "Product search results",
    single_product: "One product found",
    catalog_detail: "EMRN product detail",
    catalog_compatibility: "EMRN compatibility detail",
    related_parts: "Related parts search",
    no_products: "No product found",
    quote_request_sent: "Quote request sent",
    quote_missing_fields: "Quote needs details",
    compare_products: "Product comparison",
    filter_results: "Filtered results",
    account_help: "Account/help answer",
  };
  return labels[value] || value.replace(/_/g, " ");
}

function humanFeature(value: string) {
  const labels: Record<string, string> = {
    search_translator: "Search helper",
    assistant_response: "Assistant answer",
    trusted_web_search: "Trusted web check",
  };
  return labels[value] || value.replace(/_/g, " ");
}

function biggestBottleneck({
  searchMs,
  openAiMs,
  supabaseMs,
  knowledgeMs,
}: {
  searchMs: number;
  openAiMs: number;
  supabaseMs: number;
  knowledgeMs: number;
}) {
  const parts = [
    { label: "search/catalog lookup", value: searchMs },
    { label: "OpenAI verification", value: openAiMs },
    { label: "Supabase memory", value: supabaseMs },
    { label: "knowledge check", value: knowledgeMs },
  ].sort((a, b) => b.value - a.value);
  const top = parts[0];
  if (!top || top.value <= 0) return "No clear bottleneck was recorded.";
  if (top.label === "OpenAI verification") return `Main delay: OpenAI verification took ${formatMs(top.value)}. This is expected when Pulse could not safely answer from an approved EMRN rule.`;
  if (top.label === "Supabase memory") return `Main delay: Supabase memory lookup took ${formatMs(top.value)}. If this repeats, add short caching.`;
  if (top.label === "knowledge check") return `Main delay: the knowledge/evidence check took ${formatMs(top.value)}. This can be optimized after we review repeated slow rows.`;
  return `Main delay: product search took ${formatMs(top.value)}. If this repeats, the query may be too broad or using too many fallback searches.`;
}

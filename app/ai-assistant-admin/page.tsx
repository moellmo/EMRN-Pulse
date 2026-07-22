import { performanceReviewKey, readAssistantAdminData } from "@/lib/assistant/analytics";
import { readAssistantConfig } from "@/lib/assistant/admin-config";
import { readKnowledgeMemory } from "@/lib/assistant/knowledge-memory";
import { readSkuConfigSync } from "@/lib/assistant/sku-config";
import { AssistantAdminTabs } from "@/components/assistant/AssistantAdminTabs";
import { AssistantConfigAdmin } from "@/components/assistant/AssistantConfigAdmin";
import { KnowledgeReviewAdmin } from "@/components/assistant/KnowledgeReviewAdmin";
import { PerformanceReviewedButton } from "@/components/assistant/PerformanceReviewedButton";
import { SkuConfigAdmin } from "@/components/assistant/SkuConfigAdmin";
import type { KnowledgeMemoryType } from "@/lib/assistant/knowledge-memory";
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
    answerPreview?: string;
    proofSourceType?: string;
    proofSourceUrls?: string[];
    proofPartNumbers?: string[];
    proofSearchTerms?: string[];
    emrnMatchCount?: number;
    emrnMatchedSkus?: string[];
    deployVersion?: string;
    slow?: boolean;
    openAiUsed?: boolean;
    supabaseUsed?: boolean;
  };
};

type AdminPageProps = {
  searchParams: Promise<{
    token?: string | string[];
    history?: string | string[];
    teachQuery?: string | string[];
    teachType?: string | string[];
    teachTerms?: string | string[];
    teachNote?: string | string[];
  }>;
};

export default async function AssistantAdminPage({ searchParams }: AdminPageProps) {
  const token = process.env.EMRN_ASSISTANT_ADMIN_TOKEN;
  const params = await searchParams;
  const providedToken = params.token;
  const historyMode = Array.isArray(params.history) ? params.history[0] : params.history;
  const teachQuery = searchParamValue(params.teachQuery);
  const fullHistory = historyMode === "full";
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

  const data = await readAssistantAdminData({ full: fullHistory, limit: 100 }).catch((error) => {
    console.error("[EMRN Pulse] admin page data unavailable", error);
    return null;
  });
  const assistantConfig = await readAssistantConfig();
  const knowledgeMemory = await readKnowledgeMemory();
  const skuConfig = readSkuConfigSync();
  const adminToken = Array.isArray(providedToken) ? providedToken[0] || "" : providedToken || "";
  const teachDraft = teachQuery
    ? {
        type: safeKnowledgeType(searchParamValue(params.teachType)) || "alias",
        query: teachQuery,
        correctSearchTerms: searchParamValue(params.teachTerms),
        note: searchParamValue(params.teachNote),
        status: "approved" as const,
      }
    : undefined;

  return (
    <main className="min-h-screen bg-slate-50 p-6 text-slate-950">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-bold">EMRN Pulse Admin</h1>
        <p className="mt-2 text-slate-600">Quote requests, support escalations, and assistant metrics.</p>
        {data ? (
          <p className="mt-2 text-sm text-slate-500">
            Data source: <span className="font-semibold">{String(data.metrics.dataSource || "local").replace(/_/g, " ")}</span>
            <span className="ml-2">
              Mode: <span className="font-semibold">{fullHistory ? "full history" : "recent only"}</span>
            </span>
            <a
              className="ml-2 font-semibold text-slate-700 underline underline-offset-2"
              href={`/ai-assistant-admin?${new URLSearchParams({
                ...(adminToken ? { token: adminToken } : {}),
                ...(fullHistory ? {} : { history: "full" }),
              }).toString()}`}
            >
              {fullHistory ? "Recent only" : "View more"}
            </a>
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
              <AssistantAdminTabs labels={["Overview", "QA Queue", "Performance", "Teach", "Settings", "Logs"]} initialIndex={teachDraft ? 3 : 0}>
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

                <QaQueuePanel rows={data.performance || []} token={adminToken} fullHistory={fullHistory} />
                <SuggestedLiveTestsPanel token={adminToken} />

                <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
                  <PerformancePanel title="Slow Questions" rows={data.slowPerformance || []} emptyText="No slow questions yet." token={adminToken} fullHistory={fullHistory} />
                  <PerformancePanel title="Recent Timings" rows={data.performance || []} emptyText="No timing records yet." compact token={adminToken} fullHistory={fullHistory} />
                  <ExternalSourcesPanel rows={data.externalKnowledgeSources || []} />
                  <AiUsagePanel rows={data.aiUsage} />
                  <KnowledgeShadowPanel rows={data.knowledgeShadow || []} />
                </section>

                <KnowledgeReviewAdmin token={adminToken} items={knowledgeMemory} failedSearches={data.failedSearches || []} initialDraft={teachDraft} />

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

function PerformancePanel({
  title,
  rows,
  emptyText,
  compact = false,
  token,
  fullHistory,
}: {
  title: string;
  rows: PerformanceRow[];
  emptyText: string;
  compact?: boolean;
  token: string;
  fullHistory: boolean;
}) {
  const sortedRows = sortRowsByTime(rows);
  const visibleCount = compact ? 12 : 25;
  const toggleHref = `/ai-assistant-admin?${new URLSearchParams({
    ...(token ? { token } : {}),
    ...(fullHistory ? {} : { history: "full" }),
  }).toString()}#performance`;
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <div className="mt-1 text-xs text-slate-500">
            Newest first · Eastern time · showing {Math.min(sortedRows.length, visibleCount)} of {sortedRows.length}
          </div>
        </div>
        <a className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50" href={toggleHref}>
          {fullHistory ? "Recent only" : "View more"}
        </a>
      </div>
      <div className="max-h-[620px] overflow-y-auto">
        {sortedRows.length ? (
          sortedRows.slice(0, visibleCount).map((row, index) => <PerformanceCard key={`${row.createdAt}-${index}`} row={row} compact={compact} token={token} fullHistory={fullHistory} />)
        ) : (
          <div className="p-4 text-sm text-slate-500">{emptyText}</div>
        )}
      </div>
    </div>
  );
}

function QaQueuePanel({ rows, token, fullHistory }: { rows: PerformanceRow[]; token: string; fullHistory: boolean }) {
  const sortedRows = sortRowsByTime(rows);
  const groups = [
    {
      title: "Needs Teaching",
      help: "Real product questions that look wrong, unsure, missing, or worth training.",
      rows: sortedRows.filter((row) => {
        const question = rowQuery(row);
        if (!isRealProductQaQuestion(question)) return false;
        return performanceReviewHint(row, cleanAdminAnswerPreview(String(row.performance?.answerPreview || ""))).needsTeaching;
      }).slice(0, 20),
    },
    {
      title: "Can’t Confirm",
      help: "Meri could not prove the answer. Teach if EMRN has the fact, SKU, or compatible product.",
      rows: sortedRows.filter((row) => /can.t confirm|could not confirm|i do not see|item-sourcing/i.test(String(row.performance?.answerPreview || ""))).slice(0, 20),
    },
    {
      title: "Slow But Answered",
      help: "The answer may be fine, but repeated slow questions should be taught or optimized.",
      rows: sortedRows.filter((row) => {
        const answer = cleanAdminAnswerPreview(String(row.performance?.answerPreview || ""));
        const hint = performanceReviewHint(row, answer);
        return Number(row.performance?.totalMs || 0) >= 2500 && answer && !hint.needsTeaching;
      }).slice(0, 20),
    },
    {
      title: "OpenAI Used",
      help: "These cost money and may be slower. Teach recurring good answers so Meri can answer from EMRN first.",
      rows: sortedRows.filter((row) => row.performance?.openAiUsed).slice(0, 20),
    },
  ];

  return (
    <section className="grid gap-6 xl:grid-cols-2">
      {groups.map((group) => (
        <div key={group.title} className="rounded-md border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-lg font-semibold">{group.title}</h2>
            <p className="mt-1 text-xs text-slate-500">{group.help}</p>
          </div>
          <div className="max-h-[680px] overflow-y-auto">
            {group.rows.length ? (
              group.rows.map((row, index) => (
                <PerformanceCard key={`${group.title}-${row.createdAt}-${index}`} row={row} compact token={token} fullHistory={fullHistory} />
              ))
            ) : (
              <div className="p-4 text-sm text-slate-500">No rows in this bucket right now.</div>
            )}
          </div>
        </div>
      ))}
      <div className="rounded-md border border-slate-200 bg-white p-4 xl:col-span-2">
        <h2 className="text-lg font-semibold">Reviewed Hidden</h2>
        <p className="mt-1 text-sm text-slate-600">
          Rows you mark Reviewed are hidden from QA Queue, Slow Questions, and Recent Timings. They stay in the raw logs for history.
        </p>
      </div>
    </section>
  );
}

function SuggestedLiveTestsPanel({ token }: { token: string }) {
  const tests = [
    { group: "AED pads", query: "What AED pads work with Philips FRx?" },
    { group: "AED pads", query: "What pediatric pads work with ZOLL AED Plus?" },
    { group: "Batteries", query: "What battery works with Philips HeartStart FRx AED?" },
    { group: "Batteries", query: "What replacement battery fits ZOLL AED Plus?" },
    { group: "Lungs / airways", query: "Do Laerdal Little Junior QCPR replacement airways work with Little Junior QCPR?" },
    { group: "Lungs / airways", query: "What replacement lungs fit Laerdal Little Anne QCPR?" },
    { group: "SKU searches", query: "G35004BU+" },
    { group: "SKU searches", query: "989803139261" },
    { group: "French terms", query: "électrodes pour Philips FRx" },
    { group: "French terms", query: "batterie pour défibrillateur Philips FRx" },
    { group: "Typo searches", query: "hat AED pads work with Philips FRx?" },
    { group: "Typo searches", query: "maniknns qcpr" },
    { group: "No-match quote/source", query: "G35004OR" },
    { group: "No-match quote/source", query: "does the orange G3 oxygen battery cartridge fit Philips FRx?" },
  ];

  return (
    <section className="mt-6 rounded-md border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-lg font-semibold">Suggested Live Tests</h2>
        <p className="mt-1 text-xs text-slate-500">Use these after deploy to check pads, batteries, replacement parts, SKUs, French, typos, and no-match/source cases.</p>
      </div>
      <div className="grid gap-px bg-slate-100 md:grid-cols-2">
        {tests.map((test) => (
          <div key={`${test.group}-${test.query}`} className="flex items-start justify-between gap-3 bg-white p-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{test.group}</div>
              <div className="mt-1 text-sm font-semibold text-slate-900">{test.query}</div>
            </div>
            <a
              href={`/ai-assistant-test?${new URLSearchParams({ ...(token ? { token } : {}), q: test.query }).toString()}`}
              className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Retest
            </a>
          </div>
        ))}
      </div>
    </section>
  );
}

function PerformanceCard({ row, compact, token, fullHistory }: { row: PerformanceRow; compact: boolean; token: string; fullHistory: boolean }) {
  const perf = row.performance || {};
  const totalMs = Number(perf.totalMs || 0);
  const searchMs = Number(perf.searchMs || 0);
  const openAiMs = Number(perf.openAiMs || 0);
  const supabaseMs = Number(perf.supabaseMs || 0);
  const knowledgeMs = Number(perf.knowledgeMs || 0);
  const route = String(perf.answerPath || "unknown");
  const question = rowQuery(row) || "Unknown question";
  const questionLabel = quickActionQuestionLabel(question);
  const answerPreview = cleanAdminAnswerPreview(String(perf.answerPreview || ""));
  const review = performanceReviewHint(row, answerPreview);
  const reasons = qaReasonsForRow(row, answerPreview);
  const teaching = teachingSuggestionForRow(row, answerPreview);
  const deployVersion = String(perf.deployVersion || "");
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
  const teachHref = teachLinkForRow(row, token, fullHistory);
  const retestHref = retestLinkForRow(row, token);

  return (
    <article className="border-b border-slate-100 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-slate-950">{question}</div>
          <div className="mt-1 text-xs text-slate-500">{formatDate(row.createdAt)} · {row.language || "unknown"} · session {shortId("sessionId" in row ? row.sessionId : undefined)}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a href={teachHref} className="rounded bg-slate-950 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-800">
            Teach this
          </a>
          <a href={retestHref} className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            Retest
          </a>
          <PerformanceReviewedButton token={token} reviewedPerformanceKey={performanceReviewKey(row)} query={question} />
          <span className={`rounded px-2 py-1 text-xs font-semibold ${ratingClass}`}>{rating}</span>
        </div>
      </div>

      <div className="mt-3 rounded-md border border-slate-200 bg-white">
        <div className="grid gap-px bg-slate-200 sm:grid-cols-2">
          <div className="bg-slate-50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{questionLabel}</div>
            <div className="mt-1 text-sm font-semibold text-slate-950">{question}</div>
          </div>
          <div className="bg-slate-50 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Meri answered</div>
            <div className={`${compact ? "line-clamp-3" : ""} mt-1 text-sm text-slate-800`}>
              {answerPreview || "Answer was not logged yet for this older row. New rows will show Meri's reply here."}
            </div>
          </div>
        </div>
        <div className={`border-t border-slate-200 p-3 text-sm ${review.needsTeaching ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-900"}`}>
          <span className="font-semibold">{review.label}:</span> {review.reason}
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded bg-slate-50 p-3 text-sm text-slate-700">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Why this is here</div>
          <ul className="mt-2 space-y-1">
            {reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
        <div className="rounded bg-slate-50 p-3 text-sm text-slate-700">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Suggested teaching</div>
          <div className="mt-2 font-semibold text-slate-900">{teaching.typeLabel}</div>
          <div className="mt-1">{teaching.reason}</div>
          {teaching.fields.length ? (
            <div className="mt-2 text-xs text-slate-600">{teaching.fields.join(" · ")}</div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <HumanMetric label="Total answer time" value={formatMs(totalMs)} />
        <HumanMetric label="Answer route" value={humanAnswerPath(route)} />
        <HumanMetric label="OpenAI used" value={perf.openAiUsed ? "Yes" : "No"} />
        <HumanMetric label="Products found" value={String(perf.productCount ?? 0)} />
        <HumanMetric label="Search used" value={String(perf.searchQuery || rowQuery(row) || "none").slice(0, 80)} />
        <HumanMetric label="Deploy" value={deployVersion ? shortId(deployVersion) : "not logged"} />
        {perf.proofSourceType ? <HumanMetric label="Proof source" value={humanProofSource(String(perf.proofSourceType))} /> : null}
        {typeof perf.emrnMatchCount === "number" ? <HumanMetric label="EMRN match" value={`${perf.emrnMatchCount} found${perf.emrnMatchedSkus?.length ? `: ${perf.emrnMatchedSkus.join(", ")}` : ""}`} /> : null}
      </div>

      {perf.proofSourceUrls?.length || perf.proofPartNumbers?.length || perf.proofSearchTerms?.length ? (
        <details className="mt-3 rounded bg-slate-50 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-600">Proof and recovery details</summary>
          <div className="mt-2 grid gap-3 text-sm text-slate-700 md:grid-cols-3">
            <ProofList title="Where Meri checked" items={perf.proofSourceUrls || []} />
            <ProofList title="Part numbers found" items={perf.proofPartNumbers || []} />
            <ProofList title="EMRN searches tried" items={perf.proofSearchTerms || []} />
          </div>
        </details>
      ) : null}

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

function ProofList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      {items.length ? (
        <ul className="mt-1 space-y-1">
          {items.slice(0, 8).map((item) => (
            <li key={item} className="break-words text-xs">{item}</li>
          ))}
        </ul>
      ) : (
        <div className="mt-1 text-xs text-slate-500">None logged.</div>
      )}
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
  const sortedRows = sortRowsByTime(rows);
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">AI Usage</h2>
      <div className="max-h-[520px] overflow-y-auto">
        {sortedRows.length ? sortedRows.slice(0, 20).map((row, index) => (
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
  const sortedRows = sortRowsByTime(rows);
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">External Source Checks</h2>
      <div className="max-h-[520px] overflow-y-auto">
        {sortedRows.length ? sortedRows.slice(0, 20).map((row, index) => (
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
  const sortedRows = sortRowsByTime(rows);
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <h2 className="border-b border-slate-200 px-4 py-3 text-lg font-semibold">Knowledge Checks</h2>
      <div className="max-h-[520px] overflow-y-auto">
        {sortedRows.length ? sortedRows.slice(0, 20).map((row, index) => (
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

function cleanAdminAnswerPreview(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function quickActionQuestionLabel(question: string) {
  if (isShortFollowUp(question)) return "Customer follow-up";
  if (/^I have a product question about compatibility, parts, or which item fits$/i.test(question)) return "Customer clicked quick button";
  if (/^Find a product$/i.test(question)) return "Customer clicked quick button";
  if (/^I need a quote$/i.test(question)) return "Customer clicked quick button";
  if (/^Look up a quote$/i.test(question)) return "Customer clicked quick button";
  if (/^Reorder my last order$/i.test(question)) return "Customer clicked quick button";
  if (/^Find my invoice or receipt$/i.test(question)) return "Customer clicked quick button";
  if (/^Can you check availability\?$/i.test(question)) return "Customer clicked quick button";
  if (/^Check order status$/i.test(question)) return "Customer clicked quick button";
  if (/^Contact support$/i.test(question)) return "Customer clicked quick button";
  return "Customer asked";
}

function isShortFollowUp(question: string) {
  return /^(?:no|nope|nah|yes|yeah|yep|ok|okay|k|thanks|thank you|thx|merci|non|oui|d'accord|daccord|sure)$/i.test(question.trim());
}

function isRealProductQaQuestion(question: string) {
  const clean = question.trim();
  if (!clean || isShortFollowUp(clean)) return false;
  if (quickActionQuestionLabel(clean) === "Customer clicked quick button") return false;
  if (clean.split(/\s+/).length <= 2 && !extractLooksLikeSku(clean)) return false;
  return /\b(sku|part|model|compatible|compatibility|fit|fits|work|works|replacement|replace|pads?|padz|electrodes?|airways?|lungs?|batter(?:y|ies)|manikins?|mannequins?|aed|defib|zoll|philips|laerdal|little|frx|g3|price|cheap|cost|stock|available|availability|couleur|color|devis|quote)\b/i.test(clean);
}

function extractLooksLikeSku(value: string) {
  return /\b(?=[A-Z0-9+.-]*\d)[A-Z0-9]{2,}(?:[-+.][A-Z0-9]{1,})*\b/i.test(value.trim());
}

function humanProofSource(value: string) {
  const labels: Record<string, string> = {
    manufacturer: "Manufacturer",
    supplier_catalog: "Supplier/catalog",
    emrn: "EMRN",
    mixed: "Mixed sources",
    unknown: "Unknown",
  };
  return labels[value] || value.replace(/_/g, " ");
}

function qaReasonsForRow(row: PerformanceRow, answerPreview: string) {
  const perf = row.performance || {};
  const reasons: string[] = [];
  const query = rowQuery(row);
  const route = String(perf.answerPath || "");

  if (!answerPreview) reasons.push("Older row: Meri's answer was not logged yet.");
  if (/can.t confirm|could not confirm|i do not see|item-sourcing|send this to support/i.test(answerPreview)) reasons.push("Meri was unsure or moved toward support/sourcing.");
  if (perf.openAiUsed) reasons.push("OpenAI was used, so this may be slower or worth teaching if it repeats.");
  if (Number(perf.totalMs || 0) >= 2500) reasons.push(`Slow answer: ${formatMs(Number(perf.totalMs || 0))}.`);
  if (route.includes("no_products") || Number(perf.productCount || 0) === 0) reasons.push("No exact EMRN product was found in the logged result.");
  if (/\b(compatible|compatibility|fit|fits|work with|works with|replacement|pads?|airways?|lungs?|batter)/i.test(query)) reasons.push("Question looked like product compatibility or replacement-part help.");
  if (typeof perf.emrnMatchCount === "number") reasons.push(`External recovery found ${perf.emrnMatchCount} EMRN match${perf.emrnMatchCount === 1 ? "" : "es"}.`);
  if (isShortFollowUp(query)) reasons.push("This looks like a customer follow-up, not a standalone product question.");
  if (quickActionQuestionLabel(query) === "Customer clicked quick button") reasons.push("This came from a starter button click.");
  if (!reasons.length) reasons.push("No obvious issue detected; review only if the answer is wrong or incomplete.");
  return reasons.slice(0, 5);
}

function teachingSuggestionForRow(row: PerformanceRow, answerPreview: string) {
  const perf = row.performance || {};
  const query = rowQuery(row);
  const answerPath = String(perf.answerPath || "");
  const type = knowledgeTypeForPerformanceRow(query, answerPath);
  const sourceSku = firstUsefulSku([
    ...(perf.emrnMatchedSkus || []),
    ...(answerPreview.match(/\bSKU\s+\*\*?([A-Z0-9+.-]{2,})/gi) || []).map((value) => value.replace(/^SKU\s+\**/i, "")),
    ...(perf.proofPartNumbers || []),
  ]);
  const searchTerms = String(perf.searchQuery || query || "").slice(0, 120);

  if (isShortFollowUp(query)) {
    return {
      typeLabel: "No teaching needed",
      reason: "Mark Reviewed unless this follow-up exposed a real bad answer in the full conversation.",
      fields: ["Use Retest only with the full question."],
    };
  }
  if (quickActionQuestionLabel(query) === "Customer clicked quick button") {
    return {
      typeLabel: "No teaching needed",
      reason: "This is just the customer pressing a starter button.",
      fields: ["Mark Reviewed after checking the follow-up question."],
    };
  }
  if (/can.t confirm|could not confirm|i do not see|item-sourcing/i.test(answerPreview)) {
    return {
      typeLabel: knowledgeTypeLabel(type),
      reason: "Teach this if EMRN has a known correct product, SKU, compatibility fact, or replacement part.",
      fields: [`Query: ${query}`, sourceSku ? `SKU/part: ${sourceSku}` : "Add correct SKU if known", searchTerms ? `Search terms: ${searchTerms}` : ""].filter(Boolean),
    };
  }
  if (perf.openAiUsed && sourceSku) {
    return {
      typeLabel: knowledgeTypeLabel(type === "alias" ? "preferred_product" : type),
      reason: "A proven answer used OpenAI. Teaching it can make repeat questions faster and more consistent.",
      fields: [`Query: ${query}`, `SKU/part: ${sourceSku}`, searchTerms ? `Search terms: ${searchTerms}` : ""].filter(Boolean),
    };
  }
  if (Number(perf.totalMs || 0) >= 2500) {
    return {
      typeLabel: "Alias or preferred product",
      reason: "The answer looks usable but slow. Teach better search terms or a preferred SKU if this query repeats.",
      fields: [`Query: ${query}`, searchTerms ? `Search terms: ${searchTerms}` : ""].filter(Boolean),
    };
  }
  return {
    typeLabel: knowledgeTypeLabel(type),
    reason: "Teach only if you know the answer is wrong, missing a better EMRN product, or needs cleaner wording.",
    fields: [`Query: ${query}`, searchTerms ? `Search terms: ${searchTerms}` : ""].filter(Boolean),
  };
}

function firstUsefulSku(values: string[]) {
  return values
    .map((value) => String(value || "").replace(/[^A-Z0-9+.-]/gi, "").toUpperCase())
    .find((value) => /[A-Z0-9]/.test(value) && value.length >= 3) || "";
}

function knowledgeTypeLabel(type: KnowledgeMemoryType) {
  return type.replace(/_/g, " ");
}

function performanceReviewHint(row: PerformanceRow, answerPreview: string) {
  const perf = row.performance || {};
  const route = String(perf.answerPath || "");
  const totalMs = Number(perf.totalMs || 0);
  const openAiUsed = Boolean(perf.openAiUsed);
  const productCount = Number(perf.productCount || 0);
  const answer = answerPreview.toLowerCase();
  const question = rowQuery(row).toLowerCase();

  if (!answerPreview) {
    return {
      needsTeaching: true,
      label: "Review needed",
      reason: "This is an older row without the answer text. Retest the same question, then teach it if Meri is wrong or unsure.",
    };
  }
  if (/\b(can.t confirm|could not confirm|i do not see|not logged|send this to support|source request|item-sourcing)\b/i.test(answerPreview)) {
    return {
      needsTeaching: true,
      label: "Likely teach",
      reason: "Meri sounded unsure or offered support. Teach this if EMRN has the item, SKU, compatibility, replacement part, or preferred answer.",
    };
  }
  if (/\b(not compatible|does not fit|should not be treated as compatible)\b/i.test(answerPreview)) {
    return {
      needsTeaching: false,
      label: "Check if correct",
      reason: "This is a compatibility rejection. Teach only if that rejection is wrong or needs the correct replacement SKU.",
    };
  }
  if (route.includes("no_products") || productCount === 0) {
    return {
      needsTeaching: true,
      label: "Likely teach",
      reason: "No EMRN products were found. Add aliases/search terms if EMRN carries this product.",
    };
  }
  if (openAiUsed && totalMs >= 2500) {
    return {
      needsTeaching: true,
      label: "Teach to speed up",
      reason: "OpenAI was used and the answer was slow. If this question repeats, teach the answer so Meri can reply faster from EMRN knowledge.",
    };
  }
  if (/\b(compatible|fit|fits|work with|works with|replacement|pads?|airways?|lungs?|batter)/i.test(question) && !/\b(sku|confirmed|compatible|not compatible|replacement|view product)\b/i.test(answer)) {
    return {
      needsTeaching: true,
      label: "Check answer",
      reason: "The question asked for a specific product or compatibility answer, but the reply may not include a clear SKU/result.",
    };
  }
  if (totalMs >= 2500) {
    return {
      needsTeaching: false,
      label: "Slow but answered",
      reason: "The answer looks usable, but repeated slow questions may be worth teaching or adding better search terms.",
    };
  }
  return {
    needsTeaching: false,
    label: "Looks okay",
    reason: "No obvious issue detected. Teach only if you know the answer is wrong, missing a better EMRN item, or needs cleaner wording.",
  };
}

function searchParamValue(value?: string | string[]) {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

function safeKnowledgeType(value: string): KnowledgeMemoryType | "" {
  return ["alias", "preferred_product", "compatibility", "replacement_part", "color_option", "note"].includes(value)
    ? value as KnowledgeMemoryType
    : "";
}

function teachLinkForRow(row: PerformanceRow, token: string, fullHistory: boolean) {
  const perf = row.performance || {};
  const query = rowQuery(row);
  const answerPath = String(perf.answerPath || "unknown");
  const searchUsed = String(perf.searchQuery || "");
  const answerPreview = cleanAdminAnswerPreview(String(perf.answerPreview || ""));
  const type = knowledgeTypeForPerformanceRow(query, answerPath);
  const proof = [
    perf.proofSourceType ? `Proof source: ${humanProofSource(String(perf.proofSourceType))}.` : "",
    perf.proofPartNumbers?.length ? `Proof parts: ${perf.proofPartNumbers.join(", ")}.` : "",
    perf.proofSearchTerms?.length ? `Recovery searches: ${perf.proofSearchTerms.slice(0, 5).join(", ")}.` : "",
    typeof perf.emrnMatchCount === "number" ? `EMRN matches: ${perf.emrnMatchCount}${perf.emrnMatchedSkus?.length ? ` (${perf.emrnMatchedSkus.join(", ")})` : ""}.` : "",
  ].filter(Boolean).join(" ");
  const note = [
    `From Performance row: ${humanAnswerPath(answerPath)}.`,
    `Server time: ${formatMs(Number(perf.totalMs || 0))}.`,
    perf.openAiUsed ? "OpenAI was used." : "OpenAI was not used.",
    `Products found: ${String(perf.productCount ?? 0)}.`,
    answerPreview ? `Meri answered: ${answerPreview.slice(0, 400)}.` : "Meri answer was not logged.",
    proof,
  ].join(" ");
  const params = new URLSearchParams({
    ...(token ? { token } : {}),
    ...(fullHistory ? { history: "full" } : {}),
    teachQuery: query,
    teachType: type,
    teachTerms: searchUsed,
    teachNote: note,
  });
  return `/ai-assistant-admin?${params.toString()}#teach`;
}

function retestLinkForRow(row: PerformanceRow, token: string) {
  const params = new URLSearchParams({
    ...(token ? { token } : {}),
    q: rowQuery(row),
  });
  return `/ai-assistant-test?${params.toString()}`;
}

function knowledgeTypeForPerformanceRow(query: string, answerPath: string): KnowledgeMemoryType {
  if (/\b(compatible|compatibility|fit|fits|work with|works with|go with|goes with|for this|for that)\b/i.test(query)) return "compatibility";
  if (/\b(replacement|parts?|pads?|padz|electrodes?|airways?|lungs?|batter(?:y|ies)|cables?)\b/i.test(query)) return "replacement_part";
  if (/\b(color|colour|orange|red|blue|black|white|green|yellow|pink|purple)\b/i.test(query)) return "color_option";
  if (/\bapproved_knowledge|emrn_compatibility|catalog_compatibility\b/i.test(answerPath)) return "preferred_product";
  return "alias";
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
    timeZone: "America/Toronto",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function sortRowsByTime<T extends { createdAt?: string }>(rows: T[]) {
  return [...rows].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

function shortId(value?: string) {
  if (!value) return "unknown";
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function humanAnswerPath(value: string) {
  const labels: Record<string, string> = {
    emrn_compatibility: "EMRN taught/catalog answer",
    approved_knowledge: "Approved taught answer",
    openai_detail: "OpenAI verified answer",
    external_knowledge: "External knowledge verified",
    external_knowledge_structured: "External structured + EMRN search",
    external_knowledge_extracted: "External answer extracted + EMRN search",
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

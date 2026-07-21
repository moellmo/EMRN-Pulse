import { readAssistantAdminData } from "@/lib/assistant/analytics";
import type { AssistantAiUsageEvent, QuoteRequest, SupportRequest } from "@/lib/assistant/types";

export const dynamic = "force-dynamic";

type AdminRow =
  | (QuoteRequest & { createdAt: string })
  | (SupportRequest & { createdAt: string })
  | AssistantAiUsageEvent
  | { createdAt: string; type: string; query?: string; language?: string; sessionId?: string };

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

  return (
    <main className="min-h-screen bg-slate-50 p-6 text-slate-950">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-bold">EMRN Pulse Admin</h1>
        <p className="mt-2 text-slate-600">Quote requests, support escalations, and assistant metrics.</p>
        {data ? (
          <p className="mt-2 text-sm text-slate-500">
            Data source: <span className="font-semibold">{String(data.metrics.dataSource || "local").replace(/_/g, " ")}</span>
            {data.metrics.sheetsReadError ? (
              <span className="ml-2 text-amber-700">Sheets read-back: {data.metrics.sheetsReadError}</span>
            ) : null}
          </p>
        ) : null}

        {!data ? (
          <div className="mt-8 rounded-md border border-red-200 bg-white p-5 text-red-700">
            Admin data is unavailable. Set EMRN_ASSISTANT_ADMIN_TOKEN for production access.
          </div>
        ) : data.metrics.totalEvents === 0 ? (
          <div className="mt-8 rounded-md border border-amber-200 bg-white p-5 text-amber-800">
            No local admin logs are available here yet. Vercel does not keep durable local log files, so production
            history should be mirrored through the Google Sheets webhook. Set <code>EMRN_GOOGLE_SHEETS_WEBHOOK_URL</code> and
            <code className="ml-1">EMRN_GOOGLE_SHEETS_WEBHOOK_SECRET</code>, redeploy, then send a few Pulse test messages.
            This page will show local runtime logs when available and Google Sheets production logs when the Apps Script
            supports <code className="mx-1">GET?action=read</code>.
          </div>
        ) : (
          <>
            <section className="mt-8 grid gap-4 md:grid-cols-4">
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
              <MetricPanel
                title="Search Failures"
                rows={data.metrics.searchFailures || []}
              />
              <Panel title="Recent Failed Searches" rows={data.failedSearches || []} />
              <Panel title="Quote Lookups" rows={data.quoteLookups || []} />
              <Panel title="Quote Requests" rows={data.quotes} />
              <Panel title="Support Handoffs" rows={data.support} />
              <Panel title="AI Usage" rows={data.aiUsage} />
            </section>
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

function rowTitle(row: AdminRow) {
  if ("feature" in row) return `${row.feature} - ${row.model}`;
  if ("name" in row && row.name) return row.name;
  if ("email" in row && row.email) return row.email;
  if ("query" in row && row.query) return row.query;
  if ("type" in row && row.type) return row.type;
  return "Admin row";
}

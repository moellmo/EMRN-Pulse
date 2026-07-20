import { readAssistantAdminData } from "@/lib/assistant/analytics";
import type { AssistantAiUsageEvent, QuoteRequest, SupportRequest } from "@/lib/assistant/types";

export const dynamic = "force-dynamic";

type AdminRow =
  | (QuoteRequest & { createdAt: string })
  | (SupportRequest & { createdAt: string })
  | AssistantAiUsageEvent;

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

        {!data ? (
          <div className="mt-8 rounded-md border border-red-200 bg-white p-5 text-red-700">
            Admin data is unavailable. Set EMRN_ASSISTANT_ADMIN_TOKEN for production access.
          </div>
        ) : data.metrics.totalEvents === 0 ? (
          <div className="mt-8 rounded-md border border-amber-200 bg-white p-5 text-amber-800">
            No production logs have been recorded yet. Local dev logs are not available on Vercel.
            To keep durable history, set <code>EMRN_GOOGLE_SHEETS_WEBHOOK_URL</code> and
            <code className="ml-1">EMRN_GOOGLE_SHEETS_WEBHOOK_SECRET</code>, redeploy, then send a few Pulse test messages.
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
              <Panel title="Quote Requests" rows={data.quotes} />
              <Panel title="Support Escalations" rows={data.support} />
              <Panel title="AI Usage" rows={data.aiUsage} />
            </section>
          </>
        )}
      </div>
    </main>
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
  return row.name || row.email;
}

import type { QuoteRequest, SupportRequest } from "@/lib/assistant/types";

export const dynamic = "force-dynamic";

type AdminRow =
  | (QuoteRequest & { createdAt: string })
  | (SupportRequest & { createdAt: string });

async function getData() {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  const response = await fetch(`${base}/api/assistant/admin`, {
    cache: "no-store",
    headers: process.env.EMRN_ASSISTANT_ADMIN_TOKEN
      ? { Authorization: `Bearer ${process.env.EMRN_ASSISTANT_ADMIN_TOKEN}` }
      : {},
  });
  if (!response.ok) return null;
  return response.json();
}

export default async function AssistantAdminPage() {
  const data = await getData();

  return (
    <main className="min-h-screen bg-slate-50 p-6 text-slate-950">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-3xl font-bold">EMRN Pulse Admin</h1>
        <p className="mt-2 text-slate-600">Quote requests, support escalations, and assistant metrics.</p>

        {!data ? (
          <div className="mt-8 rounded-md border border-red-200 bg-white p-5 text-red-700">
            Admin data is unavailable. Set EMRN_ASSISTANT_ADMIN_TOKEN for production access.
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
              <div className="font-semibold">{row.name || row.email}</div>
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

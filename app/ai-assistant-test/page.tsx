import { MeriTestCenter } from "@/components/assistant/MeriTestCenter";

export const dynamic = "force-dynamic";

type TestPageProps = {
  searchParams: Promise<{ token?: string | string[] }>;
};

export default async function AiAssistantTestPage({ searchParams }: TestPageProps) {
  const token = process.env.EMRN_ASSISTANT_ADMIN_TOKEN;
  const providedToken = (await searchParams).token;
  const isAuthorized =
    !token ||
    (Array.isArray(providedToken) ? providedToken.includes(token) : providedToken === token);

  if (!isAuthorized) {
    return (
      <main className="min-h-screen bg-slate-50 p-6 text-slate-950">
        <div className="mx-auto max-w-xl rounded-md border border-red-200 bg-white p-5 text-red-700">
          Test Center access requires a valid token. Open this page with
          <code className="mx-1 rounded bg-red-50 px-1">?token=YOUR_ADMIN_TOKEN</code>.
        </div>
      </main>
    );
  }

  return <MeriTestCenter />;
}

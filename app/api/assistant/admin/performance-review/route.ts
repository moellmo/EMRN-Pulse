import { NextRequest, NextResponse } from "next/server";
import { logAnalyticsEvent } from "@/lib/assistant/analytics";

export const runtime = "nodejs";

function authorized(req: NextRequest) {
  const token = process.env.EMRN_ASSISTANT_ADMIN_TOKEN;
  if (!token && process.env.NODE_ENV !== "production") return true;
  return req.headers.get("authorization") === `Bearer ${token}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const reviewedPerformanceKey = String(body?.reviewedPerformanceKey || "").trim();
  const query = String(body?.query || "").trim();

  if (!reviewedPerformanceKey) {
    return NextResponse.json({ error: "Missing performance row key." }, { status: 400 });
  }

  await logAnalyticsEvent({
    type: "admin_reviewed_performance",
    sessionId: "admin",
    language: "en",
    query,
    reviewedPerformanceKey,
    createdAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}

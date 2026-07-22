import { NextRequest, NextResponse } from "next/server";
import { readAssistantConfig, saveAssistantConfig } from "@/lib/assistant/admin-config";

export const runtime = "nodejs";

function authorized(req: NextRequest) {
  const token = process.env.EMRN_ASSISTANT_ADMIN_TOKEN;
  if (!token && process.env.NODE_ENV !== "production") return true;
  return req.headers.get("authorization") === `Bearer ${token}` || req.nextUrl.searchParams.get("token") === token;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await readAssistantConfig(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const config = await saveAssistantConfig(body || {});
  return NextResponse.json(config, { headers: { "Cache-Control": "no-store" } });
}

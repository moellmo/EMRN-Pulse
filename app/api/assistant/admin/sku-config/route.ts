import { NextRequest, NextResponse } from "next/server";
import { readSkuConfigSync, saveSkuConfig } from "@/lib/assistant/sku-config";

export const runtime = "nodejs";

function authorized(req: NextRequest) {
  const token = process.env.EMRN_ASSISTANT_ADMIN_TOKEN;
  if (!token && process.env.NODE_ENV !== "production") return true;
  return req.headers.get("authorization") === `Bearer ${token}` || req.nextUrl.searchParams.get("token") === token;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(readSkuConfigSync(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const config = await saveSkuConfig({
    prefixes: Array.isArray(body?.prefixes) ? body.prefixes : undefined,
    suffixes: Array.isArray(body?.suffixes) ? body.suffixes : undefined,
  });
  return NextResponse.json(config, { headers: { "Cache-Control": "no-store" } });
}

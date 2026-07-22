import { NextRequest, NextResponse } from "next/server";
import { deleteCachedAnswer } from "@/lib/assistant/answer-cache";

export const runtime = "nodejs";

function authorized(req: NextRequest) {
  const token = process.env.EMRN_ASSISTANT_ADMIN_TOKEN;
  if (!token && process.env.NODE_ENV !== "production") return true;
  return req.headers.get("authorization") === `Bearer ${token}`;
}

export async function DELETE(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const key = String(body?.key || "").trim();
  if (!key) {
    return NextResponse.json({ error: "Missing cache key." }, { status: 400 });
  }

  const result = await deleteCachedAnswer(key);
  if (result.error) {
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...result });
}

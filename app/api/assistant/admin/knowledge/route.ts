import { NextRequest, NextResponse } from "next/server";
import { deleteKnowledgeMemoryItem, readKnowledgeMemory, saveKnowledgeMemoryItem } from "@/lib/assistant/knowledge-memory";

export const runtime = "nodejs";

function authorized(req: NextRequest) {
  const token = process.env.EMRN_ASSISTANT_ADMIN_TOKEN;
  if (!token && process.env.NODE_ENV !== "production") return true;
  return req.headers.get("authorization") === `Bearer ${token}` || req.nextUrl.searchParams.get("token") === token;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ items: await readKnowledgeMemory() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  try {
    if (body?.deleteId) return NextResponse.json(await deleteKnowledgeMemoryItem(String(body.deleteId)));
    return NextResponse.json(await saveKnowledgeMemoryItem(body || {}), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Save failed" }, { status: 400 });
  }
}

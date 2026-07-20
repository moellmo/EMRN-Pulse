import { NextRequest, NextResponse } from "next/server";
import { testGoogleSheetsMirror } from "@/lib/assistant/analytics";

export const runtime = "nodejs";

function authorized(req: NextRequest) {
  const token = process.env.EMRN_ASSISTANT_ADMIN_TOKEN;
  if (!token && process.env.NODE_ENV !== "production") return true;
  return (
    req.headers.get("authorization") === `Bearer ${token}` ||
    new URL(req.url).searchParams.get("token") === token
  );
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await testGoogleSheetsMirror();
  return NextResponse.json(result, {
    status: result.ok ? 200 : 502,
    headers: { "Cache-Control": "no-store" },
  });
}

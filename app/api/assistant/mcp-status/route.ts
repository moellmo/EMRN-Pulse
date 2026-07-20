import { NextResponse } from "next/server";
import { getBigCommerceMcpStatus } from "@/lib/assistant/bigcommerce-mcp";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getBigCommerceMcpStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}

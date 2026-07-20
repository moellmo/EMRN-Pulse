import { NextRequest, NextResponse } from "next/server";
import { createCart } from "@/lib/assistant/catalog";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const result = await createCart({ sessionId: body?.sessionId, items: body?.items || [] });

  if (result.blockedItems.length) {
    return NextResponse.json(
      {
        error: "Some items cannot be added to cart.",
        blockedItems: result.blockedItems,
      },
      { status: 409 }
    );
  }

  return NextResponse.json(result);
}

import { readFile } from "fs/promises";
import path from "path";
import { NextRequest, NextResponse } from "next/server";

const contentTypes: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

export async function GET(_req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const params = await context.params;
  const safeParts = (params.path || []).filter((part) => /^[a-z0-9._-]+$/i.test(part));
  if (!safeParts.length || safeParts.length !== params.path.length) {
    return NextResponse.json({ error: "Invalid path." }, { status: 400 });
  }
  const filePath = path.join(process.cwd(), ".data", "assistant", "uploads", ...safeParts);
  try {
    const body = await readFile(filePath);
    const ext = safeParts[safeParts.length - 1]?.split(".").pop()?.toLowerCase() || "";
    return new Response(body, {
      headers: {
        "Content-Type": contentTypes[ext] || "application/octet-stream",
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
}

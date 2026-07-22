import { NextRequest, NextResponse } from "next/server";
import { readAssistantAdminData } from "@/lib/assistant/analytics";
import { readAssistantConfig } from "@/lib/assistant/admin-config";
import { sendAdminNotificationEmail } from "@/lib/assistant/email";
import { buildQaReviewItems, formatMs } from "@/lib/assistant/qa-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest) {
  const adminToken = process.env.EMRN_ASSISTANT_ADMIN_TOKEN;
  const cronSecret = process.env.CRON_SECRET || process.env.EMRN_CRON_SECRET;
  const authorization = req.headers.get("authorization");

  if (cronSecret && authorization === `Bearer ${cronSecret}`) return true;
  if (adminToken && (authorization === `Bearer ${adminToken}` || req.nextUrl.searchParams.get("token") === adminToken)) return true;
  if (!cronSecret && req.headers.get("x-vercel-cron")) return true;
  return !adminToken && process.env.NODE_ENV !== "production";
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = await readAssistantConfig();
  if (!config.qaDailyReminderEnabled) {
    return NextResponse.json({ ok: true, sent: false, reason: "Daily QA reminders are turned off in admin settings." });
  }

  const data = await readAssistantAdminData({ full: false, limit: 150 });
  const review = buildQaReviewItems(data.performance || []);
  const counts = {
    needsTeaching: review.needsTeaching.length,
    cantConfirm: review.cantConfirm.length,
    slowButAnswered: review.slowButAnswered.length,
    openAiUsed: review.openAiUsed.length,
  };
  const totalReviewItems = review.needsTeaching.length + review.cantConfirm.length + review.slowButAnswered.length;
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  const recipient = process.env.EMRN_QA_REMINDER_EMAIL || "moshe@emrn.ca";

  if (totalReviewItems <= 0) {
    return NextResponse.json({ ok: true, sent: false, reason: "No QA review items found.", counts });
  }

  const email = buildReminderEmail({
    counts,
    adminUrl: adminUrl(req),
    needsTeaching: review.needsTeaching.slice(0, 6),
    cantConfirm: review.cantConfirm.slice(0, 4),
    slowButAnswered: review.slowButAnswered.slice(0, 4),
    openAiUsed: review.openAiUsed.slice(0, 4),
  });

  if (!dryRun) {
    await sendAdminNotificationEmail({
      to: recipient,
      subject: `EMRN Pulse QA: ${totalReviewItems} item${totalReviewItems === 1 ? "" : "s"} to review`,
      text: email,
    });
  }

  return NextResponse.json({
    ok: true,
    sent: !dryRun,
    dryRun,
    recipient,
    counts,
    preview: email,
  });
}

function buildReminderEmail(input: {
  counts: Record<string, number>;
  adminUrl: string;
  needsTeaching: ReturnType<typeof buildQaReviewItems>["needsTeaching"];
  cantConfirm: ReturnType<typeof buildQaReviewItems>["cantConfirm"];
  slowButAnswered: ReturnType<typeof buildQaReviewItems>["slowButAnswered"];
  openAiUsed: ReturnType<typeof buildQaReviewItems>["openAiUsed"];
}) {
  return [
    "EMRN Pulse has questions ready for review.",
    "",
    "Counts",
    `- Needs teaching: ${input.counts.needsTeaching}`,
    `- Can't confirm: ${input.counts.cantConfirm}`,
    `- Slow but answered: ${input.counts.slowButAnswered}`,
    `- OpenAI used: ${input.counts.openAiUsed}`,
    "",
    "Open QA Queue",
    input.adminUrl,
    "",
    section("Needs teaching", input.needsTeaching),
    section("Can't confirm", input.cantConfirm),
    section("Slow but answered", input.slowButAnswered),
    section("OpenAI used", input.openAiUsed),
    "",
    "Tip: In Admin, mark rows Reviewed after you check them so the queue stays clean.",
  ].filter(Boolean).join("\n");
}

function section(title: string, items: ReturnType<typeof buildQaReviewItems>["items"]) {
  if (!items.length) return "";
  return [
    title,
    ...items.map((item, index) => {
      const totalMs = Number(item.row.performance?.totalMs || 0);
      const answer = item.answer ? `\n  Meri: ${item.answer.slice(0, 220)}${item.answer.length > 220 ? "..." : ""}` : "";
      const reasons = item.reasons.length ? `\n  Why: ${item.reasons.join("; ")}` : "";
      const timing = totalMs ? `\n  Time: ${formatMs(totalMs)}` : "";
      return `${index + 1}. ${item.question}${timing}${reasons}${answer}`;
    }),
    "",
  ].join("\n");
}

function adminUrl(req: NextRequest) {
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
    req.nextUrl.origin;
  try {
    return new URL("/ai-assistant-admin", configured).toString();
  } catch {
    return `${req.nextUrl.origin}/ai-assistant-admin`;
  }
}

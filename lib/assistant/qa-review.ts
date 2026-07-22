export type QaPerformanceRow = {
  createdAt?: string;
  type?: string;
  query?: string;
  language?: string;
  sessionId?: string;
  performance?: {
    totalMs?: number;
    answerPath?: string;
    answerPreview?: string;
    productCount?: number;
    searchQuery?: string;
    openAiUsed?: boolean;
    emrnMatchCount?: number;
    emrnMatchedSkus?: string[];
  };
};

export type QaReviewBucket = "needsTeaching" | "cantConfirm" | "slowButAnswered" | "openAiUsed";

export type QaReviewItem = {
  row: QaPerformanceRow;
  question: string;
  answer: string;
  reasons: string[];
  buckets: QaReviewBucket[];
};

export function buildQaReviewItems(rows: QaPerformanceRow[]) {
  const items = sortRowsByTime(rows)
    .map((row) => {
      const question = rowQuestion(row);
      const answer = cleanAnswerPreview(String(row.performance?.answerPreview || ""));
      return {
        row,
        question,
        answer,
        reasons: qaReasonsForRow(row, answer),
        buckets: qaBucketsForRow(row, answer),
      };
    })
    .filter((item) => item.buckets.length > 0);

  return {
    items,
    needsTeaching: items.filter((item) => item.buckets.includes("needsTeaching")),
    cantConfirm: items.filter((item) => item.buckets.includes("cantConfirm")),
    slowButAnswered: items.filter((item) => item.buckets.includes("slowButAnswered")),
    openAiUsed: items.filter((item) => item.buckets.includes("openAiUsed")),
  };
}

export function rowQuestion(row: QaPerformanceRow) {
  return row.query || "";
}

export function cleanAnswerPreview(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function quickActionQuestionLabel(question: string) {
  if (isShortFollowUp(question)) return "Customer follow-up";
  if (/^I have a product question about compatibility, parts, or which item fits$/i.test(question)) return "Customer clicked quick button";
  if (/^Find a product$/i.test(question)) return "Customer clicked quick button";
  if (/^I need a quote$/i.test(question)) return "Customer clicked quick button";
  if (/^Look up a quote$/i.test(question)) return "Customer clicked quick button";
  if (/^Reorder my last order$/i.test(question)) return "Customer clicked quick button";
  if (/^Find my invoice or receipt$/i.test(question)) return "Customer clicked quick button";
  if (/^Can you check availability\?$/i.test(question)) return "Customer clicked quick button";
  if (/^Check order status$/i.test(question)) return "Customer clicked quick button";
  if (/^Contact support$/i.test(question)) return "Customer clicked quick button";
  return "Customer asked";
}

export function isShortFollowUp(question: string) {
  return /^(?:no|nope|nah|yes|yeah|yep|ok|okay|k|thanks|thank you|thx|merci|non|oui|d'accord|daccord|sure)$/i.test(question.trim());
}

export function isRealProductQaQuestion(question: string) {
  const clean = question.trim();
  if (!clean || isShortFollowUp(clean)) return false;
  if (quickActionQuestionLabel(clean) === "Customer clicked quick button") return false;
  if (clean.split(/\s+/).length <= 2 && !extractLooksLikeSku(clean)) return false;
  return /\b(sku|part|model|compatible|compatibility|fit|fits|work|works|replacement|replace|pads?|padz|electrodes?|airways?|lungs?|batter(?:y|ies)|manikins?|mannequins?|aed|defib|zoll|philips|laerdal|little|frx|g3|price|cheap|cost|stock|available|availability|couleur|color|devis|quote)\b/i.test(clean);
}

export function qaBucketsForRow(row: QaPerformanceRow, answerPreview: string) {
  const buckets: QaReviewBucket[] = [];
  const question = rowQuestion(row);
  const perf = row.performance || {};
  const totalMs = Number(perf.totalMs || 0);
  const answer = answerPreview.toLowerCase();
  const unsure = /can.t confirm|could not confirm|i do not see|not logged|send this to support|source request|item-sourcing/i.test(answerPreview);
  const notCompatible = /\b(not compatible|does not fit|should not be treated as compatible)\b/i.test(answerPreview);
  const route = String(perf.answerPath || "");
  const productCount = Number(perf.productCount || 0);

  if (isRealProductQaQuestion(question)) {
    if (!answerPreview || unsure || route.includes("no_products") || productCount === 0) buckets.push("needsTeaching");
    else if (Boolean(perf.openAiUsed) && totalMs >= 2500) buckets.push("needsTeaching");
    else if (!notCompatible && /\b(compatible|fit|fits|work with|works with|replacement|pads?|airways?|lungs?|batter)/i.test(question) && !/\b(sku|confirmed|compatible|not compatible|replacement|view product)\b/i.test(answer)) buckets.push("needsTeaching");
  }

  if (unsure) buckets.push("cantConfirm");
  if (totalMs >= 2500 && answerPreview && !buckets.includes("needsTeaching")) buckets.push("slowButAnswered");
  if (perf.openAiUsed) buckets.push("openAiUsed");
  return [...new Set(buckets)];
}

export function qaReasonsForRow(row: QaPerformanceRow, answerPreview: string) {
  const perf = row.performance || {};
  const reasons: string[] = [];
  const query = rowQuestion(row);
  const route = String(perf.answerPath || "");

  if (!answerPreview) reasons.push("No answer logged");
  if (/can.t confirm|could not confirm|i do not see|item-sourcing|send this to support/i.test(answerPreview)) reasons.push("Meri said can't confirm or moved toward support");
  if (perf.openAiUsed) reasons.push("OpenAI used");
  if (Number(perf.totalMs || 0) >= 2500) reasons.push(`Slow answer: ${formatMs(Number(perf.totalMs || 0))}`);
  if (route.includes("no_products") || Number(perf.productCount || 0) === 0) reasons.push("No exact EMRN match found");
  if (/\b(compatible|compatibility|fit|fits|work with|works with|replacement|pads?|airways?|lungs?|batter)/i.test(query)) reasons.push("Question looked like product compatibility or replacement help");
  if (typeof perf.emrnMatchCount === "number") reasons.push(`External recovery found ${perf.emrnMatchCount} EMRN match${perf.emrnMatchCount === 1 ? "" : "es"}`);
  if (isShortFollowUp(query)) reasons.push("Customer follow-up");
  if (quickActionQuestionLabel(query) === "Customer clicked quick button") reasons.push("Starter button click");
  if (!reasons.length) reasons.push("No obvious issue detected");
  return reasons.slice(0, 5);
}

export function formatMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} sec`;
  return `${Math.round(value)} ms`;
}

function extractLooksLikeSku(value: string) {
  return /\b(?=[A-Z0-9+.-]*\d)[A-Z0-9]{2,}(?:[-+.][A-Z0-9]{1,})*\b/i.test(value.trim());
}

function sortRowsByTime<T extends { createdAt?: string }>(rows: T[]) {
  return [...rows].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

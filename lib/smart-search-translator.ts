import { detectQueryLanguage, expandSearchQuery, getFallbackTerms, normalizeSearchText } from "./search-language";

type SmartQueryResult = {
  original_query: string;
  search_query: string;
  language: "en" | "fr";
  expanded_query: string;
  expansions: string[];
  translated_query: string;
  translator: "none" | "manual" | "openai" | "manual+openai";
  ai_status: "not_needed" | "missing_key" | "called" | "error";
  fallback_terms: string[];
  redirect_url?: string;
};

type CacheValue = {
  value: SmartQueryResult;
  expiresAt: number;
};

const globalCache = globalThis as typeof globalThis & {
  __emrnSmartSearchTranslatorCache?: Map<string, CacheValue>;
};

const cache = globalCache.__emrnSmartSearchTranslatorCache || new Map<string, CacheValue>();
globalCache.__emrnSmartSearchTranslatorCache = cache;

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14;

const modifierMap: Array<[RegExp, string]> = [
  [/\\b(\\d+(?:\\.\\d+)?)\\s*ml\\b/i, "$1 ml"],
  [/\\b(\\d+(?:\\.\\d+)?)\\s*cc\\b/i, "$1 cc"],
  [/\\b(\\d+(?:\\.\\d+)?)\\s*fr\\b/i, "$1 fr"],
  [/\\b(\\d+(?:\\.\\d+)?)\\s*g\\b/i, "$1 g"],
  [/\\bpediatrique\\b/i, "pediatric"],
  [/\\bpédiatrique\\b/i, "pediatric"],
  [/\\badulte\\b/i, "adult"],
  [/\\benfant\\b/i, "child pediatric"],
  [/\\bbebe\\b/i, "infant baby"],
  [/\\bbébé\\b/i, "infant baby"],
  [/\\bsterile\\b/i, "sterile"],
  [/\\bstérile\\b/i, "sterile"],
  [/\\bjetable\\b/i, "disposable"],
  [/\\bformation\\b/i, "training"],
  [/\\bdouche\\b/i, "shower"],
];

function cleanSearchQuery(query: string) {
  return String(query || "")
    .replace(/\\s+/g, " ")
    .trim()
    .slice(0, 160);
}

type OpenAIResponsePayload = {
  output_text?: unknown;
  output?: Array<{
    content?: Array<{
      text?: unknown;
    }>;
  }>;
};

function extractOutputText(payload: OpenAIResponsePayload) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const parts: string[] = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\\n").trim();
}

function safeParseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\\{[\\s\\S]*\\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function preserveModifiers(original: string) {
  const pieces = new Set<string>();
  const normalized = normalizeSearchText(original);

  for (const [regex, replacement] of modifierMap) {
    const match = original.match(regex) || normalized.match(regex);
    if (match) {
      const value = replacement.replace("$1", match[1] || "").trim();
      if (value) pieces.add(value);
    }
  }

  return Array.from(pieces).join(" ");
}

function buildManualQuery(original: string, expansions: string[]) {
  if (!expansions.length) return "";
  const modifiers = preserveModifiers(original);
  return cleanSearchQuery([original, ...expansions.slice(0, 6), modifiers].filter(Boolean).join(" "));
}

async function translateWithOpenAI(query: string, language: "en" | "fr") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { query: "", alternatives: [] as string[], status: "missing_key" as const };

  const model = process.env.OPENAI_SEARCH_TRANSLATOR_MODEL || "gpt-4.1-nano";
  const input = [
    {
      role: "system",
      content:
        "You translate healthcare ecommerce search queries into concise English search keywords for a Canadian medical supply website. Return ONLY JSON with keys english_query and alternatives. Preserve brand names, SKU-like strings, model numbers, sizes, quantities, and medical category meaning. Use common terms: manikin not mannequin, AED, CPR, blood pressure cuff, oxygen mask, wound dressing, syringe, catheter, gloves, shower chair.",
    },
    {
      role: "user",
      content: `Query language: ${language}\\nCustomer search query: ${query}`,
    },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1400);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({ model, input }),
    });

    if (!res.ok) {
      console.error("[EMRN SmartSearch] OpenAI translator error", res.status, await res.text());
      return { query: "", alternatives: [] as string[], status: "error" as const };
    }

    const payload = await res.json();
    const parsed = safeParseJson(extractOutputText(payload));
    const alternatives = Array.isArray(parsed?.alternatives)
      ? parsed.alternatives.map((item: unknown) => cleanSearchQuery(String(item || ""))).filter(Boolean)
      : [];
    return { query: cleanSearchQuery(parsed?.english_query || ""), alternatives, status: "called" as const };
  } catch (error) {
    console.error("[EMRN SmartSearch] OpenAI translator request failed", error);
    return { query: "", alternatives: [] as string[], status: "error" as const };
  } finally {
    clearTimeout(timeout);
  }
}

export async function buildSmartSearchQuery(query: string): Promise<SmartQueryResult> {
  const original = cleanSearchQuery(query || "*");
  const cacheKey = original.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const manual = expandSearchQuery(original);
  const language = manual.language || detectQueryLanguage(original);

  let translated = buildManualQuery(original, manual.expansions);
  let translator: SmartQueryResult["translator"] = translated ? "manual" : "none";
  let aiStatus: SmartQueryResult["ai_status"] = "not_needed";

  const looksNaturalLanguage = /^[a-zA-ZÀ-ÿ\s'-]+$/.test(original) && !/\d/.test(original);
  const shouldUseAI =
    original !== "*" &&
    original.length >= 3 &&
    !manual.expansions.length &&
    looksNaturalLanguage &&
    language === "fr";

  if (shouldUseAI) {
    const ai = await translateWithOpenAI(original, language);
    aiStatus = ai.status;
    if (ai.query) {
      translated = cleanSearchQuery([ai.query, translated, ...ai.alternatives.slice(0, 6)].filter(Boolean).join(" "));
      translator = translator === "manual" ? "manual+openai" : "openai";
    }
  }

  const fallbackTerms = Array.from(
    new Set([
      ...getFallbackTerms(original),
    ])
  ).slice(0, 8);

  const result: SmartQueryResult = {
    original_query: original,
    search_query: translated || original,
    language,
    expanded_query: manual.expanded,
    expansions: manual.expansions,
    translated_query: translated,
    translator,
    ai_status: aiStatus,
    fallback_terms: fallbackTerms,
  };

  cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

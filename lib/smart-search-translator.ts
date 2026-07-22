import { detectQueryLanguage, expandSearchQuery, getFallbackTerms, normalizeSearchText } from "./search-language";
import { logAiUsage } from "./assistant/analytics";
import { assistantFeatureEnabledAsync } from "./assistant/admin-config";

export type SmartQueryResult = {
  original_query: string;
  search_query: string;
  language: "en" | "fr";
  expanded_query: string;
  expansions: string[];
  translated_query: string;
  translator: "none" | "manual" | "openai" | "manual+openai";
  ai_status: "not_needed" | "missing_key" | "called" | "error";
  fallback_terms: string[];
  assisted_queries: string[];
  timings?: {
    totalMs: number;
    configMs?: number;
    openAiMs?: number;
  };
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
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
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

function buildManualQuery(original: string, expansions: string[], language: "en" | "fr") {
  if (!expansions.length) return "";
  const modifiers = preserveModifiers(original);
  const parts = language === "fr" ? [expansions[0], modifiers] : [original, ...expansions.slice(0, 6), modifiers];
  return cleanSearchQuery(parts.filter(Boolean).join(" "));
}

async function aiSearchHelperEnabled() {
  return assistantFeatureEnabledAsync("aiSearchHelperEnabled");
}

function shouldUseAiSearchHelper(original: string, language: "en" | "fr", looksNaturalLanguage: boolean, aiEnabled: boolean) {
  if (!aiEnabled || language !== "en" || !looksNaturalLanguage) return false;
  if (/\b[A-Z]{1,8}[-\s]?\d{3,}[A-Z0-9-]*\+?\b/.test(original)) return false;
  return /\b(what|which|does|do|work|works|fit|fits|compatible|compatibility|replacement|part|accessory|pads?|battery|batteries|for|need|looking|find|show)\b/i.test(original);
}

function shouldUseFrenchAiSearchHelper(original: string, looksNaturalLanguage: boolean, aiEnabled: boolean) {
  if (!aiEnabled || !looksNaturalLanguage) return false;
  const normalized = normalizeSearchText(original);
  return /\b(frx|zoll|philips|laerdal|prestan|qcpr|aed|dea|electrode|electrodes|pads?|batterie|batteries|pile|piles|compatible|remplacement|piece|pieces|accessoire|accessoires|pour)\b/i.test(normalized);
}

async function translateWithOpenAI(query: string, language: "en" | "fr") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { query: "", alternatives: [] as string[], status: "missing_key" as const };

  const model = process.env.OPENAI_SEARCH_TRANSLATOR_MODEL || "gpt-4.1-nano";
  const input = [
    {
      role: "system",
      content:
        "You rewrite healthcare ecommerce search queries into concise English search keywords for a Canadian medical supply website. Return ONLY JSON with keys english_query and alternatives. Preserve brand names, SKU-like strings, model numbers, sizes, quantities, and medical category meaning. Include likely manufacturer model names, part numbers, accessory names, and common catalog terms when relevant, but keep each alternative short. Use common terms: manikin not mannequin, AED, CPR, blood pressure cuff, oxygen mask, wound dressing, syringe, catheter, gloves, shower chair.",
    },
    {
      role: "user",
      content: `Query language: ${language}\\nCustomer search query: ${query}`,
    },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

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
    await logAiUsage({
      feature: "search_translator",
      model,
      inputTokens: Number(payload.usage?.input_tokens || 0),
      outputTokens: Number(payload.usage?.output_tokens || 0),
      language,
      query,
      status: "called",
    });
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
  const startedAt = Date.now();
  const original = cleanSearchQuery(query || "*");
  const cacheKey = original.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const manual = expandSearchQuery(original);
  const language = manual.language || detectQueryLanguage(original);

  let translated = buildManualQuery(original, manual.expansions, language);
  let translator: SmartQueryResult["translator"] = translated ? "manual" : "none";
  let aiStatus: SmartQueryResult["ai_status"] = "not_needed";
  let assistedQueries: string[] = [];
  let openAiMs = 0;

  const naturalLanguageCandidate = original.replace(/[?!.,"()/:]+/g, " ");
  const looksNaturalLanguage = /^[a-zA-ZÀ-ÿ0-9\s'-]+$/.test(naturalLanguageCandidate);
  const configStartedAt = Date.now();
  const aiEnabled = await aiSearchHelperEnabled();
  const configMs = Date.now() - configStartedAt;
  const shouldUseAI =
    original !== "*" &&
    original.length >= 3 &&
    looksNaturalLanguage &&
    ((language === "fr" && (!manual.expansions.length || aiEnabled || shouldUseFrenchAiSearchHelper(original, looksNaturalLanguage, aiEnabled))) ||
      shouldUseAiSearchHelper(original, language, looksNaturalLanguage, aiEnabled));

  if (shouldUseAI) {
    const openAiStartedAt = Date.now();
    const ai = await translateWithOpenAI(original, language);
    openAiMs = Date.now() - openAiStartedAt;
    aiStatus = ai.status;
    if (ai.query) {
      assistedQueries = Array.from(new Set([ai.query, ...ai.alternatives].map(cleanSearchQuery).filter(Boolean))).slice(0, 8);
      translated = language === "fr"
        ? cleanSearchQuery([ai.query, translated, ...ai.alternatives.slice(0, 6)].filter(Boolean).join(" "))
        : translated;
      translator = translator === "manual" ? "manual+openai" : "openai";
    }
  }

  const fallbackTerms = Array.from(
    new Set([
      ...getFallbackTerms(original),
      ...assistedQueries,
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
    assisted_queries: assistedQueries,
    timings: {
      totalMs: Date.now() - startedAt,
      configMs,
      openAiMs,
    },
  };

  cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

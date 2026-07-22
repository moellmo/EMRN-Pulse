import { logAiUsage, logAnalyticsEvent } from "./analytics";
import { assistantFeatureEnabledAsync } from "./admin-config";
import { buildSystemPrompt, faqContext, productContext } from "./prompt";
import type { AssistantLanguage, AssistantMessage, CatalogProduct } from "./types";

export type ExternalKnowledgeLookup = {
  status: "confirmed" | "not_compatible" | "cant_confirm";
  summary: string;
  exactProductName: string;
  manufacturerPartNumbers: string[];
  searchTerms: string[];
  sourceType: "manufacturer" | "supplier_catalog" | "emrn" | "mixed" | "unknown";
  sourceUrls: string[];
};

const trustedProductSourceDomains = [
  "emrn.ca",
  "laerdal.com",
  "prestanproducts.com",
  "bd.com",
  "stryker.com",
  "zoll.com",
  "philips.com",
  "drivemedical.com",
  "dynarex.com",
  "medline.com",
  "3m.com",
  "riester.de",
  "vyaire.com",
  "ambu.com",
  "nascohealthcare.com",
  "simulaids.com",
  "statpacks.com",
  "meretusa.com",
  "sol-m.com",
  "mckesson.com",
  "mms.mckesson.com",
  "henryschein.com",
  "boundtree.com",
  "cardinalhealth.com",
  "owens-minor.com",
  "concordancehealthcare.com",
  "vwr.com",
  "fishersci.com",
  "dotmed.com",
  "mfimedical.com",
  "cascadehealthcaresolutions.com",
  "tigermedical.com",
  "integrisequipment.com",
  "alimed.com",
  "performancehealth.com",
  "enovis.com",
  "hollister.com",
  "convatec.com",
  "smith-nephew.com",
  "molnlycke.com",
  "baxter.com",
  "cardiachealth.ca",
  "quadmed.com",
  "rescue-essentials.com",
  "schoolhealth.com",
  "liveactionsafety.com",
  "grainger.com",
  "amazon.ca",
  "amazon.com",
  "aedsuperstore.com",
  "aedbrands.com",
  "aed.us",
  "aed.com",
  "healthproductsforyou.com",
  "activeforever.com",
  "rehabmart.com",
  "graylinemedical.com",
  "medicaleshop.com",
  "schoolhealth.com",
  "redcross.ca",
  "redcross.org",
  "manualslib.com",
  "manuals.plus",
];

function trustedDomainsForProducts(products: CatalogProduct[]) {
  const domains = new Set(trustedProductSourceDomains);
  for (const product of products) {
    const text = [product.brand, product.manufacturer, product.name].join(" ").toLowerCase();
    for (const value of [product.brand, product.manufacturer]) {
      const normalized = value
        .toLowerCase()
        .replace(/\b(?:inc|llc|ltd|limited|corp|corporation|company|co|medical|products|supplies|healthcare)\b/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      if (!normalized) continue;
      const compact = normalized.replace(/\s+/g, "");
      const firstToken = normalized.split(/\s+/)[0];
      for (const candidate of [compact, firstToken]) {
        if (candidate.length >= 3) {
          domains.add(`${candidate}.com`);
          domains.add(`${candidate}.ca`);
        }
      }
    }
    if (text.includes("laerdal")) domains.add("laerdal.com");
    if (text.includes("prestan")) domains.add("prestanproducts.com");
    if (/\bbd\b|becton/.test(text)) domains.add("bd.com");
    if (text.includes("stryker")) domains.add("stryker.com");
    if (text.includes("zoll")) domains.add("zoll.com");
    if (text.includes("philips")) domains.add("philips.com");
    if (text.includes("drive")) domains.add("drivemedical.com");
    if (text.includes("dynarex")) domains.add("dynarex.com");
    if (text.includes("medline")) domains.add("medline.com");
    if (text.includes("mckesson")) domains.add("mckesson.com");
    if (text.includes("henry schein")) domains.add("henryschein.com");
    if (text.includes("bound tree")) domains.add("boundtree.com");
    if (text.includes("3m") || text.includes("littmann")) domains.add("3m.com");
    if (text.includes("riester")) domains.add("riester.de");
    if (text.includes("vyaire")) domains.add("vyaire.com");
    if (text.includes("ambu")) domains.add("ambu.com");
    if (text.includes("nasco")) domains.add("nascohealthcare.com");
    if (text.includes("statpack") || text.includes("g3+") || text.includes("load n go") || text.includes("load-n-go")) domains.add("statpacks.com");
    if (text.includes("meret")) domains.add("meretusa.com");
    if (text.includes("sol-m")) domains.add("sol-m.com");
  }
  return Array.from(domains).slice(0, 40);
}

async function shouldShowExternalSources() {
  return assistantFeatureEnabledAsync("showExternalSources");
}

function sourceVisibilityInstructions(showExternalSources: boolean) {
  if (showExternalSources) {
    return "- If an exact EMRN or manufacturer source confirms compatibility or specifications, answer confidently, include the source URL, and use wording like \"Based on the product/manufacturer info I found...\".";
  }

  return [
    "- If an exact EMRN or manufacturer source confirms compatibility or specifications, answer confidently and use wording like \"Based on EMRN/manufacturer product information I found...\".",
    "- Do not include external source URLs, external domains, competitor links, marketplace links, citation links, or markdown links to non-EMRN websites in the customer reply.",
    "- When external product information supports the answer, mention the source type only, such as \"manufacturer information\" or \"supplier catalog information\".",
    "- Include EMRN product URLs when supplied. If no EMRN product URL is supplied, do not replace it with an external URL.",
    "- Only show prices from supplied EMRN catalog/product context. Never show competitor, manufacturer, marketplace, or supplier prices.",
    "- If external sources identify the right item but no matching EMRN catalog product is supplied, do not send the customer away. Say EMRN can help source/check the item and ask for their name, email, quantity, and any needed deadline so the request can be sent to the EMRN quote team.",
    "- If the supplied EMRN catalog products are related but not the exact verified item, show them only after clearly labeling the difference, then offer to send an EMRN item-sourcing or quote request for the exact verified item.",
  ].join("\n");
}

function detailAnswerInstructions(language: AssistantLanguage, showExternalSources: boolean) {
  return [
    buildSystemPrompt(language),
    "",
    "Product detail and compatibility fallback rules:",
    "- First use the supplied EMRN catalog/product context.",
    "- If the EMRN context clearly answers the compatibility, dimension, accessory, replacement-part, or specification question, answer from EMRN context and do not rely on general memory.",
    "- If EMRN context is unclear and web search is available, search only trusted EMRN/manufacturer/large medical supplier domains supplied by the tool filter.",
    "- Search the exact brand/manufacturer page first when a brand or model is mentioned. If the manufacturer page is not enough, use large medical supplier catalogs or product catalog pages only as support.",
    "- For EMRN catalog lookup, treat the supplied EMRN SKU as exact. For manufacturer/web lookup, remember EMRN SKUs may add store-specific prefixes or suffixes, such as DY for Dynarex or trailing internal letters for Nasco. Search and match by manufacturer name, manufacturer model/part number embedded in the SKU or product title, exact product title, dimensions, and option labels too.",
    "- Do not reject a manufacturer source just because its part number omits an EMRN prefix/suffix, but do require the product title/model/dimensions/options to clearly match the EMRN product.",
    "- When a manufacturer, catalog, manual, or approved supplier source identifies the exact part number, model number, or catalog SKU, include that part number in the reply even when EMRN does not currently have a matching catalog product supplied.",
    "- If the exact item is confirmed externally but not found in EMRN catalog context, say EMRN can source/check the manufacturer part number through a quote request. Ask for name, email, quantity, and deadline instead of sending the customer to another site.",
    "- Prefer manufacturer pages, manuals, PDFs, official product pages, or EMRN pages as proof.",
    "- Large medical suppliers and marketplaces such as Medline, McKesson, Henry Schein, Bound Tree, Cardinal Health, Owens & Minor, Concordance, VWR, Fisher Scientific, Grainger, School Health, or Amazon may support specifications or model matching, but do not treat marketplace text as stronger than a manufacturer compatibility list/manual.",
    "- Answer only when the source match is exact enough: same brand, model/family, option, size, SKU/part number when available, and same intended use. If there is any doubt, say Can’t confirm and offer EMRN support/item-sourcing.",
    sourceVisibilityInstructions(showExternalSources),
    "- Never show external supplier prices. If the supplied EMRN catalog context does not include a price, say the price is unavailable or that a quote is required.",
    "- If the verified answer points to a product not found in the supplied EMRN catalog context, offer to send an item-sourcing or quote request to EMRN instead of linking to an external store.",
    "- Show supplied EMRN catalog products first only when they are exact matches for the customer's need. If they are merely related, training-only, different model, or accessories for a different use, label them as related EMRN options after the verified answer and still offer an item-sourcing or quote request for the exact item.",
    "- For compatibility questions, start with one of these labels exactly: \"Confirmed compatible:\", \"Not compatible:\", or \"Can’t confirm:\". Use Confirmed compatible only when EMRN/manufacturer/source text clearly supports the fit. Use Not compatible only when source text clearly says it does not fit or is for a different model. Use Can’t confirm when the source does not prove it.",
    "- If the best source is a marketplace, distributor, or supplier rather than EMRN/manufacturer, do not include the competitor URL or name. Say \"I found supporting product info, but not on EMRN or the manufacturer page\" and answer only if the match is exact.",
    "- If sources are ambiguous, missing, or only suggest a possibility, use this exact answer once and include the EMRN product URL when a product URL is supplied: \"Can’t confirm: I can’t confirm from available product/manufacturer info. Here’s the EMRN product page: [URL]\\n\\nReply yes and I’ll send this to support.\" Keep punctuation outside product URLs and markdown links.",
    "- If part of the answer is confirmed and part is not, state the confirmed part briefly, include the EMRN product URL when supplied, then use the exact support handoff sentence once.",
    "- Do not ask the customer to provide more details instead of using that exact support handoff when the current EMRN product context is ambiguous.",
    "- Never infer fit from similar names alone. Model numbers, SKUs, exact names, or official compatibility lists must support the answer.",
  ].join("\n");
}

function externalLookupInstructions() {
  return [
    "You are an EMRN product research assistant.",
    "Use web search only on trusted manufacturer, official catalog, manual, EMRN, and major medical supplier sources.",
    "Return structured JSON only.",
    "Find whether the customer's compatibility, replacement-part, accessory, dimension, or product-identification question can be confirmed.",
    "Prefer manufacturer pages, manuals, official product pages, and EMRN pages over supplier or marketplace pages.",
    "If confirmed, identify exact manufacturer part numbers, model numbers, catalog SKUs, and clean EMRN search terms.",
    "Put only bare part/model/catalog numbers in manufacturerPartNumbers, without descriptions or dashes.",
    "Do not include prices from external websites.",
    "Use confirmed only when source text clearly supports the exact model/family/use. Use not_compatible only when the source clearly shows a different model or incompatibility. Otherwise use cant_confirm.",
    "Keep the summary short and customer-safe.",
  ].join("\n");
}

function outputTextFromResponse(value: unknown) {
  const record = value as { output_text?: unknown; output?: unknown };
  if (typeof record.output_text === "string") return record.output_text;
  const chunks: string[] = [];
  const seen = new Set<string>();

  const visit = (item: unknown) => {
    if (!item) return;
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item !== "object") return;
    const current = item as Record<string, unknown>;
    for (const key of ["text", "content"]) {
      const text = current[key];
      if (typeof text === "string" && !seen.has(text)) {
        seen.add(text);
        chunks.push(text);
      }
    }
    Object.values(current).forEach(visit);
  };

  visit(value);
  return chunks.join("\n").trim();
}

function cleanLookupArray(value: unknown, max = 8) {
  return Array.isArray(value)
    ? value
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .slice(0, max)
    : [];
}

function parseExternalLookup(value: unknown): ExternalKnowledgeLookup | null {
  const rawText = outputTextFromResponse(value).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const text = rawText.match(/\{[\s\S]*\}/)?.[0] || rawText;
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const status = String(parsed.status || "").trim();
    if (!["confirmed", "not_compatible", "cant_confirm"].includes(status)) return null;
    return {
      status: status as ExternalKnowledgeLookup["status"],
      summary: String(parsed.summary || "").trim().slice(0, 700),
      exactProductName: String(parsed.exactProductName || "").trim().slice(0, 220),
      manufacturerPartNumbers: cleanLookupArray(parsed.manufacturerPartNumbers),
      searchTerms: cleanLookupArray(parsed.searchTerms),
      sourceType: ["manufacturer", "supplier_catalog", "emrn", "mixed", "unknown"].includes(String(parsed.sourceType || ""))
        ? parsed.sourceType as ExternalKnowledgeLookup["sourceType"]
        : "unknown",
      sourceUrls: cleanLookupArray(parsed.sourceUrls, 12),
    };
  } catch {
    return null;
  }
}

export async function lookupExternalKnowledge({
  messages,
  products,
  language,
  sessionId,
  query,
}: {
  messages: AssistantMessage[];
  products: CatalogProduct[];
  language: AssistantLanguage;
  sessionId?: string;
  query?: string;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_WEB_SEARCH_MODEL || "gpt-4.1-mini";
  const webSearchToolType = process.env.OPENAI_WEB_SEARCH_TOOL || "web_search";
  const requestBody = {
    model,
    stream: false,
    instructions: externalLookupInstructions(),
    text: {
      format: {
        type: "json_schema",
        name: "external_knowledge_lookup",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", enum: ["confirmed", "not_compatible", "cant_confirm"] },
            summary: { type: "string" },
            exactProductName: { type: "string" },
            manufacturerPartNumbers: { type: "array", items: { type: "string" } },
            searchTerms: { type: "array", items: { type: "string" } },
            sourceType: { type: "string", enum: ["manufacturer", "supplier_catalog", "emrn", "mixed", "unknown"] },
            sourceUrls: { type: "array", items: { type: "string" } },
          },
          required: [
            "status",
            "summary",
            "exactProductName",
            "manufacturerPartNumbers",
            "searchTerms",
            "sourceType",
            "sourceUrls",
          ],
        },
      },
    },
    tools: [
      {
        type: webSearchToolType,
        search_context_size: "low",
        ...(webSearchToolType === "web_search"
          ? {
              filters: {
                allowed_domains: trustedDomainsForProducts(products),
              },
            }
          : {}),
      },
    ],
    tool_choice: "required",
    input: [
      "EMRN catalog context:",
      productContext(products),
      "",
      "Conversation:",
      ...messages.slice(-8).map((message) => `${message.role.toUpperCase()}: ${message.content}`),
      "",
      "Return JSON with these fields:",
      "{",
      "  \"status\": \"confirmed | not_compatible | cant_confirm\",",
      "  \"summary\": \"short reason based on source info\",",
      "  \"exactProductName\": \"exact item name if found\",",
      "  \"manufacturerPartNumbers\": [\"part/model/catalog numbers\"],",
      "  \"searchTerms\": [\"clean EMRN product searches, no sentences\"],",
      "  \"sourceType\": \"manufacturer | supplier_catalog | emrn | mixed | unknown\",",
      "  \"sourceUrls\": [\"source URLs used\"]",
      "}",
    ].join("\n"),
    max_output_tokens: 900,
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    console.error("[EMRN Pulse] OpenAI external lookup failed", response.status, await response.text());
    return null;
  }

  const json = await response.json();
  const lookup = parseExternalLookup(json);
  const usage = (json as { usage?: Record<string, unknown> }).usage;
  await logAiUsage({
    feature: "trusted_web_search",
    model,
    inputTokens: Number(usage?.input_tokens || 0),
    outputTokens: Number(usage?.output_tokens || 0),
    sessionId,
    language,
    query,
    status: lookup ? "called" : "error",
  });
  await logAnalyticsEvent({
    type: "external_knowledge_sources",
    sessionId: sessionId || "unknown",
    language,
    query,
    externalSources: lookup?.sourceUrls.map((url) => ({ url, domain: domainFromUrl(url) })) || extractResponseSources(json),
    createdAt: new Date().toISOString(),
  });

  return lookup;
}

export async function streamAssistantResponse({
  messages,
  products,
  language,
  sessionId,
  query,
  trustedWebSearch,
}: {
  messages: AssistantMessage[];
  products: CatalogProduct[];
  language: AssistantLanguage;
  sessionId?: string;
  query?: string;
  trustedWebSearch?: boolean;
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return fallbackStream(language, trustedWebSearch ? products : []);
  }

  const model = trustedWebSearch
    ? process.env.OPENAI_WEB_SEARCH_MODEL || process.env.OPENAI_ASSISTANT_MODEL || "gpt-4.1-mini"
    : process.env.OPENAI_ASSISTANT_MODEL || "gpt-4.1-mini";
  const webSearchToolType = process.env.OPENAI_WEB_SEARCH_TOOL || "web_search";
  const webSearchTool = trustedWebSearch
    ? [
        {
          type: webSearchToolType,
          search_context_size: "low",
          ...(webSearchToolType === "web_search"
            ? {
                filters: {
                  allowed_domains: trustedDomainsForProducts(products),
                },
              }
            : {}),
        },
      ]
    : undefined;
  const showExternalSources = await shouldShowExternalSources();
  const requestBody = {
    model,
    stream: true,
    instructions: trustedWebSearch ? detailAnswerInstructions(language, showExternalSources) : buildSystemPrompt(language),
    ...(webSearchTool ? { tools: webSearchTool, tool_choice: "required" } : {}),
    input: [
      faqContext(),
      "",
      "Catalog search results:",
      productContext(products),
      "",
      "Conversation:",
      ...messages.slice(-12).map((message) => `${message.role.toUpperCase()}: ${message.content}`),
      "",
      "Reply to the latest customer message.",
    ].join("\n"),
    max_output_tokens: 650,
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok || !response.body) {
    if (trustedWebSearch) {
      console.error("[EMRN Pulse] OpenAI trusted web detail response failed", response.status, await response.text());
    }
    return fallbackStream(language, trustedWebSearch ? products : []);
  }

  return response.body
    .pipeThrough(parseOpenAiSse({ model, sessionId, language, query, feature: trustedWebSearch ? "trusted_web_search" : "assistant_response" }))
    .pipeThrough(stripExternalSourceLinksIfNeeded(trustedWebSearch, showExternalSources));
}

function parseOpenAiSse({
  model,
  sessionId,
  language,
  query,
  feature,
}: {
  model: string;
  sessionId?: string;
  language: AssistantLanguage;
  query?: string;
  feature: "assistant_response" | "trusted_web_search";
}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const line = part
          .split("\n")
          .find((item) => item.startsWith("data: "))
          ?.slice(6);
        if (!line || line === "[DONE]") continue;

        try {
          const event = JSON.parse(line);
          if (event.type === "response.output_text.delta" && event.delta) {
            controller.enqueue(encoder.encode(event.delta));
          }
          if (event.type === "response.completed" && event.response?.usage) {
            void logAiUsage({
              feature,
              model,
              inputTokens: Number(event.response.usage.input_tokens || 0),
              outputTokens: Number(event.response.usage.output_tokens || 0),
              sessionId,
              language,
              query,
              status: "called",
            });
            if (feature === "trusted_web_search") {
              const externalSources = extractResponseSources(event.response);
              void logAnalyticsEvent({
                type: "external_knowledge_sources",
                sessionId: sessionId || "unknown",
                language,
                query,
                externalSources,
                createdAt: new Date().toISOString(),
              });
            }
          }
        } catch {
          continue;
        }
      }
    },
  });
}

function extractResponseSources(response: unknown) {
  const sources: Array<{ title?: string; url: string; domain?: string }> = [];
  const seen = new Set<string>();

  const visit = (value: unknown) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : "";
    const type = typeof record.type === "string" ? record.type : "";
    if (url && (type.includes("citation") || type.includes("url") || "title" in record)) {
      const cleanUrl = url.replace(/[),.;]+$/g, "");
      if (!seen.has(cleanUrl)) {
        seen.add(cleanUrl);
        sources.push({
          title: typeof record.title === "string" ? record.title : undefined,
          url: cleanUrl,
          domain: domainFromUrl(cleanUrl),
        });
      }
    }

    Object.values(record).forEach(visit);
  };

  visit(response);
  return sources.slice(0, 12);
}

function domainFromUrl(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function isEmrnUrl(value: string) {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "").toLowerCase();
    return host === "emrn.ca" || host.endsWith(".emrn.ca");
  } catch {
    return false;
  }
}

function sanitizeExternalSourceLinks(text: string) {
  return text
    .replace(/\]\((https?:\/\/[^)\s]+)[).,;]+\)/gi, (_match, url: string) => `](${url.replace(/[).,;]+$/g, "")})`)
    .replace(/\s*\(\[([^\]]+)\]\((https?:\/\/[^)]+)\)\)/gi, (match, label: string, url: string) =>
      isEmrnUrl(url) ? match : label.toLowerCase().includes("emrn") ? ` (${label})` : ""
    )
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/gi, (_match, label: string, url: string) =>
      isEmrnUrl(url) ? `[${label}](${url})` : label.toLowerCase().includes("emrn") ? label : "manufacturer information"
    )
    .replace(/https?:\/\/[^\s)]+/gi, (rawUrl: string) => {
      const trailing = rawUrl.match(/[),.;]+$/)?.[0] || "";
      const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
      return `${isEmrnUrl(url) ? url : ""}${isEmrnUrl(url) ? trailing : ""}`;
    })
    .replace(/\(\s*(manufacturer|supplier|catalog)\s+information\s*$/gi, "($1 information)")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\(\s*\)/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function stripExternalSourceLinksIfNeeded(trustedWebSearch: boolean | undefined, showExternalSources: boolean) {
  if (!trustedWebSearch || showExternalSources) return new TransformStream<Uint8Array, Uint8Array>();

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let text = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk) {
      text += decoder.decode(chunk, { stream: true });
    },
    flush(controller) {
      text += decoder.decode();
      controller.enqueue(encoder.encode(sanitizeExternalSourceLinks(text)));
    },
  });
}

function fallbackStream(language: AssistantLanguage, products: CatalogProduct[] = []) {
  const encoder = new TextEncoder();
  const product = products.find((item) => item.url);
  const text = product
    ? language === "fr"
      ? `Can’t confirm: Je ne peux pas confirmer cette information à partir des renseignements produit/fabricant disponibles. Voici la page produit EMRN: ${product.url}. Répondez oui et j’enverrai cette question au support.`
      : `Can’t confirm: I can’t confirm from available product/manufacturer info. Here’s the EMRN product page: ${product.url}. Reply yes and I’ll send this to support.`
    : language === "fr"
      ? "Je peux vous aider, mais le service IA n’est pas configuré pour le moment. Répondez oui et j’enverrai votre question au support."
      : "I can help, but the AI service is not configured right now. Reply yes and I’ll send your question to support.";

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

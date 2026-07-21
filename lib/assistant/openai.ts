import { logAiUsage } from "./analytics";
import { buildSystemPrompt, faqContext, productContext } from "./prompt";
import type { AssistantLanguage, AssistantMessage, CatalogProduct } from "./types";

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
  "sol-m.com",
  "mckesson.com",
  "henryschein.com",
  "boundtree.com",
  "quadmed.com",
  "rescue-essentials.com",
  "schoolhealth.com",
  "liveactionsafety.com",
  "grainger.com",
  "amazon.ca",
  "amazon.com",
];

function trustedDomainsForProducts(products: CatalogProduct[]) {
  const domains = new Set(trustedProductSourceDomains);
  for (const product of products) {
    const text = [product.brand, product.manufacturer, product.name].join(" ").toLowerCase();
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
    if (text.includes("sol-m")) domains.add("sol-m.com");
  }
  return Array.from(domains).slice(0, 30);
}

function detailAnswerInstructions(language: AssistantLanguage) {
  return [
    buildSystemPrompt(language),
    "",
    "Product detail and compatibility fallback rules:",
    "- First use the supplied EMRN catalog/product context.",
    "- If the EMRN context clearly answers the compatibility, dimension, accessory, replacement-part, or specification question, answer from EMRN context and do not rely on general memory.",
    "- If EMRN context is unclear and web search is available, search only trusted EMRN/manufacturer/large medical supplier domains supplied by the tool filter.",
    "- For EMRN catalog lookup, treat the supplied EMRN SKU as exact. For manufacturer/web lookup, remember EMRN SKUs may add store-specific prefixes or suffixes, such as DY for Dynarex or trailing internal letters for Nasco. Search and match by manufacturer name, manufacturer model/part number embedded in the SKU or product title, exact product title, dimensions, and option labels too.",
    "- Do not reject a manufacturer source just because its part number omits an EMRN prefix/suffix, but do require the product title/model/dimensions/options to clearly match the EMRN product.",
    "- Prefer manufacturer pages, manuals, PDFs, official product pages, or EMRN pages as proof.",
    "- Large medical suppliers and marketplaces such as Medline, McKesson, Henry Schein, Bound Tree, Grainger, or Amazon may support specifications or model matching, but do not treat marketplace text as stronger than a manufacturer compatibility list/manual.",
    "- If an exact EMRN or manufacturer source confirms compatibility or specifications, answer confidently, include the source URL, and use wording like \"Based on the product/manufacturer info I found...\".",
    "- If the best source is a marketplace, distributor, or supplier rather than EMRN/manufacturer, do not include the competitor URL or name. Say \"I found supporting product info, but not on EMRN or the manufacturer page\" and answer only if the match is exact.",
    "- If sources are ambiguous, missing, or only suggest a possibility, use this exact answer once: \"I can’t confirm from available product/manufacturer info. Would you like me to send this to support?\"",
    "- If part of the answer is confirmed and part is not, state the confirmed part briefly, then use the exact support handoff sentence once.",
    "- Do not ask the customer to provide more details instead of using that exact support handoff when the current EMRN product context is ambiguous.",
    "- Never infer fit from similar names alone. Model numbers, SKUs, exact names, or official compatibility lists must support the answer.",
  ].join("\n");
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
    return fallbackStream(language);
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
  const requestBody = {
    model,
    stream: true,
    instructions: trustedWebSearch ? detailAnswerInstructions(language) : buildSystemPrompt(language),
    ...(webSearchTool ? { tools: webSearchTool, tool_choice: "auto" } : {}),
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
  let response = await fetch("https://api.openai.com/v1/responses", {
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
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...requestBody, tools: undefined, tool_choice: undefined }),
      });
      if (response.ok && response.body) {
        return response.body.pipeThrough(parseOpenAiSse({ model, sessionId, language, query }));
      }
    }
    return fallbackStream(language);
  }

  return response.body.pipeThrough(parseOpenAiSse({ model, sessionId, language, query }));
}

function parseOpenAiSse({
  model,
  sessionId,
  language,
  query,
}: {
  model: string;
  sessionId?: string;
  language: AssistantLanguage;
  query?: string;
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
              feature: "assistant_response",
              model,
              inputTokens: Number(event.response.usage.input_tokens || 0),
              outputTokens: Number(event.response.usage.output_tokens || 0),
              sessionId,
              language,
              query,
              status: "called",
            });
          }
        } catch {
          continue;
        }
      }
    },
  });
}

function fallbackStream(language: AssistantLanguage) {
  const encoder = new TextEncoder();
  const text =
    language === "fr"
      ? "Je peux vous aider, mais le service IA n’est pas configuré pour le moment. Voulez-vous que j’envoie votre question à notre équipe de support?"
      : "I can help, but the AI service is not configured right now. Would you like me to send your question to our support team?";

  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

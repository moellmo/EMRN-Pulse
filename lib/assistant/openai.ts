import { logAiUsage } from "./analytics";
import { buildSystemPrompt, faqContext, productContext } from "./prompt";
import type { AssistantLanguage, AssistantMessage, CatalogProduct } from "./types";

export async function streamAssistantResponse({
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
  if (!apiKey) {
    return fallbackStream(language);
  }

  const model = process.env.OPENAI_ASSISTANT_MODEL || "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      instructions: buildSystemPrompt(language),
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
    }),
  });

  if (!response.ok || !response.body) {
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

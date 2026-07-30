import type { OrderStatusRequest, QuoteRequest, SupportRequest } from "./types";

const supportEmail = process.env.EMRN_SUPPORT_EMAIL || "moshe@emrn.ca";
const quoteEmail = process.env.EMRN_QUOTE_EMAIL || "moshe@emrn.ca";
const orderStatusEmail = process.env.EMRN_ORDER_STATUS_EMAIL || "support@emrn.ca";

type EmailInput = {
  to: string;
  subject: string;
  text: string;
};

export type EmailDeliveryResult = {
  sent: boolean;
  reason?: "invalid_recipient" | "provider_rejected" | "not_configured";
  providerStatus?: number;
  providerId?: string;
};

function emailRecipients(value: string) {
  return Array.from(new Set(String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []));
}

function emailSender(value: string | undefined) {
  return String(value || "").trim().replace(/^["']+|["']+$/g, "");
}

async function sendEmail(input: EmailInput) {
  const from = emailSender(process.env.EMRN_EMAIL_FROM);
  if (process.env.RESEND_API_KEY && from) {
    const recipients = emailRecipients(input.to);
    const replyTo = emailRecipients(process.env.EMRN_EMAIL_REPLY_TO || "")[0];
    if (!recipients.length) {
      console.error("[EMRN Assistant] Email skipped because no valid recipient was found.", {
        to: input.to,
        subject: input.subject,
      });
      return { sent: false, reason: "invalid_recipient" } satisfies EmailDeliveryResult;
    }

    const idempotencyKey = `emrn-pulse-${crypto.randomUUID()}`;
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let response: Response;
      try {
        response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            from,
            to: recipients,
            subject: input.subject,
            text: input.text,
            ...(replyTo ? { reply_to: replyTo } : {}),
          }),
          signal: AbortSignal.timeout(10000),
        });
      } catch (error) {
        console.error("[EMRN Assistant] Email provider request failed.", {
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
          from,
          to: recipients,
          subject: input.subject,
        });
        if (attempt === 0) continue;
        return { sent: false, reason: "provider_rejected" } satisfies EmailDeliveryResult;
      }

      if (response.ok) {
        const body = await response.json().catch(() => null) as { id?: string } | null;
        console.log("[EMRN Assistant] Email provider accepted", {
          id: body?.id || "unknown",
          to: recipients,
          subject: input.subject,
        });
        return { sent: true, providerId: body?.id } satisfies EmailDeliveryResult;
      }

      lastStatus = response.status;
      const body = await response.text().catch(() => "");
      console.error("[EMRN Assistant] Email provider rejected message.", {
        attempt: attempt + 1,
        status: response.status,
        body: body.slice(0, 500),
        from,
        to: recipients,
        subject: input.subject,
      });
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue;
      return { sent: false, reason: "provider_rejected", providerStatus: response.status } satisfies EmailDeliveryResult;
    }

    return { sent: false, reason: "provider_rejected", providerStatus: lastStatus } satisfies EmailDeliveryResult;
  }

  console.error("[EMRN Assistant] Email provider not configured. Message logged only.", {
    hasApiKey: Boolean(process.env.RESEND_API_KEY),
    hasFrom: Boolean(from),
    to: input.to,
    subject: input.subject,
  });
  return { sent: false, reason: "not_configured" } satisfies EmailDeliveryResult;
}

export async function sendAdminNotificationEmail(input: EmailInput): Promise<EmailDeliveryResult> {
  return sendEmail(input);
}

export async function sendQuoteRequestEmail(request: QuoteRequest): Promise<EmailDeliveryResult> {
  return sendEmail({
    to: quoteEmail,
    subject: "New Quote Request - AI Assistant",
    text: [
      "New quote request from EMRN AI Assistant",
      `Date: ${new Date().toISOString()}`,
      "",
      "Customer information",
      `Name: ${request.name}`,
      `Company: ${request.company || "Not provided"}`,
      `Email: ${request.email}`,
      `Phone: ${request.phone || "Not provided"}`,
      "",
      "Requested products",
      ...request.products.map(
        (item) => `- ${item.quantity} x ${item.name}${item.sku ? ` (${item.sku})` : ""}${item.url ? ` - ${item.url}` : ""}`
      ),
      "",
      "Special notes",
      request.notes || "None",
      "",
      "Conversation",
      ...request.conversation.map((message) => `${message.role.toUpperCase()}: ${message.content}`),
    ].join("\n"),
  });
}

export async function sendSupportEmail(request: SupportRequest): Promise<EmailDeliveryResult> {
  const summary = request.summary;
  return sendEmail({
    to: supportEmail,
    subject: "New Support Request - AI Assistant",
    text: [
      "New support request from EMRN AI Assistant",
      `Date: ${new Date().toISOString()}`,
      "",
      "Customer information",
      `Name: ${request.name}`,
      `Email: ${request.email}`,
      `Phone: ${request.phone || "Not provided"}`,
      "",
      "Question",
      request.question,
      "",
      "Internal summary",
      `Category: ${request.category || "other"}`,
      `Customer question: ${summary?.customerQuestion || request.question}`,
      `Product/SKU/page: ${summary?.productContext || "Not captured"}`,
      `EMRN data found: ${summary?.emrnDataFound || "Not captured"}`,
      `Web/manufacturer result: ${summary?.externalDataFound || "Not used or not captured"}`,
      `Confidence: ${summary?.confidence || "unknown"}`,
      ...(request.attachments?.length
        ? [
            "",
            "Attachments",
            ...request.attachments.map((attachment) =>
              `- ${attachment.kind || "photo"}: ${attachment.fileName || attachment.storagePath || "uploaded file"}${attachment.url ? ` - ${attachment.url}` : ""}`
            ),
          ]
        : []),
      ...(summary?.transcriptSnippet?.length
        ? ["", "Transcript snippet", ...summary.transcriptSnippet]
        : []),
      "",
      "Conversation",
      ...request.conversation.map((message) => `${message.role.toUpperCase()}: ${message.content}`),
    ].join("\n"),
  });
}

export async function sendQuoteLinkEmail(input: { to: string; quoteNumber: string; checkoutUrl: string; language: "en" | "fr" | "unknown" }) {
  return sendEmail({
    to: input.to,
    subject: `EMRN Quote ${input.quoteNumber} Payment Link`,
    text:
      input.language === "fr"
        ? [
            `Bonjour,`,
            "",
            `Voici le lien de paiement sécurisé pour le devis ${input.quoteNumber}:`,
            input.checkoutUrl,
            "",
            "Si vous avez des questions, répondez à ce courriel ou contactez EMRN.",
          ].join("\n")
        : [
            "Hello,",
            "",
            `Here is the secure payment link for quote ${input.quoteNumber}:`,
            input.checkoutUrl,
            "",
            "If you have any questions, reply to this email or contact EMRN.",
          ].join("\n"),
  });
}

export async function sendOrderStatusEmail(request: OrderStatusRequest): Promise<EmailDeliveryResult> {
  return sendEmail({
    to: orderStatusEmail,
    subject: `Order Status Request - ${request.orderNumber}`,
    text: [
      "New order status request from EMRN AI Assistant",
      `Date: ${new Date().toISOString()}`,
      "",
      "Customer information",
      `Name: ${request.name || "Not provided"}`,
      `Email: ${request.email}`,
      `Order number: ${request.orderNumber}`,
      "",
      "Requested action",
      "Customer is looking for an update/tracking information for this order. If tracking is available, please send it to the customer. If not, please follow up with the order status.",
      "",
      "Conversation",
      ...request.conversation.map((message) => `${message.role.toUpperCase()}: ${message.content}`),
    ].join("\n"),
  });
}

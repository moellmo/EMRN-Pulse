import type { OrderStatusRequest, QuoteRequest, SupportRequest } from "./types";

const supportEmail = process.env.EMRN_SUPPORT_EMAIL || "moshe@emrn.ca";
const quoteEmail = process.env.EMRN_QUOTE_EMAIL || "moshe@emrn.ca";
const orderStatusEmail = process.env.EMRN_ORDER_STATUS_EMAIL || "support@emrn.ca";

type EmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
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
            ...(input.html ? { html: input.html } : {}),
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

function escapeHtml(value: string) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function receiptEmailHtml(input: {
  title: string;
  greeting: string;
  intro: string;
  detailTitle?: string;
  detailHtml?: string;
  closing: string;
}) {
  const publicSiteUrl = String(process.env.EMRN_PUBLIC_SITE_URL || "https://emrn-pulse-ih1i.vercel.app").replace(/\/+$/, "");
  const meriLogo = `${publicSiteUrl}/emrn-pulse/meri-avatar.png`;
  const emrnLogo = `${publicSiteUrl}/emrn-pulse/emrn-logo.jpg`;
  const detail = input.detailHtml
    ? `<tr><td style="padding:0 32px 24px;"><div style="border:1px solid #e8e3e0;border-radius:10px;background:#fffaf9;padding:18px 20px;"><p style="margin:0 0 10px;color:#5b4c4d;font:600 13px Arial,sans-serif;letter-spacing:.04em;text-transform:uppercase;">${escapeHtml(input.detailTitle || "Details")}</p>${input.detailHtml}</div></td></tr>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f5f3f2;color:#302b2d;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f5f3f2;"><tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(41,25,29,.12);">
      <tr><td style="background:#ffffff;border-bottom:5px solid #c94f52;padding:16px 32px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
        <td valign="middle"><img src="${escapeHtml(emrnLogo)}" width="255" alt="EMRN Medical Supplies" style="display:block;max-width:255px;height:auto;border:0;"></td>
        <td align="right" valign="middle"><img src="${escapeHtml(meriLogo)}" width="44" height="44" alt="Meri, EMRN assistant" style="display:block;border:0;border-radius:50%;background:#fff;"></td>
      </tr></table></td></tr>
      <tr><td style="padding:32px 32px 14px;"><p style="margin:0 0 12px;color:#c94f52;font:600 13px Arial,sans-serif;letter-spacing:.07em;text-transform:uppercase;">Meri from EMRN</p><h1 style="margin:0;color:#302b2d;font-size:25px;line-height:1.25;">${escapeHtml(input.title)}</h1></td></tr>
      <tr><td style="padding:4px 32px 24px;"><p style="margin:0 0 14px;font-size:16px;line-height:1.55;">${escapeHtml(input.greeting)}</p><p style="margin:0;font-size:16px;line-height:1.55;">${escapeHtml(input.intro)}</p></td></tr>
      ${detail}
      <tr><td style="padding:0 32px 32px;"><p style="margin:0;color:#514849;font-size:15px;line-height:1.55;">${escapeHtml(input.closing)}</p></td></tr>
      <tr><td style="border-top:1px solid #ece8e6;padding:20px 32px;color:#766d6e;font-size:12px;line-height:1.5;">EMRN Medical Supplies &middot; Equipment Medical Rive Nord<br><a href="https://emrn.ca" style="color:#c94f52;text-decoration:underline;">emrn.ca</a></td></tr>
    </table>
  </td></tr></table>
</body></html>`;
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

export async function sendQuoteRequestReceiptEmail(request: QuoteRequest): Promise<EmailDeliveryResult> {
  const isFrench = request.language === "fr";
  const productsText = request.products.map((item) => `- ${item.quantity} x ${item.name}${item.sku ? ` (SKU ${item.sku})` : ""}`).join("\n");
  const productsHtml = `<ul style="margin:0;padding-left:20px;color:#302b2d;font-size:15px;line-height:1.6;">${request.products.map((item) => `<li>${escapeHtml(`${item.quantity} x ${item.name}${item.sku ? ` (SKU ${item.sku})` : ""}`)}</li>`).join("")}</ul>`;
  return sendEmail({
    to: request.email,
    subject: isFrench ? "EMRN — demande de devis reçue" : "EMRN — Quote request received",
    text: isFrench
      ? [
          `Bonjour ${request.name},`,
          "",
          "Nous avons reçu votre demande de devis et notre équipe la révisera sous peu.",
          "",
          "Articles demandés:",
          productsText,
          "",
          "Si vous devez ajouter une quantité, un SKU, une photo ou une échéance, répondez directement à ce courriel.",
          "",
          "Merci,",
          "EMRN Medical Supplies",
        ].join("\n")
      : [
          `Hello ${request.name},`,
          "",
          "We received your quote request and our team will review it shortly.",
          "",
          "Requested items:",
          productsText,
          "",
          "If you need to add a quantity, SKU, photo, or deadline, reply directly to this email.",
          "",
          "Thank you,",
          "EMRN Medical Supplies",
        ].join("\n"),
    html: receiptEmailHtml({
      title: isFrench ? "Demande de devis reçue" : "Quote request received",
      greeting: isFrench ? `Bonjour ${request.name},` : `Hello ${request.name},`,
      intro: isFrench
        ? "Nous avons reçu votre demande de devis. Notre équipe la révisera sous peu."
        : "We received your quote request. Our team will review it shortly.",
      detailTitle: isFrench ? "Articles demandés" : "Requested items",
      detailHtml: productsHtml,
      closing: isFrench
        ? "Pour ajouter une quantité, un SKU, une photo ou une échéance, répondez directement à ce courriel."
        : "To add a quantity, SKU, photo, or deadline, reply directly to this email.",
    }),
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

export async function sendSupportReceiptEmail(request: SupportRequest): Promise<EmailDeliveryResult> {
  const isFrench = request.language === "fr";
  const question = String(request.question || "").replace(/\s+/g, " ").trim().slice(0, 700);
  return sendEmail({
    to: request.email,
    subject: isFrench ? "EMRN — demande de soutien reçue" : "EMRN — Support request received",
    text: isFrench
      ? [
          `Bonjour ${request.name},`,
          "",
          "Nous avons reçu votre demande de soutien et notre équipe la révisera sous peu.",
          question ? `Résumé: ${question}` : "",
          "",
          "Vous pouvez répondre directement à ce courriel pour ajouter des détails, un numéro de commande, un SKU ou des photos.",
          "",
          "Merci,",
          "EMRN Medical Supplies",
        ].filter(Boolean).join("\n")
      : [
          `Hello ${request.name},`,
          "",
          "We received your support request and our team will review it shortly.",
          question ? `Summary: ${question}` : "",
          "",
          "Reply directly to this email if you need to add details, an order number, SKU, or photos.",
          "",
          "Thank you,",
          "EMRN Medical Supplies",
        ].filter(Boolean).join("\n"),
    html: receiptEmailHtml({
      title: isFrench ? "Demande de soutien reçue" : "Support request received",
      greeting: isFrench ? `Bonjour ${request.name},` : `Hello ${request.name},`,
      intro: isFrench
        ? "Nous avons reçu votre demande de soutien. Notre équipe la révisera sous peu."
        : "We received your support request. Our team will review it shortly.",
      ...(question
        ? {
            detailTitle: isFrench ? "Votre demande" : "Your request",
            detailHtml: `<p style="margin:0;color:#302b2d;font-size:15px;line-height:1.6;">${escapeHtml(question)}</p>`,
          }
        : {}),
      closing: isFrench
        ? "Pour ajouter des détails, un numéro de commande, un SKU ou des photos, répondez directement à ce courriel."
        : "To add details, an order number, SKU, or photos, reply directly to this email.",
    }),
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

import type { OrderStatusRequest, QuoteRequest, SupportRequest } from "./types";

const supportEmail = process.env.EMRN_SUPPORT_EMAIL || "moshe@emrn.ca";
const quoteEmail = process.env.EMRN_QUOTE_EMAIL || "moshe@emrn.ca";
const orderStatusEmail = process.env.EMRN_ORDER_STATUS_EMAIL || "support@emrn.ca";

type EmailInput = {
  to: string;
  subject: string;
  text: string;
};

async function sendEmail(input: EmailInput) {
  if (process.env.RESEND_API_KEY && process.env.EMRN_EMAIL_FROM) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMRN_EMAIL_FROM,
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Email provider failed: ${response.status} ${await response.text()}`);
    }

    return;
  }

  console.warn("[EMRN Assistant] Email provider not configured. Message logged only.", input);
}

export async function sendQuoteRequestEmail(request: QuoteRequest) {
  await sendEmail({
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

export async function sendSupportEmail(request: SupportRequest) {
  await sendEmail({
    to: supportEmail,
    subject: "New Support Request - AI Assistant",
    text: [
      "New support request from EMRN AI Assistant",
      `Date: ${new Date().toISOString()}`,
      "",
      "Customer information",
      `Name: ${request.name}`,
      `Email: ${request.email}`,
      "",
      "Question",
      request.question,
      "",
      "Conversation",
      ...request.conversation.map((message) => `${message.role.toUpperCase()}: ${message.content}`),
    ].join("\n"),
  });
}

export async function sendOrderStatusEmail(request: OrderStatusRequest) {
  await sendEmail({
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

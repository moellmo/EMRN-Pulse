# EMRN Pulse

Standalone AI customer assistant for EMRN Medical Supplies.

## What It Uses

- Next.js
- TypeScript
- Tailwind CSS
- OpenAI Responses API
- Typesense product search
- BigCommerce MCP cart/checkout
- BigCommerce Orders API for order status/tracking
- Grit Global BackOrder API for customer-facing availability
- Resend for quote/support/order-status emails

This project is separate from EMRN SmartSearch. It reads the same Typesense and BigCommerce data through environment variables, but it does not modify or replace the existing search UI.

## Local Dev

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open:

- `http://localhost:3000/ai-assistant`
- Widget page: `http://localhost:3000/ai-assistant-widget`
- Embed script: `http://localhost:3000/emrn-pulse-widget.js`

## Vercel

1. Import this repo into Vercel.
2. Add the variables from `.env.example` in Vercel Project Settings.
3. Deploy.
4. Copy the deployment URL.

## BigCommerce Script Manager

Add this in BigCommerce Script Manager after Vercel deploy:

```html
<script src="https://YOUR-VERCEL-DOMAIN.vercel.app/emrn-pulse-widget.js" defer></script>
```

Recommended settings:

- Location: Footer
- Pages: All pages
- Script type: Script

## Order Status Flow

Meri asks for order number and email. The server verifies the email against BigCommerce before showing tracking. If tracking is not available, or the order cannot be verified automatically, an email is sent to `EMRN_ORDER_STATUS_EMAIL`.


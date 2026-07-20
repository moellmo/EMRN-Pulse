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

## Admin And Usage Logs

Open the admin page at:

- Local: `http://localhost:3000/ai-assistant-admin`
- Production: `https://YOUR-VERCEL-DOMAIN.vercel.app/ai-assistant-admin`

The admin page shows conversation metrics, product searches, no-result searches, quote requests, support escalations, and AI usage/cost estimates.

Pulse always writes local JSONL logs under `.data/assistant` when the filesystem is available. To mirror logs into Google Sheets, create a Google Sheet, then open Extensions > Apps Script and paste this script:

```js
const SECRET = "replace-with-a-long-secret";

function doPost(e) {
  const providedSecret = e?.parameter?.secret || e?.headers?.["X-EMRN-Pulse-Secret"];
  if (SECRET && providedSecret !== SECRET) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "unauthorized" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const payload = JSON.parse(e.postData.contents || "{}");
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = payload.kind || "analytics";
  const sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
  const row = payload.row || {};
  const headers = Object.keys(row);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  }

  const existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const missingHeaders = headers.filter((header) => !existingHeaders.includes(header));
  if (missingHeaders.length) {
    sheet.getRange(1, existingHeaders.length + 1, 1, missingHeaders.length).setValues([missingHeaders]);
  }

  const finalHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.appendRow(finalHeaders.map((header) => {
    const value = row[header];
    return typeof value === "object" && value !== null ? JSON.stringify(value) : value ?? "";
  }));

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

Deploy the Apps Script as a Web App with access set to “Anyone with the link”. Add these Vercel environment variables:

```env
EMRN_GOOGLE_SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec?secret=replace-with-a-long-secret
EMRN_GOOGLE_SHEETS_WEBHOOK_SECRET=replace-with-a-long-secret
```

The sheet will receive separate tabs named `analytics`, `quote`, `support`, and `ai_usage`.

To test the connection after deploy, open:

```text
https://YOUR-VERCEL-DOMAIN.vercel.app/api/assistant/admin/sheets-test?token=YOUR_ADMIN_TOKEN
```

Expected success response:

```json
{ "configured": true, "ok": true, "status": 200, "body": "{\"ok\":true}" }
```

If it fails:

- `configured: false` means `EMRN_GOOGLE_SHEETS_WEBHOOK_URL` is missing in Vercel.
- `status: 401` or a body containing `unauthorized` usually means the Apps Script secret and Vercel secret do not match.
- A Google HTML/error body usually means the Apps Script web app was not deployed with access set to “Anyone with the link”.
- After changing Apps Script code, deploy a new web-app version and update/reuse the deployment URL.

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

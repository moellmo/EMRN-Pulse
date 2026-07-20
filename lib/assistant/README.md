# EMRN Pulse Assistant

This folder is intentionally separate from SmartSearch storefront code.

## Structure

- `catalog.ts` wraps read-only Typesense product search and guarded BigCommerce cart creation.
- `bigcommerce-mcp.ts` contains the optional BigCommerce MCP connector.
- `prompt.ts` contains Meri's personality, quote-only rules, safety rules, and FAQ/policy context.
- `openai.ts` calls the OpenAI Responses API with streaming output.
- `intent.ts` handles low-cost deterministic routing for quote, support, and medical-advice flows.
- `email.ts` sends quote/support emails when `RESEND_API_KEY` and `EMRN_EMAIL_FROM` are configured.
- `analytics.ts` logs assistant metrics, quote requests, and support escalations to `.data/assistant`.
- `types.ts` defines reusable contracts for current and future assistant tools.

## Routes

- `/api/assistant/chat` streams customer-facing assistant replies.
- `/api/assistant/cart` creates guarded BigCommerce carts and blocks quote-only products.
- `/api/assistant/admin` exposes metrics, quote logs, and support logs.
- `/ai-assistant` is the customer chat UI.
- `/ai-assistant-admin` is the internal viewer.

## Future Tool Slots

Buyer Portal and BigCommerce MCP placeholders live in `catalog.ts` so future tools can be wired without changing prompt or UI contracts:

- company pricing
- company orders
- saved quotes
- invoice lookup
- user management
- purchase history
- BigCommerce MCP actions

## BigCommerce MCP

Set `BIGCOMMERCE_MCP_URL` to the storefront MCP endpoint from the BigCommerce control panel.

Optional:

- `BIGCOMMERCE_CART_PROVIDER=mcp` uses MCP for cart creation when available.
- Leave it unset to use the existing BigCommerce REST cart fallback.
- `/api/assistant/mcp-status` verifies MCP configuration and discovered tools.

Live EMRN MCP tools checked on 2026-07-20:

- `search_products`
- `get_product_details`
- `add_item_to_cart`
- `update_cart_item`
- `remove_item_from_cart`
- `create_checkout_url`

That means normal purchasable products can use MCP cart and checkout now. Logged-in customer account access, business order information, invoices, saved shipping information, B2B quote tools, company pricing, and Buyer Portal data are not exposed by the current MCP tool list and should stay behind explicit future authenticated tool contracts.

Guest/non-business flow:

- Purchasable catalog items can go to cart/checkout through MCP when configured.
- Quote-only products are blocked from cart and moved into quote request.

## Grit Global BackOrder Availability

Set these to use Grit BackOrder for customer-facing stock messages:

- `GRIT_BACKORDER_API_BASE_URL=https://api.grit.software/polar-bear/external/v0/`
- `GRIT_BACKORDER_API_KEY=...`
- Optional: `GRIT_BACKORDER_PRODUCTS_PATH=/backorder-products`
- Optional: `GRIT_LOW_STOCK_THRESHOLD=3`

The assistant maps Grit statuses like this:

- `in_stock` -> `In stock. Typically ships within 1-3 business days.`
- `backorder` -> `Available to order. Extended lead time — typically 5-9 business days.`
- `out_of_stock` -> `Currently unavailable to order online.`
- `in_stock` with stock at or below `GRIT_LOW_STOCK_THRESHOLD` -> `Low stock. Order soon.`

Backorder does not block checkout by itself. If a product is purchasable online and not quote-only, Meri can still create a cart/checkout link and explain the extended lead time.

B2B/company flow:

- Bulk pricing, purchase orders, company pricing, saved quotes, and Buyer Portal requests route to quote/support until authenticated tools are available.

## Cost Controls

- Typesense search runs before OpenAI generation.
- No extra vector database or paid helpdesk dependency is required.
- Conversations stay client-side unless a quote or support escalation is submitted.
- `OPENAI_ASSISTANT_MODEL` controls assistant model cost and stays separate from SmartSearch.
- SmartSearch translation uses `OPENAI_SEARCH_TRANSLATOR_MODEL`, so changing the assistant model does not affect search.

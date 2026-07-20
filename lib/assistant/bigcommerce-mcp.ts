import type { CartRequest, CartResult, CommerceToolStatus } from "./types";

const mcpUrl = process.env.BIGCOMMERCE_MCP_URL;
let mcpSessionId: string | null = null;

type McpToolResponse = {
  result?: unknown;
  error?: {
    message?: string;
  };
};

type McpTool = {
  name: string;
  description?: string;
};

type McpResponse<T> = {
  result?: T;
  error?: {
    message?: string;
  };
};

const toolNameCache = new Map<string, { value: string | null; expiresAt: number }>();

async function postMcp<T>(method: string, params?: Record<string, unknown>, includeSession = true) {
  const response = await fetch(mcpUrl!, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream, application/jsonl",
      ...(includeSession && mcpSessionId ? { "Mcp-Session-Id": mcpSessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method,
      ...(params ? { params } : {}),
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`BigCommerce MCP request failed with status ${response.status}.`);
  }

  const sessionId = response.headers.get("Mcp-Session-Id");
  if (sessionId) mcpSessionId = sessionId;

  const text = await response.text();
  return parseMcpResponse<T>(text);
}

function parseMcpResponse<T>(text: string): McpResponse<T> {
  const trimmed = text.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const dataLines = trimmed
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line && line !== "[DONE]");
    const lastJson = dataLines.at(-1);
    return lastJson ? JSON.parse(lastJson) : {};
  }

  const lines = trimmed.split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1) || trimmed);
}

async function initializeMcp() {
  if (mcpSessionId) return;
  await postMcp("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {
      name: "emrn-pulse-assistant",
      version: "1.0.0",
    },
  }, false).catch(() => null);
}

async function listMcpTools() {
  await initializeMcp();
  const response = await postMcp<{ tools?: McpTool[] }>("tools/list");
  if (response.error) throw new Error(response.error.message || "BigCommerce MCP tools/list failed.");
  return response.result?.tools || [];
}

async function resolveToolName(kind: "cart" | "product-search") {
  const cached = toolNameCache.get(kind);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const tools = await listMcpTools();
  const candidates =
    kind === "cart"
      ? [/add.*item.*cart/i, /add.*cart/i, /create.*cart/i, /cart/i]
      : [/search.*product/i, /product.*search/i, /catalog/i];

  const tool =
    tools.find((item) => candidates.some((pattern) => pattern.test(item.name))) ||
    tools.find((item) => candidates.some((pattern) => pattern.test(item.description || "")));
  const value = tool?.name || null;

  toolNameCache.set(kind, { value, expiresAt: Date.now() + 1000 * 60 * 10 });
  return value;
}

async function resolveCheckoutToolName() {
  const tools = await listMcpTools();
  return tools.find((item) => /create.*checkout.*url/i.test(item.name) || /checkout.*url/i.test(item.name))?.name || null;
}

function normalizeMcpCartResult(data: unknown): CartResult {
  const record = unwrapMcpToolData(data);
  const nested = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : record;
  const structuredContent =
    nested.structuredContent && typeof nested.structuredContent === "object"
      ? (nested.structuredContent as Record<string, unknown>)
      : {};
  const cart = structuredContent.cart && typeof structuredContent.cart === "object"
    ? (structuredContent.cart as Record<string, unknown>)
    : {};
  const redirectUrls =
    nested.redirect_urls && typeof nested.redirect_urls === "object"
      ? (nested.redirect_urls as Record<string, unknown>)
      : {};

  return {
    cartId: String(nested.id || nested.cartId || cart.entityId || cart.id || ""),
    checkoutUrl: String(
      structuredContent.checkoutURL ||
        structuredContent.checkoutUrl ||
        nested.checkoutURL ||
        nested.checkoutUrl ||
        nested.checkout_url ||
        redirectUrls.checkout_url ||
        redirectUrls.cart_url ||
        ""
    ),
    blockedItems: [],
    provider: "bigcommerce-mcp",
  };
}

function unwrapMcpToolData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const record = data as Record<string, unknown>;

  if (record.structuredContent && typeof record.structuredContent === "object") return record;

  const content = Array.isArray(record.content) ? record.content : [];
  const textItem = content.find(
    (item): item is { type?: string; text?: string } =>
      !!item && typeof item === "object" && (item as { type?: string }).type === "text"
  );

  if (textItem?.text) {
    try {
      const parsed = JSON.parse(textItem.text);
      if (parsed && typeof parsed === "object") {
        return {
          ...record,
          structuredContent: record.structuredContent || parsed,
          ...(parsed as Record<string, unknown>),
        };
      }
    } catch {
      return record;
    }
  }

  return record;
}

async function callBigCommerceMcpTool(
  toolNameOrKind: string,
  args: Record<string, unknown>,
  kind?: "cart" | "product-search"
) {
  if (!mcpUrl) {
    return {
      available: false,
      source: "bigcommerce-mcp" as const,
      message: "BigCommerce MCP is not configured. Set BIGCOMMERCE_MCP_URL.",
    };
  }

  try {
    const toolName = kind ? await resolveToolName(kind) : toolNameOrKind;
    if (!toolName) {
      return {
        available: false,
        source: "bigcommerce-mcp" as const,
        message: `No BigCommerce MCP ${kind || toolNameOrKind} tool was discovered.`,
      };
    }

    await initializeMcp();
    const payload = await postMcp<McpToolResponse>("tools/call", {
      name: toolName,
      arguments: args,
    });

    if (payload?.error) {
      return {
        available: false,
        source: "bigcommerce-mcp" as const,
        message: payload.error.message || "BigCommerce MCP returned an error.",
      };
    }

    return {
      available: true,
      source: "bigcommerce-mcp" as const,
      data: payload?.result,
    };
  } catch (error) {
    return {
      available: false,
      source: "bigcommerce-mcp" as const,
      message: error instanceof Error ? error.message : "BigCommerce MCP request failed.",
    };
  }
}

export async function mcpCreateCart(input: CartRequest): Promise<CommerceToolStatus<CartResult>> {
  mcpSessionId = null;
  let latestCart: unknown = null;

  for (const item of input.items) {
    const result = await callBigCommerceMcpTool(
      "add_item_to_cart",
      {
        item: {
          quantity: item.quantity,
          productEntityId: item.productId,
          variantEntityId: item.variantId || null,
          selectedOptions: {
            checkboxes: null,
            dateFields: null,
            multiLineTextFields: null,
            multipleChoices: null,
            numberFields: null,
            textFields: null,
          },
        },
      },
      "cart"
    );
    if (!result.available) {
      return {
        available: false,
        source: "bigcommerce-mcp",
        message: result.message,
      };
    }
    latestCart = result.data;
  }

  const checkoutToolName = await resolveCheckoutToolName();
  let checkoutUrl = "";
  if (checkoutToolName) {
    const checkout = await callBigCommerceMcpTool(checkoutToolName, {});
    if (checkout.available) {
      checkoutUrl = normalizeMcpCartResult(checkout.data).checkoutUrl || "";
    }
  }

  const cart = normalizeMcpCartResult(latestCart);
  return {
    available: true,
    source: "bigcommerce-mcp",
    data: {
      ...cart,
      checkoutUrl: checkoutUrl || cart.checkoutUrl,
    },
  };
}

export async function mcpAddToCart(input: CartRequest): Promise<CommerceToolStatus<CartResult>> {
  return mcpCreateCart(input);
}

export async function mcpGetCustomerAccount(): Promise<CommerceToolStatus<null>> {
  return {
    available: false,
    source: "bigcommerce-mcp",
    data: null,
    message:
      "Logged-in customer account tools are not available in the current BigCommerce B2C MCP beta. Use Buyer Portal or BigCommerce customer APIs when available.",
  };
}

export async function mcpGetShippingInfo(): Promise<CommerceToolStatus<null>> {
  return {
    available: false,
    source: "bigcommerce-mcp",
    data: null,
    message:
      "Customer shipping information requires an authenticated account integration. The current BigCommerce B2C MCP beta is guest-shopping focused.",
  };
}

export async function mcpSearchProducts(query: string) {
  return callBigCommerceMcpTool("searchProducts", { query }, "product-search");
}

export async function getBigCommerceMcpStatus() {
  if (!mcpUrl) {
    return {
      configured: false,
      tools: [] as McpTool[],
      message: "Set BIGCOMMERCE_MCP_URL to enable BigCommerce MCP.",
    };
  }

  try {
    const tools = await listMcpTools();
    return {
      configured: true,
      tools,
      cartTool: await resolveToolName("cart"),
      productSearchTool: await resolveToolName("product-search"),
    };
  } catch (error) {
    return {
      configured: true,
      tools: [] as McpTool[],
      message: error instanceof Error ? error.message : "Unable to connect to BigCommerce MCP.",
    };
  }
}

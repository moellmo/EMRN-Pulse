const STORE_HASH = process.env.BIGCOMMERCE_ADMIN_STORE_HASH || process.env.BIGCOMMERCE_STORE_HASH;
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ADMIN_ACCESS_TOKEN || process.env.BIGCOMMERCE_ACCESS_TOKEN;
const CLIENT_ID = process.env.BIGCOMMERCE_ADMIN_CLIENT_ID;
const API_V2_BASE = STORE_HASH ? `https://api.bigcommerce.com/stores/${STORE_HASH}/v2` : "";

export type OrderLookupInput = {
  orderNumber: string;
  email: string;
};

export type OrderLookupResult = {
  available: boolean;
  verified: boolean;
  orderNumber: string;
  status?: string;
  trackingNumbers: string[];
  trackingLinks: string[];
  message?: string;
};

export type RecentOrderProduct = {
  productId: number;
  variantId?: number;
  sku: string;
  name: string;
  quantity: number;
};

export type RecentOrder = {
  orderNumber: string;
  status: string;
  createdAt: string;
  total: number;
  currencyCode: string;
  products: RecentOrderProduct[];
};

export type RecentOrdersResult = {
  available: boolean;
  verified: boolean;
  email: string;
  orders: RecentOrder[];
  message?: string;
};

export type OrderDetailsResult = {
  available: boolean;
  verified: boolean;
  order?: RecentOrder;
  message?: string;
};

type BigCommerceOrder = {
  id?: number;
  status?: string;
  date_created?: string;
  total_inc_tax?: string;
  currency_code?: string;
  billing_address?: {
    email?: string;
  };
};

type BigCommerceOrderProduct = {
  product_id?: number;
  variant_id?: number;
  sku?: string;
  name?: string;
  quantity?: number;
};

type BigCommerceShipment = {
  tracking_number?: string;
  tracking_link?: string;
  tracking_carrier?: string;
};

async function bcFetchV2<T>(path: string): Promise<T> {
  const response = await fetch(`${API_V2_BASE}${path}`, {
    headers: {
      "X-Auth-Token": ACCESS_TOKEN || "",
      ...(CLIENT_ID ? { "X-Auth-Client": CLIENT_ID } : {}),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`BigCommerce orders API failed with status ${response.status}`);
  }

  return response.json();
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeOrderNumber(orderNumber: string) {
  return orderNumber.replace(/^#/, "").trim();
}

export async function getOrderStatus(input: OrderLookupInput): Promise<OrderLookupResult> {
  const orderNumber = normalizeOrderNumber(input.orderNumber);
  if (!API_V2_BASE || !ACCESS_TOKEN) {
    return {
      available: false,
      verified: false,
      orderNumber,
      trackingNumbers: [],
      trackingLinks: [],
      message: "BigCommerce Orders API is not configured.",
    };
  }

  try {
    const order = await bcFetchV2<BigCommerceOrder>(`/orders/${encodeURIComponent(orderNumber)}`);
    const orderEmail = normalizeEmail(order.billing_address?.email || "");

    if (!orderEmail || orderEmail !== normalizeEmail(input.email)) {
      return {
        available: true,
        verified: false,
        orderNumber,
        trackingNumbers: [],
        trackingLinks: [],
        message: "Order email could not be verified.",
      };
    }

    const shipments = await bcFetchV2<BigCommerceShipment[]>(
      `/orders/${encodeURIComponent(orderNumber)}/shipments`
    ).catch(() => []);

    return {
      available: true,
      verified: true,
      orderNumber,
      status: order.status || "Status unavailable",
      trackingNumbers: shipments.map((shipment) => shipment.tracking_number || "").filter(Boolean),
      trackingLinks: shipments.map((shipment) => shipment.tracking_link || "").filter(Boolean),
    };
  } catch (error) {
    return {
      available: true,
      verified: false,
      orderNumber,
      trackingNumbers: [],
      trackingLinks: [],
      message: error instanceof Error ? error.message : "Unable to look up order.",
    };
  }
}

export async function getRecentOrdersByEmail(email: string, limit = 5): Promise<RecentOrdersResult> {
  const normalizedEmail = normalizeEmail(email);
  if (!API_V2_BASE || !ACCESS_TOKEN) {
    return {
      available: false,
      verified: false,
      email: normalizedEmail,
      orders: [],
      message: "BigCommerce Orders API is not configured.",
    };
  }

  try {
    const orders = await bcFetchV2<BigCommerceOrder[]>(
      `/orders?email=${encodeURIComponent(normalizedEmail)}&limit=${Math.min(Math.max(limit, 1), 10)}&page=1&sort=date_created:desc`
    );
    const verifiedOrders = (orders || []).filter(
      (order) => normalizeEmail(order.billing_address?.email || "") === normalizedEmail && order.id
    );

    const recentOrders = await Promise.all(
      verifiedOrders.slice(0, limit).map(async (order) => {
        const products = await bcFetchV2<BigCommerceOrderProduct[]>(
          `/orders/${encodeURIComponent(String(order.id))}/products`
        ).catch(() => []);

        return {
          orderNumber: String(order.id),
          status: order.status || "Status unavailable",
          createdAt: order.date_created || "",
          total: Number(order.total_inc_tax || 0),
          currencyCode: order.currency_code || "CAD",
          products: products.map((product) => ({
            productId: Number(product.product_id || 0),
            variantId: product.variant_id ? Number(product.variant_id) : undefined,
            sku: String(product.sku || ""),
            name: String(product.name || ""),
            quantity: Number(product.quantity || 0),
          })).filter((product) => product.name || product.sku),
        };
      })
    );

    return {
      available: true,
      verified: true,
      email: normalizedEmail,
      orders: recentOrders,
    };
  } catch (error) {
    return {
      available: true,
      verified: false,
      email: normalizedEmail,
      orders: [],
      message: error instanceof Error ? error.message : "Unable to look up recent orders.",
    };
  }
}

export async function getOrderDetails(input: OrderLookupInput): Promise<OrderDetailsResult> {
  const orderNumber = normalizeOrderNumber(input.orderNumber);
  if (!API_V2_BASE || !ACCESS_TOKEN) {
    return {
      available: false,
      verified: false,
      message: "BigCommerce Orders API is not configured.",
    };
  }

  try {
    const order = await bcFetchV2<BigCommerceOrder>(`/orders/${encodeURIComponent(orderNumber)}`);
    const orderEmail = normalizeEmail(order.billing_address?.email || "");
    if (!order.id || !orderEmail || orderEmail !== normalizeEmail(input.email)) {
      return {
        available: true,
        verified: false,
        message: "Order email could not be verified.",
      };
    }

    const products = await bcFetchV2<BigCommerceOrderProduct[]>(
      `/orders/${encodeURIComponent(orderNumber)}/products`
    ).catch(() => []);

    return {
      available: true,
      verified: true,
      order: {
        orderNumber: String(order.id),
        status: order.status || "Status unavailable",
        createdAt: order.date_created || "",
        total: Number(order.total_inc_tax || 0),
        currencyCode: order.currency_code || "CAD",
        products: products.map((product) => ({
          productId: Number(product.product_id || 0),
          variantId: product.variant_id ? Number(product.variant_id) : undefined,
          sku: String(product.sku || ""),
          name: String(product.name || ""),
          quantity: Number(product.quantity || 0),
        })).filter((product) => product.name || product.sku),
      },
    };
  } catch (error) {
    return {
      available: true,
      verified: false,
      message: error instanceof Error ? error.message : "Unable to look up order.",
    };
  }
}

const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH;
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN;
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

type BigCommerceOrder = {
  id?: number;
  status?: string;
  billing_address?: {
    email?: string;
  };
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


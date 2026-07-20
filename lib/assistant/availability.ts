import type { CatalogProduct } from "./types";

const DEFAULT_BACKORDER_PATH = "/backorder-products";
const IN_STOCK_MESSAGE = "In stock. Typically ships within 1-3 business days.";
const BACKORDER_MESSAGE = "Available to order. Extended lead time — typically 5-9 business days.";
const LOW_STOCK_MESSAGE = "Low stock. Order soon.";
const OUT_OF_STOCK_MESSAGE = "Currently unavailable to order online.";

type GritBackorderProduct = {
  product_id?: number;
  variant_id?: number;
  sku?: string;
  stock?: number;
  backorder_status?: "in_stock" | "backorder" | "out_of_stock" | string;
};

type GritBackorderResponse = {
  data?: GritBackorderProduct[];
};

function gritConfig() {
  return {
    baseUrl: process.env.GRIT_BACKORDER_API_BASE_URL?.replace(/\/+$/, "") || "",
    apiKey: process.env.GRIT_BACKORDER_API_KEY || "",
    path: process.env.GRIT_BACKORDER_PRODUCTS_PATH || DEFAULT_BACKORDER_PATH,
    lowStockThreshold: Number(process.env.GRIT_LOW_STOCK_THRESHOLD || 3),
  };
}

function gritMessage(item: GritBackorderProduct, lowStockThreshold: number) {
  const status = String(item.backorder_status || "").toLowerCase();
  const stock = Number(item.stock || 0);

  if (status === "backorder") return BACKORDER_MESSAGE;
  if (status === "out_of_stock") return OUT_OF_STOCK_MESSAGE;
  if (status === "in_stock" && stock > 0 && stock <= lowStockThreshold) return LOW_STOCK_MESSAGE;
  if (status === "in_stock") return IN_STOCK_MESSAGE;

  return "";
}

function normalizedPath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

export async function getBackorderAvailabilityBySku(skus: string[]) {
  const config = gritConfig();
  const uniqueSkus = Array.from(new Set(skus.map((sku) => sku.trim()).filter(Boolean)));
  if (!config.baseUrl || !config.apiKey || !uniqueSkus.length) return new Map<string, string>();

  const url = new URL(`${config.baseUrl}${normalizedPath(config.path)}`);
  url.searchParams.set("skus", uniqueSkus.join(","));
  url.searchParams.set("limit", String(Math.min(uniqueSkus.length, 250)));

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });

    if (!response.ok) return new Map<string, string>();

    const payload = (await response.json()) as GritBackorderResponse;
    const availability = new Map<string, string>();

    for (const item of payload.data || []) {
      const sku = String(item.sku || "").trim();
      const message = gritMessage(item, config.lowStockThreshold);
      if (sku && message) availability.set(sku, message);
    }

    return availability;
  } catch {
    return new Map<string, string>();
  }
}

export async function withBackorderAvailability(products: CatalogProduct[]) {
  const availabilityBySku = await getBackorderAvailabilityBySku(products.map((product) => product.sku));
  if (!availabilityBySku.size) return products;

  return products.map((product) => {
    const availabilityDescription = availabilityBySku.get(product.sku);
    return availabilityDescription ? { ...product, availabilityDescription } : product;
  });
}


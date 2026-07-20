import { getTypesenseSearch } from "../typesense";
import { absoluteStoreUrl, normalizeCommerceUrl } from "../store-url";
import { buildSmartSearchQuery } from "../smart-search-translator";
import { withBackorderAvailability } from "./availability";
import { mcpCreateCart, mcpSearchProducts } from "./bigcommerce-mcp";
import type { CartRequest, CartResult, CatalogProduct, ProductSearchInput } from "./types";

const COLLECTION_NAME = "emrn_products";
const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH;
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN;
const BIGCOMMERCE_API_BASE = STORE_HASH ? `https://api.bigcommerce.com/stores/${STORE_HASH}/v3` : "";

type SearchDocument = Partial<{
  id: string | number;
  product_id: string | number;
  variant_id: string | number;
  name: string;
  parent_name: string;
  sku: string;
  all_skus: unknown[];
  brand: string;
  sold_by: string;
  categories: unknown[];
  description: string;
  price: string | number;
  image: string;
  url: string;
  inventory_level: string | number;
  availability: string;
  availability_description: string;
  purchasable: boolean;
  quote_only: boolean;
  purchase_message: string;
}>;

type SearchHit = {
  document?: SearchDocument;
};

type TypesenseSearchResult = {
  hits?: SearchHit[];
  found?: number;
};

type BigCommerceProduct = Partial<{
  id: number;
  name: string;
  sku: string;
  brand_id: number;
  price: number;
  calculated_price: number;
  inventory_level: number;
  availability: string;
  availability_description: string;
  is_visible: boolean;
  custom_url: {
    url?: string;
  };
  images: Array<{
    url_standard?: string;
    url_thumbnail?: string;
  }>;
  variants: BigCommerceVariant[];
  custom_fields: Array<{
    name?: string;
    value?: string;
  }>;
}>;

type BigCommerceVariant = Partial<{
  id: number;
  product_id: number;
  sku: string;
  price: number;
  calculated_price: number;
  inventory_level: number;
  purchasing_disabled: boolean;
  option_values: Array<{
    label?: string;
    option_display_name?: string;
  }>;
}>;

function hitDocument(hit: SearchHit | SearchDocument): SearchDocument {
  if ("document" in hit) return hit.document || {};
  return hit as SearchDocument;
}

function mapProduct(hit: SearchHit | SearchDocument): CatalogProduct {
  const doc = hitDocument(hit);
  return {
    id: String(doc.id || ""),
    productId: Number(doc.product_id || 0),
    variantId: Number(doc.variant_id || 0),
    name: String(doc.name || ""),
    parentName: String(doc.parent_name || doc.name || ""),
    sku: String(doc.sku || ""),
    brand: String(doc.brand || ""),
    manufacturer: String(doc.sold_by || ""),
    categories: Array.isArray(doc.categories) ? doc.categories.map(String) : [],
    description: String(doc.description || ""),
    price: Number(doc.price || 0),
    image: String(doc.image || ""),
    url: absoluteStoreUrl(doc.url),
    inventoryLevel: Number(doc.inventory_level || 0),
    availability: String(doc.availability || ""),
    availabilityDescription: String(doc.availability_description || ""),
    purchasable: Boolean(doc.purchasable),
    quoteOnly: Boolean(doc.quote_only),
    purchaseAction: doc.quote_only ? "quote_only" : "cart",
    purchaseMessage: String(doc.purchase_message || ""),
  };
}

function productFilter(input: ProductSearchInput) {
  const filters = ["is_visible:=true"];
  if (input.filters?.brand) filters.push(`brand:=${JSON.stringify(input.filters.brand)}`);
  if (input.filters?.category) filters.push(`categories:=${JSON.stringify(input.filters.category)}`);
  if (input.filters?.manufacturer) filters.push(`sold_by:=${JSON.stringify(input.filters.manufacturer)}`);
  return filters.join(" && ");
}

function normalizeSku(value: string) {
  return String(value || "").replace(/[^a-z0-9+]/gi, "").toUpperCase();
}

function skuValuesForDocument(doc: SearchDocument) {
  return [doc.sku, ...(Array.isArray(doc.all_skus) ? doc.all_skus : [])]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function skuSearchVariants(sku: string) {
  const clean = String(sku || "").trim().toUpperCase();
  const compact = clean.replace(/\s+/g, "");
  const spaced = compact.replace(/^([A-Z]+)(\d+)$/, "$1 $2");
  return Array.from(new Set([clean, compact, spaced].filter(Boolean)));
}

function bigCommerceHeaders() {
  return {
    "X-Auth-Token": ACCESS_TOKEN || "",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function bigCommerceGet<T>(path: string, params?: Record<string, string | number | undefined>) {
  if (!BIGCOMMERCE_API_BASE || !ACCESS_TOKEN) return null;

  const url = new URL(`${BIGCOMMERCE_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }

  try {
    const response = await fetch(url, {
      headers: bigCommerceHeaders(),
      cache: "no-store",
    });
    if (!response.ok) {
      console.error("[EMRN Pulse] BigCommerce catalog request failed", response.status, path);
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error("[EMRN Pulse] BigCommerce catalog request failed", error);
    return null;
  }
}

function isQuoteOnlyFromBigCommerce(product: BigCommerceProduct) {
  const text = [
    product.availability,
    product.availability_description,
    ...(product.custom_fields || []).flatMap((field) => [field.name, field.value]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return /contact\s+us\s+for\s+quote|request\s+a\s+quote|quote\s+only|requires?\s+a\s+quote/.test(text);
}

function mapBigCommerceProduct(product: BigCommerceProduct, variant?: BigCommerceVariant): CatalogProduct {
  const quoteOnly = isQuoteOnlyFromBigCommerce(product);
  const variantLabel = (variant?.option_values || [])
    .map((option) => [option.option_display_name, option.label].filter(Boolean).join(": "))
    .filter(Boolean)
    .join(", ");
  const name = [product.name, variantLabel].filter(Boolean).join(" - ");
  const sku = String(variant?.sku || product.sku || "");

  return {
    id: String(variant?.id || product.id || ""),
    productId: Number(product.id || variant?.product_id || 0),
    variantId: Number(variant?.id || 0),
    name: String(name || product.name || ""),
    parentName: String(product.name || name || ""),
    sku,
    brand: "",
    manufacturer: "",
    categories: [],
    description: "",
    price: Number(variant?.calculated_price || variant?.price || product.calculated_price || product.price || 0),
    image: String(product.images?.[0]?.url_standard || product.images?.[0]?.url_thumbnail || ""),
    url: absoluteStoreUrl(product.custom_url?.url),
    inventoryLevel: Number(variant?.inventory_level ?? product.inventory_level ?? 0),
    availability: String(product.availability || ""),
    availabilityDescription: String(product.availability_description || ""),
    purchasable: Boolean(product.is_visible !== false && !variant?.purchasing_disabled && !quoteOnly),
    quoteOnly,
    purchaseAction: quoteOnly ? "quote_only" : "cart",
    purchaseMessage: quoteOnly ? "This item requires a quotation from our sales team." : "",
  };
}

async function searchBigCommerceBySKU(sku: string) {
  const normalized = normalizeSku(sku);
  const products = new Map<string, CatalogProduct>();

  for (const variant of skuSearchVariants(sku)) {
    const productPayload = await bigCommerceGet<{ data?: BigCommerceProduct[] }>("/catalog/products", {
      sku: variant,
      include: "variants,images,custom_fields",
      is_visible: "true",
      limit: 10,
    });
    for (const product of productPayload?.data || []) {
      if (normalizeSku(String(product.sku || "")) === normalized) {
        const mapped = mapBigCommerceProduct(product);
        products.set(`${mapped.productId}:${mapped.variantId}:${mapped.sku}`, mapped);
      }
      for (const productVariant of product.variants || []) {
        if (normalizeSku(String(productVariant.sku || "")) === normalized) {
          const mapped = mapBigCommerceProduct(product, productVariant);
          products.set(`${mapped.productId}:${mapped.variantId}:${mapped.sku}`, mapped);
        }
      }
    }

    const variantPayload = await bigCommerceGet<{ data?: BigCommerceVariant[] }>("/catalog/variants", {
      sku: variant,
      limit: 10,
    });
    for (const productVariant of variantPayload?.data || []) {
      if (normalizeSku(String(productVariant.sku || "")) !== normalized || !productVariant.product_id) continue;
      const productPayloadById = await bigCommerceGet<{ data?: BigCommerceProduct }>(
        `/catalog/products/${productVariant.product_id}`,
        { include: "variants,images,custom_fields" }
      );
      if (!productPayloadById?.data) continue;
      const fullVariant =
        productPayloadById.data.variants?.find((item) => Number(item.id) === Number(productVariant.id)) || productVariant;
      const mapped = mapBigCommerceProduct(productPayloadById.data, fullVariant);
      products.set(`${mapped.productId}:${mapped.variantId}:${mapped.sku}`, mapped);
    }
  }

  return withBackorderAvailability(Array.from(products.values()));
}

async function searchBigCommerceProducts(query: string, limit = 6) {
  const payload = await bigCommerceGet<{ data?: BigCommerceProduct[] }>("/catalog/products", {
    keyword: query,
    include: "variants,images,custom_fields",
    is_visible: "true",
    limit: Math.min(Math.max(limit, 1), 12),
  });

  const mapped = (payload?.data || []).flatMap((product) => {
    const variantsWithSkus = (product.variants || []).filter((variant) => variant.sku);
    if (!variantsWithSkus.length) return [mapBigCommerceProduct(product)];
    return variantsWithSkus.slice(0, 4).map((variant) => mapBigCommerceProduct(product, variant));
  });

  return withBackorderAvailability(mapped.slice(0, limit));
}

async function searchBySKUFallback(sku: string) {
  const normalized = normalizeSku(sku);
  const keywordMatches = await searchBigCommerceProducts(sku, 12);
  return keywordMatches.filter((product) => normalizeSku(product.sku) === normalized);
}

export async function searchProducts(input: ProductSearchInput) {
  const smartQuery = await buildSmartSearchQuery(input.query);
  let result: TypesenseSearchResult = {};

  try {
    result = (await getTypesenseSearch()
      .collections(COLLECTION_NAME)
      .documents()
      .search({
        q: smartQuery.search_query || input.query || "*",
        query_by:
          "sku,all_skus,name,parent_name,brand,sold_by,categories,variant_label,option_text,search_text,description,custom_fields_text",
        query_by_weights: "40,32,18,14,10,9,8,6,6,4,2,2",
        filter_by: productFilter(input),
        sort_by: "_text_match:desc,popularity_score:desc,product_id:desc",
        per_page: Math.min(Math.max(input.limit || 6, 1), 12),
        num_typos: 2,
        typo_tokens_threshold: 1,
        prefix: true,
      })) as TypesenseSearchResult;
  } catch (error) {
    console.error("[EMRN Pulse] Typesense search failed", error);
  }

  let products = await withBackorderAvailability((result.hits || []).map(mapProduct));
  if (!products.length && input.query && input.query !== "*") {
    products = await searchBigCommerceProducts(smartQuery.search_query || input.query, input.limit || 6);
  }
  if (!products.length && input.query && input.query !== "*") {
    const mcpMatches = await mcpSearchProducts(smartQuery.search_query || input.query);
    if (mcpMatches.available && mcpMatches.data?.length) {
      products = await withBackorderAvailability(mcpMatches.data.slice(0, input.limit || 6));
    }
  }

  return {
    products,
    found: products.length || Number(result.found || 0),
    searchQuery: smartQuery.search_query || input.query,
    language: smartQuery.language,
  };
}

export async function searchBySKU(sku: string) {
  const variants = skuSearchVariants(sku);
  let results: TypesenseSearchResult[] = [];
  try {
    results = (await Promise.all(
      variants.map((variant) =>
        getTypesenseSearch().collections(COLLECTION_NAME).documents().search({
          q: variant,
          query_by: "sku,all_skus",
          query_by_weights: "40,32",
          filter_by: "is_visible:=true",
          sort_by: "_text_match:desc,popularity_score:desc",
          per_page: 6,
          num_typos: 0,
          prefix: false,
        })
      )
    )) as TypesenseSearchResult[];
  } catch (error) {
    console.error("[EMRN Pulse] Typesense SKU search failed", error);
  }
  const normalized = normalizeSku(sku);
  const products = new Map<string, CatalogProduct>();

  for (const result of results) {
    for (const hit of result.hits || []) {
      const doc = hitDocument(hit);
      const isExactSkuMatch = skuValuesForDocument(doc).some((value) => normalizeSku(value) === normalized);
      if (isExactSkuMatch) {
        const product = mapProduct(hit);
        products.set(`${product.productId}:${product.variantId}:${product.sku}`, product);
      }
    }
  }

  const typesenseProducts = await withBackorderAvailability(Array.from(products.values()));
  if (typesenseProducts.length) return typesenseProducts;

  const bigCommerceMatches = await searchBigCommerceBySKU(sku);
  if (bigCommerceMatches.length) return bigCommerceMatches;

  return searchBySKUFallback(sku);
}

export async function getProduct(productId: number, variantId?: number) {
  const filter = [`product_id:=${productId}`, "is_visible:=true"];
  if (variantId) filter.push(`variant_id:=${variantId}`);
  try {
    const result = (await getTypesenseSearch().collections(COLLECTION_NAME).documents().search({
      q: "*",
      query_by: "name",
      filter_by: filter.join(" && "),
      per_page: 1,
    })) as TypesenseSearchResult;
    if (result.hits?.[0]) {
      const [product] = await withBackorderAvailability([mapProduct(result.hits[0])]);
      if (product) return product;
    }
  } catch (error) {
    console.error("[EMRN Pulse] Typesense getProduct failed", error);
  }

  const payload = await bigCommerceGet<{ data?: BigCommerceProduct }>(`/catalog/products/${productId}`, {
    include: "variants,images,custom_fields",
  });
  if (!payload?.data) return null;
  const variant = variantId ? payload.data.variants?.find((item) => Number(item.id) === Number(variantId)) : undefined;
  const [product] = await withBackorderAvailability([mapBigCommerceProduct(payload.data, variant)]);
  return product || null;
}

export async function searchByBrand(brand: string, limit = 6) {
  return (await searchProducts({ query: brand, filters: { brand }, limit })).products;
}

export async function searchByCategory(category: string, limit = 6) {
  return (await searchProducts({ query: category, filters: { category }, limit })).products;
}

export async function searchByManufacturer(manufacturer: string, limit = 6) {
  return (await searchProducts({ query: manufacturer, filters: { manufacturer }, limit })).products;
}

export async function checkInventory(product: CatalogProduct) {
  return {
    inventoryLevel: product.inventoryLevel,
    availability: product.availability || product.availabilityDescription,
  };
}

export async function checkPurchasable(product: CatalogProduct) {
  const availabilityText = `${product.availability} ${product.availabilityDescription}`.toLowerCase();
  const extendedLeadTime = /backorder|back order|available to order|extended lead|preorder|pre-order/.test(availabilityText);

  return {
    purchasable: product.purchasable && !product.quoteOnly,
    quoteOnly: product.quoteOnly,
    message: product.quoteOnly
      ? "This item requires a quotation from our sales team."
      : product.purchasable
        ? extendedLeadTime
          ? "This item is available to order online with an extended lead time."
          : "This item can be purchased online."
        : "This item is not currently available for online purchase.",
  };
}

export async function createCart(input: CartRequest): Promise<CartResult> {
  if (process.env.BIGCOMMERCE_CART_PROVIDER === "mcp") {
    const mcpResult = await mcpCreateCart(input);
    if (mcpResult.available && mcpResult.data) return mcpResult.data;
  }

  const checkedItems = await Promise.all(
    input.items.map(async (item) => ({
      item,
      product: await getProduct(item.productId, item.variantId),
    }))
  );

  const blockedItems = checkedItems
    .filter(({ product }) => !product || product.quoteOnly || !product.purchasable)
    .map(({ product, item }) => product?.name || `Product ${item.productId}`);

  const allowedItems = checkedItems.filter(({ product }) => product && product.purchasable && !product.quoteOnly);
  if (!allowedItems.length || blockedItems.length) return { blockedItems };

  const lineItems = allowedItems.map(({ item }) => ({
    productId: item.productId,
    variantId: item.variantId,
    quantity: item.quantity,
  }));

  if (process.env.EMRN_PULSE_BROWSER_CART !== "false") {
    return {
      checkoutUrl: `${process.env.EMRN_STORE_URL || "https://emrn.ca"}/cart.php`,
      blockedItems: [],
      provider: "storefront-browser",
      lineItems,
    };
  }

  if (!BIGCOMMERCE_API_BASE || !ACCESS_TOKEN) {
    return { blockedItems: ["BigCommerce cart API is not configured."] };
  }

  const response = await fetch(`${BIGCOMMERCE_API_BASE}/carts`, {
    method: "POST",
    headers: {
      "X-Auth-Token": ACCESS_TOKEN,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      line_items: {
        physical_items: allowedItems.map(({ item }) => ({
          quantity: item.quantity,
          product_id: item.productId,
          ...(item.variantId ? { variant_id: item.variantId } : {}),
        })),
      },
    }),
  });

  if (!response.ok) {
    return { blockedItems: [`Unable to create cart: ${response.status}`] };
  }

  const data = await response.json();
  return {
    cartId: data.data?.id,
    checkoutUrl: normalizeCommerceUrl(data.data?.redirect_urls?.checkout_url || data.data?.redirect_urls?.cart_url),
    blockedItems: [],
    provider: "bigcommerce-api",
    lineItems,
  };
}

export const futureBuyerPortalTools = {
  getCompanyPricing: async () => null,
  getCompanyOrders: async () => [],
  getSavedQuotes: async () => [],
  getInvoices: async () => [],
  getPurchaseHistory: async () => [],
  manageUsers: async () => null,
};

export const futureBigCommerceMcpTools = {
  searchProducts: async () => null,
  addToCart: async () => null,
  createCart: async () => null,
  getCustomerAccount: async () => null,
  getShippingInfo: async () => null,
  getCheckout: async () => null,
};

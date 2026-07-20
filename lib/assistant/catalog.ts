import { getTypesenseSearch } from "../typesense";
import { absoluteStoreUrl, normalizeCommerceUrl } from "../store-url";
import { buildSmartSearchQuery } from "../smart-search-translator";
import { withBackorderAvailability } from "./availability";
import { mcpCreateCart } from "./bigcommerce-mcp";
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
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function skuSearchVariants(sku: string) {
  const clean = String(sku || "").trim().toUpperCase();
  const compact = clean.replace(/\s+/g, "");
  const spaced = compact.replace(/^([A-Z]+)(\d+)$/, "$1 $2");
  return Array.from(new Set([clean, compact, spaced].filter(Boolean)));
}

export async function searchProducts(input: ProductSearchInput) {
  const smartQuery = await buildSmartSearchQuery(input.query);
  const result = (await getTypesenseSearch()
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

  const products = await withBackorderAvailability((result.hits || []).map(mapProduct));

  return {
    products,
    found: Number(result.found || 0),
    searchQuery: smartQuery.search_query || input.query,
    language: smartQuery.language,
  };
}

export async function searchBySKU(sku: string) {
  const variants = skuSearchVariants(sku);
  const results = (await Promise.all(
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
  const normalized = normalizeSku(sku);
  const products = new Map<string, CatalogProduct>();

  for (const result of results) {
    for (const product of (result.hits || []).map(mapProduct)) {
      if (normalizeSku(product.sku) === normalized) {
        products.set(`${product.productId}:${product.variantId}:${product.sku}`, product);
      }
    }
  }

  return withBackorderAvailability(Array.from(products.values()));
}

export async function getProduct(productId: number, variantId?: number) {
  const filter = [`product_id:=${productId}`, "is_visible:=true"];
  if (variantId) filter.push(`variant_id:=${variantId}`);
  const result = (await getTypesenseSearch().collections(COLLECTION_NAME).documents().search({
    q: "*",
    query_by: "name",
    filter_by: filter.join(" && "),
    per_page: 1,
  })) as TypesenseSearchResult;
  if (!result.hits?.[0]) return null;
  const [product] = await withBackorderAvailability([mapProduct(result.hits[0])]);
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

  if (!BIGCOMMERCE_API_BASE || !ACCESS_TOKEN) {
    return { blockedItems: ["BigCommerce cart API is not configured."] };
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

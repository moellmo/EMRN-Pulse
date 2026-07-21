import { getTypesenseSearch } from "../typesense";
import { absoluteStoreUrl, normalizeCommerceUrl } from "../store-url";
import { buildSmartSearchQuery } from "../smart-search-translator";
import type { SmartQueryResult } from "../smart-search-translator";
import { normalizeSearchText } from "../search-language";
import { withBackorderAvailability } from "./availability";
import { mcpCreateCart, mcpRemoveCartItem, mcpSearchProducts, mcpUpdateCartItem } from "./bigcommerce-mcp";
import type { CartRequest, CartResult, CatalogProduct, ProductSearchInput } from "./types";

const COLLECTION_NAME = "emrn_products";
const STORE_HASH = process.env.BIGCOMMERCE_STORE_HASH;
const ACCESS_TOKEN = process.env.BIGCOMMERCE_ACCESS_TOKEN;
const BIGCOMMERCE_API_BASE = STORE_HASH ? `https://api.bigcommerce.com/stores/${STORE_HASH}/v3` : "";
const SMARTSEARCH_API_BASE = (process.env.EMRN_SMARTSEARCH_API_BASE || process.env.EMRN_STORE_URL || "https://emrn.ca").replace(
  /\/+$/,
  ""
);
const SMARTSEARCH_FALLBACK_ENABLED = process.env.EMRN_SMARTSEARCH_FALLBACK !== "false";

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

type SmartSearchApiResult = TypesenseSearchResult & {
  grouped_hits?: SearchHit[];
};

type BigCommerceProduct = Partial<{
  id: number;
  name: string;
  sku: string;
  description: string;
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

function productUrlFromDocument(doc: SearchDocument) {
  const url = absoluteStoreUrl(doc.url);
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const looksLikeImagePath = /\.(?:jpg|jpeg|png|gif|webp|svg)$/.test(path) || /-(?:jpg|jpeg|png|gif|webp|svg)$/.test(path);
    if (!looksLikeImagePath) return url;
  } catch {
    return url;
  }

  const fallback = new URL("/search.php", process.env.EMRN_STORE_URL || "https://emrn.ca");
  fallback.searchParams.set("search_query", String(doc.sku || doc.name || "").trim());
  return fallback.toString();
}

function mapProduct(hit: SearchHit | SearchDocument): CatalogProduct {
  const doc = hitDocument(hit);
  const quoteOnly = doc.quote_only === true;
  const explicitlyNotPurchasable = doc.purchasable === false;

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
    url: productUrlFromDocument(doc),
    inventoryLevel: Number(doc.inventory_level || 0),
    availability: String(doc.availability || ""),
    availabilityDescription: String(doc.availability_description || ""),
    purchasable: !quoteOnly && !explicitlyNotPurchasable,
    quoteOnly,
    purchaseAction: quoteOnly ? "quote_only" : "cart",
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

function skuPrefixCandidates() {
  return Array.from(
    new Set(
      (process.env.EMRN_SKU_PREFIXES || "DY,3M,MDS,LF,PP,SB,WA,ZZ,BD,PEL,AMD")
        .split(",")
        .map((value) => normalizeSku(value))
        .filter(Boolean)
    )
  );
}

function skuMatchCandidates(sku: string) {
  const normalized = normalizeSku(sku);
  const candidates = new Set([normalized].filter(Boolean));
  if (normalized && !normalized.endsWith("+")) candidates.add(`${normalized}+`);
  if (normalized.endsWith("+")) candidates.add(normalized.slice(0, -1));
  for (const prefix of skuPrefixCandidates()) {
    if (normalized.startsWith(prefix) && normalized.length > prefix.length + 2) {
      candidates.add(normalized.slice(prefix.length));
    }
  }
  if (/^[0-9][A-Z0-9]{2,}$/.test(normalized)) {
    for (const prefix of skuPrefixCandidates()) candidates.add(`${prefix}${normalized}`);
  }
  if (/^[A-Z]{1,4}[0-9][A-Z0-9]*U$/.test(normalized)) candidates.add(normalized.slice(0, -1));
  if (/^[A-Z]{1,4}[0-9][A-Z0-9]*$/.test(normalized) && !normalized.endsWith("U")) candidates.add(`${normalized}U`);
  return candidates;
}

function textFromHtml(value: string) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|tr|td|th)>/gi, "\n")
    .replace(/<(?:td|th)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&ldquo;|&rdquo;/gi, "\"")
    .replace(/&mdash;/gi, " - ")
    .replace(/&ndash;/gi, "-")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function shogunTableSpecsText(value: string) {
  const rows = Array.from(String(value || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi));
  const specs: string[] = [];

  for (const row of rows) {
    const cells = Array.from((row[1] || "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map((match) =>
      textFromHtml(match[1] || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n")
    );
    const label = cells[0] || "";
    const valueText = cells.slice(1).filter(Boolean).join("\n");
    if (!label || !valueText) continue;
    specs.push(`${label}\n${valueText}`);
  }

  return Array.from(new Set(specs)).join("\n");
}

function productPageDetailsText(html: string) {
  const cleanHtml = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const tableSpecs = shogunTableSpecsText(cleanHtml);
  const text = [textFromHtml(cleanHtml), tableSpecs].filter(Boolean).join("\n");
  const headings = [
    "Product Overview",
    "Specifications",
    "Features",
    "Dimensions",
    "Product Details",
    "Color",
    "Colour",
    "Capacity",
    "Pocket Dimensions",
    "Pack Dimensions",
    "Size",
    "Sizes",
    "Compatibility",
    "Compatible",
  ];
  const chunks: string[] = [];

  for (const heading of headings) {
    const index = text.toLowerCase().indexOf(heading.toLowerCase());
    if (index >= 0) chunks.push(text.slice(Math.max(0, index - 200), index + 2200));
  }

  return Array.from(new Set(chunks))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 12000)
    .trim();
}

async function fetchProductPageDetails(product: CatalogProduct) {
  if (!product.url || /\/search\.php\b/i.test(product.url)) return "";
  try {
    const parsed = new URL(product.url);
    const storeHost = new URL(process.env.EMRN_STORE_URL || "https://emrn.ca").hostname.replace(/^www\./, "");
    if (parsed.hostname.replace(/^www\./, "") !== storeHost) return "";
    const response = await fetch(parsed.toString(), { cache: "no-store" });
    if (!response.ok) return "";
    return productPageDetailsText(await response.text());
  } catch (error) {
    console.error("[EMRN Pulse] EMRN product page enrichment failed", error);
    return "";
  }
}

function productSpecsText(product: BigCommerceProduct) {
  const customFields = (product.custom_fields || [])
    .map((field) => [field.name, field.value].filter(Boolean).join(": "))
    .filter(Boolean);
  return [textFromHtml(product.description || ""), shogunTableSpecsText(product.description || ""), ...customFields].filter(Boolean).join("\n");
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
  const plusCompact = compact && !compact.endsWith("+") ? `${compact}+` : "";
  const plusSpaced = spaced && !spaced.endsWith("+") ? `${spaced}+` : "";
  const normalizedCandidates = Array.from(skuMatchCandidates(compact));
  const spacedCandidates = normalizedCandidates.map((candidate) => candidate.replace(/^([A-Z]+)(\d+)$/, "$1 $2"));
  const prefixedRawCandidates = /^[0-9]/.test(clean)
    ? skuPrefixCandidates().flatMap((prefix) => [`${prefix}${clean}`, `${prefix}-${clean}`])
    : [];
  const hyphenCandidates = normalizedCandidates.map((candidate) => candidate.replace(/^(3M)(\d+)$/i, "$1-$2"));
  return Array.from(new Set([clean, compact, spaced, plusCompact, plusSpaced, ...normalizedCandidates, ...spacedCandidates, ...prefixedRawCandidates, ...hyphenCandidates].filter(Boolean)));
}

function smartSearchHits(result: SmartSearchApiResult | null) {
  return [...(result?.hits || []), ...(result?.grouped_hits || [])];
}

function hitKey(hit: SearchHit) {
  const doc = hit.document || {};
  return String(doc.id || `${doc.product_id || ""}:${doc.variant_id || ""}:${doc.sku || ""}`);
}

function mergeHits(...groups: SearchHit[][]) {
  const seen = new Set<string>();
  const merged: SearchHit[] = [];

  for (const group of groups) {
    for (const hit of group || []) {
      const key = hitKey(hit);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
    }
  }

  return merged;
}

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(normalizeSearchText(term)));
}

const commonSearchTypoMap: Record<string, string> = {
  lardel: "laerdal",
  lardal: "laerdal",
  laredal: "laerdal",
  maks: "mask",
  maske: "mask",
  mak: "mask",
  msak: "mask",
  glas: "glass",
  glvoe: "glove",
  glvoes: "gloves",
  gloev: "glove",
  gloevs: "gloves",
  nedle: "needle",
  nedles: "needles",
  neelde: "needle",
  neeldes: "needles",
  syring: "syringe",
  siringe: "syringe",
  sryinge: "syringe",
  wheelchiar: "wheelchair",
  wheelchar: "wheelchair",
  whelechair: "wheelchair",
  manikan: "manikin",
  manikinne: "manikin",
  mannekin: "manikin",
  qcrp: "qcpr",
  qcprr: "qcpr",
  oximter: "oximeter",
  oxymeter: "oximeter",
  stethascope: "stethoscope",
  stethescope: "stethoscope",
  bandagee: "bandage",
  bandaid: "bandage",
};

function normalizeCommonSearchTypos(value: string) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .map((token) => commonSearchTypoMap[token] || token)
    .join(" ")
    .trim();
}

function documentNameText(hit: SearchHit) {
  const doc = hit.document || {};
  return normalizeSearchText([doc.name, doc.parent_name].filter(Boolean).join(" "));
}

function documentCategoryText(hit: SearchHit) {
  const categories = hit.document?.categories;
  const values = Array.isArray(categories) ? categories : [categories];
  return normalizeSearchText(values.map((value) => String(value || "")).join(" "));
}

function supplementalRecallQueries(originalQuery: string, translatedQuery: string, fallbackTerms: string[]) {
  const query = normalizeSearchText(`${originalQuery} ${translatedQuery} ${fallbackTerms.join(" ")}`);
  const typoNormalizedQuery = normalizeCommonSearchTypos(`${originalQuery} ${translatedQuery} ${fallbackTerms.join(" ")}`);
  const recalls: string[] = [];
  const add = (...terms: string[]) => {
    for (const term of terms) {
      const clean = term.trim();
      if (clean && !recalls.includes(clean)) recalls.push(clean);
    }
  };
  if (typoNormalizedQuery && typoNormalizedQuery !== query) add(typoNormalizedQuery);

  if (
    includesAny(query, [
      "medical bag",
      "medical bags",
      "medic bag",
      "medic bags",
      "trauma bag",
      "trauma bags",
      "ems bag",
      "emt bag",
      "jump bag",
      "jump bags",
      "first aid bag",
      "first aid bags",
      "sac medical",
      "sacs medicaux",
      "sac de premiers soins",
      "sacs de premiers soins",
      "sac d urgence",
      "sacs d urgence",
    ])
  ) {
    add("medical bag", "medical bags", "trauma bag", "ems bag", "first aid bag", "rescue bag", "medical backpack");
  }

  if (
    includesAny(query, [
      "laerdal qcpr",
      "lardel qcpr",
      "lardal qcpr",
      "little junior qcpr",
      "little anne qcpr",
      "cpr manikin",
      "cpr manikins",
      "cpr mannequin",
      "cpr mannequins",
      "training manikin",
      "training manikins",
      "adult manikin",
      "adult manikins",
      "prestan manikin",
      "prestan manikins",
      "mannequin rcr",
      "mannequins rcr",
      "manikin rcr",
      "manikins rcr",
    ])
  ) {
    add("cpr manikin", "cpr manikins", "prestan manikin", "adult cpr manikin", "training manikin");
  }

  if (
    includesAny(query, ["laerdal", "lardel", "lardal", "qcpr", "little junior", "little anne"]) &&
    !includesAny(query, ["part", "parts", "accessory", "accessories", "replacement"])
  ) {
    add("laerdal qcpr", "little junior qcpr", "little anne qcpr", "little family qcpr", "resusci junior qcpr");
  }

  return recalls.slice(0, 8);
}

function rankMedicalBagHits(hits: SearchHit[], originalQuery: string, translatedQuery: string) {
  const query = normalizeSearchText(`${originalQuery} ${translatedQuery}`);
  const isMedicalBagQuery = includesAny(query, [
    "medical bag",
    "medical bags",
    "medic bag",
    "medic bags",
    "trauma bag",
    "trauma bags",
    "ems bag",
    "emt bag",
    "first aid bag",
    "first aid bags",
    "jump bag",
    "jump bags",
    "rescue bag",
    "rescue bags",
    "sac medical",
    "sacs medicaux",
    "sac de premiers soins",
    "sacs de premiers soins",
    "sac d urgence",
    "sacs d urgence",
  ]);
  if (!isMedicalBagQuery) return hits;

  const coreBagTerms = [
    "medical bag",
    "medical bags",
    "medic bag",
    "medic bags",
    "trauma bag",
    "trauma bags",
    "ems bag",
    "ems bags",
    "emt bag",
    "emt bags",
    "jump bag",
    "jump bags",
    "rescue bag",
    "rescue bags",
    "first aid bag",
    "first aid bags",
    "oxygen bag",
    "oxygen bags",
    "medical backpack",
    "medical backpacks",
    "ems backpack",
    "ems backpacks",
    "trauma backpack",
    "trauma backpacks",
    "medpac",
    "statpack",
    "statpacks",
  ];
  const weakContainerTerms = ["pouch", "pouches", "case", "cases", "pack", "packs", "backpack", "backpacks"];
  const demoteTerms = ["sick bag", "emesis bag", "emesis bags", "amniotic sac", "amniotic sacs", "plastic bag", "bio bag", "bio bags"];

  const score = (hit: SearchHit) => {
    const name = ` ${documentNameText(hit)} `;
    const categories = ` ${documentCategoryText(hit)} `;
    let value = 0;

    const namedCoreBag = includesAny(name, coreBagTerms);
    const inMedicalBagsCategory = categories.includes(" medical bags ");
    const namedWeakContainer = includesAny(name, weakContainerTerms);

    if (namedCoreBag) value += 520;
    else if (inMedicalBagsCategory) value += 220;
    else value -= 500;
    if (namedWeakContainer && !namedCoreBag && !inMedicalBagsCategory) value -= 220;
    if (includesAny(name, demoteTerms)) value -= 420;

    return value;
  };

  return [...hits].sort((a, b) => score(b) - score(a));
}

function rankCprManikinHits(hits: SearchHit[], originalQuery: string, translatedQuery: string) {
  const query = normalizeSearchText(`${originalQuery} ${translatedQuery}`);
  const isCprManikinQuery = includesAny(query, [
    "cpr manikin",
    "cpr manikins",
    "cpr mannequin",
    "cpr mannequins",
    "training manikin",
    "training manikins",
    "adult manikin",
    "adult manikins",
    "prestan manikin",
    "prestan manikins",
    "laerdal qcpr",
    "lardel qcpr",
    "lardal qcpr",
    "little junior qcpr",
    "little anne qcpr",
    "little family qcpr",
    "mannequin rcr",
    "mannequins rcr",
    "manikin rcr",
    "manikins rcr",
  ]);
  if (includesAny(query, ["part", "parts", "accessory", "accessories", "replacement"])) return hits;
  if (!isCprManikinQuery) return hits;

  const coreTerms = [
    "cpr manikin",
    "cpr manikins",
    "cpr mannequin",
    "cpr mannequins",
    "professional adult cpr",
    "adult cpr manikin",
    "infant cpr manikin",
    "child cpr manikin",
    "prestan professional",
    "little junior qcpr",
    "little anne qcpr",
    "little family qcpr",
    "resusci junior qcpr",
  ];
  const accessoryTerms = [
    "bag",
    "carry bag",
    "replacement",
    "piston",
    "skin",
    "face shield",
    "lung bag",
    "airway",
    "clothing",
    "adapter",
    "part",
  ];

  const score = (hit: SearchHit) => {
    const name = ` ${documentNameText(hit)} `;
    let value = 0;
    if (includesAny(name, coreTerms)) value += 520;
    if (/\bmanikin\b|\bmanikins\b|\bmannequin\b|\bmannequins\b/.test(name)) value += 160;
    if (/\b(cpr training manikin|adult cpr training manikin|qcpr cpr training manikin|ultralite manikin)\b/.test(name)) value += 520;
    if (/\b(carry bag|replacement|piston|skin|face shield|lung bag|airway|adapter)\b/.test(name)) value -= 900;
    else if (includesAny(name, accessoryTerms)) value -= 180;
    return value;
  };

  return [...hits].sort((a, b) => score(b) - score(a));
}

function rankCommonProductTypeHits(hits: SearchHit[], originalQuery: string, translatedQuery: string) {
  const query = normalizeCommonSearchTypos(`${originalQuery} ${translatedQuery}`);
  const productTypes = [
    { terms: ["mask", "masks"], positive: ["mask", "masks"], negative: ["kit", "pouch"] },
    { terms: ["glove", "gloves"], positive: ["glove", "gloves"], negative: ["kit", "pouch"] },
    { terms: ["needle", "needles"], positive: ["needle", "needles"], negative: ["kit", "pouch"] },
    { terms: ["wheelchair", "wheelchairs"], positive: ["wheelchair", "wheelchairs"], negative: ["accessory", "accessories", "anti tippers", "arm rails", "caster", "fork", "hand brake", "iv pole", "holder"] },
  ];
  const type = productTypes.find((item) => includesAny(query, item.terms));
  if (!type || includesAny(query, ["part", "parts", "accessory", "accessories", "replacement", "holder", "mount"])) return hits;

  const score = (hit: SearchHit) => {
    const name = documentNameText(hit);
    const categories = documentCategoryText(hit);
    let value = 0;
    if (includesAny(name, type.positive)) value += 300;
    if (includesAny(categories, type.positive)) value += 120;
    if (includesAny(name, type.negative)) value -= 280;
    return value;
  };

  return [...hits].sort((a, b) => score(b) - score(a));
}

async function searchSmartSearchApiRaw(query: string, limit = 8): Promise<SmartSearchApiResult | null> {
  if (!SMARTSEARCH_FALLBACK_ENABLED || !query.trim()) return null;

  const url = new URL("/api/search", SMARTSEARCH_API_BASE);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", String(Math.min(Math.max(limit, 1), 24)));
  url.searchParams.set("sort", "popularity");

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      console.error("[EMRN Pulse] SmartSearch fallback failed", response.status, url.toString());
      return null;
    }
    return (await response.json()) as SmartSearchApiResult;
  } catch (error) {
    console.error("[EMRN Pulse] SmartSearch fallback failed", error);
    return null;
  }
}

async function searchSmartSearchApiProducts(query: string, limit = 8) {
  const result = await searchSmartSearchApiRaw(query, limit);
  const mapped = smartSearchHits(result).map(mapProduct).filter((product) => product.productId || product.sku);
  return withBackorderAvailability(mapped.slice(0, limit));
}

async function searchSmartSearchApiBySKU(sku: string, limit = 8) {
  const normalizedCandidates = skuMatchCandidates(sku);
  const primaryProducts = new Map<string, CatalogProduct>();
  const relatedProducts = new Map<string, CatalogProduct>();

  for (const variant of skuSearchVariants(sku)) {
    const result = await searchSmartSearchApiRaw(variant, limit);
    for (const hit of smartSearchHits(result)) {
      const doc = hitDocument(hit);
      const isPrimarySkuMatch = normalizedCandidates.has(normalizeSku(String(doc.sku || "")));
      const isRelatedSkuMatch = skuValuesForDocument(doc).some((value) => normalizedCandidates.has(normalizeSku(value)));
      if (!isPrimarySkuMatch && !isRelatedSkuMatch) continue;

      const product = mapProduct(hit);
      const key = `${product.productId}:${product.variantId}:${product.sku}`;
      if (isPrimarySkuMatch) primaryProducts.set(key, product);
      else relatedProducts.set(key, product);
    }
  }

  return withBackorderAvailability(Array.from((primaryProducts.size ? primaryProducts : relatedProducts).values()));
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
    description: productSpecsText(product),
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
  const normalizedCandidates = skuMatchCandidates(sku);
  const products = new Map<string, CatalogProduct>();

  for (const variant of skuSearchVariants(sku)) {
    const productPayload = await bigCommerceGet<{ data?: BigCommerceProduct[] }>("/catalog/products", {
      sku: variant,
      include: "variants,images,custom_fields",
      is_visible: "true",
      limit: 10,
    });
    for (const product of productPayload?.data || []) {
      if (normalizedCandidates.has(normalizeSku(String(product.sku || "")))) {
        const mapped = mapBigCommerceProduct(product);
        products.set(`${mapped.productId}:${mapped.variantId}:${mapped.sku}`, mapped);
      }
      for (const productVariant of product.variants || []) {
        if (normalizedCandidates.has(normalizeSku(String(productVariant.sku || "")))) {
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
      if (!normalizedCandidates.has(normalizeSku(String(productVariant.sku || ""))) || !productVariant.product_id) continue;
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
  const normalizedCandidates = skuMatchCandidates(sku);
  const keywordMatches = await searchBigCommerceProducts(sku, 12);
  return keywordMatches.filter((product) => normalizedCandidates.has(normalizeSku(product.sku)));
}

async function enrichProductFromBigCommerce(product: CatalogProduct) {
  const productPageDetails = async (currentProduct: CatalogProduct) => {
    const pageDetails = await fetchProductPageDetails(currentProduct);
    return pageDetails && pageDetails.length > currentProduct.description.length
      ? { ...currentProduct, description: [currentProduct.description, pageDetails].filter(Boolean).join("\n") }
      : currentProduct;
  };

  if (!product.productId) return productPageDetails(product);

  try {
    const payload = await bigCommerceGet<{ data?: BigCommerceProduct }>(`/catalog/products/${product.productId}`, {
      include: "variants,images,custom_fields",
    });
    if (!payload?.data) return productPageDetails(product);

    const variant = product.variantId
      ? payload.data.variants?.find((item) => Number(item.id) === Number(product.variantId))
      : payload.data.variants?.find((item) => normalizeSku(String(item.sku || "")) === normalizeSku(product.sku));
    const enriched = mapBigCommerceProduct(payload.data, variant);
    return productPageDetails({
      ...product,
      description: enriched.description || product.description,
      image: enriched.image || product.image,
      url: enriched.url || product.url,
      price: enriched.price || product.price,
      inventoryLevel: enriched.inventoryLevel || product.inventoryLevel,
      availability: enriched.availability || product.availability,
      availabilityDescription: enriched.availabilityDescription || product.availabilityDescription,
    });
  } catch (error) {
    console.error("[EMRN Pulse] BigCommerce product enrichment failed", error);
    return productPageDetails(product);
  }
}

async function enrichProductsFromBigCommerce(products: CatalogProduct[]) {
  return Promise.all(products.map(enrichProductFromBigCommerce));
}

async function searchTypesenseProducts(query: string, input: ProductSearchInput) {
  return (await getTypesenseSearch()
    .collections(COLLECTION_NAME)
    .documents()
    .search({
      q: query || "*",
      query_by:
        "sku,all_skus,name,parent_name,brand,sold_by,categories,variant_label,option_text,search_text,description,custom_fields_text",
      query_by_weights: "30,24,16,12,8,7,7,6,6,4,2,2",
      filter_by: productFilter(input),
      sort_by: "_text_match:desc,popularity_score:desc,product_id:desc",
      per_page: Math.min(Math.max(input.limit || 6, 1), 12),
      num_typos: 2,
      typo_tokens_threshold: 1,
      prefix: true,
    })) as TypesenseSearchResult;
}

export async function searchProducts(input: ProductSearchInput) {
  const rawQuery = input.query || "*";
  let smartQuery: SmartQueryResult = {
    original_query: rawQuery,
    search_query: rawQuery,
    language: input.language === "fr" ? "fr" as const : "en" as const,
    expanded_query: rawQuery,
    expansions: [] as string[],
    translated_query: "",
    translator: "none" as const,
    ai_status: "not_needed" as const,
    fallback_terms: [] as string[],
  };

  if (rawQuery && rawQuery !== "*") {
    try {
      smartQuery = await buildSmartSearchQuery(rawQuery);
    } catch (error) {
      console.error("[EMRN Pulse] search query expansion failed", error);
    }
  }

  const shouldPreferTranslatedQuery =
    (smartQuery.language === "fr" || input.language === "fr") && smartQuery.search_query && smartQuery.search_query !== rawQuery;
  const typoNormalizedQuery = normalizeCommonSearchTypos([rawQuery, smartQuery.search_query].filter(Boolean).join(" "));
  const primaryQuery =
    typoNormalizedQuery && typoNormalizedQuery !== normalizeSearchText([rawQuery, smartQuery.search_query].filter(Boolean).join(" "))
      ? typoNormalizedQuery
      : input.language === "fr" && smartQuery.expansions.length
      ? smartQuery.expansions[0]
      : shouldPreferTranslatedQuery
        ? smartQuery.search_query
        : rawQuery;
  let result: TypesenseSearchResult = {};
  let supplementalResults: TypesenseSearchResult[] = [];

  try {
    const recallQueries = supplementalRecallQueries(rawQuery, smartQuery.search_query, smartQuery.fallback_terms);
    const [primaryResult, ...recallResults] = (await Promise.all([
      searchTypesenseProducts(primaryQuery, input),
      ...recallQueries.map((recallQuery) => searchTypesenseProducts(recallQuery, input)),
    ])) as TypesenseSearchResult[];
    result = primaryResult;
    supplementalResults = recallResults;
  } catch (error) {
    console.error("[EMRN Pulse] Typesense search failed", error);
  }

  let mergedHits = mergeHits(
    ...(supplementalResults.map((supplementalResult) => supplementalResult.hits || [])),
    result.hits || []
  );
  mergedHits = rankMedicalBagHits(mergedHits, rawQuery, smartQuery.search_query);
  mergedHits = rankCprManikinHits(mergedHits, rawQuery, smartQuery.search_query);
  mergedHits = rankCommonProductTypeHits(mergedHits, rawQuery, smartQuery.search_query);

  let products = await withBackorderAvailability(mergedHits.map(mapProduct));

  if (!products.length && rawQuery && rawQuery !== "*" && primaryQuery !== rawQuery) {
    try {
      result = await searchTypesenseProducts(rawQuery, input);
      const rankedHits = rankCprManikinHits(
        rankMedicalBagHits(result.hits || [], rawQuery, smartQuery.search_query),
        rawQuery,
        smartQuery.search_query
      );
      products = await withBackorderAvailability(rankCommonProductTypeHits(rankedHits, rawQuery, smartQuery.search_query).map(mapProduct));
    } catch (error) {
      console.error("[EMRN Pulse] raw Typesense fallback search failed", error);
    }
  }

  if (!products.length && input.query && input.query !== "*") {
    products = await searchSmartSearchApiProducts(input.query, input.limit || 8);
  }
  if (!products.length && input.query && input.query !== "*" && smartQuery.search_query !== input.query) {
    products = await searchSmartSearchApiProducts(smartQuery.search_query || input.query, input.limit || 8);
  }
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
  const normalizedCandidates = skuMatchCandidates(sku);
  const primaryProducts = new Map<string, CatalogProduct>();
  const relatedProducts = new Map<string, CatalogProduct>();

  for (const result of results) {
    for (const hit of result.hits || []) {
      const doc = hitDocument(hit);
      const isPrimarySkuMatch = normalizedCandidates.has(normalizeSku(String(doc.sku || "")));
      const isRelatedSkuMatch = skuValuesForDocument(doc).some((value) => normalizedCandidates.has(normalizeSku(value)));
      if (isPrimarySkuMatch || isRelatedSkuMatch) {
        const product = mapProduct(hit);
        const key = `${product.productId}:${product.variantId}:${product.sku}`;
        if (isPrimarySkuMatch) primaryProducts.set(key, product);
        else relatedProducts.set(key, product);
      }
    }
  }

  const typesenseProducts = await withBackorderAvailability(Array.from((primaryProducts.size ? primaryProducts : relatedProducts).values()));
  if (typesenseProducts.length) return enrichProductsFromBigCommerce(typesenseProducts);

  const smartSearchProducts = await searchSmartSearchApiBySKU(sku);
  if (smartSearchProducts.length) return smartSearchProducts;

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
    if (mcpResult.available && mcpResult.data?.checkoutUrl) return mcpResult.data;
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

export async function updateMcpCartItem(input: {
  lineItemId: string;
  productId: number;
  variantId?: number;
  quantity: number;
}) {
  if (process.env.BIGCOMMERCE_CART_PROVIDER !== "mcp") {
    return {
      blockedItems: ["MCP cart editing is not enabled."],
    } as CartResult;
  }

  const result = await mcpUpdateCartItem(input);
  return result.available && result.data ? result.data : { blockedItems: [result.message || "Unable to update cart item."] };
}

export async function removeMcpCartItem(lineItemId: string) {
  if (process.env.BIGCOMMERCE_CART_PROVIDER !== "mcp") {
    return {
      blockedItems: ["MCP cart editing is not enabled."],
    } as CartResult;
  }

  const result = await mcpRemoveCartItem(lineItemId);
  return result.available && result.data ? result.data : { blockedItems: [result.message || "Unable to remove cart item."] };
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

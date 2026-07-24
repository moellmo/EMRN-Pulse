import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { normalizeSearchText } from "../search-language";
import {
  deleteSupabaseKnowledgeMemoryItem,
  readSupabaseKnowledgeMemory,
  saveSupabaseKnowledgeMemoryItem,
  supabaseAdminConfigured,
} from "./supabase-admin";

const dataDir = path.join(process.cwd(), ".data", "assistant");
const memoryPath = path.join(dataDir, "knowledge-memory.json");

export type KnowledgeMemoryType =
  | "alias"
  | "preferred_product"
  | "compatibility"
  | "replacement_part"
  | "color_option"
  | "note"
  | "intent_route";

export type KnowledgeMemoryStatus = "approved" | "needs_review" | "disabled";
export type KnowledgeIntentRoute = "contact" | "quote" | "order_status" | "availability" | "support";

export type KnowledgeMemoryItem = {
  id: string;
  type: KnowledgeMemoryType;
  query: string;
  correctSearchTerms?: string;
  correctSku?: string;
  relatedSku?: string;
  answer?: "confirmed" | "not_compatible" | "cant_confirm" | `route_${KnowledgeIntentRoute}` | "";
  sourceUrl?: string;
  note?: string;
  status: KnowledgeMemoryStatus;
  createdAt: string;
  updatedAt: string;
};

function cleanText(value: unknown, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function normalizeSku(value: unknown) {
  return String(value || "").replace(/[^a-z0-9+._/-]/gi, "").toUpperCase();
}

function readMemoryFile(): KnowledgeMemoryItem[] {
  try {
    if (!existsSync(memoryPath)) return [];
    const parsed = JSON.parse(readFileSync(memoryPath, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is KnowledgeMemoryItem => Boolean(item && typeof item === "object" && "id" in item)) : [];
  } catch (error) {
    console.warn("[EMRN Pulse] knowledge memory read skipped", error);
    return [];
  }
}

function writeMemoryFile(items: KnowledgeMemoryItem[]) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(memoryPath, `${JSON.stringify(items, null, 2)}\n`);
    return true;
  } catch (error) {
    console.warn("[EMRN Pulse] knowledge memory local write skipped", error);
    return false;
  }
}

export function readKnowledgeMemorySync() {
  return readMemoryFile().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readKnowledgeMemory() {
  const localRows = readKnowledgeMemorySync();
  if (!supabaseAdminConfigured()) return localRows;
  try {
    const rows = await readSupabaseKnowledgeMemory();
    if (rows) return dedupeKnowledgeRows([...rows, ...localRows]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch (error) {
    console.warn("[EMRN Pulse] Supabase knowledge memory read skipped", error);
  }
  return localRows;
}

export function approvedKnowledgeMemorySync() {
  return readKnowledgeMemorySync().filter((item) => item.status === "approved");
}

export async function approvedKnowledgeMemory() {
  return (await readKnowledgeMemory()).filter((item) => item.status === "approved");
}

export async function saveKnowledgeMemoryItem(input: Partial<KnowledgeMemoryItem>) {
  const now = new Date().toISOString();
  const items = await readKnowledgeMemory();
  const id = cleanText(input.id, 80) || crypto.randomUUID();
  const existing = items.find((item) => item.id === id);
  const next: KnowledgeMemoryItem = {
    id,
    type: (input.type || existing?.type || "alias") as KnowledgeMemoryType,
    query: cleanText(input.query ?? existing?.query, 240),
    correctSearchTerms: cleanText(input.correctSearchTerms ?? existing?.correctSearchTerms, 240),
    correctSku: normalizeSku(input.correctSku ?? existing?.correctSku),
    relatedSku: normalizeSku(input.relatedSku ?? existing?.relatedSku),
    answer: (input.answer ?? existing?.answer ?? "") as KnowledgeMemoryItem["answer"],
    sourceUrl: cleanText(input.sourceUrl ?? existing?.sourceUrl, 500),
    note: cleanText(input.note ?? existing?.note, 1000),
    status: (input.status || existing?.status || "needs_review") as KnowledgeMemoryStatus,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  if (next.type === "intent_route" && !/^route_/.test(next.answer || "")) {
    const inferredRoute = inferIntentRouteFromText(`${next.query} ${next.correctSearchTerms || ""} ${next.note || ""}`);
    if (inferredRoute) next.answer = `route_${inferredRoute}`;
  }

  if (!next.query && !next.correctSearchTerms && !next.correctSku) {
    throw new Error("Knowledge row needs a query, search terms, or SKU.");
  }

  const withoutExisting = items.filter((item) => item.id !== id);
  let supabaseSaved: KnowledgeMemoryItem | null = null;
  let supabaseError: unknown = null;

  if (supabaseAdminConfigured()) {
    try {
      supabaseSaved = await saveSupabaseKnowledgeMemoryItem(next);
    } catch (error) {
      supabaseError = error;
      console.warn("[EMRN Pulse] Supabase knowledge memory save skipped", error);
    }
  }

  const localSaved = writeMemoryFile([supabaseSaved || next, ...withoutExisting].slice(0, 1000));
  if (!supabaseSaved && !localSaved && supabaseError) throw supabaseError;
  return supabaseSaved || next;
}

export async function deleteKnowledgeMemoryItem(id: string) {
  const items = await readKnowledgeMemory();
  let supabaseDeleted = false;
  let supabaseError: unknown = null;

  if (supabaseAdminConfigured()) {
    try {
      supabaseDeleted = await deleteSupabaseKnowledgeMemoryItem(id);
    } catch (error) {
      supabaseError = error;
      console.warn("[EMRN Pulse] Supabase knowledge memory delete skipped", error);
    }
  }

  const localSaved = writeMemoryFile(items.filter((item) => item.id !== id));
  if (!supabaseDeleted && !localSaved && supabaseError) throw supabaseError;
  return { deleted: true };
}

export function knowledgeSearchHintsForQuery(query: string) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  return approvedKnowledgeMemorySync()
    .filter((item) => {
      const normalizedItemQuery = normalizeSearchText(item.query);
      return normalizedItemQuery && (normalizedQuery.includes(normalizedItemQuery) || normalizedItemQuery.includes(normalizedQuery));
    })
    .flatMap((item) => [item.correctSku, item.correctSearchTerms, item.relatedSku].filter(Boolean) as string[])
    .slice(0, 10);
}

export async function knowledgeSearchHintsForQueryAsync(query: string) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  return (await matchingApprovedKnowledgeForQuery(query))
    .flatMap((item) => [item.correctSku, item.correctSearchTerms, item.relatedSku].filter(Boolean) as string[])
    .slice(0, 10);
}

export async function matchingApprovedKnowledgeForQuery(query: string) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  return (await approvedKnowledgeMemory()).filter((item) => {
    const itemText = `${item.query} ${item.correctSearchTerms || ""} ${item.note || ""}`;
    if (hasFamilyConflict(normalizedQuery, itemText)) return false;

    const normalizedItemQuery = normalizeSearchText(item.query);
    if (normalizedItemQuery && (normalizedQuery.includes(normalizedItemQuery) || normalizedItemQuery.includes(normalizedQuery))) {
      return true;
    }
    return hasMeaningfulOverlap(normalizedQuery, itemText);
  });
}

export async function taughtIntentRouteForQuery(query: string): Promise<KnowledgeIntentRoute | null> {
  const normalizedQuery = normalizeIntentRouteText(query);
  if (!normalizedQuery) return null;

  const matches = (await approvedKnowledgeMemory())
    .filter((item) => item.type === "intent_route")
    .map((item) => {
      const route = routeFromKnowledgeItem(item);
      return {
        item,
        route,
        score: route && isKnownIntentRoute(route) ? intentRouteMatchScore(normalizedQuery, item, route) : 0,
      };
    })
    .filter((match) => match.route && match.score > 0)
    .sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt));

  return matches[0]?.route || null;
}

function isKnownIntentRoute(route: string): route is KnowledgeIntentRoute {
  return ["contact", "quote", "order_status", "availability", "support"].includes(route);
}

function routeFromKnowledgeItem(item: KnowledgeMemoryItem): KnowledgeIntentRoute | null {
  const explicitRoute = item.answer?.replace(/^route_/, "") || "";
  if (isKnownIntentRoute(explicitRoute)) return explicitRoute;
  return inferIntentRouteFromText(`${item.query} ${item.correctSearchTerms || ""} ${item.note || ""}`);
}

function inferIntentRouteFromText(value: string): KnowledgeIntentRoute | null {
  const normalized = normalizeIntentRouteText(value);
  if (!normalized) return null;
  if (querySupportsRoute(normalized, "quote")) return "quote";
  if (querySupportsRoute(normalized, "order_status")) return "order_status";
  if (querySupportsRoute(normalized, "availability")) return "availability";
  if (querySupportsRoute(normalized, "contact")) return "contact";
  if (querySupportsRoute(normalized, "support")) return "support";
  return null;
}

function normalizeIntentRouteText(value: string) {
  return normalizeSearchText(value)
    .replace(/\b(?:qutoes|qoutes|qoute|qute|qutes|quot|quote|quotes|quotation|quotations|devis)\b/g, "quote")
    .replace(/\b(?:agen|agent|agentt|agnt|agents|representative|representatives|represenattive|represenative|rep|staff|human)\b/g, "agent")
    .replace(/\b(?:speak|talk|chat|contact|connect|reach|call|email|message)\b/g, "contact")
    .replace(/\b(?:support|help|problem|issue|team)\b/g, "support")
    .replace(/\b(?:order|orders|commande|commandes)\b/g, "order")
    .replace(/\b(?:status|tracking|track|shipped|shipment|ship|shipping)\b/g, "status")
    .replace(/\b(?:available|availability|stock|instock|in\s+stock|eta|leadtime|lead\s+time)\b/g, "availability")
    .replace(/\s+/g, " ")
    .trim();
}

function intentRouteMatchScore(normalizedQuery: string, item: KnowledgeMemoryItem, route: KnowledgeIntentRoute) {
  const normalizedRule = normalizeIntentRouteText(`${item.query} ${item.note || ""}`);
  if (!normalizedRule) return 0;
  if (normalizedQuery.includes(normalizedRule) || normalizedRule.includes(normalizedQuery)) return 100;

  const queryTerms = significantIntentRouteTerms(normalizedQuery);
  const ruleTerms = significantIntentRouteTerms(normalizedRule);
  const matches = ruleTerms.filter((term) => queryTerms.includes(term));
  let score = matches.length * 10;
  if (routeCoreTerms(route).some((term) => queryTerms.includes(term) && ruleTerms.includes(term))) score += 30;
  if (querySupportsRoute(normalizedQuery, route) && routeCoreTerms(route).some((term) => ruleTerms.includes(term))) score += 25;
  return score >= 30 ? score : 0;
}

function querySupportsRoute(normalizedQuery: string, route: KnowledgeIntentRoute) {
  const terms = significantIntentRouteTerms(normalizedQuery);
  const has = (values: string[]) => values.some((value) => terms.includes(value));
  if (route === "quote") return has(["quote"]);
  if (route === "contact") return has(["contact", "agent"]);
  if (route === "support") return has(["support", "contact", "agent"]);
  if (route === "order_status") return has(["order"]) && has(["status"]);
  if (route === "availability") return has(["availability", "status"]);
  return false;
}

function routeCoreTerms(route: KnowledgeIntentRoute) {
  if (route === "quote") return ["quote"];
  if (route === "contact") return ["contact", "agent"];
  if (route === "support") return ["support", "contact", "agent"];
  if (route === "order_status") return ["order", "status"];
  if (route === "availability") return ["availability", "status"];
  return [];
}

function significantIntentRouteTerms(value: string) {
  return value
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .filter((term) => !/^(the|and|for|with|this|that|item|product|part|parts|can|get|need|want|please|hello|hi|hey|merci|thanks)$/.test(term));
}

function hasMeaningfulOverlap(normalizedQuery: string, value: string) {
  const queryTerms = significantTerms(normalizedQuery);
  const valueTerms = significantTerms(normalizeSearchText(value));
  if (!queryTerms.length || !valueTerms.length) return false;
  const matches = valueTerms.filter((term) => queryTerms.includes(term));
  return matches.length >= Math.min(3, valueTerms.length);
}

function hasFamilyConflict(normalizedQuery: string, value: string) {
  const queryFamilies = familyTokens(normalizedQuery);
  const itemFamilies = familyTokens(normalizeSearchText(value));
  if (!queryFamilies.size || !itemFamilies.size) return false;

  const littleFamilies = ["little junior", "little baby", "little anne"];
  const queryLittle = littleFamilies.filter((family) => queryFamilies.has(family));
  const itemLittle = littleFamilies.filter((family) => itemFamilies.has(family));
  if (queryLittle.length && itemLittle.length && !queryLittle.some((family) => itemFamilies.has(family))) return true;

  const philipsFamilies = ["philips", "frx", "onsite"];
  const queryPhilips = philipsFamilies.filter((family) => queryFamilies.has(family));
  const itemPhilips = philipsFamilies.filter((family) => itemFamilies.has(family));
  if (queryPhilips.length && itemPhilips.length && !queryPhilips.some((family) => itemFamilies.has(family))) return true;

  const aedBrands = ["philips", "zoll", "stryker", "physio-control"];
  const queryAedBrands = aedBrands.filter((brand) => queryFamilies.has(brand));
  const itemAedBrands = aedBrands.filter((brand) => itemFamilies.has(brand));
  return Boolean(queryAedBrands.length && itemAedBrands.length && !queryAedBrands.some((brand) => itemFamilies.has(brand)));
}

function familyTokens(value: string) {
  const families = new Set<string>();
  if (/\blittle\s+(?:junior|jr)\b/.test(value)) families.add("little junior");
  if (/\blittle\s+baby\b/.test(value)) families.add("little baby");
  if (/\blittle\s+anne\b/.test(value)) families.add("little anne");
  if (/\bfrx\b/.test(value)) families.add("frx");
  if (/\bphilips\b/.test(value)) families.add("philips");
  if (/\bzoll\b/.test(value)) families.add("zoll");
  if (/\bstryker\b/.test(value)) families.add("stryker");
  if (/\bphysio[-\s]?control\b/.test(value)) families.add("physio-control");
  if (/\b(?:onsite|heartstart\s+onsite|hs1)\b/.test(value)) families.add("onsite");
  return families;
}

function significantTerms(value: string) {
  return value
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .filter((term) => !/^(the|and|for|with|this|that|item|product|part|parts|accessory|accessories|replacement|compatible|compatibility|work|works|fit|fits|pour|avec|produit|article|piece|pièce)$/.test(term));
}

function dedupeKnowledgeRows(items: KnowledgeMemoryItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.id || `${item.type}:${item.query}:${item.correctSku}:${item.correctSearchTerms}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

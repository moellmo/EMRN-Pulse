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
  | "note";

export type KnowledgeMemoryStatus = "approved" | "needs_review" | "disabled";

export type KnowledgeMemoryItem = {
  id: string;
  type: KnowledgeMemoryType;
  query: string;
  correctSearchTerms?: string;
  correctSku?: string;
  relatedSku?: string;
  answer?: "confirmed" | "not_compatible" | "cant_confirm" | "";
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
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(memoryPath, `${JSON.stringify(items, null, 2)}\n`);
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
  const items = readMemoryFile();
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

  if (!next.query && !next.correctSearchTerms && !next.correctSku) {
    throw new Error("Knowledge row needs a query, search terms, or SKU.");
  }

  const withoutExisting = items.filter((item) => item.id !== id);
  writeMemoryFile([next, ...withoutExisting].slice(0, 1000));
  try {
    await saveSupabaseKnowledgeMemoryItem(next);
  } catch (error) {
    console.warn("[EMRN Pulse] Supabase knowledge memory save skipped", error);
  }
  return next;
}

export async function deleteKnowledgeMemoryItem(id: string) {
  const items = readMemoryFile();
  writeMemoryFile(items.filter((item) => item.id !== id));
  try {
    await deleteSupabaseKnowledgeMemoryItem(id);
  } catch (error) {
    console.warn("[EMRN Pulse] Supabase knowledge memory delete skipped", error);
  }
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
    const normalizedItemQuery = normalizeSearchText(item.query);
    if (normalizedItemQuery && (normalizedQuery.includes(normalizedItemQuery) || normalizedItemQuery.includes(normalizedQuery))) {
      return true;
    }
    return hasMeaningfulOverlap(normalizedQuery, item.correctSearchTerms || "");
  });
}

function hasMeaningfulOverlap(normalizedQuery: string, value: string) {
  const queryTerms = significantTerms(normalizedQuery);
  const valueTerms = significantTerms(normalizeSearchText(value));
  if (!queryTerms.length || !valueTerms.length) return false;
  const matches = valueTerms.filter((term) => queryTerms.includes(term));
  return matches.length >= Math.min(3, valueTerms.length);
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

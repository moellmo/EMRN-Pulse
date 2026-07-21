import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), ".data", "assistant");
const configPath = path.join(dataDir, "sku-config.json");

export type SkuConfig = {
  prefixes: string[];
  suffixes: string[];
  updatedAt?: string;
};

const defaultPrefixes = ["DY", "3M", "MDS", "LF", "PP", "SB", "WA", "ZZ", "BD", "PEL", "AMD"];
const defaultSuffixes = ["+", "U"];

function normalizeCode(value: string) {
  return String(value || "").replace(/[^a-z0-9+]/gi, "").toUpperCase();
}

function listFromEnv(value: string | undefined, fallback: string[]) {
  const values = String(value || "")
    .split(",")
    .map((item) => normalizeCode(item))
    .filter(Boolean);
  return values.length ? values : fallback;
}

function cleanList(values: unknown, fallback: string[]) {
  const source = Array.isArray(values) ? values : [];
  const cleaned = source.map((item) => normalizeCode(String(item))).filter(Boolean);
  return Array.from(new Set(cleaned.length ? cleaned : fallback));
}

export function readSkuConfigSync(): SkuConfig {
  const envPrefixes = listFromEnv(process.env.EMRN_SKU_PREFIXES, defaultPrefixes);
  const envSuffixes = listFromEnv(process.env.EMRN_SKU_SUFFIXES, defaultSuffixes);
  let saved: Partial<SkuConfig> = {};

  try {
    if (existsSync(configPath)) saved = JSON.parse(readFileSync(configPath, "utf8")) as Partial<SkuConfig>;
  } catch (error) {
    console.warn("[EMRN Pulse] SKU config read skipped", error);
  }

  return {
    prefixes: cleanList(saved.prefixes, envPrefixes),
    suffixes: cleanList(saved.suffixes, envSuffixes),
    updatedAt: saved.updatedAt,
  };
}

export async function saveSkuConfig(input: Partial<SkuConfig>) {
  const current = readSkuConfigSync();
  const config: SkuConfig = {
    prefixes: cleanList(input.prefixes, current.prefixes),
    suffixes: cleanList(input.suffixes, current.suffixes),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  process.env.EMRN_SKU_PREFIXES = config.prefixes.join(",");
  process.env.EMRN_SKU_SUFFIXES = config.suffixes.join(",");
  return config;
}

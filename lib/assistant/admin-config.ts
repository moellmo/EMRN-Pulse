import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { readSupabaseAssistantConfig, saveSupabaseAssistantConfig, supabaseAdminConfigured } from "./supabase-admin";

const dataDir = path.join(process.cwd(), ".data", "assistant");
const configPath = path.join(dataDir, "assistant-config.json");

export type AssistantRuntimeConfig = {
  aiSearchHelperEnabled: boolean;
  siteKnowledgeEnabled: boolean;
  externalKnowledgeEnabled: boolean;
  showExternalSources: boolean;
  knowledgeShadowMode: boolean;
  qaDailyReminderEnabled: boolean;
  answerCacheEnabled: boolean;
  trustedExternalDomains: string[];
  contactIntentPhrases: string[];
  updatedAt?: string;
};

export type AssistantRuntimeBooleanFeature = Exclude<keyof Omit<AssistantRuntimeConfig, "updatedAt">, "trustedExternalDomains" | "contactIntentPhrases">;

function envFlag(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function domainListValue(value: unknown, fallback: string[]) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]+/)
      : fallback;
  const domains = raw
    .map((item) => String(item || "").toLowerCase().trim())
    .map((item) => item.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0])
    .filter((item) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(item));
  return Array.from(new Set(domains));
}

function phraseListValue(value: unknown, fallback: string[]) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,]+/)
      : fallback;
  const phrases = raw
    .map((item) => String(item || "").toLowerCase().trim())
    .map((item) => item.replace(/\s+/g, " "))
    .filter((item) => item.length >= 3 && item.length <= 80);
  return Array.from(new Set(phrases)).slice(0, 250);
}

function writeConfigFile(config: AssistantRuntimeConfig) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return true;
  } catch (error) {
    console.warn("[EMRN Pulse] assistant config local write skipped", error);
    return false;
  }
}

function defaultConfig(): AssistantRuntimeConfig {
  return {
    aiSearchHelperEnabled: envFlag("EMRN_AI_SEARCH_HELPER_ENABLED", false),
    siteKnowledgeEnabled: envFlag("EMRN_SITE_KNOWLEDGE_ENABLED", false),
    externalKnowledgeEnabled: envFlag("EMRN_EXTERNAL_KNOWLEDGE_ENABLED", false),
    showExternalSources: envFlag("EMRN_SHOW_EXTERNAL_SOURCES", false),
    knowledgeShadowMode: envFlag("EMRN_KNOWLEDGE_SHADOW_MODE", true),
    qaDailyReminderEnabled: envFlag("EMRN_QA_DAILY_REMINDER_ENABLED", true),
    answerCacheEnabled: envFlag("EMRN_ANSWER_CACHE_ENABLED", true),
    trustedExternalDomains: domainListValue(process.env.EMRN_TRUSTED_EXTERNAL_DOMAINS, []),
    contactIntentPhrases: phraseListValue(process.env.EMRN_CONTACT_INTENT_PHRASES, [
      "speak with agent",
      "speak with agents",
      "speak with agen",
      "speak with agens",
      "speak to agent",
      "talk to agent",
      "talk to someone",
      "customer service",
      "contact support",
    ]),
  };
}

export function readAssistantConfigSync(): AssistantRuntimeConfig {
  const defaults = defaultConfig();
  let saved: Partial<AssistantRuntimeConfig> = {};

  try {
    if (existsSync(configPath)) {
      saved = JSON.parse(readFileSync(configPath, "utf8")) as Partial<AssistantRuntimeConfig>;
    }
  } catch (error) {
    console.warn("[EMRN Pulse] assistant config read skipped", error);
  }

  return {
    aiSearchHelperEnabled: booleanValue(saved.aiSearchHelperEnabled, defaults.aiSearchHelperEnabled),
    siteKnowledgeEnabled: booleanValue(saved.siteKnowledgeEnabled, defaults.siteKnowledgeEnabled),
    externalKnowledgeEnabled: booleanValue(saved.externalKnowledgeEnabled, defaults.externalKnowledgeEnabled),
    showExternalSources: booleanValue(saved.showExternalSources, defaults.showExternalSources),
    knowledgeShadowMode: booleanValue(saved.knowledgeShadowMode, defaults.knowledgeShadowMode),
    qaDailyReminderEnabled: booleanValue(saved.qaDailyReminderEnabled, defaults.qaDailyReminderEnabled),
    answerCacheEnabled: booleanValue(saved.answerCacheEnabled, defaults.answerCacheEnabled),
    trustedExternalDomains: domainListValue(saved.trustedExternalDomains, defaults.trustedExternalDomains),
    contactIntentPhrases: phraseListValue(saved.contactIntentPhrases, defaults.contactIntentPhrases),
    updatedAt: saved.updatedAt,
  };
}

export async function readAssistantConfig(): Promise<AssistantRuntimeConfig> {
  const localConfig = readAssistantConfigSync();
  if (!supabaseAdminConfigured()) return localConfig;

  try {
    const saved = await readSupabaseAssistantConfig();
    if (!saved) return localConfig;
    return {
      aiSearchHelperEnabled: booleanValue(saved.aiSearchHelperEnabled, localConfig.aiSearchHelperEnabled),
      siteKnowledgeEnabled: booleanValue(saved.siteKnowledgeEnabled, localConfig.siteKnowledgeEnabled),
      externalKnowledgeEnabled: booleanValue(saved.externalKnowledgeEnabled, localConfig.externalKnowledgeEnabled),
      showExternalSources: booleanValue(saved.showExternalSources, localConfig.showExternalSources),
      knowledgeShadowMode: booleanValue(saved.knowledgeShadowMode, localConfig.knowledgeShadowMode),
      qaDailyReminderEnabled: booleanValue(saved.qaDailyReminderEnabled, localConfig.qaDailyReminderEnabled),
      answerCacheEnabled: booleanValue(saved.answerCacheEnabled, localConfig.answerCacheEnabled),
      trustedExternalDomains: domainListValue(saved.trustedExternalDomains, localConfig.trustedExternalDomains),
      contactIntentPhrases: phraseListValue(saved.contactIntentPhrases, localConfig.contactIntentPhrases),
      updatedAt: saved.updatedAt,
    };
  } catch (error) {
    console.warn("[EMRN Pulse] Supabase assistant config read skipped", error);
    return localConfig;
  }
}

export async function saveAssistantConfig(input: Partial<AssistantRuntimeConfig>) {
  const current = await readAssistantConfig();
  const config: AssistantRuntimeConfig = {
    aiSearchHelperEnabled: booleanValue(input.aiSearchHelperEnabled, current.aiSearchHelperEnabled),
    siteKnowledgeEnabled: booleanValue(input.siteKnowledgeEnabled, current.siteKnowledgeEnabled),
    externalKnowledgeEnabled: booleanValue(input.externalKnowledgeEnabled, current.externalKnowledgeEnabled),
    showExternalSources: booleanValue(input.showExternalSources, current.showExternalSources),
    knowledgeShadowMode: booleanValue(input.knowledgeShadowMode, current.knowledgeShadowMode),
    qaDailyReminderEnabled: booleanValue(input.qaDailyReminderEnabled, current.qaDailyReminderEnabled),
    answerCacheEnabled: booleanValue(input.answerCacheEnabled, current.answerCacheEnabled),
    trustedExternalDomains: domainListValue(input.trustedExternalDomains, current.trustedExternalDomains),
    contactIntentPhrases: phraseListValue(input.contactIntentPhrases, current.contactIntentPhrases),
    updatedAt: new Date().toISOString(),
  };

  let supabaseSaved: AssistantRuntimeConfig | null = null;
  let supabaseError: unknown = null;
  try {
    supabaseSaved = await saveSupabaseAssistantConfig(config);
  } catch (error) {
    supabaseError = error;
    console.warn("[EMRN Pulse] Supabase assistant config save skipped", error);
  }

  const localSaved = writeConfigFile(supabaseSaved || config);
  if (!supabaseSaved && !localSaved && supabaseError) throw supabaseError;
  return supabaseSaved || config;
}

export function assistantFeatureEnabled(feature: AssistantRuntimeBooleanFeature) {
  return readAssistantConfigSync()[feature];
}

export async function assistantFeatureEnabledAsync(feature: AssistantRuntimeBooleanFeature) {
  return (await readAssistantConfig())[feature];
}

export async function matchesConfiguredContactIntent(text: string) {
  const normalizedText = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalizedText) return false;
  const phrases = (await readAssistantConfig()).contactIntentPhrases;
  return phrases.some((phrase) => normalizedText.includes(phrase) || phrase.includes(normalizedText));
}

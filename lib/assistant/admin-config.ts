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
  updatedAt?: string;
};

function envFlag(name: string, fallback: boolean) {
  const value = process.env[name];
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
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
    updatedAt: new Date().toISOString(),
  };

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  try {
    await saveSupabaseAssistantConfig(config);
  } catch (error) {
    console.warn("[EMRN Pulse] Supabase assistant config save skipped", error);
  }
  return config;
}

export function assistantFeatureEnabled(feature: keyof Omit<AssistantRuntimeConfig, "updatedAt">) {
  return readAssistantConfigSync()[feature];
}

export async function assistantFeatureEnabledAsync(feature: keyof Omit<AssistantRuntimeConfig, "updatedAt">) {
  return (await readAssistantConfig())[feature];
}

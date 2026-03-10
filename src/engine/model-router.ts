import { readFileSync } from "fs";
import { resolve } from "path";
import type { ModelTier } from "../types.js";

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
}

interface ModelsJsonConfig {
  defaults: Record<string, ModelTier>;
  overrides?: Record<string, ModelTier>;
  modelIds: Record<ModelTier, string>;
  pricing: Record<ModelTier, ModelPricing>;
  budgetLimits: {
    perAgent: Record<string, number>;
    perRun: number;
    perDay: number;
  };
}

let _config: ModelsJsonConfig | null = null;

function loadConfig(): ModelsJsonConfig {
  if (_config) return _config;
  const configPath = resolve(import.meta.dirname, "../../config/models.json");
  _config = JSON.parse(readFileSync(configPath, "utf-8"));
  return _config!;
}

export function resolveModelId(tier: ModelTier): string {
  return loadConfig().modelIds[tier];
}

export function getModelForAgent(agentName: string): ModelTier {
  const config = loadConfig();
  const override = process.env[`MODEL_OVERRIDE_${agentName.toUpperCase()}`];
  if (override && isValidTier(override)) return override;
  if (config.overrides?.[agentName]) return config.overrides[agentName];
  return config.defaults[agentName] ?? "sonnet";
}

export function getPricing(tier: ModelTier): ModelPricing {
  return loadConfig().pricing[tier];
}

export function getBudgetLimits() {
  return loadConfig().budgetLimits;
}

export function calculateCost(
  tier: ModelTier,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
): number {
  const p = getPricing(tier);
  return (
    (usage.inputTokens / 1_000_000) * p.inputPer1M +
    (usage.outputTokens / 1_000_000) * p.outputPer1M +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) * p.cacheReadPer1M +
    ((usage.cacheCreationTokens ?? 0) / 1_000_000) * p.cacheWritePer1M
  );
}

function isValidTier(value: string): value is ModelTier {
  return ["haiku", "sonnet", "opus"].includes(value);
}

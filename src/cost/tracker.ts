import type {
  CostAccumulator,
  StepCost,
  ModelTier,
  BudgetLimits,
} from "../types.js";
import { calculateCost, getBudgetLimits } from "../engine/model-router.js";

export function createCostAccumulator(): CostAccumulator {
  return {
    steps: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalUsd: 0,
  };
}

export function trackStep(
  accumulator: CostAccumulator,
  step: string,
  agent: string,
  model: ModelTier,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
): StepCost {
  const costUsd = calculateCost(model, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
  });

  const entry: StepCost = {
    step,
    agent,
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd,
    timestamp: new Date().toISOString(),
  };

  accumulator.steps.push(entry);
  accumulator.totalInputTokens += entry.inputTokens;
  accumulator.totalOutputTokens += entry.outputTokens;
  accumulator.totalCacheReadTokens += entry.cacheReadTokens;
  accumulator.totalCacheCreationTokens += entry.cacheCreationTokens;
  accumulator.totalUsd += costUsd;

  return entry;
}

export function checkBudget(
  accumulator: CostAccumulator,
  agentName: string,
  limits?: BudgetLimits,
): { allowed: boolean; reason?: string } {
  const budgetLimits = limits ?? getBudgetLimits();

  if (accumulator.totalUsd >= budgetLimits.perRun) {
    return {
      allowed: false,
      reason: `Run budget exceeded: $${accumulator.totalUsd.toFixed(4)} >= $${budgetLimits.perRun}`,
    };
  }

  const agentLimit = budgetLimits.perAgent[agentName];
  if (agentLimit) {
    const agentTotal = accumulator.steps
      .filter((s) => s.agent === agentName)
      .reduce((sum, s) => sum + s.costUsd, 0);

    if (agentTotal >= agentLimit) {
      return {
        allowed: false,
        reason: `Agent "${agentName}" budget exceeded: $${agentTotal.toFixed(4)} >= $${agentLimit}`,
      };
    }
  }

  return { allowed: true };
}

export function formatCostReport(accumulator: CostAccumulator): string {
  const byAgent = new Map<string, { cost: number; tokens: number }>();

  for (const step of accumulator.steps) {
    const existing = byAgent.get(step.agent) ?? { cost: 0, tokens: 0 };
    existing.cost += step.costUsd;
    existing.tokens += step.inputTokens + step.outputTokens;
    byAgent.set(step.agent, existing);
  }

  const lines = ["Cost Report:", "─".repeat(50)];
  for (const [agent, data] of byAgent) {
    const pct = accumulator.totalUsd > 0
      ? ((data.cost / accumulator.totalUsd) * 100).toFixed(0)
      : "0";
    lines.push(
      `  ${agent.padEnd(12)} $${data.cost.toFixed(4)} (${pct}%) — ${(data.tokens / 1000).toFixed(1)}K tokens`,
    );
  }
  lines.push("─".repeat(50));
  lines.push(`  TOTAL        $${accumulator.totalUsd.toFixed(4)}`);

  const cacheTokens = accumulator.totalCacheReadTokens;
  if (cacheTokens > 0) {
    lines.push(`  Cache reads:  ${(cacheTokens / 1000).toFixed(1)}K tokens`);
  }

  return lines.join("\n");
}

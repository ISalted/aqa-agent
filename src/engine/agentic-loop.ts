import Anthropic from "@anthropic-ai/sdk";
import { executeTool } from "../tools/index.js";
import { trackStep, checkBudget } from "../cost/tracker.js";
import { resolveModelId } from "./model-router.js";
import type {
  ModelTier,
  ToolDefinition,
  CostAccumulator,
  EffortLevel,
} from "../types.js";

const client = new Anthropic();

export interface AgenticLoopOptions {
  model: ModelTier;
  systemPrompt: string;
  userMessage: string;
  tools: ToolDefinition[];
  effort?: EffortLevel;
  maxTurns?: number;
  costAccumulator: CostAccumulator;
  agentName: string;
  stepName: string;
  cacheSystemPrompt?: boolean;
}

export interface AgenticLoopResult {
  text: string;
  toolCallCount: number;
  turns: number;
  abortReason?: string;
  /** Tool invocations (name + input) from this run, for consumers that need to detect e.g. write_file content */
  toolCalls?: { name: string; input: Record<string, unknown> }[];
}

export async function agenticLoop(
  options: AgenticLoopOptions,
): Promise<AgenticLoopResult> {
  const {
    model,
    systemPrompt,
    userMessage,
    tools,
    effort = "medium",
    maxTurns = 30,
    costAccumulator,
    agentName,
    stepName,
    cacheSystemPrompt = true,
  } = options;

  const modelId = resolveModelId(model);
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: systemPrompt,
      ...(cacheSystemPrompt ? { cache_control: { type: "ephemeral" as const } } : {}),
    },
  ];

  let totalToolCalls = 0;
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const budgetCheck = checkBudget(costAccumulator, agentName);
    if (!budgetCheck.allowed) {
      return {
        text: `Budget exceeded: ${budgetCheck.reason}`,
        toolCallCount: totalToolCalls,
        turns: turn,
        abortReason: budgetCheck.reason,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    }

    const budgetTokens = effortToBudget(effort);
    const response = await client.messages.create({
      model: modelId,
      max_tokens: Math.max(16384, budgetTokens + 4096),
      system,
      messages,
      tools: tools as Anthropic.Tool[],
      thinking: { type: "enabled", budget_tokens: budgetTokens },
    });

    trackStep(costAccumulator, `${stepName}:turn-${turn}`, agentName, model, {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
    });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      return {
        text: textBlock?.text ?? "",
        toolCallCount: totalToolCalls,
        turns: turn + 1,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      return {
        text: textBlock?.text ?? "",
        toolCallCount: totalToolCalls,
        turns: turn + 1,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map(
      (toolUse) => {
        totalToolCalls++;
        toolCalls.push({ name: toolUse.name, input: toolUse.input as Record<string, unknown> });
        const result = executeTool(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
        );
        return {
          type: "tool_result" as const,
          tool_use_id: toolUse.id,
          content: truncateToolResult(result),
        };
      },
    );

    messages.push({ role: "user", content: toolResults });
  }

  return {
    text: "Max turns reached",
    toolCallCount: totalToolCalls,
    turns: maxTurns,
    abortReason: `Reached max turns (${maxTurns})`,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function effortToBudget(effort: EffortLevel): number {
  switch (effort) {
    case "low":
      return 1024;
    case "medium":
      return 4096;
    case "high":
      return 10240;
    case "max":
      return 32768;
  }
}

function truncateToolResult(result: string, maxChars = 30_000): string {
  if (result.length <= maxChars) return result;
  const half = Math.floor(maxChars / 2);
  return (
    result.slice(0, half) +
    `\n\n... [truncated ${result.length - maxChars} chars] ...\n\n` +
    result.slice(-half)
  );
}

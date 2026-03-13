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
  /** Give agent save_notes + complete_phase tools to control handoff */
  enablePhaseTools?: boolean;
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
  /** Concatenated thinking blocks from all turns, for debugging */
  thinking?: string;
  /** Notes saved by agent via save_notes tool */
  savedNotes?: string[];
  /** Summary written by agent via complete_phase tool */
  phaseSummary?: string;
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
    enablePhaseTools = false,
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

  const allTools = enablePhaseTools ? [...tools, SAVE_NOTES_TOOL, COMPLETE_PHASE_TOOL] : tools;

  let totalToolCalls = 0;
  const toolCalls: { name: string; input: Record<string, unknown> }[] = [];
  const allThinking: string[] = [];
  const savedNotes: string[] = [];
  let phaseSummary: string | undefined;
  let phaseComplete = false;

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
      tools: allTools as Anthropic.Tool[],
      thinking: { type: "enabled", budget_tokens: budgetTokens },
    });

    trackStep(costAccumulator, `${stepName}:turn-${turn}`, agentName, model, {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
    });

    // Collect extended thinking blocks from this turn
    const turnThinking = response.content
      .filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking")
      .map((b) => b.thinking);
    if (turnThinking.length > 0) {
      allThinking.push(turn > 0 ? `[turn ${turn + 1}]\n${turnThinking.join("\n")}` : turnThinking.join("\n"));
    }

    const thinking = allThinking.length > 0 ? allThinking.join("\n\n---\n\n") : undefined;

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      return {
        text: textBlock?.text ?? "",
        toolCallCount: totalToolCalls,
        turns: turn + 1,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        thinking,
        savedNotes: savedNotes.length > 0 ? savedNotes : undefined,
        phaseSummary,
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
        thinking,
        savedNotes: savedNotes.length > 0 ? savedNotes : undefined,
        phaseSummary,
      };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map(
      (toolUse) => {
        totalToolCalls++;
        toolCalls.push({ name: toolUse.name, input: toolUse.input as Record<string, unknown> });

        // Phase tools: handled locally, never sent to executeTool
        if (toolUse.name === "save_notes") {
          const { notes } = toolUse.input as { notes: string };
          savedNotes.push(notes);
          return { type: "tool_result" as const, tool_use_id: toolUse.id, content: "Notes saved." };
        }
        if (toolUse.name === "complete_phase") {
          const { summary } = toolUse.input as { summary: string };
          phaseSummary = summary;
          phaseComplete = true;
          return { type: "tool_result" as const, tool_use_id: toolUse.id, content: "Phase complete." };
        }

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

    // Agent called complete_phase — exit immediately after adding tool results
    if (phaseComplete) {
      return {
        text: phaseSummary ?? "",
        toolCallCount: totalToolCalls,
        turns: turn + 1,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        thinking,
        savedNotes: savedNotes.length > 0 ? savedNotes : undefined,
        phaseSummary,
      };
    }

    // Compress old tool results to keep history lean (thinking blocks are preserved — API requires them)
    compressOldToolResults(messages);
  }

  return {
    text: "Max turns reached",
    toolCallCount: totalToolCalls,
    turns: maxTurns,
    abortReason: `Reached max turns (${maxTurns})`,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    thinking: allThinking.length > 0 ? allThinking.join("\n\n---\n\n") : undefined,
    savedNotes: savedNotes.length > 0 ? savedNotes : undefined,
    phaseSummary,
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

/**
 * Compresses tool_result content in older turns to keep message history lean.
 * Keeps the last 2 turns untouched. Thinking blocks are never touched — Anthropic API requires them intact.
 * Each "turn" = assistant message + user/tool_results message (2 entries).
 * messages[0] is the initial user message (never a turn).
 */
function compressOldToolResults(messages: Anthropic.MessageParam[], keepTurns = 2): void {
  // turns start at index 1 (assistant) + 2 (tool_results), each pair = 2 entries
  const turnCount = Math.floor((messages.length - 1) / 2);
  if (turnCount <= keepTurns) return;

  const compressUpTo = messages.length - keepTurns * 2 - 1;
  for (let i = 2; i < compressUpTo; i += 2) {
    // i = user/tool_results message of an old turn
    const userMsg = messages[i];
    if (!userMsg || !Array.isArray(userMsg.content)) continue;
    userMsg.content = (userMsg.content as Anthropic.ToolResultBlockParam[]).map((block) => {
      if (block.type !== "tool_result") return block;
      const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
      if (content.length <= 300) return block;
      return { ...block, content: `[compressed: ${content.length} chars — key data saved to notes]` };
    });
  }
}

// ─── Phase Tools ─────────────────────────────────────────────

const SAVE_NOTES_TOOL: ToolDefinition = {
  name: "save_notes",
  description: "Save key findings or decisions to notes. Notes travel to the next stage. The tool result stored in message history is tiny ('Notes saved.') so history stays lean.",
  input_schema: {
    type: "object",
    properties: {
      notes: { type: "string", description: "Key findings, decisions, or context to preserve for the next stage" },
    },
    required: ["notes"],
  },
};

const COMPLETE_PHASE_TOOL: ToolDefinition = {
  name: "complete_phase",
  description: "Signal that this phase is complete. Stops the loop immediately and passes the summary to the next stage as a structured note.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "What was accomplished and why key decisions were made" },
    },
    required: ["summary"],
  },
};

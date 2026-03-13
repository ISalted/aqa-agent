import { agenticLoop } from "../engine/agentic-loop.js";
import { getModelForAgent } from "../engine/model-router.js";
import { buildCoderContext } from "../rag/context-builder.js";
import { validateGeneratedCode } from "./guardrails.js";
import { basename, join } from "path";
import type {
  NormalizedContract,
  CoverageReport,
  TestPlan,
  CostAccumulator,
  GuardrailResult,
  StepNote,
} from "../types.js";
import { TOOLS_FOR_AGENT } from "../tools/index.js";

export interface WriteTestsResult {
  code: string | null;
  guardrailResult: GuardrailResult | null;
  error?: string;
  thinking?: string;
  savedNotes?: string[];
  phaseSummary?: string;
}

/**
 * LLM step: writes a complete test file based on a plan.
 * Uses Sonnet by default — needs code generation quality.
 * Has tool access to read existing files for reference.
 */
export async function writeTests(
  contract: NormalizedContract,
  coverage: CoverageReport,
  plan: TestPlan,
  skillTradePath: string,
  costAccumulator: CostAccumulator,
  testDir: string,
  notes: StepNote[] = [],
): Promise<WriteTestsResult> {
  const model = getModelForAgent("coder");
  const context = buildCoderContext(contract, coverage, plan.method, skillTradePath);
  const userMessage = formatNotes(notes) + buildCoderPrompt(plan, context, skillTradePath, testDir);

  const result = await agenticLoop({
    model,
    systemPrompt: assembleSystemPrompt(context),
    userMessage,
    tools: TOOLS_FOR_AGENT.coder,
    effort: "high",
    maxTurns: 25,
    costAccumulator,
    agentName: "coder",
    stepName: `write:${plan.method}`,
    enablePhaseTools: true,
  });

  if (result.abortReason) {
    return { code: null, guardrailResult: null, error: result.abortReason, thinking: result.thinking };
  }

  let code = extractCodeBlock(result.text);
  if (!code && result.toolCalls?.length) {
    code = extractCodeFromWriteFileCalls(result.toolCalls, plan.fileName);
  }
  if (!code) {
    return {
      code: null,
      guardrailResult: null,
      error: "Failed to extract code from LLM response",
      thinking: result.thinking,
      savedNotes: result.savedNotes,
      phaseSummary: result.phaseSummary,
    };
  }

  const guardrailResult = validateGeneratedCode(code);
  return { code, guardrailResult, thinking: result.thinking, savedNotes: result.savedNotes, phaseSummary: result.phaseSummary };
}

function buildCoderPrompt(
  plan: TestPlan,
  context: AgentContextLocal,
  skillTradePath: string,
  testDir: string,
): string {
  const targetPath = join(testDir, basename(plan.fileName));
  const parts = [
    `Write a complete Playwright test file for: ${plan.service}.${plan.method}`,
    `Target file path (use this EXACT path when calling write_file): ${targetPath}`,
    `Working directory: ${skillTradePath}`,
    "",
    "## Test Plan",
    JSON.stringify(plan, null, 2),
  ];

  if (context.exampleTest) {
    parts.push(
      "",
      "## Example Test (follow this pattern EXACTLY)",
      "```typescript",
      context.exampleTest,
      "```",
    );
  }

  if (context.wrapperCode) {
    parts.push("", "## Service Wrapper", "```typescript", context.wrapperCode, "```");
  }

  if (context.protoContract) {
    parts.push("", "## Proto Contract", "```protobuf", context.protoContract, "```");
  }

  parts.push(
    "",
    "Write the COMPLETE file. Start with imports, end with the last test.",
    "Use read_file tool to check existing files if you need to verify import paths or patterns.",
    "Use each planned test case ID in the final Playwright test title exactly, e.g. \"UCW-001: ...\".",
    "Output the full TypeScript code.",
  );

  return parts.join("\n");
}

function assembleSystemPrompt(context: AgentContextLocal): string {
  const parts = [context.systemPrompt];

  if (context.skills.length > 0) {
    parts.push("\n## Knowledge Base\n" + context.skills.join("\n---\n"));
  }

  if (context.projectRules) {
    const truncated = context.projectRules.length > 4000
      ? context.projectRules.slice(0, 4000) + "\n... [truncated]"
      : context.projectRules;
    parts.push("\n## Project Rules\n" + truncated);
  }

  return parts.join("\n");
}

type AgentContextLocal = {
  systemPrompt: string;
  skills: string[];
  protoContract?: string | null;
  exampleTest?: string | null;
  wrapperCode?: string | null;
  projectRules: string;
};

function formatNotes(notes: StepNote[]): string {
  if (notes.length === 0) return "";
  return "## Context from previous steps:\n" +
    notes.map((n) => `[${n.phase.toUpperCase()}] ${n.summary}`).join("\n") +
    "\n\n";
}

function extractCodeBlock(text: string): string | null {
  const codeBlockMatch = text.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  if (text.includes("import ") && text.includes("test(")) {
    return text.trim();
  }

  return null;
}

/** If the coder wrote the file via write_file tool instead of outputting code in the message, use that content. */
function extractCodeFromWriteFileCalls(
  toolCalls: { name: string; input: Record<string, unknown> }[],
  expectedFileName: string,
): string | null {
  const fileName = basename(expectedFileName);
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const call = toolCalls[i];
    if (call.name !== "write_file") continue;
    const path = typeof call.input.path === "string" ? call.input.path : "";
    const content = typeof call.input.content === "string" ? call.input.content : "";
    if (!path.endsWith(fileName)) continue;
    if (content.includes("import ") && content.includes("test(")) {
      return content.trim();
    }
  }
  return null;
}

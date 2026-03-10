import { agenticLoop } from "../engine/agentic-loop.js";
import { getModelForAgent } from "../engine/model-router.js";
import { buildCoderContext } from "../rag/context-builder.js";
import { validateGeneratedCode } from "./guardrails.js";
import type {
  NormalizedContract,
  CoverageReport,
  TestPlan,
  CostAccumulator,
  GuardrailResult,
} from "../types.js";
import { TOOLS_FOR_AGENT } from "../tools/index.js";

export interface WriteTestsResult {
  code: string | null;
  guardrailResult: GuardrailResult | null;
  error?: string;
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
): Promise<WriteTestsResult> {
  const model = getModelForAgent("coder");
  const context = buildCoderContext(contract, coverage, plan.method, skillTradePath);
  const userMessage = buildCoderPrompt(plan, context, skillTradePath);

  const result = await agenticLoop({
    model,
    systemPrompt: assembleSystemPrompt(context),
    userMessage,
    tools: TOOLS_FOR_AGENT.coder,
    effort: "high",
    maxTurns: 15,
    costAccumulator,
    agentName: "coder",
    stepName: `write:${plan.method}`,
  });

  if (result.abortReason) {
    return { code: null, guardrailResult: null, error: result.abortReason };
  }

  const code = extractCodeBlock(result.text);
  if (!code) {
    return {
      code: null,
      guardrailResult: null,
      error: "Failed to extract code from LLM response",
    };
  }

  const guardrailResult = validateGeneratedCode(code);
  return { code, guardrailResult };
}

function buildCoderPrompt(
  plan: TestPlan,
  context: AgentContextLocal,
  skillTradePath: string,
): string {
  const parts = [
    `Write a complete Playwright test file for: ${plan.service}.${plan.method}`,
    `File name: ${plan.fileName}`,
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

function extractCodeBlock(text: string): string | null {
  const codeBlockMatch = text.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  if (text.includes("import ") && text.includes("test(")) {
    return text.trim();
  }

  return null;
}

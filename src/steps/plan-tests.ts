import { agenticLoop } from "../engine/agentic-loop.js";
import { getModelForAgent } from "../engine/model-router.js";
import { buildPlannerContext } from "../rag/context-builder.js";
import { validatePlan } from "./guardrails.js";
import type {
  NormalizedContract,
  CoverageReport,
  TestPlan,
  TestCase,
  CostAccumulator,
  GuardrailResult,
  StepNote,
  ManualTestCase,
} from "../types.js";

export interface PlanTestsResult {
  plan: TestPlan | null;
  guardrailResult: GuardrailResult | null;
  error?: string;
  thinking?: string;
  savedNotes?: string[];
  phaseSummary?: string;
  systemPrompt?: string;
}

/**
 * Plan tests for a single RPC method.
 *
 * Two paths:
 *   1. testomatioTests provided → deterministic mapping, zero LLM tokens
 *   2. No testomatio tests → LLM generates the plan
 */
export async function planTests(
  contract: NormalizedContract,
  coverage: CoverageReport,
  method: string,
  skillTradePath: string,
  costAccumulator: CostAccumulator,
  notes: StepNote[] = [],
  testomatioTests: ManualTestCase[] = [],
): Promise<PlanTestsResult> {

  // ─── Path 1: Testomatio-sourced plan (no LLM) ──────────────
  if (testomatioTests.length > 0) {
    const plan = buildPlanFromTestomatio(contract, method, testomatioTests);
    return {
      plan,
      guardrailResult: { valid: true, errors: [], warnings: [] },
    };
  }

  // ─── Path 2: LLM-generated plan ────────────────────────────
  const model = getModelForAgent("planner");
  const context = buildPlannerContext(contract, coverage, method, skillTradePath);
  const userMessage = formatNotes(notes) + buildPlannerPrompt(contract, coverage, method, context);

  const result = await agenticLoop({
    model,
    systemPrompt: assembleSystemPrompt(context),
    userMessage,
    tools: [],
    effort: "medium",
    maxTurns: 3,
    costAccumulator,
    agentName: "planner",
    stepName: `plan:${method}`,
    enablePhaseTools: true,
  });

  if (result.abortReason) {
    return { plan: null, guardrailResult: null, error: result.abortReason, thinking: result.thinking };
  }

  const plan = extractJson<TestPlan>(result.text);
  if (!plan) {
    return {
      plan: null,
      guardrailResult: null,
      error: `Failed to parse plan JSON from LLM response`,
      savedNotes: result.savedNotes,
    };
  }

  const guardrailResult = validatePlan(plan);
  return {
    plan,
    guardrailResult,
    thinking: result.thinking,
    savedNotes: result.savedNotes,
    phaseSummary: result.phaseSummary,
    systemPrompt: assembleSystemPrompt(context),
  };
}

// ─── Testomatio → TestPlan (deterministic) ───────────────────

function buildPlanFromTestomatio(
  contract: NormalizedContract,
  method: string,
  tests: ManualTestCase[],
): TestPlan {
  const serviceName = contract.intentName ?? contract.service;
  const prefix = methodToPrefix(method);
  const fileName = `${method.charAt(0).toLowerCase()}${method.slice(1)}.test.ts`;

  // Schema test is always first — required by the implementer
  const schemaTest: TestCase = {
    id: `${prefix}-001`,
    type: "schema",
    priority: "P1",
    name: `${prefix}-001: Schema validation for ${method} response structure`,
    description: `Verify the ${method} response matches the expected proto schema`,
    expectedBehavior: "Response matches proto schema with all required fields",
  };

  const testCases: TestCase[] = [schemaTest];

  tests.forEach((t, i) => {
    const id = `${prefix}-${String(i + 2).padStart(3, "0")}`;
    const cleanTitle = t.title.replace(/@[\w-]+/g, "").trim();
    const expectedBehavior = extractExpected(t.description);

    testCases.push({
      id,
      type: inferType(t.tags ?? []),
      priority: inferPriority(t.tags ?? []),
      name: `${id}: ${cleanTitle}`,
      description: t.description ?? cleanTitle,
      expectedBehavior: expectedBehavior || cleanTitle,
    });
  });

  return { service: serviceName, method, fileName, testCases };
}

/**
 * Convert PascalCase method name to 3-letter uppercase prefix.
 * CancelContest → CAN, CreateContest → CCO, RegisterToContest → RTC
 */
function methodToPrefix(method: string): string {
  const words = method.match(/[A-Z][a-z]*/g) ?? [method.slice(0, 3).toUpperCase()];
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  if (words.length === 2) return (words[0].slice(0, 2) + words[1].slice(0, 1)).toUpperCase();
  return words.map((w) => w[0]).join("").slice(0, 3).toUpperCase();
}

function inferType(tags: string[]): TestCase["type"] {
  const lower = tags.map((t) => t.toLowerCase());
  if (lower.some((t) => t === "happy-path" || t === "positive")) return "positive";
  if (lower.some((t) => t === "negative")) return "negative";
  if (lower.some((t) => t === "edge-case" || t === "edge")) return "edge";
  if (lower.some((t) => t === "boundary")) return "boundary";
  return "positive";
}

function inferPriority(tags: string[]): TestCase["priority"] {
  const lower = tags.map((t) => t.toLowerCase());
  if (lower.some((t) => t === "smoke" || t === "critical")) return "P1";
  if (lower.some((t) => t === "low")) return "P3";
  return "P2";
}

/**
 * Extract the "Expected result:" section from a Testomatio description.
 */
function extractExpected(description?: string): string {
  if (!description) return "";
  const lines = description.split("\n");
  const idx = lines.findIndex((l) => /expected result:/i.test(l));
  if (idx === -1) return "";
  return lines
    .slice(idx)
    .join("\n")
    .replace(/^expected result:\s*/i, "")
    .trim();
}

// ─── LLM path helpers ────────────────────────────────────────

function buildPlannerPrompt(
  contract: NormalizedContract,
  coverage: CoverageReport,
  method: string,
  context: AgentContextLocal,
): string {
  const methodDef = contract.methods.find((m) => m.name === method);
  const inputMsg = contract.messages.find((m) => m.name === methodDef?.inputType);
  const outputMsg = contract.messages.find((m) => m.name === methodDef?.outputType);

  const serviceName = contract.intentName ?? contract.service;
  return `Create a test plan for method "${method}" of service "${serviceName}".

## Proto Contract
\`\`\`protobuf
${context.protoContract ?? "Not available"}
\`\`\`

## Method Details
- RPC: ${methodDef?.name ?? method}
- Input: ${methodDef?.inputType ?? "unknown"} (${inputMsg?.fields.length ?? 0} fields)
- Output: ${methodDef?.outputType ?? "unknown"} (${outputMsg?.fields.length ?? 0} fields)

## Input Message Fields
${inputMsg?.fields.map((f) => `- ${f.name}: ${f.type} (${f.optional ? "optional" : "required"}${f.repeated ? ", repeated" : ""})`).join("\n") ?? "N/A"}

## Output Message Fields
${outputMsg?.fields.map((f) => `- ${f.name}: ${f.type} (${f.optional ? "optional" : "required"}${f.repeated ? ", repeated" : ""})`).join("\n") ?? "N/A"}

## Existing Coverage
- Total methods in service: ${coverage.totalMethods}
- Already covered: ${coverage.coveredMethods.map((c) => c.method).join(", ") || "none"}
- Uncovered: ${coverage.uncoveredMethods.join(", ")}

## Enums Available
${contract.enums.map((e) => `- ${e.name}: ${e.values.map((v) => v.name).join(", ")}`).join("\n") || "None"}

Output ONLY the JSON test plan. No markdown, no explanations.`;
}

function assembleSystemPrompt(context: AgentContextLocal): string {
  const parts = [context.systemPrompt];
  if (context.skills.length > 0) {
    parts.push("\n## Knowledge Base\n" + context.skills.join("\n---\n"));
  }
  if (context.projectRules) {
    parts.push("\n## Project Rules\n" + context.projectRules);
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

function extractJson<T>(text: string): T | null {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

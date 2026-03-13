import { agenticLoop } from "../engine/agentic-loop.js";
import { getModelForAgent } from "../engine/model-router.js";
import { buildPlannerContext } from "../rag/context-builder.js";
import { validatePlan } from "./guardrails.js";
import type {
  NormalizedContract,
  CoverageReport,
  TestPlan,
  CostAccumulator,
  GuardrailResult,
  StepNote,
} from "../types.js";

export interface PlanTestsResult {
  plan: TestPlan | null;
  guardrailResult: GuardrailResult | null;
  error?: string;
  thinking?: string;
  savedNotes?: string[];
  phaseSummary?: string;
}

/**
 * LLM step: generates a test plan for a single RPC method.
 * Uses Haiku by default (cheap, structured output).
 */
export async function planTests(
  contract: NormalizedContract,
  coverage: CoverageReport,
  method: string,
  skillTradePath: string,
  costAccumulator: CostAccumulator,
  notes: StepNote[] = [],
): Promise<PlanTestsResult> {
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
  return { plan, guardrailResult, thinking: result.thinking, savedNotes: result.savedNotes, phaseSummary: result.phaseSummary };
}

function buildPlannerPrompt(
  contract: NormalizedContract,
  coverage: CoverageReport,
  method: string,
  context: AgentContextLocal,
): string {
  const methodDef = contract.methods.find((m) => m.name === method);
  const inputMsg = contract.messages.find((m) => m.name === methodDef?.inputType);
  const outputMsg = contract.messages.find((m) => m.name === methodDef?.outputType);

  // Use intentName (from proto filename) for naming — it's the canonical identifier,
  // resilient to typos in proto's service declaration (e.g. ContestEngine vs MissionEngine).
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

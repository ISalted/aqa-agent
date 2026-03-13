import { agenticLoop } from "../engine/agentic-loop.js";
import { getModelForAgent } from "../engine/model-router.js";
import { buildDebuggerContext } from "../rag/context-builder.js";
import { validateGeneratedCode } from "./guardrails.js";
import {
  findMatchingPattern,
  recordFailurePattern,
} from "../memory/failure-patterns.js";
import type {
  NormalizedContract,
  CoverageReport,
  TestResult,
  CostAccumulator,
  ClassifiedFailure,
  FailureClass,
  GuardrailResult,
  StepNote,
} from "../types.js";
import { TOOLS_FOR_AGENT } from "../tools/index.js";

export interface DebugResult {
  fixedCode: string | null;
  failures: ClassifiedFailure[];
  guardrailResult: GuardrailResult | null;
  error?: string;
}

/**
 * LLM step: diagnoses failing tests and produces fixes.
 * First checks known failure patterns (memory), then uses LLM.
 */
export async function debugTests(
  contract: NormalizedContract,
  coverage: CoverageReport,
  testFile: string,
  testResult: TestResult,
  skillTradePath: string,
  costAccumulator: CostAccumulator,
  notes: StepNote[] = [],
): Promise<DebugResult> {
  const classified = classifyFailures(testResult);

  const autoFixable = classified.filter((f) => f.autoFixable);
  if (autoFixable.length === classified.length && autoFixable.length > 0) {
    return {
      fixedCode: null,
      failures: classified,
      guardrailResult: null,
      error: `All ${autoFixable.length} failures are auto-fixable but require infra fixes, not code changes`,
    };
  }

  const model = getModelForAgent("debugger");
  const context = buildDebuggerContext(contract, coverage, skillTradePath);
  const userMessage = formatNotes(notes) + buildDebugPrompt(testFile, testResult, classified, skillTradePath);

  const result = await agenticLoop({
    model,
    systemPrompt: context.systemPrompt,
    userMessage,
    tools: TOOLS_FOR_AGENT.debugger,
    effort: "high",
    maxTurns: 20,
    costAccumulator,
    agentName: "debugger",
    stepName: `debug:${testResult.file}`,
  });

  for (const failure of classified) {
    if (failure.diagnosis) {
      recordFailurePattern(
        failure.error,
        failure.failureClass,
        failure.diagnosis,
        result.text.slice(0, 200),
      );
    }
  }

  if (result.abortReason) {
    return {
      fixedCode: null,
      failures: classified,
      guardrailResult: null,
      error: result.abortReason,
    };
  }

  const code = extractCodeBlock(result.text);
  const guardrailResult = code ? validateGeneratedCode(code) : null;

  return { fixedCode: code, failures: classified, guardrailResult };
}

function formatNotes(notes: StepNote[]): string {
  if (notes.length === 0) return "";
  return "## Context from previous steps:\n" +
    notes.map((n) => `[${n.phase.toUpperCase()}] ${n.summary}`).join("\n") +
    "\n\n";
}

function classifyFailures(testResult: TestResult): ClassifiedFailure[] {
  return testResult.errors.map((error) => {
    const knownPattern = findMatchingPattern(error);
    if (knownPattern) {
      return {
        failureClass: knownPattern.failureClass,
        error,
        autoFixable: knownPattern.failureClass === "F_INFRA",
        strategy: determineStrategy(knownPattern.failureClass),
        diagnosis: knownPattern.diagnosis,
      };
    }

    const failureClass = inferFailureClass(error.message);
    return {
      failureClass,
      error,
      autoFixable: false,
      strategy: determineStrategy(failureClass),
    };
  });
}

function inferFailureClass(message: string): FailureClass {
  const lower = message.toLowerCase();

  if (lower.includes("import") || lower.includes("module not found") || lower.includes("cannot find")) {
    return "D_LOGIC";
  }
  if (lower.includes("timeout") || lower.includes("econnrefused") || lower.includes("unavailable")) {
    return "F_INFRA";
  }
  if (lower.includes("schema") || lower.includes("validation") || lower.includes("checker")) {
    return "C_STALE";
  }
  if (lower.includes("undefined") || lower.includes("null") || lower.includes("type")) {
    return "D_LOGIC";
  }
  if (lower.includes("not implemented") || lower.includes("unimplemented")) {
    return "G_SPEC";
  }

  return "D_LOGIC";
}

function determineStrategy(
  failureClass: FailureClass,
): "auto-fix" | "llm-debug" | "skip-report" | "escalate" {
  switch (failureClass) {
    case "F_INFRA":
      return "skip-report";
    case "G_SPEC":
      return "escalate";
    case "E_MODEL":
      return "escalate";
    case "A_PROMPT":
    case "B_KNOWLEDGE":
    case "C_STALE":
    case "D_LOGIC":
      return "llm-debug";
  }
}

function buildDebugPrompt(
  testFile: string,
  testResult: TestResult,
  classified: ClassifiedFailure[],
  skillTradePath: string,
): string {
  const errorSummary = classified
    .map(
      (f) =>
        `[${f.failureClass}] ${f.error.testName}: ${f.error.message}${f.diagnosis ? ` (known: ${f.diagnosis})` : ""}`,
    )
    .join("\n");

  return `Fix the failing test file: ${testFile}
Working directory: ${skillTradePath}

## Test Results
- Passed: ${testResult.passed}
- Failed: ${testResult.failed}
- Errors:
${errorSummary}

## Stack Traces
${testResult.errors.map((e) => `### ${e.testName}\n${e.stack ?? "No stack trace"}`).join("\n\n")}

Steps:
1. Read the test file using read_file
2. Read the proto contract and service wrapper
3. Diagnose the root cause of each failure
4. Write the corrected file using write_file

After fixing, output the complete corrected file content.`;
}

function extractCodeBlock(text: string): string | null {
  const codeBlockMatch = text.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  if (text.includes("import ") && text.includes("test(")) {
    return text.trim();
  }

  return null;
}

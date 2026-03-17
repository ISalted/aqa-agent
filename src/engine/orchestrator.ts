import { randomUUID } from "crypto";
import { createCostAccumulator, formatCostReport } from "../cost/tracker.js";
import { updateServiceIndex } from "../memory/project-index.js";
import { appendRunHistory, saveRunLedger } from "../memory/run-history.js";
import {
  savePlanArtifacts,
  loadPlanArtifacts,
} from "../memory/resumable-context.js";
import { saveLastImplementRun } from "../memory/resumable-context.js";
import { emitPipelineEvent } from "../events.js";
import { transition } from "./state-machine.js";
import { runSetupPhases } from "./pipeline-setup.js";
import {
  processValidateOnly,
  processFix,
  processPlan,
  processImplement,
} from "./pipeline-actions.js";
import type {
  RunState,
  ParsedIntent,
  MethodResult,
  RunLedger,
  LedgerFact,
  LedgerDecision,
  LedgerAttempt,
  RunHistoryEntry,
  TestPlan,
} from "../types.js";

// ─── Entry Point ─────────────────────────────────────────────

export async function runPipeline(
  intent: ParsedIntent,
  signal?: AbortSignal,
): Promise<void> {
  const skillTradePath = process.env.SKILL_TRADE_PATH;
  if (!skillTradePath) throw new Error("SKILL_TRADE_PATH not set in .env");

  const state: RunState = {
    runId: randomUUID().slice(0, 8),
    startedAt: new Date().toISOString(),
    phase: "init",
    service: intent.service,
    intent,
    understandContext: null,
    infrastructure: null,
    contract: null,
    coverage: null,
    currentMethodIndex: 0,
    methodResults: [],
    cost: createCostAccumulator(),
    retries: 0,
    maxRetries: 2,
    notes: [],
  };

  const ledgerFacts: LedgerFact[] = [];
  const ledgerDecisions: LedgerDecision[] = [];
  const ledgerAttempts: LedgerAttempt[] = [];
  const startMs = Date.now();

  log(state, "Pipeline started");
  emitPipelineEvent("started", state.runId, {
    service: state.service,
    action: state.intent.action,
    methods: state.intent.methods,
  });

  try {
    // ─── Setup: resolve → parse → coverage ───────────────────
    await runSetupPhases(state, skillTradePath, ledgerFacts, signal);

    // ─── Analyze: no implementation, just report ──────────────
    if (intent.action === "analyze") {
      state.methodResults = state.coverage!.uncoveredMethods.map((method) => ({
        method, plan: null, testFile: null, result: null,
        failures: [], attempts: 0, cost: 0, status: "analyzed",
      }));
      updateMemory(state);
      transition(state, "done", "action=analyze: no implementation requested");
      log(state, "Analysis complete (no implementation requested)");
      printCoverageSummary(state);
      return;
    }

    // ─── Load saved plans for implement_only ─────────────────
    let savedPlansForResume: Record<string, TestPlan> | null = null;
    if (intent.action === "implement_only") {
      savedPlansForResume = loadPlanArtifacts(intent.service);
      if (!savedPlansForResume || Object.keys(savedPlansForResume).length === 0) {
        throw new Error(`No saved plans for service "${intent.service}". Run plan first.`);
      }
    }

    // ─── Select methods to process ────────────────────────────
    const methodsToProcess = selectMethods(state, savedPlansForResume);
    if (methodsToProcess.length === 0) {
      updateMemory(state);
      transition(state, "done", methodsToProcess.length === 0
        ? (intent.action === "validate_only" ? "no test files found" : "all methods already covered")
        : "no methods to process");
      log(state, intent.action === "validate_only"
        ? "No test files found for this service."
        : "All methods already covered! Nothing to do.");
      return;
    }

    ledgerDecisions.push({
      what: `Processing ${methodsToProcess.length} methods via action "${intent.action}"`,
      why: decideWhy(intent.action),
      alternatives: ["Skip already covered", "Regenerate all"],
    });

    // ─── State Machine: per-method loop ───────────────────────
    for (let i = 0; i < methodsToProcess.length; i++) {
      if (signal?.aborted) throw new Error("Pipeline aborted by user");
      const method = methodsToProcess[i];
      state.currentMethodIndex = i;

      const ctx = { skillTradePath, methodIndex: i, totalMethods: methodsToProcess.length, ledgerAttempts, signal };

      let methodResult: MethodResult;
      switch (intent.action) {
        case "validate_only":
          methodResult = processValidateOnly(state, method, ctx);
          break;
        case "fix":
          methodResult = await processFix(state, method, ctx);
          break;
        case "plan":
          methodResult = await processPlan(state, method, ctx);
          break;
        case "implement_only": {
          methodResult = await processImplement(state, method, ctx, savedPlansForResume![method]);
          break;
        }
        default: { // null = full pipeline: plan → implement
          const planResult = await processPlan(state, method, ctx);
          if (planResult.plan) {
            const implResult = await processImplement(state, method, ctx, planResult.plan);
            implResult.cost += planResult.cost;
            methodResult = implResult;
          } else {
            methodResult = planResult;
          }
          break;
        }
      }

      state.methodResults.push(methodResult);
    }

    // ─── Save & Report ────────────────────────────────────────
    const passed = state.methodResults.filter((m) => m.status === "passed").length;
    transition(state, "save", `methods loop done: ${passed}/${state.methodResults.length} passed`);
    if (intent.action === "plan") {
      savePlanArtifacts(state.service, state.runId, state.methodResults,
        state.infrastructure ? { protoPath: state.infrastructure.protoPath, testDir: state.infrastructure.testDir } : undefined);
    }
    if (intent.action === null || intent.action === "implement_only") {
      saveLastImplementRun(state.service, state.runId, state.methodResults);
    }
    updateMemory(state);

    transition(state, "report", "artifacts saved");
    printReport(state);

    transition(state, "done", "report printed");
    log(state, "Pipeline complete");

  } catch (error) {
    if ((error as Error).message === "Pipeline aborted by user") {
      transition(state, "stopped", "user aborted");
      log(state, "Pipeline stopped by user");
      emitPipelineEvent("aborted", state.runId, { phase: state.phase, service: state.service, totalCost: state.cost.totalUsd });
    } else {
      transition(state, "failed", (error as Error).message);
      log(state, `FATAL: ${(error as Error).message}`);
      throw error;
    }
  } finally {
    const durationMs = Date.now() - startMs;
    saveLedger(state, ledgerFacts, ledgerDecisions, ledgerAttempts, durationMs);
    console.log("\n" + formatCostReport(state.cost));
    console.log(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
    emitPipelineEvent("complete", state.runId, {
      phase: state.phase,
      action: state.intent.action,
      service: state.service,
      totalCost: state.cost.totalUsd,
      durationMs,
      totalInputTokens: state.cost.totalInputTokens,
      totalOutputTokens: state.cost.totalOutputTokens,
      summary: buildCompletionSummary(state),
      methods: state.methodResults.map(serializeMethodResult),
      costByAgent: buildCostByAgent(state),
      costByPhase: buildCostByPhase(state),
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function selectMethods(
  state: RunState,
  savedPlansForResume?: Record<string, TestPlan> | null,
): string[] {
  const { intent, coverage } = state;
  if (!coverage) return [];

  if (intent.action === "implement_only" && savedPlansForResume) {
    if (intent.methods && intent.methods.length > 0) {
      return intent.methods.filter((m) => savedPlansForResume[m]);
    }
    return Object.keys(savedPlansForResume);
  }

  if (intent.action === "validate_only") return coverage.coveredMethods.map((c) => c.method);
  if (intent.methods && intent.methods.length > 0) return intent.methods;

  switch (intent.action) {
    case null:   return coverage.uncoveredMethods;
    case "fix":   return coverage.coveredMethods.map((c) => c.method);
    case "plan":  return coverage.uncoveredMethods;
    default:      return coverage.uncoveredMethods;
  }
}

function decideWhy(action: string | null): string {
  switch (action) {
    case null:            return "Running full pipeline";
    case "implement_only": return "Using saved plans from previous plan run";
    case "validate_only":  return "Running tests only (no write, no debug)";
    case "fix":            return "User requested fix of failing tests";
    case "plan":           return "User requested plan generation only";
    default:               return "User requested";
  }
}

function updateMemory(state: RunState): void {
  if (!state.contract || !state.coverage) return;

  const passedMethods = state.methodResults.filter((m) => m.status === "passed");
  const newCoverage = Math.round(
    ((state.coverage.coveredMethods.length + passedMethods.length) / state.contract.methods.length) * 100,
  );

  updateServiceIndex(state.service, {
    protoFile: state.infrastructure?.protoPath ?? "",
    methods: state.contract.methods.map((m) => m.name),
    wrapperExists: !!state.infrastructure?.wrapperPath,
    typesExist: !!state.infrastructure?.typesPath,
    testFiles: state.methodResults.filter((m) => m.testFile).map((m) => m.testFile!),
    coveragePercent: newCoverage,
  });

  const historyEntry: RunHistoryEntry = {
    runId: state.runId,
    timestamp: state.startedAt,
    service: state.service,
    action: state.intent.action,
    methodsCovered: passedMethods.length,
    totalMethods: state.contract.methods.length,
    testsCreated: state.methodResults.filter((m) => m.testFile).length,
    testsPassed: passedMethods.length,
    testsFailed: state.methodResults.filter((m) => m.status === "failed").length,
    totalCostUsd: state.cost.totalUsd,
    durationMs: Date.now() - new Date(state.startedAt).getTime(),
  };
  appendRunHistory(historyEntry);
}

function saveLedger(state: RunState, facts: LedgerFact[], decisions: LedgerDecision[], attempts: LedgerAttempt[], durationMs: number): void {
  const passedCount = state.methodResults.filter((m) => m.status === "passed").length;
  const totalCount = state.methodResults.length;

  const ledger: RunLedger = {
    runId: state.runId,
    task: state.intent.raw,
    scope: { service: state.service, methods: state.methodResults.map((m) => m.method) },
    facts,
    decisions,
    attempts,
    failures: state.methodResults.flatMap((m) => m.failures),
    cost: state.cost,
    finalVerdict: state.phase === "failed" ? "aborted" : passedCount === totalCount ? "accepted" : passedCount > 0 ? "partial" : "rejected",
    startedAt: state.startedAt,
    completedAt: new Date().toISOString(),
  };
  saveRunLedger(ledger);
}

function serializeMethodResult(mr: MethodResult) {
  return {
    method: mr.method, status: mr.status, cost: mr.cost, attempts: mr.attempts,
    passed: mr.result?.passed ?? 0, failed: mr.result?.failed ?? 0, testFile: mr.testFile,
    plan: mr.plan ? { fileName: mr.plan.fileName, totalCases: mr.plan.testCases.length + 1, schemaTest: mr.plan.schemaTest, testCases: mr.plan.testCases } : null,
  };
}

function buildCompletionSummary(state: RunState) {
  const passed = state.methodResults.filter((m) => m.status === "passed").length;
  const failed = state.methodResults.filter((m) => m.status === "failed").length;
  return {
    action: state.intent.action,
    totalMethods: state.contract?.methods.length ?? 0,
    coveredCount: state.coverage?.coveredMethods.length ?? 0,
    uncoveredCount: state.coverage?.uncoveredMethods.length ?? 0,
    uncoveredMethods: state.coverage?.uncoveredMethods ?? [],
    coveragePercent: state.coverage?.coveragePercent ?? 0,
    processedCount: state.methodResults.length,
    plannedCount: state.methodResults.filter((m) => m.status === "planned").length,
    passedCount: passed,
    failedCount: failed,
    analyzedCount: state.methodResults.filter((m) => m.status === "analyzed").length,
    skippedCount: state.methodResults.filter((m) => m.status === "skipped").length,
    testsCreated: state.methodResults.filter((m) => m.testFile).length,
    testsPassedTotal: state.methodResults.reduce((s, m) => s + (m.result?.passed ?? 0), 0),
    testsFailedTotal: state.methodResults.reduce((s, m) => s + (m.result?.failed ?? 0), 0),
  };
}

function buildCostByAgent(state: RunState): Record<string, number> {
  return Object.fromEntries(
    state.cost.steps.reduce((acc, s) => {
      acc.set(s.agent, (acc.get(s.agent) ?? 0) + s.costUsd);
      return acc;
    }, new Map<string, number>()),
  );
}

function buildCostByPhase(state: RunState): Record<string, number> {
  return Object.fromEntries(
    state.cost.steps.reduce((acc, s) => {
      const prefix = s.step.split(":")[0];
      const phase = prefix === "write" ? "implement" : prefix;
      acc.set(phase, (acc.get(phase) ?? 0) + s.costUsd);
      return acc;
    }, new Map<string, number>()),
  );
}

function printReport(state: RunState): void {
  console.log("\n" + "═".repeat(60));
  console.log(`Run ${state.runId} — ${state.service}`);
  console.log("═".repeat(60));
  for (const mr of state.methodResults) {
    const icon = mr.status === "passed" ? "✅" : mr.status === "failed" ? "❌" : "⏭️";
    console.log(`  ${icon} ${mr.method}: ${mr.status} (${mr.attempts} attempts) — $${mr.cost.toFixed(4)}`);
    if (mr.result && mr.result.passed > 0) {
      console.log(`     ${mr.result.passed} passed, ${mr.result.failed} failed`);
    }
  }
  console.log("─".repeat(60));
  const passed = state.methodResults.filter((m) => m.status === "passed").length;
  console.log(`Result: ${passed}/${state.methodResults.length} methods passed`);
}

function printCoverageSummary(state: RunState): void {
  if (!state.coverage) return;
  console.log("\n" + "═".repeat(60));
  console.log(`Coverage Report — ${state.service}`);
  console.log("═".repeat(60));
  console.log(`  Total: ${state.coverage.totalMethods}, Covered: ${state.coverage.coveredMethods.length}, Uncovered: ${state.coverage.uncoveredMethods.length}`);
  console.log(`  Coverage: ${state.coverage.coveragePercent}%`);
  if (state.coverage.uncoveredMethods.length > 0) {
    console.log(`\n  Uncovered: ${state.coverage.uncoveredMethods.join(", ")}`);
  }
}

function log(state: RunState, msg: string): void {
  const elapsed = ((Date.now() - new Date(state.startedAt).getTime()) / 1000).toFixed(1);
  console.log(`[${state.runId}] [${elapsed}s] [${state.phase}] ${msg}`);
  emitPipelineEvent("log", state.runId, {
    phase: state.phase, message: msg,
    elapsed: parseFloat(elapsed), cost: state.cost.totalUsd,
  });
}

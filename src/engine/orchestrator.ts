import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { createCostAccumulator, formatCostReport } from "../cost/tracker.js";
import { resolveService } from "../steps/resolve-service.js";
import { parseContract } from "../steps/parse-contract.js";
import { analyzeCoverage } from "../steps/analyze-coverage.js";
import { planTests } from "../steps/plan-tests.js";
import { writeTests } from "../steps/write-tests.js";
import { runTests } from "../steps/run-tests.js";
import { debugTests } from "../steps/debug-tests.js";
import { validatePlan, validateGeneratedCode } from "../steps/guardrails.js";
import {
  updateServiceIndex,
} from "../memory/project-index.js";
import { appendRunHistory, saveRunLedger } from "../memory/run-history.js";
import { emitPipelineEvent } from "../events.js";
import type {
  RunState,
  ParsedIntent,
  MethodResult,
  Phase,
  RunLedger,
  LedgerFact,
  LedgerDecision,
  LedgerAttempt,
  RunHistoryEntry,
} from "../types.js";

const MAX_DEBUG_RETRIES = 2;

export async function runPipeline(intent: ParsedIntent): Promise<void> {
  const skillTradePath = process.env.SKILL_TRADE_PATH;
  if (!skillTradePath) {
    throw new Error("SKILL_TRADE_PATH not set in .env");
  }

  const state: RunState = {
    runId: randomUUID().slice(0, 8),
    startedAt: new Date().toISOString(),
    phase: "init",
    service: intent.service,
    intent,
    infrastructure: null,
    contract: null,
    coverage: null,
    currentMethodIndex: 0,
    methodResults: [],
    cost: createCostAccumulator(),
    retries: 0,
    maxRetries: MAX_DEBUG_RETRIES,
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
    // ─── Phase: Resolve Infrastructure ──────────────────────
    state.phase = "resolve";
    const isReadOnly = intent.action === "analyze" || intent.action === "plan";
    log(state, `Resolving service infrastructure${isReadOnly ? " (read-only)" : ""}...`);

    state.infrastructure = await resolveService(
      intent.service,
      skillTradePath,
      state.cost,
      { readOnly: isReadOnly },
    );

    ledgerFacts.push({
      what: `Service ${intent.service}: ${state.infrastructure.missingComponents.length} missing components`,
      source: "resolve-service",
      confirmed: true,
    });

    if (state.infrastructure.missingComponents.includes("proto")) {
      throw new Error(
        `Proto file not found for service "${intent.service}" even after sync attempt`,
      );
    }

    // ─── Phase: Parse Contract ──────────────────────────────
    state.phase = "parse";
    log(state, "Parsing proto contract...");

    state.contract = parseContract(state.infrastructure.protoPath, intent.service);
    ledgerFacts.push({
      what: `Contract: ${state.contract.methods.length} methods, ${state.contract.messages.length} messages`,
      source: state.infrastructure.protoPath,
      confirmed: true,
    });

    log(state, `Found ${state.contract.methods.length} methods: ${state.contract.methods.map((m) => m.name).join(", ")}`);

    // ─── Phase: Analyze Coverage ────────────────────────────
    state.phase = "coverage";
    log(state, "Analyzing test coverage...");

    state.coverage = analyzeCoverage(state.contract, skillTradePath);
    ledgerFacts.push({
      what: `Coverage: ${state.coverage.coveragePercent}% (${state.coverage.coveredMethods.length}/${state.coverage.totalMethods})`,
      source: "analyze-coverage",
      confirmed: true,
    });

    log(state, `Coverage: ${state.coverage.coveragePercent}% — uncovered: ${state.coverage.uncoveredMethods.join(", ") || "none"}`);

    if (intent.action === "analyze") {
      state.methodResults = buildAnalyzeMethodResults(state);
      updateMemory(state);
      state.phase = "done";
      log(state, "Analysis complete (no implementation requested)");
      printCoverageSummary(state);
      return;
    }

    const methodsToProcess = selectMethods(state);
    if (methodsToProcess.length === 0) {
      updateMemory(state);
      state.phase = "done";
      log(state, "All methods already covered! Nothing to do.");
      return;
    }

    ledgerDecisions.push({
      what: `Processing ${methodsToProcess.length} methods`,
      why: intent.action === "cover" ? "Uncovered methods found" : "User requested",
      alternatives: ["Skip already covered", "Regenerate all"],
    });

    // ─── Per-Method Loop ────────────────────────────────────
    for (let i = 0; i < methodsToProcess.length; i++) {
      const method = methodsToProcess[i];
      state.currentMethodIndex = i;

      const methodResult: MethodResult = {
        method,
        plan: null,
        testFile: null,
        result: null,
        failures: [],
        attempts: 0,
        cost: 0,
        status: "pending",
      };
      state.methodResults.push(methodResult);

      const costBefore = state.cost.totalUsd;

      // ─── Fix: re-run existing tests and debug failures ─
      if (intent.action === "fix") {
        const existingTest = state.coverage!.coveredMethods.find(
          (c) => c.method === method,
        );
        if (!existingTest) {
          methodResult.status = "skipped";
          log(state, `  No existing test file for ${method}, skipping fix`);
          methodResult.cost = state.cost.totalUsd - costBefore;
          emitMethodResult(state, methodResult);
          continue;
        }

        state.phase = "validate";
        log(state, `[${i + 1}/${methodsToProcess.length}] Fixing: ${method}`);
        log(state, `  Running existing test: ${existingTest.testFile}`);

        methodResult.testFile = existingTest.testFile;
        methodResult.attempts++;
        let currentTestResult = runTests(existingTest.testFile, skillTradePath);
        methodResult.result = currentTestResult;

        if (currentTestResult.failed === 0 && currentTestResult.passed > 0) {
          methodResult.status = "passed";
          log(state, `  Already passing: ${currentTestResult.passed} tests`);
          methodResult.cost = state.cost.totalUsd - costBefore;
          emitMethodResult(state, methodResult);
          continue;
        }

        state.phase = "debug";
        let debugAttempt = 0;
        while (debugAttempt < MAX_DEBUG_RETRIES && currentTestResult.failed > 0) {
          debugAttempt++;
          log(state, `  Debug attempt ${debugAttempt}/${MAX_DEBUG_RETRIES}...`);

          const debugResult = await debugTests(
            state.contract!,
            state.coverage!,
            existingTest.testFile,
            currentTestResult,
            skillTradePath,
            state.cost,
          );

          methodResult.failures.push(...debugResult.failures);

          if (debugResult.fixedCode) {
            writeFileSync(existingTest.testFile, debugResult.fixedCode);
            methodResult.attempts++;
            currentTestResult = runTests(existingTest.testFile, skillTradePath);
            methodResult.result = currentTestResult;

            if (currentTestResult.failed === 0 && currentTestResult.passed > 0) {
              methodResult.status = "passed";
              log(state, `  FIXED: ${currentTestResult.passed} tests now pass`);
              break;
            }
          } else {
            log(state, `  Debug produced no fix: ${debugResult.error}`);
            break;
          }
        }

        if (methodResult.status !== "passed") {
          methodResult.status = "failed";
          log(state, `  Still failing after ${debugAttempt} debug attempts`);
        }

        methodResult.cost = state.cost.totalUsd - costBefore;
        emitMethodResult(state, methodResult);
        continue;
      }

      // ─── Plan ─────────────────────────────────────────
      if (intent.action === "plan") {
        state.phase = "plan";
        log(state, `[${i + 1}/${methodsToProcess.length}] Planning: ${method}`);

        const planResult = await planTests(
          state.contract!,
          state.coverage!,
          method,
          skillTradePath,
          state.cost,
        );

        if (planResult.plan && planResult.guardrailResult?.valid) {
          methodResult.plan = planResult.plan;
          methodResult.status = "planned";
          log(state, `  Plan OK: ${planResult.plan.testCases.length + 1} test cases`);
        } else {
          methodResult.status = "failed";
          const reason = planResult.error ?? planResult.guardrailResult?.errors.join("; ") ?? "Unknown";
          log(state, `  Plan FAILED: ${reason}`);
        }

        methodResult.cost = state.cost.totalUsd - costBefore;
        emitMethodResult(state, methodResult);
        continue;
      }

      // ─── Plan + Implement + Run + Debug ───────────────
      state.phase = "plan";
      log(state, `[${i + 1}/${methodsToProcess.length}] Planning: ${method}`);

      const planResult = await planTests(
        state.contract!,
        state.coverage!,
        method,
        skillTradePath,
        state.cost,
      );

      if (!planResult.plan) {
        methodResult.status = "failed";
        log(state, `  Plan FAILED: ${planResult.error}`);
        ledgerAttempts.push({
          step: "plan",
          method,
          result: "failure",
          cost: state.cost.totalUsd - costBefore,
          duration: 0,
          error: planResult.error,
        });
        emitMethodResult(state, methodResult);
        continue;
      }

      if (!planResult.guardrailResult?.valid) {
        log(state, `  Plan guardrail warnings: ${planResult.guardrailResult?.errors.join("; ")}`);
      }

      methodResult.plan = planResult.plan;
      methodResult.status = "planned";
      log(state, `  Plan OK: ${planResult.plan.testCases.length + 1} test cases`);
      emitMethodResult(state, methodResult);

      // ─── Write ────────────────────────────────────────
      state.phase = "implement";
      log(state, `  Writing tests for: ${method}`);

      const writeResult = await writeTests(
        state.contract!,
        state.coverage!,
        planResult.plan,
        skillTradePath,
        state.cost,
      );

      if (!writeResult.code) {
        methodResult.status = "failed";
        log(state, `  Write FAILED: ${writeResult.error}`);
        emitMethodResult(state, methodResult);
        continue;
      }

      // ─── Validate (guardrails) before writing ─────────
      state.phase = "validate";
      const codeValidation = validateGeneratedCode(writeResult.code);
      if (codeValidation.warnings.length > 0) {
        log(state, `  Guardrail warnings: ${codeValidation.warnings.join("; ")}`);
      }
      if (!codeValidation.valid) {
        log(state, `  Guardrail BLOCKED: ${codeValidation.errors.join("; ")}`);
        methodResult.status = "failed";
        ledgerAttempts.push({
          step: "validate",
          method,
          result: "failure",
          cost: state.cost.totalUsd - costBefore,
          duration: 0,
          error: `Guardrail rejected: ${codeValidation.errors.join("; ")}`,
        });
        methodResult.cost = state.cost.totalUsd - costBefore;
        emitMethodResult(state, methodResult);
        continue;
      }

      const testFilePath = join(
        state.infrastructure!.testDir,
        planResult.plan.fileName,
      );
      writeFileSync(testFilePath, writeResult.code);
      methodResult.testFile = testFilePath;
      methodResult.status = "written";
      log(state, `  File written: ${testFilePath}`);
      emitMethodResult(state, methodResult);

      // ─── Run ──────────────────────────────────────────
      log(state, `  Running tests...`);
      methodResult.attempts++;
      const testResult = runTests(testFilePath, skillTradePath);
      methodResult.result = testResult;

      if (testResult.failed === 0 && testResult.passed > 0) {
        methodResult.status = "passed";
        log(state, `  PASSED: ${testResult.passed} tests in ${testResult.duration}ms`);
        ledgerAttempts.push({
          step: "run",
          method,
          result: "success",
          cost: state.cost.totalUsd - costBefore,
          duration: testResult.duration,
        });
        methodResult.cost = state.cost.totalUsd - costBefore;
        emitMethodResult(state, methodResult);
        continue;
      }

      // ─── Debug Loop ───────────────────────────────────
      state.phase = "debug";
      let debugAttempt = 0;
      let currentTestResult = testResult;

      while (debugAttempt < MAX_DEBUG_RETRIES && currentTestResult.failed > 0) {
        debugAttempt++;
        log(state, `  Debug attempt ${debugAttempt}/${MAX_DEBUG_RETRIES}...`);

        const debugResult = await debugTests(
          state.contract!,
          state.coverage!,
          testFilePath,
          currentTestResult,
          skillTradePath,
          state.cost,
        );

        methodResult.failures.push(...debugResult.failures);

        if (debugResult.fixedCode) {
          writeFileSync(testFilePath, debugResult.fixedCode);
          methodResult.attempts++;
          currentTestResult = runTests(testFilePath, skillTradePath);
          methodResult.result = currentTestResult;

          if (currentTestResult.failed === 0 && currentTestResult.passed > 0) {
            methodResult.status = "passed";
            log(state, `  PASSED after debug: ${currentTestResult.passed} tests`);
            break;
          }
        } else {
          log(state, `  Debug produced no fix: ${debugResult.error}`);
          break;
        }
      }

      if (methodResult.status !== "passed") {
        methodResult.status = "failed";
        log(state, `  FAILED after ${debugAttempt} debug attempts`);
      }

      ledgerAttempts.push({
        step: "implement",
        method,
        result: methodResult.status === "passed" ? "success" : "failure",
        cost: state.cost.totalUsd - costBefore,
        duration: currentTestResult.duration,
        error: currentTestResult.errors[0]?.message,
      });

      methodResult.cost = state.cost.totalUsd - costBefore;
      emitMethodResult(state, methodResult);
    }

    // ─── Phase: Save & Report ───────────────────────────────
    state.phase = "save";
    updateMemory(state);

    state.phase = "report";
    printReport(state);

    state.phase = "done";
    log(state, "Pipeline complete");
  } catch (error) {
    state.phase = "failed";
    log(state, `FATAL: ${(error as Error).message}`);
    throw error;
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
      costByAgent: Object.fromEntries(
        [...new Map<string, number>(
          state.cost.steps.reduce((acc, s) => {
            acc.set(s.agent, (acc.get(s.agent) ?? 0) + s.costUsd);
            return acc;
          }, new Map<string, number>()),
        )],
      ),
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────

function selectMethods(state: RunState): string[] {
  const { intent, coverage } = state;
  if (!coverage) return [];

  if (intent.methods && intent.methods.length > 0) {
    return intent.methods;
  }

  switch (intent.action) {
    case "cover":
      return coverage.uncoveredMethods;
    case "fix":
      return coverage.coveredMethods.map((c) => c.method);
    case "plan":
      return coverage.uncoveredMethods;
    default:
      return coverage.uncoveredMethods;
  }
}

function buildAnalyzeMethodResults(state: RunState): MethodResult[] {
  if (!state.coverage) return [];

  return state.coverage.uncoveredMethods.map((method) => ({
    method,
    plan: null,
    testFile: null,
    result: null,
    failures: [],
    attempts: 0,
    cost: 0,
    status: "analyzed",
  }));
}

function serializeMethodResult(methodResult: MethodResult) {
  return {
    method: methodResult.method,
    status: methodResult.status,
    cost: methodResult.cost,
    attempts: methodResult.attempts,
    passed: methodResult.result?.passed ?? 0,
    failed: methodResult.result?.failed ?? 0,
    testFile: methodResult.testFile,
    plan: methodResult.plan
      ? {
          fileName: methodResult.plan.fileName,
          totalCases: methodResult.plan.testCases.length + 1,
          schemaTest: methodResult.plan.schemaTest,
          testCases: methodResult.plan.testCases,
        }
      : null,
  };
}

function buildCompletionSummary(state: RunState) {
  const coveredCount = state.coverage?.coveredMethods.length ?? 0;
  const uncoveredMethods = state.coverage?.uncoveredMethods ?? [];
  const passedMethods = state.methodResults.filter((m) => m.status === "passed");
  const failedMethods = state.methodResults.filter((m) => m.status === "failed");
  const plannedMethods = state.methodResults.filter((m) => m.status === "planned");
  const analyzedMethods = state.methodResults.filter((m) => m.status === "analyzed");
  const skippedMethods = state.methodResults.filter((m) => m.status === "skipped");
  const createdFiles = state.methodResults.filter((m) => m.testFile).length;
  const testsPassedTotal = state.methodResults.reduce(
    (sum, m) => sum + (m.result?.passed ?? 0),
    0,
  );
  const testsFailedTotal = state.methodResults.reduce(
    (sum, m) => sum + (m.result?.failed ?? 0),
    0,
  );

  return {
    action: state.intent.action,
    totalMethods: state.contract?.methods.length ?? 0,
    coveredCount,
    uncoveredCount: uncoveredMethods.length,
    uncoveredMethods,
    coveragePercent: state.coverage?.coveragePercent ?? 0,
    processedCount: state.methodResults.length,
    plannedCount: plannedMethods.length,
    passedCount: passedMethods.length,
    failedCount: failedMethods.length,
    analyzedCount: analyzedMethods.length,
    skippedCount: skippedMethods.length,
    testsCreated: createdFiles,
    testsPassedTotal,
    testsFailedTotal,
  };
}

function emitMethodResult(state: RunState, methodResult: MethodResult): void {
  emitPipelineEvent("method-result", state.runId, {
    phase: state.phase,
    method: serializeMethodResult(methodResult),
  });
}

function updateMemory(state: RunState): void {
  if (!state.contract || !state.coverage) return;

  const passedMethods = state.methodResults.filter((m) => m.status === "passed");
  const newCoverage = Math.round(
    ((state.coverage.coveredMethods.length + passedMethods.length) /
      state.contract.methods.length) *
      100,
  );

  updateServiceIndex(state.service, {
    protoFile: state.infrastructure?.protoPath ?? "",
    methods: state.contract.methods.map((m) => m.name),
    wrapperExists: !!state.infrastructure?.wrapperPath,
    typesExist: !!state.infrastructure?.typesPath,
    testFiles: state.methodResults
      .filter((m) => m.testFile)
      .map((m) => m.testFile!),
    coveragePercent: newCoverage,
  });

  const historyEntry: RunHistoryEntry = {
    runId: state.runId,
    timestamp: state.startedAt,
    service: state.service,
    action: state.intent.action,
    methodsCovered: state.methodResults.filter((m) => m.status === "passed").length,
    totalMethods: state.contract.methods.length,
    testsCreated: state.methodResults.filter((m) => m.testFile).length,
    testsPassed: state.methodResults.filter((m) => m.status === "passed").length,
    testsFailed: state.methodResults.filter((m) => m.status === "failed").length,
    totalCostUsd: state.cost.totalUsd,
    durationMs: Date.now() - new Date(state.startedAt).getTime(),
  };

  appendRunHistory(historyEntry);
}

function saveLedger(
  state: RunState,
  facts: LedgerFact[],
  decisions: LedgerDecision[],
  attempts: LedgerAttempt[],
  durationMs: number,
): void {
  const passedCount = state.methodResults.filter(
    (m) => m.status === "passed",
  ).length;
  const totalCount = state.methodResults.length;

  const ledger: RunLedger = {
    runId: state.runId,
    task: state.intent.raw,
    scope: {
      service: state.service,
      methods: state.methodResults.map((m) => m.method),
    },
    facts,
    decisions,
    attempts,
    failures: state.methodResults.flatMap((m) => m.failures),
    cost: state.cost,
    finalVerdict:
      state.phase === "failed"
        ? "aborted"
        : passedCount === totalCount
          ? "accepted"
          : passedCount > 0
            ? "partial"
            : "rejected",
    startedAt: state.startedAt,
    completedAt: new Date().toISOString(),
  };

  saveRunLedger(ledger);
}

function printReport(state: RunState): void {
  console.log("\n" + "═".repeat(60));
  console.log(`Run ${state.runId} — ${state.service}`);
  console.log("═".repeat(60));

  for (const mr of state.methodResults) {
    const icon =
      mr.status === "passed" ? "✅" : mr.status === "failed" ? "❌" : "⏭️";
    const cost = `$${mr.cost.toFixed(4)}`;
    const attempts = mr.attempts > 1 ? ` (${mr.attempts} attempts)` : "";
    console.log(`  ${icon} ${mr.method}: ${mr.status}${attempts} — ${cost}`);

    if (mr.result && mr.result.passed > 0) {
      console.log(`     ${mr.result.passed} passed, ${mr.result.failed} failed`);
    }
  }

  console.log("─".repeat(60));

  const passed = state.methodResults.filter((m) => m.status === "passed").length;
  const total = state.methodResults.length;
  console.log(`Result: ${passed}/${total} methods passed`);
}

function printCoverageSummary(state: RunState): void {
  if (!state.coverage) return;

  console.log("\n" + "═".repeat(60));
  console.log(`Coverage Report — ${state.service}`);
  console.log("═".repeat(60));
  console.log(`  Total methods: ${state.coverage.totalMethods}`);
  console.log(`  Covered: ${state.coverage.coveredMethods.length}`);
  console.log(`  Uncovered: ${state.coverage.uncoveredMethods.length}`);
  console.log(`  Coverage: ${state.coverage.coveragePercent}%`);

  if (state.coverage.uncoveredMethods.length > 0) {
    console.log(`\n  Uncovered methods:`);
    for (const method of state.coverage.uncoveredMethods) {
      console.log(`    - ${method}`);
    }
  }
}

function log(state: RunState, msg: string): void {
  const elapsed = ((Date.now() - new Date(state.startedAt).getTime()) / 1000).toFixed(1);
  console.log(`[${state.runId}] [${elapsed}s] [${state.phase}] ${msg}`);
  emitPipelineEvent("log", state.runId, {
    phase: state.phase,
    message: msg,
    elapsed: parseFloat(elapsed),
    cost: state.cost.totalUsd,
  });
}

import { randomUUID } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { createCostAccumulator, formatCostReport } from "../cost/tracker.js";
import { resolveService } from "../steps/resolve-service.js";
import { parseContract } from "../steps/parse-contract.js";
import { analyzeCoverage } from "../steps/analyze-coverage.js";
import { planTests } from "../steps/plan-tests.js";
import { writeTests } from "../steps/write-tests.js";
import { runTests } from "../steps/run-tests.js";
import { debugTests } from "../steps/debug-tests.js";
import { validatePlan, validateGeneratedCode } from "../steps/guardrails.js";
import { updateServiceIndex } from "../memory/project-index.js";
import { appendRunHistory, saveRunLedger } from "../memory/run-history.js";
import {
  savePlanArtifacts,
  loadPlanArtifacts,
  loadPlanContext,
  saveLastImplementRun,
  type PlanContext,
} from "../memory/resumable-context.js";
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
  TestPlan,
} from "../types.js";

const MAX_DEBUG_RETRIES = 2;

class AbortError extends Error {
  constructor() {
    super("Pipeline aborted by user");
    this.name = "AbortError";
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

export async function runPipeline(
  intent: ParsedIntent,
  signal?: AbortSignal,
): Promise<void> {
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

  let savedPlanContext: PlanContext | null = null;
  if (intent.action === "implement_only") {
    savedPlanContext = loadPlanContext(intent.service);
  }
  const skipResolve =
    intent.action === "implement_only" &&
    savedPlanContext != null &&
    savedPlanContext.protoPath != null &&
    savedPlanContext.testDir != null;

  if (skipResolve && savedPlanContext) {
    state.infrastructure = {
      service: intent.service,
      protoPath: savedPlanContext.protoPath,
      testDir: savedPlanContext.testDir,
      wrapperPath: null,
      typesPath: null,
      generatedPath: null,
      fixtureConnected: false,
      missingComponents: [],
    };
    state.contract = parseContract(savedPlanContext.protoPath, intent.service);
    state.coverage = analyzeCoverage(state.contract, skillTradePath);
    log(state, "Using saved plan context (skipping resolve/parse/coverage)");
    // Emit completed events for skipped phases so UI shows ✓ on those steps
    for (const phase of ["resolve", "parse", "coverage", "plan"] as const) {
      emitPipelineEvent("log", state.runId, {
        phase,
        message: `(restored from saved plan)`,
        elapsed: 0,
        cost: 0,
      });
      emitPipelineEvent("phase", state.runId, { phase, status: "complete" });
    }
  }

  if (!skipResolve) {
    // ─── Phase: Resolve Infrastructure ──────────────────────
    checkAbort(signal);
    state.phase = "resolve";
    const isReadOnly =
      intent.action === "analyze" ||
      intent.action === "plan" ||
      intent.action === "validate_only";
    log(
      state,
      `Resolving service infrastructure${isReadOnly ? " (read-only)" : ""}...`,
    );

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
    checkAbort(signal);
    state.phase = "parse";
    log(state, "Parsing proto contract...");

    state.contract = parseContract(
      state.infrastructure.protoPath,
      intent.service,
    );
    ledgerFacts.push({
      what: `Contract: ${state.contract.methods.length} methods, ${state.contract.messages.length} messages`,
      source: state.infrastructure.protoPath,
      confirmed: true,
    });

    log(
      state,
      `Found ${state.contract.methods.length} methods: ${state.contract.methods.map((m) => m.name).join(", ")}`,
    );

    // ─── Phase: Analyze Coverage ────────────────────────────
    checkAbort(signal);
    state.phase = "coverage";
    log(state, "Analyzing test coverage...");

    state.coverage = analyzeCoverage(state.contract, skillTradePath);
    ledgerFacts.push({
      what: `Coverage: ${state.coverage.coveragePercent}% (${state.coverage.coveredMethods.length}/${state.coverage.totalMethods})`,
      source: "analyze-coverage",
      confirmed: true,
    });

    log(
      state,
      `Coverage: ${state.coverage.coveragePercent}% — uncovered: ${state.coverage.uncoveredMethods.join(", ") || "none"}`,
    );
  }

  let savedPlansForResume: Record<string, TestPlan> | null = null;
  if (intent.action === "implement_only") {
    savedPlansForResume =
      savedPlanContext?.plans ?? loadPlanArtifacts(intent.service);
    if (!savedPlansForResume || Object.keys(savedPlansForResume).length === 0) {
      throw new Error(
        `No saved plans for service "${intent.service}". Run plan first (e.g. "plan tests for ${intent.service}").`,
      );
    }
  }

  try {
    if (intent.action === "analyze") {
      state.methodResults = buildAnalyzeMethodResults(state);
      updateMemory(state);
      state.phase = "done";
      log(state, "Analysis complete (no implementation requested)");
      printCoverageSummary(state);
      return;
    }

    const methodsToProcess = selectMethods(state, savedPlansForResume);
    if (methodsToProcess.length === 0) {
      updateMemory(state);
      state.phase = "done";
      if (intent.action === "validate_only") {
        log(state, "No test files found for this service.");
      } else {
        log(state, "All methods already covered! Nothing to do.");
      }
      return;
    }

    ledgerDecisions.push({
      what: `Processing ${methodsToProcess.length} methods`,
      why:
        intent.action === "cover"
          ? "Uncovered methods found"
          : intent.action === "implement_only"
            ? "Using saved plans from previous plan run"
            : intent.action === "validate_only"
              ? "Running tests only (no write, no debug)"
              : "User requested",
      alternatives: ["Skip already covered", "Regenerate all"],
    });

    // ─── Per-Method Loop ────────────────────────────────────
    for (let i = 0; i < methodsToProcess.length; i++) {
      checkAbort(signal);
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

      // ─── Validate only: run tests, no debug ─────────────────
      if (intent.action === "validate_only") {
        const existingTest = state.coverage!.coveredMethods.find(
          (c) => c.method === method,
        );
        if (!existingTest) {
          methodResult.status = "skipped";
          log(state, `  No test file for ${method}, skipping`);
          methodResult.cost = state.cost.totalUsd - costBefore;
          emitMethodResult(state, methodResult);
          continue;
        }
        state.phase = "validate";
        log(
          state,
          `[${i + 1}/${methodsToProcess.length}] Running tests: ${method}`,
        );
        methodResult.testFile = existingTest.testFile;
        methodResult.attempts++;
        const testResult = runTests(existingTest.testFile, skillTradePath);
        methodResult.result = testResult;
        methodResult.status =
          testResult.failed === 0 && testResult.passed > 0
            ? "passed"
            : "failed";
        log(
          state,
          `  ${methodResult.status === "passed" ? "PASSED" : "FAILED"}: ${testResult.passed} passed, ${testResult.failed} failed`,
        );
        methodResult.cost = state.cost.totalUsd - costBefore;
        emitMethodResult(state, methodResult);
        continue;
      }

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
        while (
          debugAttempt < MAX_DEBUG_RETRIES &&
          currentTestResult.failed > 0
        ) {
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

            if (
              currentTestResult.failed === 0 &&
              currentTestResult.passed > 0
            ) {
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

      // ─── Plan only: generate test plans, save for later implement_only ─
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

        if (planResult.thinking) {
          emitPipelineEvent("log", state.runId, {
            phase: "plan",
            message: planResult.thinking,
            elapsed: 0,
            cost: 0,
            isThinking: true,
          });
        }

        if (planResult.plan && planResult.guardrailResult?.valid) {
          methodResult.plan = planResult.plan;
          methodResult.status = "planned";
          log(
            state,
            `  Plan OK: ${planResult.plan.testCases.length + 1} test cases`,
          );
        } else {
          methodResult.status = "failed";
          const reason =
            planResult.error ??
            planResult.guardrailResult?.errors.join("; ") ??
            "Unknown";
          log(state, `  Plan FAILED: ${reason}`);
        }

        methodResult.cost = state.cost.totalUsd - costBefore;
        emitMethodResult(state, methodResult);
        continue;
      }

      // ─── Implement only: use saved plan from previous plan run ─
      let planToUse: TestPlan;
      if (intent.action === "implement_only") {
        const savedPlan = savedPlansForResume![method];
        if (!savedPlan) {
          methodResult.status = "skipped";
          log(state, `  No saved plan for ${method}, skipping`);
          methodResult.cost = state.cost.totalUsd - costBefore;
          emitMethodResult(state, methodResult);
          continue;
        }
        planToUse = savedPlan;
        methodResult.plan = planToUse;
        methodResult.status = "planned";
        log(
          state,
          `[${i + 1}/${methodsToProcess.length}] Using saved plan for: ${method}`,
        );
        emitMethodResult(state, methodResult);
      } else {
        // ─── Cover: Plan + Implement + Run + Debug ───────────────
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
          log(
            state,
            `  Plan guardrail warnings: ${planResult.guardrailResult?.errors.join("; ")}`,
          );
        }

        planToUse = planResult.plan;
        methodResult.plan = planToUse;
        methodResult.status = "planned";
        log(state, `  Plan OK: ${planToUse.testCases.length + 1} test cases`);
        emitMethodResult(state, methodResult);
      }

      // ─── Write ────────────────────────────────────────
      state.phase = "implement";
      log(state, `  Writing tests for: ${method}`);

      const writeResult = await writeTests(
        state.contract!,
        state.coverage!,
        planToUse,
        skillTradePath,
        state.cost,
        state.infrastructure!.testDir,
      );

      if (writeResult.thinking) {
        emitPipelineEvent("log", state.runId, {
          phase: "implement",
          message: writeResult.thinking,
          elapsed: 0,
          cost: 0,
          isThinking: true,
        });
      }

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
        log(
          state,
          `  Guardrail warnings: ${codeValidation.warnings.join("; ")}`,
        );
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

      // Ensure target test directory exists (especially when skipping resolve in implement_only)
      mkdirSync(state.infrastructure!.testDir, { recursive: true });
      const testFilePath = join(
        state.infrastructure!.testDir,
        basename(planToUse.fileName),
      );
      writeFileSync(testFilePath, writeResult.code);
      methodResult.testFile = testFilePath;
      methodResult.status = "written";
      log(state, `  File written: ${testFilePath}`);
      emitMethodResult(state, methodResult);

      // For now, skip automatic run+debug in the cover pipeline to save tokens.
      // Tests will be executed only when the user explicitly asks via validate_only / fix actions.
      methodResult.cost = state.cost.totalUsd - costBefore;
      emitMethodResult(state, methodResult);
      continue;
    }

    // ─── Phase: Save & Report ───────────────────────────────
    state.phase = "save";
    if (intent.action === "plan") {
      savePlanArtifacts(
        state.service,
        state.runId,
        state.methodResults,
        state.infrastructure
          ? {
              protoPath: state.infrastructure.protoPath,
              testDir: state.infrastructure.testDir,
            }
          : undefined,
      );
    }
    if (intent.action === "cover" || intent.action === "implement_only") {
      saveLastImplementRun(state.service, state.runId, state.methodResults);
    }
    updateMemory(state);

    state.phase = "report";
    printReport(state);

    state.phase = "done";
    log(state, "Pipeline complete");
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      state.phase = "stopped";
      log(state, "Pipeline stopped by user");
      emitPipelineEvent("aborted", state.runId, {
        phase: state.phase,
        service: state.service,
        totalCost: state.cost.totalUsd,
      });
    } else {
      state.phase = "failed";
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
      costByAgent: Object.fromEntries([
        ...new Map<string, number>(
          state.cost.steps.reduce((acc, s) => {
            acc.set(s.agent, (acc.get(s.agent) ?? 0) + s.costUsd);
            return acc;
          }, new Map<string, number>()),
        ),
      ]),
      costByPhase: Object.fromEntries(
        state.cost.steps.reduce((acc, s) => {
          // step names: "resolve:ServiceName", "plan:MethodName", "write:MethodName", "debug:file.ts"
          const prefix = s.step.split(":")[0];
          const phase = prefix === "write" ? "implement" : prefix;
          acc.set(phase, (acc.get(phase) ?? 0) + s.costUsd);
          return acc;
        }, new Map<string, number>()),
      ),
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────

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

  if (intent.action === "validate_only") {
    return coverage.coveredMethods.map((c) => c.method);
  }

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
  const passedMethods = state.methodResults.filter(
    (m) => m.status === "passed",
  );
  const failedMethods = state.methodResults.filter(
    (m) => m.status === "failed",
  );
  const plannedMethods = state.methodResults.filter(
    (m) => m.status === "planned",
  );
  const analyzedMethods = state.methodResults.filter(
    (m) => m.status === "analyzed",
  );
  const skippedMethods = state.methodResults.filter(
    (m) => m.status === "skipped",
  );
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

  const passedMethods = state.methodResults.filter(
    (m) => m.status === "passed",
  );
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
    methodsCovered: state.methodResults.filter((m) => m.status === "passed")
      .length,
    totalMethods: state.contract.methods.length,
    testsCreated: state.methodResults.filter((m) => m.testFile).length,
    testsPassed: state.methodResults.filter((m) => m.status === "passed")
      .length,
    testsFailed: state.methodResults.filter((m) => m.status === "failed")
      .length,
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
      console.log(
        `     ${mr.result.passed} passed, ${mr.result.failed} failed`,
      );
    }
  }

  console.log("─".repeat(60));

  const passed = state.methodResults.filter(
    (m) => m.status === "passed",
  ).length;
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
  const elapsed = (
    (Date.now() - new Date(state.startedAt).getTime()) /
    1000
  ).toFixed(1);
  console.log(`[${state.runId}] [${elapsed}s] [${state.phase}] ${msg}`);
  emitPipelineEvent("log", state.runId, {
    phase: state.phase,
    message: msg,
    elapsed: parseFloat(elapsed),
    cost: state.cost.totalUsd,
  });
}

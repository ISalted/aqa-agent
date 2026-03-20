import { writeFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { planTests } from "../steps/plan-tests.js";
import { analyzeImplementationContext } from "../steps/plan-infra.js";
import { writeTests } from "../steps/write-tests.js";
import { runTests } from "../steps/run-tests.js";
import { debugTests } from "../steps/debug-tests.js";
import { emitPipelineEvent, serializeStateSnapshot } from "../events.js";
import { transition } from "./state-machine.js";
import type { RunState, MethodResult, TestPlan, LedgerAttempt, ImplementationContext } from "../types.js";

const MAX_DEBUG_RETRIES = 2;

export interface MethodContext {
  skillTradePath: string;
  methodIndex: number;
  totalMethods: number;
  ledgerAttempts: LedgerAttempt[];
  signal?: AbortSignal;
}

// ─── validate_only ───────────────────────────────────────────

export function processValidateOnly(
  state: RunState,
  method: string,
  ctx: MethodContext,
): MethodResult {
  const methodResult = createMethodResult(method);
  const costBefore = state.cost.totalUsd;

  const existingTest = state.coverage!.coveredMethods.find((c) => c.method === method);
  if (!existingTest) {
    methodResult.status = "skipped";
    log(state, `  No test file for ${method}, skipping`);
    methodResult.cost = state.cost.totalUsd - costBefore;
    emitMethodResult(state, methodResult);
    return methodResult;
  }

  transition(state, "validate", `validate_only for method=${method}`);
  log(state, `[${ctx.methodIndex + 1}/${ctx.totalMethods}] Running tests: ${method}`);
  methodResult.testFile = existingTest.testFile;
  methodResult.attempts++;

  const testResult = runTests(existingTest.testFile, ctx.skillTradePath);
  methodResult.result = testResult;
  methodResult.status = testResult.failed === 0 && testResult.passed > 0 ? "passed" : "failed";
  log(state, `  ${methodResult.status === "passed" ? "PASSED" : "FAILED"}: ${testResult.passed} passed, ${testResult.failed} failed`);

  methodResult.cost = state.cost.totalUsd - costBefore;
  emitMethodResult(state, methodResult);
  return methodResult;
}

// ─── fix ─────────────────────────────────────────────────────

export async function processFix(
  state: RunState,
  method: string,
  ctx: MethodContext,
): Promise<MethodResult> {
  const methodResult = createMethodResult(method);
  const costBefore = state.cost.totalUsd;

  const existingTest = state.coverage!.coveredMethods.find((c) => c.method === method);
  if (!existingTest) {
    methodResult.status = "skipped";
    log(state, `  No existing test file for ${method}, skipping fix`);
    methodResult.cost = state.cost.totalUsd - costBefore;
    emitMethodResult(state, methodResult);
    return methodResult;
  }

  transition(state, "validate", `fix action: running existing test for method=${method}`);
  log(state, `[${ctx.methodIndex + 1}/${ctx.totalMethods}] Fixing: ${method}`);
  log(state, `  Running existing test: ${existingTest.testFile}`);

  methodResult.testFile = existingTest.testFile;
  methodResult.attempts++;
  let currentTestResult = runTests(existingTest.testFile, ctx.skillTradePath);
  methodResult.result = currentTestResult;

  if (currentTestResult.failed === 0 && currentTestResult.passed > 0) {
    methodResult.status = "passed";
    log(state, `  Already passing: ${currentTestResult.passed} tests`);
    methodResult.cost = state.cost.totalUsd - costBefore;
    emitMethodResult(state, methodResult);
    return methodResult;
  }

  transition(state, "debug", `${currentTestResult.failed} tests failed, starting debug loop`);
  let debugAttempt = 0;
  while (debugAttempt < MAX_DEBUG_RETRIES && currentTestResult.failed > 0) {
    debugAttempt++;
    log(state, `  Debug attempt ${debugAttempt}/${MAX_DEBUG_RETRIES}...`);

    const debugResult = await debugTests(
      state.contract!,
      state.coverage!,
      existingTest.testFile,
      currentTestResult,
      ctx.skillTradePath,
      state.cost,
      state.notes,
    );

    methodResult.failures.push(...debugResult.failures);

    if (debugResult.fixedCode) {
      writeFileSync(existingTest.testFile, debugResult.fixedCode);
      methodResult.attempts++;
      currentTestResult = runTests(existingTest.testFile, ctx.skillTradePath);
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
  return methodResult;
}

// ─── plan ────────────────────────────────────────────────────

export async function processPlan(
  state: RunState,
  method: string,
  ctx: MethodContext,
): Promise<MethodResult> {
  const methodResult = createMethodResult(method);
  const costBefore = state.cost.totalUsd;

  transition(state, "plan", `processPlan for method=${method} (${ctx.methodIndex + 1}/${ctx.totalMethods})`);
  log(state, `[${ctx.methodIndex + 1}/${ctx.totalMethods}] Planning: ${method}`);

  // Read existing test file if present (for delta analysis)
  const methodFileName = `${method.charAt(0).toLowerCase()}${method.slice(1)}.test.ts`;
  const serviceDir = state.contract!.service.replace(/Service$/, "").replace(/([A-Z])/g, (m, l, o) => (o ? "-" : "") + l.toLowerCase());
  const existingFilePath = join(ctx.skillTradePath, "tests", "grpc", serviceDir, methodFileName);
  const existingFileContent = existsSync(existingFilePath) ? readFileSync(existingFilePath, "utf-8") : undefined;

  const planResult = await planTests(
    state.contract!,
    state.coverage!,
    method,
    ctx.skillTradePath,
    state.cost,
    state.notes,
    state.understandContext?.manualTestCases ?? [],
    existingFileContent,
  );

  if (planResult.systemPrompt) {
    emitPipelineEvent("system-prompt", state.runId, { phase: "plan", systemPrompt: planResult.systemPrompt });
  }
  if (planResult.thinking) {
    emitPipelineEvent("log", state.runId, { phase: "plan", message: planResult.thinking, elapsed: 0, cost: 0, isThinking: true });
  }

  if (planResult.plan && planResult.guardrailResult?.valid) {
    const plan = planResult.plan;
    methodResult.plan = plan;

    if (plan.mode === "noop") {
      methodResult.status = "planned";
      log(state, `  No changes — all ${plan.deltaInfo?.existing.length ?? 0} test cases already up to date`);
      methodResult.cost = state.cost.totalUsd - costBefore;
      emitMethodResult(state, methodResult);
      return methodResult;
    }

    methodResult.status = "planned";
    const delta = plan.deltaInfo;
    if (plan.mode === "delta" && delta) {
      log(state, `  Plan delta: +${delta.added.length} new, ~${delta.changed.length} changed, ${delta.existing.length} unchanged`);
    } else {
      log(state, `  Plan OK: ${plan.testCases.length} test cases (new file)`);
    }

    // Build implementation context
    const implCtx = analyzeImplementationContext(
      state.contract!,
      state.infrastructure!,
      ctx.skillTradePath,
      method,
    );
    methodResult.implementationContext = implCtx;

    // Log infrastructure status
    if (implCtx.missingComponents.length > 0) {
      log(state, `  Missing: ${implCtx.missingComponents.join(", ")}`);
    }
    if (implCtx.relevantSettings.length > 0) {
      log(state, `  Settings: ${implCtx.relevantSettings.map(s => s.accessPattern).join(", ")}`);
    }
    if (implCtx.availableFixtures.length > 0) {
      log(state, `  Fixtures: ${implCtx.availableFixtures.join(", ")}`);
    }

    // Agent-written notes take priority — fall back to structural summary only if agent wrote nothing
    if (planResult.savedNotes?.length) {
      planResult.savedNotes.forEach((n) => state.notes.push({ phase: "plan", summary: n }));
    } else {
      state.notes.push({ phase: "plan", summary: `${planResult.plan.testCases.length + 1} test cases planned for ${method}.` });
    }
  } else {
    methodResult.status = "failed";
    log(state, `  Plan FAILED: ${planResult.error ?? planResult.guardrailResult?.errors.join("; ") ?? "Unknown"}`);
  }

  methodResult.cost = state.cost.totalUsd - costBefore;
  emitMethodResult(state, methodResult);
  return methodResult;
}

// ─── implement ───────────────────────────────────────────────

export async function processImplement(
  state: RunState,
  method: string,
  ctx: MethodContext,
  plan: TestPlan,
  implementationContext?: ImplementationContext,
): Promise<MethodResult> {
  const methodResult = createMethodResult(method);
  methodResult.plan = plan;
  const costBefore = state.cost.totalUsd;

  transition(state, "implement", `plan OK: ${plan.testCases.length + 1} test cases for method=${method}`);
  log(state, `[${ctx.methodIndex + 1}/${ctx.totalMethods}] Writing: ${method}`);

  const writeResult = await writeTests(
    state.contract!,
    state.coverage!,
    plan,
    ctx.skillTradePath,
    state.cost,
    state.infrastructure!.testDir,
    state.notes,
    implementationContext,
  );

  if (writeResult.systemPrompt) {
    emitPipelineEvent("system-prompt", state.runId, { phase: "implement", systemPrompt: writeResult.systemPrompt });
  }
  if (writeResult.thinking) {
    emitPipelineEvent("log", state.runId, { phase: "implement", message: writeResult.thinking, elapsed: 0, cost: 0, isThinking: true });
  }

  if (writeResult.phaseSummary) {
    state.notes.push({ phase: "implement", summary: writeResult.phaseSummary });
  } else if (writeResult.savedNotes?.length) {
    state.notes.push({ phase: "implement", summary: writeResult.savedNotes.join(" | ") });
  }

  if (!writeResult.code) {
    methodResult.status = "failed";
    log(state, `  Write FAILED: ${writeResult.error}`);
    methodResult.cost = state.cost.totalUsd - costBefore;
    emitMethodResult(state, methodResult);
    return methodResult;
  }

  mkdirSync(state.infrastructure!.testDir, { recursive: true });
  const testFilePath = join(state.infrastructure!.testDir, basename(plan.fileName));
  writeFileSync(testFilePath, writeResult.code);
  methodResult.testFile = testFilePath;
  methodResult.testCode = writeResult.code;
  methodResult.status = "written";
  log(state, `  File written: ${testFilePath}`);
  state.notes.push({
    phase: "implement",
    summary: `Written ${testFilePath} for ${method} with ${plan.testCases.length + 1} tests.`,
  });

  methodResult.cost = state.cost.totalUsd - costBefore;
  emitMethodResult(state, methodResult);
  return methodResult;
}

// ─── Helpers ─────────────────────────────────────────────────

function createMethodResult(method: string): MethodResult {
  return { method, plan: null, testFile: null, result: null, failures: [], attempts: 0, cost: 0, status: "pending" };
}

function emitMethodResult(state: RunState, methodResult: MethodResult): void {
  emitPipelineEvent("method-result", state.runId, {
    phase: state.phase,
    stateSnapshot: serializeStateSnapshot(state),
    method: {
      method: methodResult.method,
      status: methodResult.status,
      cost: methodResult.cost,
      attempts: methodResult.attempts,
      passed: methodResult.result?.passed ?? 0,
      failed: methodResult.result?.failed ?? 0,
      testFile: methodResult.testFile,
      testCode: methodResult.testCode ?? null,
      plan: methodResult.plan ? {
        fileName: methodResult.plan.fileName,
        totalCases: methodResult.plan.testCases.length,
        testCases: methodResult.plan.testCases,
      } : null,
    },
  });
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

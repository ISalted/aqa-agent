import { writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { planTests } from "../steps/plan-tests.js";
import { writeTests } from "../steps/write-tests.js";
import { runTests } from "../steps/run-tests.js";
import { debugTests } from "../steps/debug-tests.js";
import { emitPipelineEvent } from "../events.js";
import { transition } from "./state-machine.js";
import type { RunState, MethodResult, TestPlan, LedgerAttempt } from "../types.js";

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

  const planResult = await planTests(
    state.contract!,
    state.coverage!,
    method,
    ctx.skillTradePath,
    state.cost,
    state.notes,
  );

  if (planResult.thinking) {
    emitPipelineEvent("log", state.runId, { phase: "plan", message: planResult.thinking, elapsed: 0, cost: 0, isThinking: true });
  }

  if (planResult.plan && planResult.guardrailResult?.valid) {
    methodResult.plan = planResult.plan;
    methodResult.status = "planned";
    log(state, `  Plan OK: ${planResult.plan.testCases.length + 1} test cases`);
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

// ─── cover / implement_only ──────────────────────────────────

export async function processCover(
  state: RunState,
  method: string,
  ctx: MethodContext,
  savedPlan?: TestPlan,
): Promise<MethodResult> {
  const methodResult = createMethodResult(method);
  const costBefore = state.cost.totalUsd;

  let planToUse: TestPlan;

  if (savedPlan) {
    // implement_only: use saved plan
    planToUse = savedPlan;
    methodResult.plan = planToUse;
    methodResult.status = "planned";
    log(state, `[${ctx.methodIndex + 1}/${ctx.totalMethods}] Using saved plan for: ${method}`);
    emitMethodResult(state, methodResult);
  } else {
    // cover: plan first
    transition(state, "plan", `cover action: planning method=${method} (${ctx.methodIndex + 1}/${ctx.totalMethods})`);
    log(state, `[${ctx.methodIndex + 1}/${ctx.totalMethods}] Planning: ${method}`);

    const planResult = await planTests(
      state.contract!,
      state.coverage!,
      method,
      ctx.skillTradePath,
      state.cost,
      state.notes,
    );

    if (!planResult.plan) {
      methodResult.status = "failed";
      log(state, `  Plan FAILED: ${planResult.error}`);
      ctx.ledgerAttempts.push({ step: "plan", method, result: "failure", cost: state.cost.totalUsd - costBefore, duration: 0, error: planResult.error });
      emitMethodResult(state, methodResult);
      methodResult.cost = state.cost.totalUsd - costBefore;
      return methodResult;
    }

    if (!planResult.guardrailResult?.valid) {
      log(state, `  Plan guardrail warnings: ${planResult.guardrailResult?.errors.join("; ")}`);
    }

    planToUse = planResult.plan;
    methodResult.plan = planToUse;
    methodResult.status = "planned";
    log(state, `  Plan OK: ${planToUse.testCases.length + 1} test cases`);
    if (planResult.savedNotes?.length) {
      planResult.savedNotes.forEach((n) => state.notes.push({ phase: "plan", summary: n }));
    } else {
      state.notes.push({ phase: "plan", summary: `${planToUse.testCases.length + 1} test cases planned for ${method}.` });
    }
    emitMethodResult(state, methodResult);
  }

  // ─── Write ───────────────────────────────────────────────
  transition(state, "implement", `plan OK: ${planToUse.testCases.length + 1} test cases for method=${method}`);
  log(state, `  Writing tests for: ${method}`);

  const writeResult = await writeTests(
    state.contract!,
    state.coverage!,
    planToUse,
    ctx.skillTradePath,
    state.cost,
    state.infrastructure!.testDir,
    state.notes,
  );

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
    emitMethodResult(state, methodResult);
    methodResult.cost = state.cost.totalUsd - costBefore;
    return methodResult;
  }

  // ─── Validate (guardrails) — DISABLED temporarily ───────
  transition(state, "validate", `code written for method=${method}, saving file`);
  // TODO: re-enable guardrail check once pipeline is stable
  // const codeValidation = validateGeneratedCode(writeResult.code);

  // ─── Save file ───────────────────────────────────────────
  mkdirSync(state.infrastructure!.testDir, { recursive: true });
  const testFilePath = join(state.infrastructure!.testDir, basename(planToUse.fileName));
  writeFileSync(testFilePath, writeResult.code);
  methodResult.testFile = testFilePath;
  methodResult.status = "written";
  log(state, `  File written: ${testFilePath}`);
  state.notes.push({
    phase: "implement",
    summary: `Written ${testFilePath} for ${method} with ${planToUse.testCases.length + 1} tests.`,
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
    method: {
      method: methodResult.method,
      status: methodResult.status,
      cost: methodResult.cost,
      attempts: methodResult.attempts,
      passed: methodResult.result?.passed ?? 0,
      failed: methodResult.result?.failed ?? 0,
      testFile: methodResult.testFile,
      plan: methodResult.plan ? {
        fileName: methodResult.plan.fileName,
        totalCases: methodResult.plan.testCases.length + 1,
        schemaTest: methodResult.plan.schemaTest,
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

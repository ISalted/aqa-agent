import { resolveService } from "../steps/resolve-service.js";
import { parseContract } from "../steps/parse-contract.js";
import { analyzeCoverage } from "../steps/analyze-coverage.js";
import { loadPlanContext, type PlanContext } from "../memory/resumable-context.js";
import { emitPipelineEvent } from "../events.js";
import { transition } from "./state-machine.js";
import type { RunState, LedgerFact } from "../types.js";

/**
 * Runs the setup phases: resolve → parse → coverage.
 * Handles the implement_only fast path (skip resolve if saved plan context exists).
 * Mutates state in place and returns it.
 */
export async function runSetupPhases(
  state: RunState,
  skillTradePath: string,
  ledgerFacts: LedgerFact[],
  signal?: AbortSignal,
): Promise<RunState> {
  const { intent } = state;

  // ─── implement_only fast path ────────────────────────────
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

    transition(state, "resolve",   "restored from saved plan");
    transition(state, "parse",     "restored from saved plan");
    transition(state, "coverage",  "restored from saved plan");
    transition(state, "plan",      "restored from saved plan");
    for (const phase of ["resolve", "parse", "coverage", "plan"] as const) {
      emitPipelineEvent("log", state.runId, { phase, message: "(restored from saved plan)", elapsed: 0, cost: 0 });
      emitPipelineEvent("phase", state.runId, { phase, status: "complete" });
    }
    return state;
  }

  // ─── Phase: Resolve ──────────────────────────────────────
  checkAbort(signal);
  transition(state, "resolve", `starting setup for action=${intent.action}`);
  const isReadOnly =
    intent.action === "analyze" ||
    intent.action === "plan" ||
    intent.action === "validate_only";
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
    throw new Error(`Proto file not found for service "${intent.service}" even after sync attempt`);
  }

  state.notes.push({
    phase: "resolve",
    summary: `wrapper: ${state.infrastructure.wrapperPath ? "exists" : "absent"}. missing: [${state.infrastructure.missingComponents.join(", ") || "none"}]`,
  });

  // ─── Phase: Parse ────────────────────────────────────────
  checkAbort(signal);
  transition(state, "parse", `resolve done: protoPath=${state.infrastructure.protoPath}, missing=[${state.infrastructure.missingComponents.join(", ") || "none"}]`);
  log(state, "Parsing proto contract...");

  state.contract = parseContract(state.infrastructure.protoPath, intent.service);
  ledgerFacts.push({
    what: `Contract: ${state.contract.methods.length} methods, ${state.contract.messages.length} messages`,
    source: state.infrastructure.protoPath,
    confirmed: true,
  });
  log(state, `Found ${state.contract.methods.length} methods: ${state.contract.methods.map((m) => m.name).join(", ")}`);

  state.notes.push({
    phase: "parse",
    summary: `methods: [${state.contract.methods.map((m) => m.name).join(", ")}]`,
  });

  // ─── Phase: Coverage ─────────────────────────────────────
  checkAbort(signal);
  transition(state, "coverage", `parse done: ${state.contract.methods.length} methods found`);
  log(state, "Analyzing test coverage...");

  state.coverage = analyzeCoverage(state.contract, skillTradePath);
  ledgerFacts.push({
    what: `Coverage: ${state.coverage.coveragePercent}% (${state.coverage.coveredMethods.length}/${state.coverage.totalMethods})`,
    source: "analyze-coverage",
    confirmed: true,
  });
  log(state, `Coverage: ${state.coverage.coveragePercent}% — uncovered: ${state.coverage.uncoveredMethods.join(", ") || "none"}`);

  state.notes.push({
    phase: "coverage",
    summary: `coverage: ${state.coverage.coveragePercent}%. uncovered: [${state.coverage.uncoveredMethods.join(", ") || "none"}]`,
  });

  return state;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Pipeline aborted by user");
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

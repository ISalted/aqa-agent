import { loadPlanContext, type PlanContext } from "../memory/resumable-context.js";
import { emitPipelineEvent, serializeStateSnapshot } from "../events.js";
import { transition } from "./state-machine.js";
import { understand } from "../understand/index.js";
import { parseContract } from "../steps/parse-contract.js";
import { analyzeCoverage } from "../steps/analyze-coverage.js";
import type { RunState, LedgerFact } from "../types.js";

/**
 * Runs the Understand phase (absorbs resolve → parse → coverage).
 * Handles the implement_only fast path (skip understand if saved plan context exists).
 * Mutates state in place and returns it.
 */
export async function runSetupPhases(
  state: RunState,
  skillTradePath: string,
  ledgerFacts: LedgerFact[],
  signal?: AbortSignal,
): Promise<RunState> {
  const { intent } = state;

  // ─── Phase: Understand ───────────────────────────────────
  checkAbort(signal);
  transition(state, "understand", "gathering service context");
  log(state, "Resolving service context...");

  // ─── implement_only fast path ────────────────────────────
  let savedPlanContext: PlanContext | null = null;
  if (intent.action === "implement_only") {
    savedPlanContext = loadPlanContext(intent.service);
  }

  const skipFull =
    intent.action === "implement_only" &&
    savedPlanContext != null &&
    savedPlanContext.protoPath != null &&
    savedPlanContext.testDir != null;

  if (skipFull && savedPlanContext) {
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
    log(state, "Using saved plan context");
    emitPipelineEvent("phase", state.runId, { phase: "understand", status: "complete", stateSnapshot: serializeStateSnapshot(state), tools: [] });
    transition(state, "plan", "restored from saved plan");
    const planCount = Object.keys(savedPlanContext.plans).length;
    log(state, `${planCount} saved plan(s) loaded — skipping LLM planning`);
    emitPipelineEvent("phase", state.runId, { phase: "plan", status: "pending" });
    return state;
  }

  // ─── Full understand ─────────────────────────────────────
  try {
    const ctx = await understand(intent, skillTradePath);
    state.understandContext = ctx;

    // Propagate to RunState fields used by plan/implement
    state.service       = ctx.canonicalService;
    state.intent        = ctx.intent;
    state.infrastructure = ctx.infrastructure;
    state.contract      = ctx.contract;
    state.coverage      = ctx.coverage;

    const parts: string[] = [
      `proto: ${ctx.protoFile}`,
      `methods: ${ctx.contract.methods.length}`,
      `coverage: ${ctx.coverage.coveragePercent}%`,
      `localTests: ${ctx.localTestFilesCount}`,
      `scope: ${ctx.scope}`,
    ];
    if (ctx.protoChanges) {
      const c = ctx.protoChanges;
      parts.push(`protoChanges: +${c.addedMethods.length} ~${c.changedMethods.length} -${c.removedMethods.length}`);
    }
    if (ctx.testomatioCoverage) {
      const t = ctx.testomatioCoverage;
      parts.push(`testomatio: ${t.manualTests} manual / ${t.automatedTests} auto`);
    }

    log(state, parts.join(", "));
    state.notes.push({ phase: "understand", summary: parts.join("; ") });
    ledgerFacts.push({
      what: `Understand: ${parts.join("; ")}`,
      source: "service-map+proto+testomatio",
      confirmed: true,
    });

  } catch (err) {
    throw new Error(`Understand failed: ${(err as Error).message}`);
  }

  emitPipelineEvent("phase", state.runId, { phase: "understand", status: "complete", stateSnapshot: serializeStateSnapshot(state), tools: [] });
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

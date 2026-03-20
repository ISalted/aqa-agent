import { EventEmitter } from "events";
import type { RunState } from "./types.js";

export interface PipelineEvent {
  type: "started" | "log" | "phase" | "method-result" | "complete" | "error" | "aborted" | "system-prompt";
  runId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export const pipelineEvents = new EventEmitter();
pipelineEvents.setMaxListeners(50);

export function emitPipelineEvent(
  type: PipelineEvent["type"],
  runId: string,
  data: Record<string, unknown> = {},
): void {
  pipelineEvents.emit("pipeline", {
    type,
    runId,
    timestamp: new Date().toISOString(),
    data,
  } satisfies PipelineEvent);
}

export function serializeStateSnapshot(state: RunState): Record<string, unknown> {
  const ctx = state.understandContext;
  return {
    service: state.service,
    phase: state.phase,
    intent: {
      action: state.intent.action,
      methods: state.intent.methods ?? null,
    },
    infrastructure: state.infrastructure ? {
      protoPath: state.infrastructure.protoPath,
      testDir: state.infrastructure.testDir,
      missingComponents: state.infrastructure.missingComponents,
    } : null,
    coverage: state.coverage ? {
      totalMethods: state.coverage.totalMethods,
      coveredMethods: state.coverage.coveredMethods.map(c => c.method),
      uncoveredMethods: state.coverage.uncoveredMethods,
      coveragePercent: state.coverage.coveragePercent,
    } : null,
    understand: ctx ? {
      scope: ctx.scope,
      localTestFilesCount: ctx.localTestFilesCount,
      testomatio: ctx.testomatioCoverage ? {
        manual: ctx.testomatioCoverage.manualTests,
        auto: ctx.testomatioCoverage.automatedTests,
        total: ctx.testomatioCoverage.totalTests,
      } : null,
      protoChanges: ctx.protoChanges ? {
        added: ctx.protoChanges.addedMethods,
        changed: ctx.protoChanges.changedMethods,
        removed: ctx.protoChanges.removedMethods,
      } : null,
      manualTestCases: ctx.manualTestCases?.length
        ? ctx.manualTestCases.map(t => ({
            id: t.id,
            title: t.title,
            description: t.description ?? null,
            tags: t.tags ?? [],
          }))
        : null,
    } : null,
    contractMethods: state.contract?.methods.map(m => ({
      name: m.name,
      inputType: m.inputType,
      outputType: m.outputType,
    })) ?? [],
    contractMessages: state.contract?.messages.map(msg => ({
      name: msg.name,
      fields: msg.fields.map(f => ({
        name: f.name,
        type: f.type,
        number: f.number,
        optional: f.optional,
        repeated: f.repeated,
        mapKeyType: f.mapKeyType,
        mapValueType: f.mapValueType,
      })),
      oneofs: msg.oneofs,
    })) ?? [],
    methodResults: state.methodResults.map(m => ({
      method: m.method,
      status: m.status,
      cost: m.cost,
    })),
    notes: state.notes.map(n => ({
      phase: n.phase,
      summary: n.summary,
    })),
    totalCost: state.cost.totalUsd,
  };
}

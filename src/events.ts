import { EventEmitter } from "events";

export interface PipelineEvent {
  type: "started" | "log" | "phase" | "method-result" | "complete" | "error" | "aborted";
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

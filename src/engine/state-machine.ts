import type { Phase, RunState, StepNote } from "../types.js";

// ─── Valid Transitions ───────────────────────────────────────
// Per-method phases (plan/implement/validate/debug) loop back to themselves
// because the same RunState is reused across multiple methods.

export const PHASE_TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
  init:       ["understand", "failed"],
  understand: ["plan", "done", "failed", "stopped"],
  plan:      ["plan", "implement", "save", "done", "failed", "stopped"],
  implement: ["implement", "validate", "plan", "save", "failed", "stopped"],
  validate:  ["validate", "plan", "implement", "debug", "save", "done", "failed", "stopped"],
  debug:     ["debug", "validate", "save", "failed", "stopped"],
  save:      ["report", "failed"],
  report:    ["done"],
  done:      [],
  failed:    [],
  stopped:   [],
};

/**
 * Transitions RunState to the next phase with an explicit reason.
 * Throws if the transition is not in the allowed table — this prevents
 * silent phase corruption that was the original bug.
 *
 * The reason is appended to state.notes so every decision is auditable.
 */
export function transition(state: RunState, next: Phase, reason: string): void {
  const allowed = PHASE_TRANSITIONS[state.phase];
  if (!(allowed as readonly string[]).includes(next)) {
    throw new Error(
      `[state-machine] Invalid transition: ${state.phase} → ${next}. ` +
      `Allowed from ${state.phase}: [${allowed.join(", ")}]. Reason: ${reason}`,
    );
  }

  const note: StepNote = {
    phase: state.phase,
    summary: `→ ${next}: ${reason}`,
  };
  state.notes.push(note);
  state.phase = next;
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import type { RunHistoryEntry, RunLedger } from "../types.js";

const STATE_DIR = resolve(import.meta.dirname, "../../state");
const HISTORY_PATH = resolve(STATE_DIR, "run-history.json");
const RUNS_DIR = resolve(STATE_DIR, "runs");

export function loadRunHistory(): RunHistoryEntry[] {
  if (!existsSync(HISTORY_PATH)) return [];
  return JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
}

export function appendRunHistory(entry: RunHistoryEntry): void {
  const history = loadRunHistory();
  history.push(entry);

  const MAX_ENTRIES = 100;
  const trimmed = history.slice(-MAX_ENTRIES);

  mkdirSync(dirname(HISTORY_PATH), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(trimmed, null, 2));
}

export function saveRunLedger(ledger: RunLedger): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  const path = resolve(RUNS_DIR, `${ledger.runId}.json`);
  writeFileSync(path, JSON.stringify(ledger, null, 2));
}

export function loadRunLedger(runId: string): RunLedger | null {
  const path = resolve(RUNS_DIR, `${runId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

const STATE_DIR = resolve(import.meta.dirname, "../../state");
const SESSION_COST_PATH = resolve(STATE_DIR, "session-cost.json");

export interface SessionCost {
  totalUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  runCount: number;
  lastUpdated: string;
}

function load(): SessionCost {
  if (!existsSync(SESSION_COST_PATH)) {
    return {
      totalUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      runCount: 0,
      lastUpdated: new Date().toISOString(),
    };
  }
  return JSON.parse(readFileSync(SESSION_COST_PATH, "utf-8"));
}

function save(session: SessionCost): void {
  mkdirSync(dirname(SESSION_COST_PATH), { recursive: true });
  session.lastUpdated = new Date().toISOString();
  writeFileSync(SESSION_COST_PATH, JSON.stringify(session, null, 2));
}

export function getSessionCost(): SessionCost {
  return load();
}

export function addRunCost(partial: {
  totalUsd: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
}): SessionCost {
  const session = load();
  session.totalUsd += partial.totalUsd;
  session.totalInputTokens += partial.totalInputTokens ?? 0;
  session.totalOutputTokens += partial.totalOutputTokens ?? 0;
  session.runCount += 1;
  save(session);
  return session;
}

export function resetSessionCost(): SessionCost {
  const session: SessionCost = {
    totalUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    runCount: 0,
    lastUpdated: new Date().toISOString(),
  };
  save(session);
  return session;
}

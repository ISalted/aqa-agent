import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import type { TestPlan, MethodResult } from "../types.js";

const STATE_DIR = resolve(import.meta.dirname, "../../state");
const LAST_PLAN_PATH = resolve(STATE_DIR, "last-plan-run.json");
const LAST_IMPLEMENT_PATH = resolve(STATE_DIR, "last-implement-run.json");
const PLANS_DIR = resolve(STATE_DIR, "plans");

export interface LastPlanRunContext {
  service: string;
  runId: string;
  completedAt: string;
  methods: string[];
}

export interface LastImplementRunContext {
  service: string;
  runId: string;
  completedAt: string;
  methods: { method: string; testFile: string; status: string }[];
}

/** Load the last "plan" run (for chat + implement_only). */
export function loadLastPlanRun(): LastPlanRunContext | null {
  if (!existsSync(LAST_PLAN_PATH)) return null;
  return JSON.parse(readFileSync(LAST_PLAN_PATH, "utf-8"));
}

/** Load the last run that wrote tests (for chat + validate_only). */
export function loadLastImplementRun(): LastImplementRunContext | null {
  if (!existsSync(LAST_IMPLEMENT_PATH)) return null;
  return JSON.parse(readFileSync(LAST_IMPLEMENT_PATH, "utf-8"));
}

/** Save plan artifacts after a successful "plan" run. Optionally save protoPath and testDir for implement_only to skip resolve. */
export function savePlanArtifacts(
  service: string,
  runId: string,
  methodResults: MethodResult[],
  context?: { protoPath: string; testDir: string },
): void {
  const plans: Record<string, TestPlan> = {};
  for (const mr of methodResults) {
    if (mr.plan) plans[mr.method] = mr.plan;
  }
  if (Object.keys(plans).length === 0) return;

  mkdirSync(PLANS_DIR, { recursive: true });
  const plansPath = resolve(PLANS_DIR, `${service}.json`);
  const payload: Record<string, unknown> = {
    service,
    runId,
    completedAt: new Date().toISOString(),
    plans,
  };
  if (context?.protoPath && context?.testDir) {
    payload.protoPath = context.protoPath;
    payload.testDir = context.testDir;
  }
  writeFileSync(plansPath, JSON.stringify(payload, null, 2));

  const lastPlan: LastPlanRunContext = {
    service,
    runId,
    completedAt: new Date().toISOString(),
    methods: Object.keys(plans),
  };
  mkdirSync(dirname(LAST_PLAN_PATH), { recursive: true });
  writeFileSync(LAST_PLAN_PATH, JSON.stringify(lastPlan, null, 2));
}

/** Save last implement run context (service, methods with testFiles) for validate_only. */
export function saveLastImplementRun(
  service: string,
  runId: string,
  methodResults: MethodResult[],
): void {
  const methods = methodResults
    .filter((m) => m.testFile)
    .map((m) => ({
      method: m.method,
      testFile: m.testFile!,
      status: m.status,
    }));
  if (methods.length === 0) return;

  mkdirSync(dirname(LAST_IMPLEMENT_PATH), { recursive: true });
  const ctx: LastImplementRunContext = {
    service,
    runId,
    completedAt: new Date().toISOString(),
    methods,
  };
  writeFileSync(LAST_IMPLEMENT_PATH, JSON.stringify(ctx, null, 2));
}

/** Load saved plans for a service (for implement_only). */
export function loadPlanArtifacts(
  service: string,
): Record<string, TestPlan> | null {
  const path = resolve(PLANS_DIR, `${service}.json`);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf-8"));
  return data.plans ?? null;
}

export interface PlanContext {
  plans: Record<string, TestPlan>;
  protoPath: string;
  testDir: string;
}

/** Load full plan context (plans + protoPath + testDir) for implement_only to skip resolve. */
export function loadPlanContext(service: string): PlanContext | null {
  const path = resolve(PLANS_DIR, `${service}.json`);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf-8"));
  const plans = data.plans ?? null;
  const protoPath = data.protoPath;
  const testDir = data.testDir;
  if (!plans || Object.keys(plans).length === 0 || !protoPath || !testDir) return null;
  return { plans, protoPath, testDir };
}

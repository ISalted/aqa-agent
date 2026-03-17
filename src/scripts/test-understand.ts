// ============================================================
// Manual test script for the Understand phase.
// Run: npm run test-understand
// Tests all paths: entity resolution, proto parse, coverage,
//   testomatio, proto changes, Haiku fallback.
// ============================================================

import { config } from "dotenv";
config({ path: new URL("../../.env", import.meta.url).pathname, override: true });
import { understand } from "../understand/index.js";
import type { ParsedIntent } from "../types.js";

const SKILL_TRADE_PATH = process.env.SKILL_TRADE_PATH ?? "/Users/brudni/skill-trade";

type TestCase = {
  name: string;
  intent: ParsedIntent;
  check: (ctx: Awaited<ReturnType<typeof understand>>) => void;
};

const tests: TestCase[] = [
  // ─── 1. Exact match in service-map ───────────────────────
  {
    name: "Entity resolution — exact match (MissionEngine)",
    intent: { action: "analyze", service: "MissionEngine", raw: "analyze MissionEngine" },
    check: (ctx) => {
      assert(ctx.canonicalService === "MissionEngine", `canonical=${ctx.canonicalService}`);
      assert(ctx.contract.methods.length > 0, "no methods parsed");
      print(`  methods: ${ctx.contract.methods.map((m) => m.name).join(", ")}`);
    },
  },

  // ─── 2. Normalized match (GrpcService suffix stripped) ───
  {
    name: "Entity resolution — normalized match (UsersGrpcService → UsersGrpcService)",
    intent: { action: "analyze", service: "UsersGrpcService", raw: "analyze UsersGrpcService" },
    check: (ctx) => {
      assert(ctx.canonicalService === "UsersGrpcService", `canonical=${ctx.canonicalService}`);
      assert(ctx.coverage.totalMethods > 0, "no methods in contract");
      print(`  coverage: ${ctx.coverage.coveragePercent}% (${ctx.coverage.coveredMethods.length}/${ctx.coverage.totalMethods})`);
    },
  },

  // ─── 3. Haiku fallback — typo in service name ────────────
  {
    name: "Entity resolution — Haiku fallback (UserSercice typo)",
    intent: { action: "analyze", service: "UserSercice", raw: "analyze UserSercice" },
    check: (ctx) => {
      assert(ctx.canonicalService === "UsersGrpcService", `expected UsersGrpcService, got ${ctx.canonicalService}`);
      print(`  Haiku resolved: ${ctx.canonicalService}`);
    },
  },

  // ─── 4. Local test file count ────────────────────────────
  {
    name: "localTestFilesCount — UsersGrpcService has 8 test files",
    intent: { action: "analyze", service: "UsersGrpcService", raw: "analyze UsersGrpcService" },
    check: (ctx) => {
      assert(ctx.localTestFilesCount === 8, `expected 8, got ${ctx.localTestFilesCount}`);
      print(`  localTestFilesCount: ${ctx.localTestFilesCount}`);
    },
  },

  // ─── 5. Coverage analysis — covered methods ──────────────
  {
    name: "Coverage — covered methods match test files",
    intent: { action: "analyze", service: "UsersGrpcService", raw: "analyze UsersGrpcService" },
    check: (ctx) => {
      assert(ctx.coverage.coveredMethods.length > 0, "no covered methods found");
      print(`  covered: ${ctx.coverage.coveredMethods.map((m) => m.method).join(", ")}`);
      print(`  uncovered: ${ctx.coverage.uncoveredMethods.join(", ") || "none"}`);
    },
  },

  // ─── 6. Proto contract parse ─────────────────────────────
  {
    name: "Parse contract — messages and enums extracted",
    intent: { action: "analyze", service: "MissionEngine", raw: "analyze MissionEngine" },
    check: (ctx) => {
      assert(ctx.contract.messages.length > 0, "no messages parsed");
      print(`  messages: ${ctx.contract.messages.length}, enums: ${ctx.contract.enums.length}`);
    },
  },

  // ─── 7. Infrastructure resolve ───────────────────────────
  {
    name: "Infrastructure — protoPath found, no proto in missingComponents",
    intent: { action: "analyze", service: "MissionEngine", raw: "analyze MissionEngine" },
    check: (ctx) => {
      assert(!ctx.infrastructure.missingComponents.includes("proto"), "proto listed as missing");
      assert(ctx.infrastructure.protoPath.endsWith(".proto"), `protoPath=${ctx.infrastructure.protoPath}`);
      print(`  protoPath: ${ctx.infrastructure.protoPath}`);
      print(`  missing: ${ctx.infrastructure.missingComponents.join(", ") || "none"}`);
    },
  },

  // ─── 8. Testomatio coverage (best-effort, may be null) ───
  {
    name: "Testomatio — API call (best-effort, null if unreachable)",
    intent: { action: "analyze", service: "MissionEngine", raw: "analyze MissionEngine" },
    check: (ctx) => {
      if (ctx.testomatioCoverage) {
        print(`  testomatio: ${ctx.testomatioCoverage.manualTests} manual / ${ctx.testomatioCoverage.automatedTests} auto`);
      } else {
        print(`  testomatio: null (no suite found or API unavailable)`);
      }
      // always passes — testomatio is best-effort
    },
  },

  // ─── 9. Scope logic — all_methods when no proto changes ──
  {
    name: "Scope — all_methods when no proto changes for service",
    intent: { action: "analyze", service: "XpEngine", raw: "analyze XpEngine" },
    check: (ctx) => {
      print(`  scope: ${ctx.scope}, protoChanges: ${ctx.protoChanges ? "yes" : "none"}`);
      // scope is "changed_only" only if protoChanges exist for this service
      if (!ctx.protoChanges) {
        assert(ctx.scope === "all_methods", `expected all_methods, got ${ctx.scope}`);
      } else {
        assert(ctx.scope === "changed_only", `expected changed_only, got ${ctx.scope}`);
      }
    },
  },
];

// ─── Runner ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const test of tests) {
  process.stdout.write(`\n[TEST] ${test.name}\n`);
  try {
    const ctx = await understand(test.intent, SKILL_TRADE_PATH);
    test.check(ctx);
    console.log(`  ✓ PASS`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${(err as Error).message}`);
    failed++;
  }
}

console.log(`\n─────────────────────────────────`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// ─── Helpers ────────────────────────────────────────────────

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function print(msg: string): void {
  console.log(msg);
}

import type { GuardrailResult, TestPlan, TestCase } from "../types.js";

/**
 * Deterministic guardrails — zero LLM tokens.
 * Validates plans and generated code against hard constraints.
 */

// ─── Plan Validation ────────────────────────────────────────

export function validatePlan(plan: TestPlan): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!plan.service || !plan.method) {
    errors.push("Plan must specify service and method");
  }

  if (!plan.schemaTest) {
    errors.push("Plan must include a schema validation test (mandatory per project rules)");
  }

  if (plan.testCases.length === 0) {
    errors.push("Plan must have at least one test case");
  }

  const hasPositive = plan.testCases.some((t) => t.type === "positive");
  if (!hasPositive) {
    errors.push("Plan must include at least one positive (happy path) test");
  }

  const ids = plan.testCases.map((t) => t.id);
  if (new Set(ids).size !== ids.length) {
    errors.push("Duplicate test case IDs detected");
  }

  for (const tc of plan.testCases) {
    validateTestCase(tc, errors, warnings);
  }

  if (plan.testCases.length > 20) {
    warnings.push(`Plan has ${plan.testCases.length} test cases — consider splitting`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateTestCase(tc: TestCase, errors: string[], warnings: string[]): void {
  if (!tc.name.trim()) errors.push(`Test case ${tc.id} has empty name`);
  if (!tc.expectedBehavior.trim()) {
    errors.push(`Test case ${tc.id} has empty expectedBehavior`);
  }
  if (tc.description.length < 10) {
    warnings.push(`Test case ${tc.id} has very short description`);
  }
}

// ─── Code Validation ────────────────────────────────────────

export function validateGeneratedCode(code: string): GuardrailResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (code.includes("sleep(") || code.includes("setTimeout(")) {
    errors.push("No sleep/setTimeout allowed — use proper waits or retries");
  }

  if (/['"`]\w+@\w+/.test(code) && !code.includes("generateProcessId")) {
    warnings.push("Possible hardcoded email — use dynamic test data generators");
  }

  const hardcodedStrings = code.match(/['"](?:test|demo|example|sample|foo|bar|baz)['"]/gi);
  if (hardcodedStrings && hardcodedStrings.length > 3) {
    warnings.push("Multiple hardcoded test strings — consider using data generators");
  }

  if (!code.includes("import")) {
    errors.push("Generated code has no imports — likely incomplete");
  }

  if (!code.includes("test(") && !code.includes("test.describe(")) {
    errors.push("No test() or test.describe() found — not a valid test file");
  }

  if (!code.includes("expect(")) {
    errors.push("No expect() assertions found");
  }

  if (code.includes("ts-interface-checker") || code.includes("createCheckers")) {
    // schema validation present — good
  } else {
    warnings.push(
      "No ts-interface-checker import — schema validation test may be missing",
    );
  }

  if (code.includes(".only(") || code.includes(".skip(")) {
    errors.push("Remove .only() / .skip() before committing");
  }

  if (code.includes("console.log(")) {
    warnings.push("console.log() found — remove debugging output");
  }

  const testCount = (code.match(/test\s*\(/g) || []).length;
  if (testCount === 0) {
    errors.push("No tests found in generated code");
  }

  return { valid: errors.length === 0, errors, warnings };
}

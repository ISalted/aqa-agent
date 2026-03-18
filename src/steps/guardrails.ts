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

  if (plan.testCases.length === 0) {
    errors.push("Plan must have at least one test case");
  }

  const schemaTest = plan.testCases[0];
  if (!schemaTest || schemaTest.type !== "schema") {
    errors.push("First test case must be type: schema (mandatory per project rules)");
  }

  const hasPositive = plan.testCases.some((t) => t.type === "positive");
  if (!hasPositive) {
    errors.push("Plan must include at least one positive (happy path) test");
  }

  const ids = plan.testCases.map((t) => t.id);
  if (new Set(ids).size !== ids.length) {
    errors.push("Duplicate test case IDs detected");
  }

  const idPattern = /^[A-Z]{3}-\d{3}$/;
  for (const tc of plan.testCases) {
    if (!idPattern.test(tc.id)) {
      errors.push(`Test case ${tc.id || "<missing>"} must match ID format AAA-001`);
    }
    if (!tc.name.startsWith(`${tc.id}: `)) {
      errors.push(`Test case ${tc.id} name must start with "${tc.id}: "`);
    }
  }

  if (schemaTest && !idPattern.test(schemaTest.id)) {
    errors.push("Schema test must use ID format AAA-001");
  }
  if (schemaTest && !/\-001$/.test(schemaTest.id)) {
    errors.push("Schema test must be the first numbered case and end with -001");
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

  if (!code.includes("expect(") && !code.includes("ResponseChecker.strictCheck(")) {
    warnings.push("No expect() assertions found");
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
    warnings.push("No tests found in generated code");
  }

  return { valid: errors.length === 0, errors, warnings };
}

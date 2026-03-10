import { execSync } from "child_process";
import type { TestResult, TestError } from "../types.js";

/**
 * Deterministic test runner — zero LLM tokens.
 * Executes a single test file via Playwright and parses results.
 */
export function runTests(
  testFile: string,
  skillTradePath: string,
): TestResult {
  const startTime = Date.now();

  try {
    const stdout = execSync(
      `npx playwright test "${testFile}" --reporter=json`,
      {
        cwd: skillTradePath,
        encoding: "utf-8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024 * 10,
        env: { ...process.env, CI: "true" },
      },
    );

    return parsePlaywrightJson(testFile, stdout, Date.now() - startTime);
  } catch (e) {
    const err = e as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };

    const rawOutput = [err.stdout ?? "", err.stderr ?? ""].join("\n");

    if (err.stdout) {
      try {
        return parsePlaywrightJson(testFile, err.stdout, Date.now() - startTime);
      } catch {
        // fall through to raw parsing
      }
    }

    return parseRawOutput(testFile, rawOutput, Date.now() - startTime);
  }
}

function parsePlaywrightJson(
  file: string,
  stdout: string,
  duration: number,
): TestResult {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) {
    return parseRawOutput(file, stdout, duration);
  }

  const json = JSON.parse(stdout.slice(jsonStart));
  const suites = json.suites ?? [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const errors: TestError[] = [];

  function walkSuites(suiteList: unknown[]): void {
    for (const suite of suiteList as Record<string, unknown>[]) {
      const specs = (suite.specs ?? []) as Record<string, unknown>[];
      for (const spec of specs) {
        const tests = (spec.tests ?? []) as Record<string, unknown>[];
        for (const test of tests) {
          const results = (test.results ?? []) as Record<string, unknown>[];
          for (const result of results) {
            switch (result.status) {
              case "passed":
                passed++;
                break;
              case "failed":
              case "timedOut":
                failed++;
                errors.push({
                  testName: spec.title as string,
                  message: (result.error as Record<string, unknown>)?.message as string ?? "Unknown error",
                  stack: (result.error as Record<string, unknown>)?.stack as string | undefined,
                });
                break;
              case "skipped":
                skipped++;
                break;
            }
          }
        }
      }
      if (suite.suites) walkSuites(suite.suites as unknown[]);
    }
  }

  walkSuites(suites);

  return { file, passed, failed, skipped, duration, errors };
}

function parseRawOutput(
  file: string,
  output: string,
  duration: number,
): TestResult {
  const passedMatch = output.match(/(\d+)\s+passed/);
  const failedMatch = output.match(/(\d+)\s+failed/);
  const skippedMatch = output.match(/(\d+)\s+skipped/);

  const errors: TestError[] = [];
  const errorPattern = /\d+\)\s+(.+?)(?:\n[\s\S]*?Error:\s*([\s\S]*?)(?=\n\s*\d+\)|\n\s*$))?/g;
  let match: RegExpExecArray | null;
  while ((match = errorPattern.exec(output)) !== null) {
    errors.push({
      testName: match[1].trim(),
      message: match[2]?.trim() ?? "Test failed",
    });
  }

  return {
    file,
    passed: passedMatch ? parseInt(passedMatch[1]) : 0,
    failed: failedMatch ? parseInt(failedMatch[1]) : errors.length,
    skipped: skippedMatch ? parseInt(skippedMatch[1]) : 0,
    duration,
    errors,
  };
}

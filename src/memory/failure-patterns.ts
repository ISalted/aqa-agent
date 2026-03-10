import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import type { FailurePattern, FailureClass, TestError } from "../types.js";

const STATE_DIR = resolve(import.meta.dirname, "../../state");
const PATTERNS_PATH = resolve(STATE_DIR, "failure-patterns.json");

export function loadFailurePatterns(): FailurePattern[] {
  if (!existsSync(PATTERNS_PATH)) return [];
  return JSON.parse(readFileSync(PATTERNS_PATH, "utf-8"));
}

export function recordFailurePattern(
  error: TestError,
  failureClass: FailureClass,
  diagnosis: string,
  fix: string,
): void {
  const patterns = loadFailurePatterns();

  const normalizedMessage = normalizeErrorMessage(error.message);
  const existing = patterns.find((p) => p.pattern === normalizedMessage);

  if (existing) {
    existing.occurrences++;
    existing.lastSeen = new Date().toISOString();
    if (diagnosis) existing.diagnosis = diagnosis;
    if (fix) existing.fix = fix;
  } else {
    patterns.push({
      pattern: normalizedMessage,
      failureClass,
      diagnosis,
      fix,
      occurrences: 1,
      lastSeen: new Date().toISOString(),
    });
  }

  mkdirSync(dirname(PATTERNS_PATH), { recursive: true });
  writeFileSync(PATTERNS_PATH, JSON.stringify(patterns, null, 2));
}

export function findMatchingPattern(
  error: TestError,
): FailurePattern | undefined {
  const patterns = loadFailurePatterns();
  const normalized = normalizeErrorMessage(error.message);

  return patterns.find(
    (p) =>
      normalized.includes(p.pattern) ||
      p.pattern.includes(normalized) ||
      levenshteinSimilarity(normalized, p.pattern) > 0.7,
  );
}

function normalizeErrorMessage(msg: string): string {
  return msg
    .replace(/\b[0-9a-f]{8,}\b/g, "<ID>")
    .replace(/\b\d{10,}\b/g, "<TIMESTAMP>")
    .replace(/at\s+.+:\d+:\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] =
        i === 0
          ? j
          : Math.min(
              matrix[i - 1][j] + 1,
              matrix[i][j - 1] + 1,
              matrix[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
    }
  }

  return 1 - matrix[a.length][b.length] / maxLen;
}

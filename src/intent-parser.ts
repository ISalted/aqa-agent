import { join, basename } from "path";
import { existsSync } from "fs";
import { globSync } from "glob";
import Anthropic from "@anthropic-ai/sdk";
import type { ParsedIntent } from "./types.js";

// ─── Testomatio URL parsing ───────────────────────────────────

// Matches: https://app.testomat.io/projects/{project}/suite/{id}-{slug}
const TESTOMATIO_SUITE_RE = /testomat\.io\/projects\/[^/]+\/suite\/([a-f0-9]{8})(?:-([a-z0-9-]+))?/i;

/**
 * Extract suite ID from a Testomatio URL.
 * Returns null if no URL found in the prompt.
 */
export function parseSuiteIdFromUrl(prompt: string): string | null {
  const match = prompt.match(TESTOMATIO_SUITE_RE);
  return match ? match[1] : null;
}

/**
 * Convert URL slug to PascalCase method name.
 * "cancel-contest" → "CancelContest"
 */
export function slugToPascalCase(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Extract the slug part from a Testomatio URL (after the suite ID).
 * "https://.../suite/f2b50ae0-cancel-contest" → "cancel-contest"
 */
function parseSlugFromUrl(prompt: string): string | null {
  const match = prompt.match(TESTOMATIO_SUITE_RE);
  return match?.[2] ?? null;
}

const ACTION_KEYWORDS: Partial<Record<NonNullable<ParsedIntent["action"]>, RegExp>> = {
  analyze:       /аналіз|проаналізу|analyze|coverage|покрит[тя]/i,
  plan:          /^план|^plan|тільки план|plan only|запланій/i,
  fix:           /полагод|fix|виправ|repair|почин|лагод/i,
  implement_only:/реалізуй тести по плану|імплементуй по плану|implement_only|use saved plan|from saved plan/i,
  validate_only: /запусти тести|завалідуй|run tests|validate only|заранити тести/i,
};

function getAvailableServices(skillTradePath: string): string[] {
  const protoDir = join(skillTradePath, "lib/clients/gRPC/proto");
  if (!existsSync(protoDir)) return [];
  return globSync("*.proto", { cwd: protoDir }).map((f) =>
    basename(f, ".proto"),
  );
}

function matchService(prompt: string, services: string[]): string | null {
  const lower = prompt.toLowerCase();
  const sorted = [...services].sort((a, b) => b.length - a.length);
  for (const s of sorted) {
    if (lower.includes(s.toLowerCase())) return s;
  }
  return null;
}

const ACTION_PRIORITY: NonNullable<ParsedIntent["action"]>[] = [
  "implement_only",
  "fix",
  "validate_only",
  "plan",
  "analyze",
];

function matchAction(prompt: string): ParsedIntent["action"] {
  const matched = new Set<NonNullable<ParsedIntent["action"]>>();
  for (const [action, regex] of Object.entries(ACTION_KEYWORDS)) {
    if ((regex as RegExp).test(prompt)) matched.add(action as NonNullable<ParsedIntent["action"]>);
  }
  for (const action of ACTION_PRIORITY) {
    if (matched.has(action)) return action;
  }
  return null; // default: full pipeline
}

function matchMethods(
  prompt: string,
  serviceName: string,
): string[] | undefined {
  const pascal = prompt.match(/\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g) || [];
  const methods = pascal.filter((w) => w !== serviceName);
  return methods.length > 0 ? methods : undefined;
}

export function parsePromptRegex(
  prompt: string,
  skillTradePath: string,
): ParsedIntent | null {
  const suiteId = parseSuiteIdFromUrl(prompt);

  const services = getAvailableServices(skillTradePath);
  const service = matchService(prompt, services);
  if (!service && !suiteId) return null;

  // Infer method from URL slug if no explicit method found
  const slug = parseSlugFromUrl(prompt);
  const methodFromSlug = slug ? [slugToPascalCase(slug)] : undefined;
  const explicitMethods = service ? matchMethods(prompt, service) : undefined;

  return {
    action: matchAction(prompt),
    service: service ?? "",
    methods: explicitMethods ?? methodFromSlug,
    raw: prompt,
    testomatioSuiteId: suiteId ?? undefined,
  };
}

export async function parsePromptLLM(
  prompt: string,
  skillTradePath: string,
): Promise<ParsedIntent | null> {
  const services = getAvailableServices(skillTradePath);
  if (services.length === 0) return null;

  const client = new Anthropic();

  const suiteId = parseSuiteIdFromUrl(prompt);
  const slug = parseSlugFromUrl(prompt);

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    system: [
      "Parse the user's request into a JSON object for a QA test automation agent.",
      `Available services: ${services.join(", ")}`,
      "Available actions: null (default, full pipeline: plan+write+validate), analyze (coverage report only), plan (generate test plan only, no implementation), fix (repair failing tests), implement_only (write code from a previously saved plan), validate_only (run existing tests only)",
      "Action selection rules: return null when user wants to write/create/implement/generate/cover tests — this triggers the full pipeline. CRITICAL: 'implement tests for X', 'write tests for X', 'імплементуй тести', 'напиши тести', 'покрий тестами' all = null. Use 'implement_only' ONLY when user explicitly says 'from saved plan', 'use existing plan', 'по плану', or 'implement only' without specifying a new task. Use 'plan' ONLY when user says 'only plan', 'just plan', 'тільки план'.",
      "If the prompt contains a Testomatio URL (testomat.io/projects/.../suite/...), use the suite slug to identify the method name (e.g. 'cancel-contest' → 'CancelContest') and infer the service from context.",
      'Return ONLY valid JSON: {"action":"...","service":"...","methods":null}',
      'If methods are mentioned, return them as an array: {"methods":["MethodName"]}',
      "If you cannot determine the service, return null.",
    ].join("\n"),
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!parsed.service || !services.includes(parsed.service)) return null;

    const methodFromSlug = slug ? [slugToPascalCase(slug)] : undefined;

    return {
      action: parsed.action || null,
      service: parsed.service,
      methods: parsed.methods?.length ? parsed.methods : methodFromSlug,
      raw: prompt,
      testomatioSuiteId: suiteId ?? undefined,
    };
  } catch {
    return null;
  }
}

export async function parsePrompt(
  prompt: string,
  skillTradePath: string,
): Promise<ParsedIntent | null> {
  const regexResult = parsePromptRegex(prompt, skillTradePath);
  if (regexResult) return regexResult;

  return parsePromptLLM(prompt, skillTradePath);
}

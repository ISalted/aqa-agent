import { join, basename } from "path";
import { existsSync } from "fs";
import { globSync } from "glob";
import Anthropic from "@anthropic-ai/sdk";
import type { ParsedIntent } from "./types.js";

const ACTION_KEYWORDS: Partial<Record<NonNullable<ParsedIntent["action"]>, RegExp>> = {
  analyze:       /аналіз|проаналізу|analyze|coverage|покрит[тя]/i,
  plan:          /^план|^plan|тільки план|plan only|запланій/i,
  fix:           /полагод|fix|виправ|repair|почин|лагод/i,
  implement_only:/реалізуй тести по плану|тепер реалізуй|тепер імплементуй|імплементуй по плану|implement_only|implement only|збережених планів|use saved plan|from saved plan/i,
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
  const services = getAvailableServices(skillTradePath);
  const service = matchService(prompt, services);
  if (!service) return null;

  return {
    action: matchAction(prompt),
    service,
    methods: matchMethods(prompt, service),
    raw: prompt,
  };
}

export async function parsePromptLLM(
  prompt: string,
  skillTradePath: string,
): Promise<ParsedIntent | null> {
  const services = getAvailableServices(skillTradePath);
  if (services.length === 0) return null;

  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    system: [
      "Parse the user's request into a JSON object for a QA test automation agent.",
      `Available services: ${services.join(", ")}`,
      "Available actions: null (default, full pipeline: plan+write+validate), analyze (coverage report only), plan (generate test plan only, no implementation), fix (repair failing tests), implement_only (write code from a previously saved plan), validate_only (run existing tests only)",
      "Action selection rules: return null when user wants to write/create/implement/generate tests — this triggers the full pipeline. Use 'implement_only' ONLY when user explicitly says 'from saved plan', 'use existing plan', or 'implement only'. Use 'plan' ONLY when user says 'only plan' or 'just plan'.",
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

    return {
      action: parsed.action || null,
      service: parsed.service,
      methods: parsed.methods?.length ? parsed.methods : undefined,
      raw: prompt,
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

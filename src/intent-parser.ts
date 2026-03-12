import { join, basename } from "path";
import { existsSync } from "fs";
import { globSync } from "glob";
import Anthropic from "@anthropic-ai/sdk";
import type { ParsedIntent } from "./types.js";

const ACTION_KEYWORDS: Record<ParsedIntent["action"], RegExp> = {
  analyze: /аналіз|проаналізу|analyze|coverage|покрит[тя]/i,
  plan: /план|plan|запланій/i,
  fix: /полагод|fix|виправ|repair|почин|лагод/i,
  implement_only: /реалізуй тести|тепер реалізуй|тепер імплементуй|імплементуй тести|implement_only|implement only|збережених планів/i,
  validate_only: /запусти тести|завалідуй|run tests|validate|заранити тести/i,
  cover: /покри[йтв]|cover|напиши|write|тестам|тести|test/i,
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

// Priority order: more specific/expensive actions win over simpler ones.
// This handles compound intents like "analyze AND implement" → cover (full pipeline).
const ACTION_PRIORITY: ParsedIntent["action"][] = [
  "cover",
  "implement_only",
  "fix",
  "validate_only",
  "plan",
  "analyze",
];

function matchAction(prompt: string): ParsedIntent["action"] {
  const matched = new Set<ParsedIntent["action"]>();
  for (const [action, regex] of Object.entries(ACTION_KEYWORDS)) {
    if (regex.test(prompt)) matched.add(action as ParsedIntent["action"]);
  }
  for (const action of ACTION_PRIORITY) {
    if (matched.has(action)) return action;
  }
  return "cover";
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
      "Available actions: cover (full pipeline: write tests), analyze (coverage report only), plan (test plans only), fix (repair failures), implement_only (write from saved plans), validate_only (run tests only)",
      "Action selection rules: if the user wants BOTH analysis AND implementation/tests → use 'cover'. Only use 'analyze' if the user explicitly wants only a coverage report with no implementation.",
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
      action: parsed.action || "cover",
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

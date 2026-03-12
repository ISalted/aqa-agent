import Anthropic from "@anthropic-ai/sdk";
import { basename } from "path";
import { existsSync } from "fs";
import { globSync } from "glob";
import { join } from "path";
import { loadProjectIndex } from "./memory/project-index.js";
import {
  loadLastPlanRun,
  loadLastImplementRun,
} from "./memory/resumable-context.js";
import type { ParsedIntent } from "./types.js";

const client = new Anthropic();

export interface ChatResult {
  type: "message" | "pipeline";
  text: string;
  thinking?: string;
  intent?: ParsedIntent;
  _rawContent: Anthropic.ContentBlock[];
  _toolUseId?: string;
}

const PIPELINE_TOOL: Anthropic.Tool = {
  name: "start_pipeline",
  description:
    "Start the QA test automation pipeline. Call this when you clearly understand what the user wants.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["cover", "analyze", "plan", "fix", "implement_only", "validate_only"],
        description:
          "cover = full cycle (plan+write), analyze = coverage only, plan = plans only, fix = repair failures, implement_only = write from saved plans, validate_only = run tests only (no write/debug)",
      },
      service: {
        type: "string",
        description: "Exact service name from the available list",
      },
      methods: {
        type: "array",
        items: { type: "string" },
        description: "Specific methods to process (optional, omit to process all uncovered)",
      },
    },
    required: ["action", "service"],
  },
};

function getAvailableServices(skillTradePath: string): string[] {
  const protoDir = join(skillTradePath, "lib/clients/gRPC/proto");
  if (!existsSync(protoDir)) return [];
  return globSync("*.proto", { cwd: protoDir })
    .map((f) => basename(f, ".proto"))
    .sort();
}

function buildSystemPrompt(skillTradePath: string): string {
  const services = getAvailableServices(skillTradePath);
  const index = loadProjectIndex();
  const lastPlan = loadLastPlanRun();
  const lastImplement = loadLastImplementRun();

  const serviceLines = services
    .map((s) => {
      const info = index.services[s];
      if (info) {
        return `  - ${s}: ${info.coveragePercent}% covered, methods: [${info.methods.join(", ")}]`;
      }
      return `  - ${s}: no coverage data yet`;
    })
    .join("\n");

  const lastPlanSection =
    lastPlan && lastPlan.methods.length > 0
      ? [
          "",
          "Last plan run (resumable):",
          `  Service: ${lastPlan.service}. Methods with saved plans: ${lastPlan.methods.join(", ")}.`,
          "  If user says \"реалізуй тести\" / \"тепер імплементуй\" → use action implement_only and this service.",
        ].join("\n")
      : "";

  const lastImplementSection =
    lastImplement && lastImplement.methods.length > 0
      ? [
          "",
          "Last implement run (can validate):",
          `  Service: ${lastImplement.service}. Test files: ${lastImplement.methods.length} method(s).`,
          "  If user says \"запусти тести\" / \"завалідуй\" / \"run tests\" → use action validate_only and this service.",
        ].join("\n")
      : "";

  return [
    "You are AQA Agent — an AI test automation assistant for gRPC services (Playwright + TypeScript).",
    "",
    "Available services:",
    serviceLines,
    "",
    "Available actions:",
    "  - cover: full cycle — plan + write tests for uncovered methods",
    "  - analyze: coverage report only",
    "  - plan: generate test plans only (saves for implement_only)",
    "  - fix: repair failing tests (run + debug)",
    "  - implement_only: write tests using saved plans (after plan run)",
    "  - validate_only: run tests only, no write/debug (after implement)",
    lastPlanSection,
    lastImplementSection,
    "",
    "Rules:",
    "- If user just ran plan and asks to implement (\"реалізуй тести\", \"тепер імплементуй\") → use implement_only for that service.",
    "- If user asks to run/validate tests (\"запусти тести\", \"завалідуй\") and we have last implement run → use validate_only for that service.",
    "- If user clearly asks for analyze, plan, cover, fix, implement, or validate for a service → call start_pipeline immediately with that action and exact service name.",
    "- Match the service name EXACTLY from the list above.",
    "- Respond in the same language the user writes in.",
    "- Be concise.",
  ].join("\n");
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function extractThinking(content: Anthropic.ContentBlock[]): string | undefined {
  const thinking = content
    .filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n")
    .trim();
  return thinking || undefined;
}

export async function chatTurn(
  userMessage: string,
  history: Anthropic.MessageParam[],
  skillTradePath: string,
): Promise<ChatResult> {
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 4096,
    system: buildSystemPrompt(skillTradePath),
    messages,
    tools: [PIPELINE_TOOL],
    thinking: { type: "enabled", budget_tokens: 2048 },
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );

  const thinking = extractThinking(response.content);

  if (toolUse && toolUse.name === "start_pipeline") {
    const input = toolUse.input as {
      action: string;
      service: string;
      methods?: string[];
    };
    return {
      type: "pipeline",
      text: extractText(response.content) || `Starting: ${input.action} ${input.service}`,
      thinking,
      intent: {
        action: input.action as ParsedIntent["action"],
        service: input.service,
        methods: input.methods?.length ? input.methods : undefined,
        raw: userMessage,
      },
      _rawContent: response.content,
      _toolUseId: toolUse.id,
    };
  }

  return {
    type: "message",
    text: extractText(response.content) || "I'm not sure what you mean. Could you clarify?",
    thinking,
    _rawContent: response.content,
  };
}

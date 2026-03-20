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
import { parseSuiteIdFromUrl, slugToPascalCase } from "./intent-parser.js";
import type { ParsedIntent } from "./types.js";

const client = new Anthropic();

export interface ChatResult {
  type: "message" | "pipeline" | "clarification";
  text: string;
  thinking?: string;
  intent?: ParsedIntent;
  _rawContent: Anthropic.ContentBlock[];
  _toolUseId?: string;
}

// ─── Tools ──────────────────────────────────────────────────

const PIPELINE_TOOL: Anthropic.Tool = {
  name: "start_pipeline",
  description:
    "Start the QA test automation pipeline. Call this when the user's intent is clear.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["analyze", "understand_only", "plan", "fix", "implement_only", "validate_only"],
        description:
          "understand_only = fetch proto + testomatio cases only (no plan/implement), analyze = coverage only, plan = plans only, fix = repair failures, implement_only = write from saved plans, validate_only = run tests only. Omit for full pipeline (plan+write+validate).",
      },
      service: {
        type: "string",
        description: "Exact service name from the available list",
      },
      methods: {
        type: "array",
        items: { type: "string" },
        description: "Specific methods to process (optional — omit to process all)",
      },
      testomatio_suite_url: {
        type: "string",
        description:
          "Full Testomatio suite URL if the user provided one (e.g. https://app.testomat.io/projects/.../suite/abc123-cancel-contest). Pass it as-is.",
      },
    },
    required: ["service"],
  },
};

const CLARIFY_TOOL: Anthropic.Tool = {
  name: "ask_clarification",
  description:
    "Ask the user a clarifying question when the request is ambiguous. Use this when you are unsure which service, action, or methods the user wants.",
  input_schema: {
    type: "object" as const,
    properties: {
      question: {
        type: "string",
        description: "The clarifying question to ask the user",
      },
      understood: {
        type: "string",
        description: "Brief summary of what you understood so far",
      },
    },
    required: ["question"],
  },
};

// ─── Context Helpers ────────────────────────────────────────

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
  const lastImpl = loadLastImplementRun();

  // Build service lines with coverage context
  const serviceLines = services
    .map((s) => {
      const info = index.services[s];
      if (info) {
        const uncovered = info.methods.filter(
          (m) => !info.testFiles.some((f) => f.toLowerCase().includes(m.toLowerCase())),
        ).length;
        return `  - ${s}: ${info.coveragePercent}% covered (${info.methods.length} methods, ~${uncovered} uncovered)`;
      }
      return `  - ${s}: not yet analyzed`;
    })
    .join("\n");

  // Build resumable context section (only if relevant)
  const resumeLines: string[] = [];
  if (lastPlan && lastPlan.methods.length > 0) {
    resumeLines.push(
      `Last plan run — service: ${lastPlan.service}, saved plans for: ${lastPlan.methods.join(", ")}.`,
      `  → If user says "реалізуй" / "implement" → action: implement_only, service: ${lastPlan.service}`,
    );
  }
  if (lastImpl && lastImpl.methods.length > 0) {
    resumeLines.push(
      `Last implement run — service: ${lastImpl.service}, ${lastImpl.methods.length} test file(s) written.`,
      `  → If user says "запусти тести" / "run tests" → action: validate_only, service: ${lastImpl.service}`,
    );
  }

  return [
    "You are AQA Agent — an AI test automation assistant for gRPC services (Playwright + TypeScript).",
    "",
    "## Available Services",
    serviceLines || "  (no services found — SKILL_TRADE_PATH may be wrong)",
    "",
    "## Available Actions",
    "  (omit)         — full pipeline: plan + write + validate all uncovered methods",
    "  understand_only — fetch proto + testomatio cases only, stop before plan/implement",
    "  analyze        — coverage report only, no implementation",
    "  plan           — generate test plans only (saves them for implement_only)",
    "  fix            — repair failing tests (run + debug loop)",
    "  implement_only  — write tests from previously saved plans",
    "  validate_only  — run tests only, no write or debug",
    ...(resumeLines.length > 0 ? ["", "## Resumable Context", ...resumeLines] : []),
    "",
    "## Behavior Rules",
    "- Call start_pipeline immediately when the user's intent is clear.",
    "- Use ask_clarification when the service or action is genuinely ambiguous.",
    "- OMIT action (do not set it) when user wants to write/implement/cover/generate tests — this triggers full pipeline.",
    "- Match service names EXACTLY from the list above.",
    "- Respond in the same language the user writes in.",
    "- Be concise.",
    "- If the user provides a Testomatio URL (testomat.io/projects/.../suite/...): pass it as testomatio_suite_url, infer the service from the slug (e.g. 'cancel-contest' → ContestEngine), and infer the method from the slug in PascalCase (e.g. 'cancel-contest' → CancelContest). Do NOT ask clarifying questions when a URL is provided.",
    "- Use action: understand_only when the user wants to VIEW or FETCH existing data (proto, test cases, coverage) WITHOUT writing or running tests. The user's intent is to inspect, not to generate.",
  ].join("\n");
}

// ─── Response Helpers ────────────────────────────────────────

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

// ─── Main Chat Turn ─────────────────────────────────────────

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
    tools: [PIPELINE_TOOL, CLARIFY_TOOL],
    thinking: { type: "enabled", budget_tokens: 2048 },
  });

  const thinking = extractThinking(response.content);

  // Check for pipeline start
  const pipelineTool = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "start_pipeline",
  );
  if (pipelineTool) {
    const input = pipelineTool.input as {
      action?: string;
      service: string;
      methods?: string[];
      testomatio_suite_url?: string;
    };

    // Extract suite ID and method from URL if provided
    const suiteUrl = input.testomatio_suite_url ?? parseSuiteIdFromUrl(userMessage) ? userMessage : undefined;
    const suiteId = input.testomatio_suite_url
      ? parseSuiteIdFromUrl(input.testomatio_suite_url)
      : parseSuiteIdFromUrl(userMessage);

    // If URL provided and no explicit methods, infer method from slug
    let methods = input.methods?.length ? input.methods : undefined;
    if (!methods && suiteUrl) {
      const slugMatch = suiteUrl.match(/suite\/[a-f0-9]{8}-([a-z0-9-]+)/i);
      if (slugMatch) {
        methods = [slugToPascalCase(slugMatch[1])];
      }
    }

    return {
      type: "pipeline",
      text: extractText(response.content) || `Starting: ${input.action ?? "full pipeline"} ${input.service}`,
      thinking,
      intent: {
        action: (input.action ?? null) as ParsedIntent["action"],
        service: input.service,
        methods,
        raw: userMessage,
        testomatioSuiteId: suiteId ?? undefined,
      },
      _rawContent: response.content,
      _toolUseId: pipelineTool.id,
    };
  }

  // Check for clarification question
  const clarifyTool = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "ask_clarification",
  );
  if (clarifyTool) {
    const input = clarifyTool.input as { question: string; understood?: string };
    const prefix = input.understood ? `${input.understood}\n\n` : "";
    return {
      type: "clarification",
      text: prefix + input.question,
      thinking,
      _rawContent: response.content,
      _toolUseId: clarifyTool.id,
    };
  }

  // Plain message
  return {
    type: "message",
    text: extractText(response.content) || "I'm not sure what you mean. Could you clarify?",
    thinking,
    _rawContent: response.content,
  };
}

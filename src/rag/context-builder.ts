import { readFileSync, existsSync } from "fs";
import { globSync } from "glob";
import { join, resolve } from "path";
import type {
  NormalizedContract,
  CoverageReport,
  AgentContext,
  FailurePattern,
  RunNotes,
} from "../types.js";
import { loadFailurePatterns } from "../memory/failure-patterns.js";

const KB_DIR = resolve(import.meta.dirname, "../../kb");

/**
 * File-based RAG — assembles relevant context for LLM agents.
 * No vector DB: we know the domain, so we select files deterministically.
 * RunNotes carry natural-language summaries from previous phases.
 */
export function buildPlannerContext(
  contract: NormalizedContract,
  coverage: CoverageReport,
  method: string,
  skillTradePath: string,
  notes?: RunNotes,
): AgentContext {
  const skills = loadSkills(["grpc-patterns", "schema-validation", "data-generation"]);
  const projectRules = loadProjectRules(skillTradePath);
  const exampleTest = pickBestExample(coverage.existingPatterns.exampleTestFiles);
  const wrapperCode = findWrapperCode(contract, skillTradePath);
  const failurePatterns = loadFailurePatterns();

  const protoContent = readFileSafe(contract.protoFile);
  const methodContract = protoContent ? extractMethodSection(protoContent, method) : null;

  return {
    systemPrompt: buildPlannerSystemPrompt(),
    skills,
    protoContract: methodContract ?? protoContent ?? undefined,
    exampleTest: exampleTest ?? undefined,
    wrapperCode: wrapperCode ?? undefined,
    failurePatterns: failurePatterns.filter((p) => p.occurrences > 1),
    projectRules,
    runNotes: buildPlannerRunNotes(notes),
  };
}

export function buildCoderContext(
  contract: NormalizedContract,
  coverage: CoverageReport,
  method: string,
  skillTradePath: string,
  notes?: RunNotes,
): AgentContext {
  const skills = loadSkills([
    "grpc-patterns",
    "schema-validation",
    "error-assertions",
    "data-generation",
  ]);
  const projectRules = loadProjectRules(skillTradePath);
  const exampleTest = pickBestExample(coverage.existingPatterns.exampleTestFiles);
  const wrapperCode = findWrapperCode(contract, skillTradePath);
  const protoContent = readFileSafe(contract.protoFile);

  return {
    systemPrompt: buildCoderSystemPrompt(),
    skills,
    protoContract: protoContent ?? undefined,
    exampleTest: exampleTest ?? undefined,
    wrapperCode: wrapperCode ?? undefined,
    projectRules,
    runNotes: buildCoderRunNotes(notes, method),
  };
}

export function buildDebuggerContext(
  contract: NormalizedContract,
  coverage: CoverageReport,
  skillTradePath: string,
): AgentContext {
  const skills = loadSkills(["debugging-grpc", "error-assertions"]);
  const projectRules = loadProjectRules(skillTradePath);
  const failurePatterns = loadFailurePatterns();

  return {
    systemPrompt: buildDebuggerSystemPrompt(),
    skills,
    protoContract: readFileSafe(contract.protoFile) ?? undefined,
    failurePatterns,
    projectRules,
  };
}

// ─── Run Notes Builders ─────────────────────────────────────
// These assemble natural-language context from structured phase outputs.

function buildPlannerRunNotes(notes?: RunNotes): string | undefined {
  if (!notes) return undefined;
  const parts: string[] = [];
  if (notes.infrastructure) parts.push(notes.infrastructure);
  if (notes.coverage) parts.push(notes.coverage);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function buildCoderRunNotes(notes?: RunNotes, method?: string): string | undefined {
  if (!notes) return undefined;
  const parts: string[] = [];
  if (notes.infrastructure) parts.push(notes.infrastructure);
  if (notes.coverage) parts.push(notes.coverage);
  if (method && notes.methodNotes[method]?.plan) {
    parts.push(`## Plan Notes\n${notes.methodNotes[method].plan}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

// ─── Skill Loader ───────────────────────────────────────────

function loadSkills(names: string[]): string[] {
  const skillsDir = join(KB_DIR, "skills");
  const loaded: string[] = [];

  for (const name of names) {
    const path = join(skillsDir, `${name}.md`);
    if (existsSync(path)) {
      loaded.push(readFileSync(path, "utf-8"));
    }
  }
  return loaded;
}

// ─── Project Rules ──────────────────────────────────────────

function loadProjectRules(skillTradePath: string): string {
  const claudeMd = join(skillTradePath, "CLAUDE.md");
  if (existsSync(claudeMd)) {
    return readFileSync(claudeMd, "utf-8");
  }

  const projectRulesFallback = join(KB_DIR, "project-rules.md");
  if (existsSync(projectRulesFallback)) {
    return readFileSync(projectRulesFallback, "utf-8");
  }

  return "No project rules found.";
}

// ─── Example Picker ─────────────────────────────────────────

function pickBestExample(exampleFiles: string[]): string | undefined {
  if (exampleFiles.length === 0) return undefined;
  return readFileSafe(exampleFiles[0]) || undefined;
}

// ─── Wrapper Finder ─────────────────────────────────────────

function findWrapperCode(contract: NormalizedContract, skillTradePath: string): string | undefined {
  const servicesDir = join(skillTradePath, "lib/clients/gRPC/services");
  const lookupNames = [
    contract.intentName,
    normalizeServiceName(contract.intentName),
    contract.service,
    normalizeServiceName(contract.service),
  ];

  for (const name of lookupNames) {
    const candidates = globSync(`*${name}*.ts`, { cwd: servicesDir, absolute: true });
    if (candidates.length > 0) {
      return readFileSafe(candidates[0]) || undefined;
    }
  }

  return undefined;
}

// ─── Proto Section Extractor ────────────────────────────────

function extractMethodSection(protoContent: string, method: string): string | null {
  const rpcLine = protoContent.match(
    new RegExp(`rpc\\s+${method}\\s*\\(\\s*(\\w+)\\s*\\)\\s*returns\\s*\\(\\s*(\\w+)\\s*\\)`),
  );
  if (!rpcLine) return null;

  const [, inputType, outputType] = rpcLine;
  const sections = [rpcLine[0]];

  for (const msgName of [inputType, outputType]) {
    const msgPattern = new RegExp(`message\\s+${msgName}\\s*\\{[\\s\\S]*?\\}`, "m");
    const msgMatch = protoContent.match(msgPattern);
    if (msgMatch) sections.push(msgMatch[0]);
  }

  return sections.join("\n\n");
}

// ─── System Prompts ─────────────────────────────────────────

function buildPlannerSystemPrompt(): string {
  return `You are a QA Test Planner for an automated RPC test framework.
Plan test cases for a single method based on the provided contract.

## Your workflow
1. Analyse the proto schema carefully — look for required/optional fields, oneofs, enums, repeated fields, complex types
2. Call save_notes with your key findings (schema complexity, tricky fields, edge cases, risks). These notes travel to the implementer.
3. Return the test plan JSON

## Notes format (save_notes)
Write concise, specific insights the implementer needs. Example:
"oneof identity (email|phone) — both paths must be tested. user_id is UUID — use generateUUID(). status enum has 4 values including UNKNOWN — boundary test needed. deadline is optional int64 — test null vs zero vs past."

## Output Format
Return ONLY valid JSON — no markdown fences, no explanations:
{
  "service": "string",
  "method": "string",
  "fileName": "string (camelCase like methodName.test.ts)",
  "schemaTest": { "id": "PREFIX-001", "type": "schema", "priority": "P1", "name": "PREFIX-001: Schema validation for ...", "description": "string", "expectedBehavior": "string" },
  "testCases": [{ "id": "PREFIX-NNN", "type": "positive|negative|boundary|edge", "priority": "P1|P2|P3", "name": "PREFIX-NNN: ...", "description": "string", "expectedBehavior": "string" }]
}

## Rules
- Always include a schema validation test first (id: PREFIX-001, type: schema, P1)
- Minimum: 1 positive + 1 negative test case
- Use a 3-letter uppercase prefix derived from the method name (e.g. GetMission → GMI)
- P1 = critical (must have), P2 = important (should have), P3 = nice to have
- 5-10 test cases total per method
- Every test name must start with its full ID: "PREFIX-NNN: ..."`;
}

function buildCoderSystemPrompt(): string {
  return `You are a QA Test Coder. Write complete, runnable TypeScript test files.

## Your workflow
1. Read the planner notes in context — they contain schema insights and risks you must address
2. Use save_notes if you discover anything important while reading files (e.g. wrapper has unexpected signature, fixture needs special setup)
3. Write the complete test file
4. Call complete_phase with a brief summary of what you wrote and any gotchas encountered

## Rules
- Follow the provided example test EXACTLY for imports, structure, and style
- Schema validation test MUST use ts-interface-checker (createCheckers)
- Use generateProcessId() or generateUUID() for unique IDs — NEVER hardcode values
- Each test must be self-contained — no shared mutable state between tests
- Use the exact test case IDs from the plan in every test title
- Write the COMPLETE file — no partial code, no TODOs, no placeholder comments

Output ONLY the complete TypeScript file content. No explanations, no markdown fences.`;
}

function buildDebuggerSystemPrompt(): string {
  return `You are a QA Test Debugger. Diagnose failing tests and produce fixes.

You have tools: read_file, write_file, list_files, grep_files, run_command.

## Process
1. Read the failing test file and examine the error details
2. Check the proto contract for field/type mismatches
3. Check the service wrapper for correct method signatures
4. Identify the root cause
5. Write the corrected file

## Common Failure Patterns
- Wrong import paths
- Incorrect RPC method call signature
- Missing or wrong field names (proto vs generated types mismatch)
- Wrong error type assertions
- Stale generated types (need proto rebuild)`;
}

// ─── Utility ────────────────────────────────────────────────

function readFileSafe(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

function normalizeServiceName(service: string): string {
  return service
    .replace(/Service$/, "")
    .replace(/Grpc$/, "")
    .replace(/GrpcService$/, "");
}

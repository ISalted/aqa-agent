import { readFileSync, existsSync } from "fs";
import { globSync } from "glob";
import { join, resolve } from "path";
import type {
  NormalizedContract,
  CoverageReport,
  AgentContext,
  FailurePattern,
} from "../types.js";
import { loadFailurePatterns } from "../memory/failure-patterns.js";

const KB_DIR = resolve(import.meta.dirname, "../../kb");

/**
 * File-based RAG — assembles relevant context for LLM agents.
 * No vector DB: we know the domain, so we select files deterministically.
 */
export function buildPlannerContext(
  contract: NormalizedContract,
  coverage: CoverageReport,
  method: string,
  skillTradePath: string,
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
  };
}

export function buildCoderContext(
  contract: NormalizedContract,
  coverage: CoverageReport,
  method: string,
  skillTradePath: string,
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
  return `You are a QA Test Planner for a gRPC test automation framework.
Your job: given a proto contract and existing coverage, produce a test plan in JSON.

Output ONLY valid JSON matching this schema:
{
  "service": "string",
  "method": "string",
  "fileName": "string (camelCase like methodName.test.ts)",
  "schemaTest": { "id": "string", "type": "schema", "priority": "P1", "name": "string", "description": "string", "expectedBehavior": "string" },
  "testCases": [{ "id": "string", "type": "positive|negative|boundary|edge", "priority": "P1|P2|P3", "name": "string", "description": "string", "expectedBehavior": "string" }]
}

Rules:
- ALWAYS include a schema validation test (type: "schema", P1) as the first test
- Include at least 1 positive and 1 negative test case
- Each test must have a clear expectedBehavior
- Use project naming conventions (camelCase file names)
- Use a 3-letter uppercase mnemonic ID prefix plus 3-digit numbering for ALL test cases
- Schema test must be "PREFIX-001", next cases "PREFIX-002", "PREFIX-003", ...
- Every test name must start with its ID, e.g. "UCW-001: Schema validation for UpdateClientWallet response"
- Do NOT use titles like "Schema | ...", "Positive | ...", or unnumbered names
- P1 = must have, P2 = should have, P3 = nice to have
- Keep plans focused: 5-10 test cases per method`;
}

function buildCoderSystemPrompt(): string {
  return `You are a QA Test Coder for a Playwright + gRPC + TypeScript framework.
Your job: write complete, runnable test files following project patterns exactly.

Rules:
- Use the provided example test as a template for imports, structure, and style
- Schema validation test MUST use ts-interface-checker (createCheckers)
- Use generateProcessId() or generateUUID() for unique test data — NEVER hardcode
- Each test must be independent — no shared mutable state
- Use proper error handling with gRPC error types
- Follow the exact import paths from the example
- Use the test case IDs from the provided plan exactly as written
- Every generated test title must start with "{PREFIX}-{NNN}:"
- Write complete files — never partial code

Output ONLY the complete TypeScript test file content. No explanations.`;
}

function buildDebuggerSystemPrompt(): string {
  return `You are a QA Test Debugger for a Playwright + gRPC + TypeScript framework.
Your job: diagnose why a test is failing and produce a fix.

You have access to tools: read_file, write_file, list_files, grep_files, run_command.

Process:
1. Read the failing test file and error details
2. Check the proto contract for any mismatches
3. Check the service wrapper for method signatures
4. Identify the root cause
5. Write the corrected file

Common failure patterns:
- Wrong import paths
- Incorrect gRPC method call signature
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

// ============================================================
// AQA Agent — Core Type Definitions
// Artifact-first design: every pipeline step produces a typed artifact
// ============================================================

// ─── Anthropic API Types ────────────────────────────────────

export type ModelTier = "haiku" | "sonnet" | "opus";

export type ThinkingConfig = { type: "adaptive" } | { type: "disabled" };

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface AgentConfig {
  model: ModelTier;
  thinking: ThinkingConfig;
  effort: EffortLevel;
  maxTokens: number;
  cacheSystemPrompt: boolean;
  budgetLimit: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ─── Artifacts (pipeline step outputs) ──────────────────────

export interface NormalizedContract {
  service: string;
  /** The name the user asked for — used for directory/file lookups */
  intentName: string;
  package: string;
  protoFile: string;
  methods: ProtoMethod[];
  enums: ProtoEnum[];
  messages: ProtoMessage[];
}

export interface ProtoMethod {
  name: string;
  inputType: string;
  outputType: string;
}

export interface ProtoEnum {
  name: string;
  values: { name: string; number: number }[];
}

export interface ProtoMessage {
  name: string;
  fields: ProtoField[];
  oneofs: ProtoOneof[];
}

export interface ProtoField {
  name: string;
  type: string;
  number: number;
  required: boolean;
  repeated: boolean;
  optional: boolean;
  mapKeyType?: string;
  mapValueType?: string;
}

export interface ProtoOneof {
  name: string;
  fields: string[];
}

// ─── Coverage ───────────────────────────────────────────────

export interface CoverageReport {
  service: string;
  totalMethods: number;
  coveredMethods: CoveredMethod[];
  uncoveredMethods: string[];
  coveragePercent: number;
  existingPatterns: ExistingPatterns;
}

export interface CoveredMethod {
  method: string;
  testFile: string;
  testCount: number;
}

export interface ExistingPatterns {
  imports: string[];
  helpers: string[];
  assertionStyle: string;
  dataGeneration: string;
  exampleTestFiles: string[];
}

// ─── Service Infrastructure ─────────────────────────────────

export interface ServiceInfrastructure {
  service: string;
  protoPath: string;
  wrapperPath: string | null;
  typesPath: string | null;
  generatedPath: string | null;
  fixtureConnected: boolean;
  testDir: string;
  missingComponents: InfraComponent[];
}

export type InfraComponent =
  | "proto"
  | "generated"
  | "wrapper"
  | "types"
  | "fixture"
  | "test-dir";

// ─── Test Plan ──────────────────────────────────────────────

export type PlanMode = "new" | "delta" | "noop";

export interface TestPlan {
  service: string;
  method: string;
  fileName: string;
  testCases: TestCase[]; // first element must be type: "schema"
  mode?: PlanMode;
  deltaInfo?: {
    added: string[];    // IDs to add
    changed: string[];  // IDs to update
    removed: string[];  // IDs removed from Testomatio (warn only)
    existing: string[]; // IDs already in file, unchanged
  };
}

export interface TestCase {
  id: string;
  type: "schema" | "positive" | "negative" | "boundary" | "edge";
  priority: "P1" | "P2" | "P3";
  name: string;
  description: string;
  expectedBehavior: string;
}

// ─── Implementation Context ─────────────────────────────────

export interface ImplementationContext {
  // Infrastructure status
  serviceWrapperExists: boolean;
  serviceWrapperPath: string | null;
  typesExist: boolean;
  fixtureConnected: boolean;
  availableFixtures: string[]; // ["gRPC", "noSQL", "db", "helpers"]
  missingComponents: string[]; // what Plan found missing

  // Current noSQL/DB settings relevant to this service (table names and schema)
  relevantSettings: RelevantSetting[];

  // Method info for implementer
  methodSignature: {
    name: string;
    inputType: string;
    outputType: string;
  } | null;

  // Test file target
  testFile: string;
}

export interface RelevantSetting {
  tableName: string;   // e.g. "contestSettings"
  tableFile: string;   // absolute path to .table.ts file
  description: string; // what this table contains (extracted from code)
  accessPattern: string; // e.g. "noSQL.contestSettings.get()"
}

// ─── Test Results ───────────────────────────────────────────

export interface TestResult {
  file: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  errors: TestError[];
}

export interface TestError {
  testName: string;
  message: string;
  stack?: string;
}

// ─── Failure Classification (PM's incident taxonomy) ────────

export type FailureClass =
  | "A_PROMPT"
  | "B_KNOWLEDGE"
  | "C_STALE"
  | "D_LOGIC"
  | "E_MODEL"
  | "F_INFRA"
  | "G_SPEC";

export interface ClassifiedFailure {
  failureClass: FailureClass;
  error: TestError;
  autoFixable: boolean;
  strategy: "auto-fix" | "llm-debug" | "skip-report" | "escalate";
  diagnosis?: string;
}

// ─── Guardrail Results ──────────────────────────────────────

export interface GuardrailResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Understand Context ─────────────────────────────────────

export interface UnderstandContext {
  intent: ParsedIntent;
  canonicalService: string;
  protoFile: string;
  testDir: string;
  testomatioCoverage: { suiteTitle: string | null; totalTests: number; manualTests: number; automatedTests: number } | null;
  protoChanges: ProtoChangeServiceReport | null;
  scope: "changed_only" | "all_methods";
  localTestFilesCount: number;
  // Manual test cases fetched from Testomatio (when suite URL provided)
  manualTestCases: ManualTestCase[];
  // Absorbed from resolve/parse/coverage phases
  infrastructure: ServiceInfrastructure;
  contract: NormalizedContract;
  coverage: CoverageReport;
}

// ─── Run State & Orchestration ──────────────────────────────

export type Phase =
  | "init"
  | "understand"
  | "plan"
  | "implement"
  | "validate"
  | "debug"
  | "save"
  | "report"
  | "done"
  | "failed"
  | "stopped";

export interface StepNote {
  phase: Phase;
  summary: string;
}

export interface RunState {
  runId: string;
  startedAt: string;
  phase: Phase;
  service: string;
  intent: ParsedIntent;
  understandContext: UnderstandContext | null;
  infrastructure: ServiceInfrastructure | null;
  contract: NormalizedContract | null;
  coverage: CoverageReport | null;
  currentMethodIndex: number;
  methodResults: MethodResult[];
  cost: CostAccumulator;
  retries: number;
  maxRetries: number;
  notes: StepNote[];
}

export interface MethodResult {
  method: string;
  plan: TestPlan | null;
  testFile: string | null;
  result: TestResult | null;
  failures: ClassifiedFailure[];
  attempts: number;
  cost: number;
  status:
    | "pending"
    | "analyzed"
    | "planned"
    | "written"
    | "passed"
    | "failed"
    | "skipped";
  testCode?: string;
  implementationContext?: ImplementationContext;
}

export interface ParsedIntent {
  action:
    | null           // default: full pipeline (understand → plan → implement → validate → debug)
    | "fix"
    | "analyze"
    | "understand_only"
    | "plan"
    | "implement_only"
    | "validate_only";
  service: string;
  methods?: string[];
  raw: string;
  testomatioSuiteId?: string; // suite ID extracted from Testomatio URL
}

export interface ManualTestCase {
  id: string;
  title: string;
  description?: string; // full Testomatio description (Preconditions + Steps + Expected)
  tags?: string[];
}

// ─── Cost Tracking ──────────────────────────────────────────

export interface CostAccumulator {
  steps: StepCost[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalUsd: number;
}

export interface StepCost {
  step: string;
  agent: string;
  model: ModelTier;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  timestamp: string;
}

export interface BudgetLimits {
  perAgent: Record<string, number>;
  perRun: number;
  perDay: number;
}

// ─── Memory / Persistence ───────────────────────────────────

export interface ProjectIndex {
  services: Record<string, ServiceIndex>;
  lastUpdated: string;
}

export interface ProtoSnapshotsStore {
  services: Record<string, ProtoServiceSnapshot>;
  lastUpdated: string;
}

export interface ProtoServiceSnapshot {
  service: string;
  protoFile: string;
  fileHash: string;
  methods: ProtoMethodSnapshot[];
  messages: ProtoMessageSnapshot[];
  capturedAt: string;
}

export interface ProtoMethodSnapshot {
  name: string;
  inputType: string;
  outputType: string;
  signature: string;
}

export interface ProtoMessageSnapshot {
  name: string;
  signature: string;
}

export interface ProtoChangeServiceReport {
  service: string;
  protoFile: string;
  status: "added" | "removed" | "updated";
  addedMethods: string[];
  removedMethods: string[];
  changedMethods: string[];
  changedMessages: string[];
}

export interface ProtoChangeReport {
  syncedAt: string;
  hasChanges: boolean;
  changedFiles: string[];
  changedServices: ProtoChangeServiceReport[];
}

export interface ServiceIndex {
  protoFile: string;
  methods: string[];
  wrapperExists: boolean;
  typesExist: boolean;
  testFiles: string[];
  coveragePercent: number;
}

export interface RunHistoryEntry {
  runId: string;
  timestamp: string;
  service: string;
  action: string | null;
  methodsCovered: number;
  totalMethods: number;
  testsCreated: number;
  testsPassed: number;
  testsFailed: number;
  totalCostUsd: number;
  durationMs: number;
}

export interface FailurePattern {
  pattern: string;
  failureClass: FailureClass;
  diagnosis: string;
  fix: string;
  occurrences: number;
  lastSeen: string;
}

// ─── Run Ledger (episodic memory per run) ───────────────────

export interface RunLedger {
  runId: string;
  task: string;
  scope: { service: string; methods: string[] };
  facts: LedgerFact[];
  decisions: LedgerDecision[];
  attempts: LedgerAttempt[];
  failures: ClassifiedFailure[];
  cost: CostAccumulator;
  finalVerdict: "accepted" | "partial" | "rejected" | "aborted";
  startedAt: string;
  completedAt: string;
}

export interface LedgerFact {
  what: string;
  source: string;
  confirmed: boolean;
}

export interface LedgerDecision {
  what: string;
  why: string;
  alternatives?: string[];
}

export interface LedgerAttempt {
  step: string;
  method: string;
  result: "success" | "failure" | "skipped";
  cost: number;
  duration: number;
  error?: string;
}

// ─── RAG Context ────────────────────────────────────────────

export interface RunNotes {
  infrastructure?: string;
  coverage?: string;
  methodNotes: Record<string, { plan?: string }>;
}

export interface AgentContext {
  systemPrompt: string;
  skills: string[];
  protoContract?: string;
  exampleTest?: string;
  wrapperCode?: string;
  failurePatterns?: FailurePattern[];
  projectRules: string;
  runNotes?: string;
}

// ─── Config ─────────────────────────────────────────────────

export interface ModelsConfig {
  defaults: Record<string, ModelTier>;
  overrides?: Record<string, ModelTier>;
}
// 

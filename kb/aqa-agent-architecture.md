# AQA Agent — Architecture Document

## Overview

An AI-powered pipeline that takes a natural-language command, resolves the target gRPC service, and autonomously generates, runs, debugs, and maintains Playwright integration tests — end to end — with no human intervention.

**Two operational modes:**
- **Full pipeline** — new method, generate everything from scratch (understand → plan → implement → validate → debug)
- **Fix** — tests exist but fail, agent debugs and repairs them

**Tech stack under test:**
- Playwright 1.48 (backend E2E, no browser)
- TypeScript 5.4 + ts-node
- `@grpc/grpc-js`, `google-protobuf`, `grpc-tools`
- `ts-interface-checker`
- PostgreSQL (`pg`)
- `@faker-js/faker`

---

## Core Principles

### Script-First, LLM as Fallback
Entity resolution, proto parsing, and coverage analysis are fully deterministic — no LLM involved. Haiku is called only when script normalization cannot match a service name. This keeps the Understand phase near-zero cost ($0.00 for 99% of runs).

### One File Per RPC Method
Each gRPC method gets its own `.test.ts` file. No shared state between test files. One pipeline run per method.

### Notes as Agent-to-Agent Communication
Agents don't share memory implicitly. The Planner writes key findings via `save_notes` tool — these travel to the Coder through `state.notes`. The Coder reads them as structured context. History stores only `"Notes saved."` — minimal footprint.

### History Compression
The agentic loop compresses tool results older than the last 2 turns to `[compressed: N chars]`. Thinking blocks are never compressed (Anthropic API requirement). Reduces token cost by 40–60% on long implement runs.

### Prompt Caching
All system prompts are marked `cache_control: ephemeral`. Cache read tokens cost ~90% less than input tokens. Highly effective when the same agent runs across multiple methods in one session.

### Explicit State Machine
All phase transitions go through `transition(state, next, reason)` — validated against a `PHASE_TRANSITIONS` table. Invalid transition throws immediately with full context. Every transition reason is recorded in `state.notes` for post-mortem audit.

---

## Service Map

Each gRPC service has a descriptor in `config/service-map.json` that defines its boundaries:

```json
{
  "ContestEngine": {
    "proto": "ContestEngine.proto",
    "testDir": "tests/grpc/contest-engine",
    "testomatio": "contest-engine"
  },
  "UsersGrpcService": {
    "proto": "UsersGrpcService.proto",
    "testDir": "tests/grpc/users",
    "testomatio": "users"
  }
}
```

This tells the agent: which proto to parse (`proto`), where to write tests (`testDir`), and which Testomatio project to sync coverage from (`testomatio`).

---

## Pipeline Architecture

### Full Pipeline

```
Natural language command
        │
        ▼
┌─────────────────────────────────────────────────┐
│  Intent Parser                    [Regex→Haiku]  │
│  Resolve: service, action, methods               │
└─────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────┐
│  UNDERSTAND                        [Haiku/None]  │
│  Entity resolution (script → Haiku fallback)     │
│  Proto parse + Coverage analysis                 │
│  Proto change detection + Testomatio sync        │
└─────────────────────────────────────────────────┘
        │
        ▼  per-method loop
┌─────────────────────────────────────────────────┐
│  PLAN                              [Haiku]       │
│  Analyse proto schema (fields, oneofs, enums)    │
│  save_notes → key findings travel to Coder       │
│  Output: TestPlan JSON (5–10 test cases)         │
└─────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────┐
│  IMPLEMENT                         [Sonnet]      │
│  Read: wrapper, example test, proto contract     │
│  Write: complete .test.ts file                   │
│  Tools: read_file, write_file, grep_files,       │
│         list_files, run_command                  │
└─────────────────────────────────────────────────┘
        │
        ▼
    COMPLETE  (status: "written")
    ─ validate/debug are NOT part of the full pipeline ─
    ─ they run only in "fix" action (see Fix Mode below) ─
```

### Fix Mode

```
Natural language command ("fix tests for UsersGrpcService")
        │
        ▼
  UNDERSTAND (same as above)
        │
        ▼
  VALIDATE → run existing test file
        │ failing
        ▼
  DEBUG → diagnose + patch → re-validate
        │ max 2 retries
        ▼
  COMPLETE
```

---

## Run Actions

| Action | What happens | LLM involved |
|--------|-------------|--------------|
| *(default — full pipeline)* | understand → plan → implement (writes file, done) | Haiku + Sonnet |
| `plan` | understand → plan only, save artifacts to disk | Haiku |
| `implement_only` | load saved plan artifacts → implement (writes file, done) | Sonnet |
| `fix` | understand → validate existing → debug failing | Sonnet |
| `validate_only` | understand → run existing tests, no writes | None |
| `analyze` | understand → coverage report only, exit | None ($0.00) |

---

## Phase Definitions

### Intent Parser

**Goal:** Resolve a natural-language command into a structured `ParsedIntent`.

**API configuration:**

```typescript
{
  model: "claude-haiku-4-5",
  max_tokens: 200,
  // Called only when regex fails to match service name
}
```

**Parser behavior:**

1. Regex pass — normalizes prompt, matches service name from proto file list, detects action keywords (supports Ukrainian and English)
2. Haiku fallback — if regex finds no service match, Haiku resolves ambiguous names semantically

**Output:**

```typescript
{
  action: null | "plan" | "implement_only" | "fix" | "validate_only" | "analyze",
  service: "ContestEngine",
  methods: ["CreateContest"] | undefined,  // undefined = all uncovered
  raw: "імплементуй тести для ContestEngine"
}
```

---

### Understand

**Goal:** Build complete context about the target service — without LLM (except for ambiguous service name resolution).

**Model:** None (Haiku only as entity resolution fallback)

**Steps:**

1. **Entity resolution** — normalize service name → lookup in `service-map.json`. If no match: Haiku sees all proto files + test dirs and picks the best canonical name
2. **Proto change detection** — compare current proto against stored snapshot → `scope: all_methods | changed_only`
3. **Testomatio sync** — best-effort: fetch manual/automated test counts for the service
4. **Local test count** — count `.test.ts` files in the service test directory
5. **Infrastructure resolve** — find proto path, service wrapper, ts-types, generated code paths
6. **Proto parse** — extract all RPC methods, message types, fields, enums
7. **Coverage analysis** — determine which methods already have test files

**Output:** `UnderstandContext`

```typescript
{
  canonicalService: "ContestEngine",
  protoFile: "ContestEngine.proto",
  testDir: "tests/grpc/contest-engine",
  scope: "all_methods",           // or "changed_only" if proto changed
  protoChanges: { addedMethods: [], changedMethods: [], removedMethods: [] },
  testomatioCoverage: { manualTests: 4, automatedTests: 1 },
  localTestFilesCount: 1,
  infrastructure: { protoPath, testDir, wrapperPath, typesPath, generatedPath },
  contract: { methods, messages, enums },
  coverage: { totalMethods, coveredMethods, uncoveredMethods, coveragePercent }
}
```

---

### Plan

**Goal:** For each uncovered RPC method, produce a structured test plan (5–10 test cases).

**Model:** `claude-haiku-4-5`

**API configuration:**

```typescript
{
  model: "claude-haiku-4-5",
  max_tokens: 16384,
  thinking: { type: "enabled", budget_tokens: 4096 },  // effort: medium
  tools: [save_notes, complete_phase],
  maxTurns: 3
}
```

**Context in prompt:**
- System prompt (planner) + KB skills: `grpc-patterns-plan.md`, `test-coverage-rules.md`
- `planner-project-rules.md` — compact project rules (no TypeScript patterns)
- Proto contract (only the method section: rpc + request/response messages)
- Input/output field breakdown (name, type, optional/required, repeated)
- Existing coverage summary
- Available enums
- Notes from previous phases

**Agent behavior:**

1. Analyses proto schema — identifies oneofs, optional fields, enums, boundary types
2. Calls `save_notes` with schema insights for the Coder (e.g. `"oneof identity (email|phone) — both paths needed. user_id is UUID."`)
3. Returns test plan JSON

**Output:**

```json
{
  "service": "ContestEngine",
  "method": "CreateContest",
  "fileName": "createContest.test.ts",
  "testCases": [
    { "id": "CRC-001", "type": "schema", "priority": "P1", "name": "CRC-001: Schema validation for CreateContest response", "description": "...", "expectedBehavior": "..." },
    { "id": "CRC-002", "type": "positive", "priority": "P1", "name": "CRC-002: Successfully create contest with valid data", "description": "...", "expectedBehavior": "..." },
    { "id": "CRC-003", "type": "negative", "priority": "P2", "name": "CRC-003: Create contest with missing name returns error", "description": "...", "expectedBehavior": "..." }
  ]
}
```

---

### Implement

**Goal:** Write a complete, runnable TypeScript Playwright test file for the RPC method.

**Model:** `claude-sonnet-4-6`

**API configuration:**

```typescript
{
  model: "claude-sonnet-4-6",
  max_tokens: 32768,
  thinking: { type: "enabled", budget_tokens: 10240 },  // effort: high
  tools: [read_file, write_file, list_files, grep_files, run_command, save_notes, complete_phase],
  maxTurns: 25
}
```

**Context in prompt:**
- System prompt (coder) + KB skills: `grpc-patterns.md`, `schema-validation.md`, `error-assertions.md`, `data-generation.md`
- Full project rules (`CLAUDE.md` from skill-trade)
- Test plan (from Plan phase)
- Example test file (from same service, or any `tests/grpc/**/*.test.ts`)
- Service wrapper code (`lib/clients/gRPC/services/{Service}.ts`)
- Full proto contract
- Notes from Planner (via `state.notes`)

**Agent behavior:**

1. Calls `save_notes` first with execution plan (keeps history lean)
2. Reads planner notes for schema insights
3. Reads service wrapper for exact method signatures
4. Optionally reads existing test files or fixtures for import patterns
5. Writes complete `.test.ts` file via `write_file`
6. Calls `complete_phase` with summary

**Output:** Complete TypeScript file, e.g.:

```typescript
import { test, expect } from "@fixtures";
import { ContestEngineErrorType } from "@lib/clients/gRPC/services/generated/ContestEngineService/ContestEngine_pb";
import { createCheckers } from "ts-interface-checker";
import contestEngineTypes from "@lib/clients/gRPC/types/contest-engine/contestEngine.types-ti";

const { CreateContestResponse: ResponseChecker } = createCheckers(contestEngineTypes);

test.describe("ContestEngine — CreateContest @grpc @contest-engine @create-contest @Sa3f1b2c9", () => {
  test("CRC-001: Schema validation for CreateContest response @T4d8e2f1a", async ({ gRPC }) => {
    const response = await gRPC.contestEngine.createContest(`test-${Date.now()}`, Date.now() + 86400000, ["ETHUSD"]);
    ResponseChecker.strictCheck(response);
  });
  // ...
});
```

---

### Validate

**Goal:** Run the written test file and report pass/fail.

**Model:** None

**Behavior:**

Executes `npx playwright test {testFilePath}` in `SKILL_TRADE_PATH` directory. Parses JSON output for passed/failed counts.

**Output:**

```typescript
{ passed: 8, failed: 1, output: "..." }
```

If all tests pass → method status = `"passed"`, pipeline moves to next method.
If any fail → pipeline transitions to Debug.

---

### Debug

**Goal:** Diagnose failing tests and produce a fix.

**Model:** `claude-sonnet-4-6`

**API configuration:**

```typescript
{
  model: "claude-sonnet-4-6",
  max_tokens: 32768,
  thinking: { type: "enabled", budget_tokens: 10240 },  // effort: high
  tools: [read_file, write_file, list_files, grep_files, run_command, save_notes, complete_phase],
  maxTurns: 25
}
```

**Agent behavior:**

1. Calls `save_notes` with diagnosis plan
2. Reads failing test file and error output
3. Checks proto contract for field/type mismatches
4. Checks service wrapper for correct method signatures
5. Identifies root cause, writes corrected file
6. Calls `complete_phase` with what was fixed and why

**Retry loop:** up to `MAX_DEBUG_RETRIES = 2`. After each fix attempt, Validate re-runs. If still failing after max retries → method status = `"failed"`.

**Failure Pattern Memory:** Every diagnosed failure is recorded to `state/failure-patterns.json` with normalized error message, failure class, diagnosis, and fix. Patterns with `occurrences > 1` are injected into the Planner's context on future runs to prevent recurrence.

---

## Agentic Loop

Core execution engine used by Plan, Implement, and Debug agents.

```typescript
async function agenticLoop(options: AgenticLoopOptions): Promise<AgenticLoopResult>
```

**Key mechanisms:**

### Extended Thinking

Claude reasons before responding. Budget is set per agent:

| Effort | Budget tokens | Used by |
|--------|--------------|---------|
| `medium` | 4 096 | Planner |
| `high` | 10 240 | Coder, Debugger |

### History Compression

After each turn: last 2 turns are kept full. Older turns are compressed:
- Tool results in user messages → `[compressed: N chars — key data saved to notes]`
- Tool inputs in assistant messages → `{ _compressed: "N chars" }`
- Thinking blocks: **never compressed** (Anthropic API requirement)

Saves 40–60% tokens on long Implement runs.

### Phase Tools

Available to Planner and Coder. Handled locally inside the loop — never forwarded to `executeTool`.

| Tool | Behavior | History footprint |
|------|----------|-------------------|
| `save_notes` | Appends to `result.savedNotes`, returns `"Notes saved."` | 12 chars |
| `complete_phase` | Sets `phaseSummary`, exits loop immediately | 15 chars |

### Prompt Caching

```typescript
system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }]
```

Cache read tokens cost ~90% less. Effective when the same agent processes multiple methods in one run.

### Budget Guard

Checked before every turn:

```typescript
const budgetCheck = checkBudget(costAccumulator, agentName);
if (!budgetCheck.allowed) return { abortReason: budgetCheck.reason, ... };
```

---

## Tools

### Per-Agent Tool Access

| Agent | Tools |
|-------|-------|
| planner | `read_file` + phase tools (`save_notes`, `complete_phase`) |
| coder | `read_file`, `write_file`, `list_files`, `grep_files`, `run_command` + phase tools |
| debugger | `read_file`, `write_file`, `list_files`, `grep_files`, `run_command` + phase tools |

### Tool Definitions

**`read_file`** — reads a file by absolute path. Used by Coder to inspect wrappers, existing tests, and fixture files.

**`write_file`** — writes a file to an absolute path. Primary output mechanism for Coder and Debugger.

**`list_files`** — glob pattern search. Used to discover test files, wrappers, and type definitions.

**`grep_files`** — regex search across files. Used to find import patterns, error enum values, and method signatures.

**`run_command`** — executes a shell command in a given working directory. Used by Debugger to run targeted test commands for diagnosis.

---

## Context Builder (RAG)

File-based RAG — assembles relevant context for each agent role deterministically. No vector DB.

### Planner Context

```
system_prompt (planner)
+ KB skills: grpc-patterns-plan.md, test-coverage-rules.md
+ planner-project-rules.md (compact — no TypeScript patterns)
+ proto_contract (method section only: rpc + request/response messages)
+ example_test (1 file from same service, or any tests/grpc/**/*.test.ts)
+ wrapper_code (lib/clients/gRPC/services/{Service}.ts)
+ failure_patterns (occurrences > 1 only)
+ notes from Understand phase
```

### Coder Context

```
system_prompt (coder)
+ KB skills: grpc-patterns.md, schema-validation.md, error-assertions.md, data-generation.md
+ CLAUDE.md from skill-trade (full project rules)
+ proto_contract (full file)
+ example_test (1 file from same service, or any tests/grpc/**/*.test.ts)
+ wrapper_code (lib/clients/gRPC/services/{Service}.ts)
+ notes from Understand + Plan phases
```

### Example Test Selection

`extractExistingPatterns()` scans up to 3 test files from the same service directory. The first file is passed as the example (`pickBestExample`). If no service-specific tests exist, falls back to any file under `tests/grpc/`.

---

## State Machine

```typescript
export const PHASE_TRANSITIONS = {
  init:       ["understand", "failed"],
  understand: ["plan", "done", "failed", "stopped"],
  plan:       ["plan", "implement", "save", "done", "failed", "stopped"],
  implement:  ["implement", "validate", "plan", "save", "failed", "stopped"],
  validate:   ["validate", "plan", "implement", "debug", "save", "done", "failed", "stopped"],
  debug:      ["debug", "validate", "save", "failed", "stopped"],
  save:       ["report", "failed"],
  report:     ["done"],
  done:       [],
  failed:     [],
  stopped:    [],
}
```

Every call to `transition(state, next, reason)`:
1. Validates `next` is in `PHASE_TRANSITIONS[state.phase]` — throws if not
2. Appends `{ phase, summary: "→ next: reason" }` to `state.notes`
3. Sets `state.phase = next`

---

## Memory & Persistence

All state is stored in `state/` directory as JSON files.

| File | Contents |
|------|----------|
| `state/project-index.json` | Coverage % per service, proto path, test file list |
| `state/run-history.json` | Last 20 runs: service, action, pass/fail counts, cost, duration |
| `state/plans/{service}.json` | Saved TestPlan artifacts for `implement_only` resumption |
| `state/ledger/{runId}.json` | Facts, decisions, attempts, failures — full audit trail per run |
| `state/failure-patterns.json` | Classified failure patterns with occurrence count and fix strategy |
| `state/proto-changes.json` | Proto snapshot diff from last `sync-protos` run |

### Run Ledger

Every run produces a ledger saved to `state/ledger/{runId}.json`:

```typescript
{
  runId: "a3f1b2c9",
  task: "імплементуй тести для ContestEngine",
  scope: { service: "ContestEngine", methods: ["CreateContest"] },
  facts: [{ what: "proto: ContestEngine.proto, methods: 5, coverage: 40%", source: "service-map+proto+testomatio", confirmed: true }],
  decisions: [{ what: "Processing 1 method via action null", why: "Running full pipeline", alternatives: [...] }],
  attempts: [...],
  failures: [],
  cost: { totalUsd: 0.2259, totalInputTokens: 48000, totalOutputTokens: 6723, ... },
  finalVerdict: "accepted",  // accepted | partial | rejected | aborted
  startedAt: "2026-03-18T13:39:01Z",
  completedAt: "2026-03-18T13:40:35Z"
}
```

---

## Web Dashboard

Single-page application built with **Express + SSE** (Server-Sent Events). No WebSocket, no React — vanilla HTML/JS with real-time streaming.

```
┌──────────────────────────────────────────────────┐
│  Frontend (HTML/JS)                              │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Pipeline Status Bar                       │  │
│  │  Understand → Plan → Implement →           │  │
│  │  Validate → Debug → Complete               │  │
│  │  (phase badges with cost + status)         │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Phase Inspector (expandable sections)     │  │
│  │  • Log — real-time event stream            │  │
│  │  • System Prompt — full prompt per phase   │  │
│  │  • Thinking — extended thinking blocks     │  │
│  │  • State — RunState snapshot               │  │
│  │  • Tools — every tool call with in/out     │  │
│  │  • Notes — save_notes content              │  │
│  │  • Output — TestPlan / code / test result  │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Chat                                      │  │
│  │  Natural language → Intent Parser →        │  │
│  │  Pipeline                                  │  │
│  │  Before Run Check: proto sync status,      │  │
│  │  policy warnings                           │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Cost Panel                                │  │
│  │  Total USD / Total tokens /                │  │
│  │  Breakdown by agent (coder / planner)      │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Run History (last 100)                    │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
        │
        │  SSE (Server-Sent Events) — real-time
        ▼
┌──────────────────────────────────────────────────┐
│  Backend (Node.js / Express)                     │
│                                                  │
│  POST /chat       — parse intent → run pipeline  │
│  GET  /events     — SSE stream                   │
│  POST /stop       — abort signal                 │
│  GET  /history    — run history                  │
│  GET  /plans      — saved plan artifacts         │
│  POST /snapshot   — save proto snapshot          │
│  GET  /coverage   — project index                │
└──────────────────────────────────────────────────┘
```

**SSE Events emitted:**

| Event | When |
|-------|------|
| `started` | Pipeline begins |
| `log` | Every log line (phase, message, elapsed, cost) |
| `phase` | Phase transition (understand / plan / implement / validate / debug) |
| `system-prompt` | System prompt assembled for plan or implement |
| `method-result` | After each method completes (plan, testFile, pass/fail counts) |
| `complete` | Pipeline done (full summary, cost breakdown by agent and phase) |
| `aborted` | User stopped the run |

---

## Cost Estimates

### Full Pipeline — 1 method (~9 test cases)

> Full pipeline = plan → implement only. Validate/debug run separately via `fix` action.

| Phase | Model | Typical cost |
|-------|-------|-------------|
| Understand | None (Haiku fallback ~$0.001) | ~$0.00 |
| Plan | Haiku | ~$0.002–0.005 |
| Implement | Sonnet | ~$0.03–0.08 |
| **Total (full pipeline)** | | **~$0.03–0.09** |

### Fix Mode — 1 method

| Phase | Model | Typical cost |
|-------|-------|-------------|
| Validate | None | $0.00 |
| Debug (1 retry) | Sonnet | ~$0.02–0.05 |
| **Total (1 debug attempt)** | | **~$0.02–0.05** |

### Observed Runs (real data)

| Run | Method | Test cases | Cost | Tokens |
|-----|--------|-----------|------|--------|
| Full pipeline | `InsertOrReplaceRewardPack` | 9 | $0.2259 | 54 723 |

### Actions Without Full Pipeline

| Action | Model | Cost |
|--------|-------|------|
| `analyze` | None | $0.00 |
| `validate_only` | None | $0.00 |
| `plan` only | Haiku | ~$0.002–0.005 |
| `implement_only` (from saved plan) | Sonnet | ~$0.03–0.08 |
| `fix` (debug existing) | Sonnet | ~$0.02–0.05 |

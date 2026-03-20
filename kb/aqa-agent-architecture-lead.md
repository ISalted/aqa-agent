# AQA Agent — Architecture Document

## Overview

An AI-powered pipeline that takes QA test cases, service contracts, and codebase context as input and produces a structured execution plan for automated backend E2E test generation. Claude Code consumes the plan and writes all test code.

**Two operational modes:**
- **Fresh** — new service, generate everything from scratch
- **Update** — service changed, agent receives diffs and figures out what to create/modify/delete

**Tech stack under test:**
- Playwright 1.48 (backend E2E, no browser)
- TypeScript 5.4 + ts-node
- `@grpc/grpc-js`, `google-protobuf`, `grpc-tools`
- `ts-interface-checker`
- PostgreSQL
- `@faker-js`

---
## Core Principles

### Raw Context, No Preprocessing
All source files (protos, GraphQL schemas, DB models, event contracts) are passed to agents as raw text. No parsing or normalization layer — the LLM reads the original files and preserves comments, naming conventions, and implicit context that a parser would strip.

### Real Dependencies, No Mocks
All gRPC client dependencies are real services in the test environment. Tests set up preconditions by calling real dependent services via gRPC or by inserting directly into their databases. No mock servers.

### DDD + Microservices = Small Context
Each service is a bounded context. The full context bundle for any single service fits comfortably in the LLM context window.

### Pattern-Based Scaling
Happy path tests (~24 per service) get individual attention from Opus. Negative/edge cases (200+) are grouped by pattern — one representative mapped in detail, then expanded across the group.

### Haiku Sub-Agent for Lookups
Expensive models (Opus/Sonnet) hold the big picture. A Haiku sub-agent is exposed as a tool for targeted file lookups, keeping the main agent's context lean and costs low.

### System Prompts in Database
All system prompts for every state and sub-agent tool are stored in PostgreSQL — not hardcoded. This allows prompt iteration, A/B testing, and versioning without redeploying the application.

---

## Service Descriptor

Each microservice has a descriptor that defines its boundaries:

```json
{
  "name": "contest-engine-grpc",
  "type": "microservice",
  "description": "Core contest orchestration engine.",
  "grpc_servers": ["ContestEngineGrpcService"],
  "grpc_clients": ["ClientWalletsGrpcService", "UsersGrpcService"],
  "queue": {
    "publish_queues": ["contest-registration-update"],
    "subscribe_queues": ["contest-accounts-updates"]
  },
  "is_http_server": false
}
```

This tells the agent: what to test directly (`grpc_servers`), what to call for setup (`grpc_clients`), and what events flow in/out (`queue`).

---

## QA Test Case Schema

Test cases are stored in PostgreSQL with the following structure:

| Column | Type | Description |
|--------|------|-------------|
| `id` | uuid | Primary key |
| `service_name` | string | Service this case belongs to |
| `test_type` | enum | `happy_path` / `negative` / `edge_cases` / `e2e` |
| `api_method` | string | Method/endpoint under test |
| `title` | string | Human-readable test title |
| `priority` | enum | `high` / `medium` / `low` |
| `preconditions` | json | Array of precondition strings |
| `steps` | json | Array of step strings |
| `expected_result` | string | Expected outcome |
| `post_conditions` | json | Array of post-condition strings |
| `related_entities` | json | Array of DB entity names |
| `notes` | string | Optional notes |
| `version` | integer | Starts at 1, increments on each update |
| `status` | enum | `active` / `obsolete` |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

Key fields for the agent:
- `test_type` — pre-classifies happy/negative/edge, no agent guessing needed
- `api_method` — hard anchor to specific RPC
- `related_entities` — DB tables for assertions, explicitly listed
- `preconditions` / `steps` / `post_conditions` — natural language, agent must interpret
- `version` + `status` + `updated_at` — enables update mode via simple query

---

## Input Context Bundle

### Fresh Mode

```
├── Service descriptor JSON
├── Proto files — this service (grpc_servers)
├── Proto files — client services (grpc_clients)
├── GraphQL schemas (if applicable)
├── Queue/event contracts (publish + subscribe)
├── DB models — this service
├── DB models — dependent services (for direct DB setup)
├── Redis models (if applicable)
├── QA test cases (JSON, queried from DB)
├── Tech task description
├── Business task description
└── Environment config (service addresses, DB connections, queue config)
```

### Update Mode

All of the above, plus:

```
├── Contract diffs (proto/GraphQL/events — what changed)
├── QA test cases diff (new/modified/removed, derived via version + updated_at)
└── Description of the change (epic/task)
```

---

## Pipeline Architecture

### Fresh Mode

```
Context Bundle (raw files)
        │
        ▼
┌─────────────────────────────────────────────────┐
│  State 1: Service Inventory          [Sonnet]   │
│  Build complete map of service surfaces         │
├─────────────────────────────────────────────────┤
│  State 2: Test Case Mapping          [Opus]     │
│  Phase 2a: Classify & group          [Haiku]    │
│  Phase 2b: Map one per pattern       [Opus]     │
│  Phase 2c: Expand templates          [Sonnet]   │
├─────────────────────────────────────────────────┤
│  State 3: Dependency Graph           [Sonnet]   │
│  Execution order, factories, helpers            │
├─────────────────────────────────────────────────┤
│  State 4: Execution Plan             [Sonnet]   │
│  Final structured JSON for Claude Code          │
└─────────────────────────────────────────────────┘
        │
        ▼
  Claude Code (writes all test code)
```

### Update Mode

```
Context Bundle + Diffs
        │
        ▼
┌─────────────────────────────────────────────────┐
│  State U1: Diff Analysis             [Sonnet]   │
│  Classify every change and its impact           │
├─────────────────────────────────────────────────┤
│  State U2: Impact Mapping            [Opus]     │
│  Map changes to create/modify/delete actions    │
│  New tests → run Phase 2a/2b/2c from fresh mode │
├─────────────────────────────────────────────────┤
│  State U3: Updated Execution Plan    [Sonnet]   │
│  Modification instructions for Claude Code      │
└─────────────────────────────────────────────────┘
        │
        ▼
  Claude Code (applies modifications)
```

---

## State Definitions — Fresh Mode

### State 1: Service Inventory

**Goal:** Produce a complete map of what the service exposes, consumes, stores, and emits.

**Model:** `claude-sonnet-4-20250514`

**Context in prompt:**
- Service descriptor JSON
- Tech task / business task
- File manifest (list of all available files with paths)

**API configuration:**

```typescript
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 8000,
  temperature: 0,
  system: "loaded from DB — state_prompts table, key: state_1_inventory",
  tools: [ask_context]
}
```

**Tools:**

| Tool | Sub-agent | Description |
|------|-----------|-------------|
| `ask_context` | Haiku | Reads raw files and answers targeted questions |

**Agent behavior:**

1. Reads service descriptor, identifies all surfaces (server RPCs, client RPCs, queues, DB)
2. Calls `ask_context` per surface area:
   - "List all RPCs, request/response types, and field descriptions" → proto files
   - Same for each client service proto
   - "List all tables, columns, types, constraints" → DB model files
   - "List all event schemas and their fields" → event contract files
3. Synthesizes into structured service inventory JSON

**Output:** Service inventory JSON — all RPCs, all tables, all events, all fields, all types.

---

### State 2: Test Case Mapping

**Goal:** For each QA test case, produce the full test specification — preconditions, action, assertions.

This state has three phases to handle scale (200+ negative cases efficiently).

#### Phase 2a: Classify & Group

**Model:** `claude-haiku-4-5-20251001`

**Context:** All QA test cases + State 1 inventory summary

**API configuration:**

```typescript
{
  model: "claude-haiku-4-5-20251001",
  max_tokens: 4000,
  temperature: 0,
  system: "loaded from DB — state_prompts table, key: phase_2a_classify",
  tools: []
}
```

**Tools:** None — pure reasoning over structured input.

**Agent behavior:**

1. Reads all test cases, already split by `test_type` from the DB schema
2. Within each type, groups by `api_method` and then by pattern:
   - Invalid field value (missing, empty, too long, wrong type)
   - Invalid numeric field (negative, zero, overflow)
   - Invalid entity reference (non-existent, wrong state, unauthorized)
   - Missing precondition (insufficient balance, expired, banned)
   - Concurrency / timing edge cases
3. Selects one representative case per pattern group

**Output:** Pattern groups with representative case IDs.

#### Phase 2b: Map Representatives

**Model:** `claude-opus-4-20250514`

**Context:**
- State 1 inventory
- Representative test cases (one per pattern)
- Service descriptor
- Tech/business task

**API configuration:**

```typescript
{
  model: "claude-opus-4-20250514",
  max_tokens: 16000,
  temperature: 0,
  system: "loaded from DB — state_prompts table, key: phase_2b_mapping",
  tools: [ask_context]
}
```

**Tools:**

| Tool | Sub-agent | Description |
|------|-----------|-------------|
| `ask_context` | Haiku | Targeted file lookups for proto details, DB schemas, event shapes |

**Agent behavior:**

For each representative test case, produces a detailed mapping:

```yaml
test_case_id: "TC-042"
title: "Create contest with insufficient balance"
type: "negative"
pattern_group: "missing_precondition"

preconditions:
  - type: "grpc_call"
    service: "UsersGrpcService"
    rpc: "CreateUser"
    input: { name: "faker.person.fullName()", email: "faker.internet.email()" }
    save_as: "created_user"

  - type: "db_insert"
    service: "client-wallets"
    table: "wallets"
    data: { user_id: "$created_user.id", balance: 0 }

action:
  type: "grpc_call"
  service: "ContestEngineGrpcService"
  rpc: "CreateContest"
  input: { creator_id: "$created_user.id", entry_fee: 1000 }

assertions:
  - type: "grpc_error"
    expected_code: "FAILED_PRECONDITION"
    expected_message_contains: "insufficient"

  - type: "db_absent"
    table: "contests"
    where: { creator_id: "$created_user.id" }

  - type: "event_not_published"
    queue: "contest-registration-update"
    timeout_ms: 2000
```

Key reasoning the agent performs:
- **gRPC vs direct DB for preconditions:** gRPC for happy path setup (create user → user exists). Direct DB insert for edge cases (set balance to 0, create expired records, weird timestamps).
- **Variable references:** Uses `$variable_name` syntax to chain outputs between steps.
- **Faker patterns:** Derives appropriate faker methods from field types in protos.

**Output:** Detailed mapping per representative test case (pattern template).

#### Phase 2c: Expand Templates

**Model:** `claude-sonnet-4-20250514` (or deterministic if QA cases are structured enough)

**Context:**
- Phase 2b pattern templates
- All test cases grouped by pattern from Phase 2a

**API configuration:**

```typescript
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 8000,
  temperature: 0,
  system: "loaded from DB — state_prompts table, key: phase_2c_expand",
  tools: []
}
```

**Tools:** None — template expansion over structured data.

**Agent behavior:**

Takes each pattern template and fills in the variables for every case in the group:

```yaml
# Template: invalid_field_value on CreateContest
# Representative mapped field=title, value=null

Expansion:
  TC-101: field=title, value=null, error="title is required"
  TC-102: field=title, value="", error="title cannot be empty"
  TC-103: field=title, value="x".repeat(256), error="title exceeds max length"
  TC-104: field=entry_fee, value=null, error="entry_fee is required"
  TC-105: field=entry_fee, value=-1, error="entry_fee must be positive"
  ...
```

**Output:** Complete mapped test cases for all 200+ cases.

---

### State 3: Dependency Graph & Shared Modules

**Goal:** Figure out execution order, shared fixtures, factories, and helpers.

**Model:** `claude-sonnet-4-20250514`

**Context:**
- State 2 output (all mapped test cases)
- State 1 inventory

**API configuration:**

```typescript
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 8000,
  temperature: 0,
  system: "loaded from DB — state_prompts table, key: state_3_dependencies",
  tools: [check_conflicts]
}
```

**Tools:**

| Tool | Sub-agent | Description |
|------|-----------|-------------|
| `check_conflicts` | Haiku | Checks if two test cases have conflicting DB state requirements |

**Agent behavior:**

1. Identifies common precondition patterns → factories
2. Groups tests sharing same setup → `describe` blocks
3. Identifies tests that modify global state → sequential, not parallel
4. Determines helper modules needed

**Output:**

```yaml
factories:
  - name: "createTestUser"
    calls: [UsersGrpcService.CreateUser]
    returns: { id, name, email }

  - name: "createFundedUser"
    calls: [createTestUser, "db_insert:wallets"]
    params: { balance: number }
    returns: { user, wallet }

helpers:
  - name: "grpcClient"
    description: "Typed gRPC client wrapper for all services"
    services: [ContestEngineGrpcService, UsersGrpcService, ClientWalletsGrpcService]

  - name: "eventListener"
    description: "Queue consumer that captures events for assertion"
    queues: [contest-registration-update]

  - name: "dbHelper"
    description: "Direct DB query/insert for all service databases"
    connections: [contest-engine-db, wallets-db, users-db]

test_groups:
  - name: "contest-creation-happy"
    tests: [TC-041, TC-042, TC-043]
    shared_setup: "createFundedUser"
    parallel: true

  - name: "contest-creation-invalid-fields"
    tests: [TC-101, TC-102, ..., TC-115]
    pattern: "test.each parameterized"
    shared_setup: "createFundedUser"
    parallel: true

  - name: "contest-lifecycle"
    tests: [TC-050, TC-051, TC-052]
    sequential: true
```

---

### State 4: Execution Plan

**Goal:** Produce the final JSON that Claude Code consumes to write all test code.

**Model:** `claude-sonnet-4-20250514`

**Context:**
- State 3 output (dependency graph, factories, helpers)
- State 2 output (all mapped test cases)
- State 1 inventory (for type references)
- Tech stack constraints

**API configuration:**

```typescript
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 16000,
  temperature: 0,
  system: "loaded from DB — state_prompts table, key: state_4_execution_plan",
  tools: [generate_test_data_pattern]
}
```

**Tools:**

| Tool | Sub-agent | Description |
|------|-----------|-------------|
| `generate_test_data_pattern` | Haiku | Generates faker.js patterns for proto message types |

**Output:** Complete execution plan — file tree, every file's specification, function signatures, imports, test structure. Consumed by Claude Code. See [Execution Plan Schema](#execution-plan-schema) section for the exact format.

---

## State Definitions — Update Mode

### State U1: Diff Analysis

**Goal:** Classify every change in the diffs and determine its impact.

**Model:** `claude-sonnet-4-20250514`

**Context:**
- Service descriptor
- Contract diffs (proto, GraphQL, events, DB models)
- QA test cases diff (derived from `version` + `updated_at`)
- Tech/business task describing the change

**API configuration:**

```typescript
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 8000,
  temperature: 0,
  system: "loaded from DB — state_prompts table, key: state_u1_diff_analysis",
  tools: [ask_context]
}
```

**Tools:**

| Tool | Sub-agent | Description |
|------|-----------|-------------|
| `ask_context` | Haiku | Read full current files for context around diffs |

**Output:**

```yaml
changes:
  - type: "field_added"
    location: "CreateContestRequest.max_participants"
    required: true
    impact: "all tests calling CreateContest need this field"

  - type: "rpc_added"
    location: "ContestEngineGrpcService.CancelContest"
    impact: "new tests needed"

  - type: "event_schema_changed"
    location: "contest-registration-update.payload"
    added_field: "cancelled_at"
    impact: "event assertions may need updating"

  - type: "qa_cases_added"
    cases: [TC-301, TC-302, TC-303]

  - type: "qa_cases_removed"
    cases: [TC-042]
```

---

### State U2: Impact Mapping

**Goal:** Map each change to concrete create/modify/delete actions against existing tests.

**Model:** `claude-opus-4-20250514`

**Context:**
- State U1 diff analysis
- Current raw files (full context)
- State 1 inventory (re-run or cached)
- Existing test file names and structure (derived from `api_method` naming convention)

**API configuration:**

```typescript
{
  model: "claude-opus-4-20250514",
  max_tokens: 16000,
  temperature: 0,
  system: "loaded from DB — state_prompts table, key: state_u2_impact_mapping",
  tools: [ask_context]
}
```

**Tools:**

| Tool | Sub-agent | Description |
|------|-----------|-------------|
| `ask_context` | Haiku | Lookup details in current files and existing test code |

**Agent behavior:**

- For new QA cases → runs Phase 2a/2b/2c from fresh mode (scoped to new cases only)
- For modified contracts → identifies affected tests via `api_method` → file naming convention, determines required changes
- For removed QA cases → identifies test blocks to delete

**Output:**

```yaml
actions:
  - action: "modify"
    files: ["contest-creation.spec.ts"]
    reason: "Add max_participants to all CreateContest calls"
    changes:
      - update_factory: "createContestRequest"
        add_field: { max_participants: "faker.number.int({min:2, max:100})" }

  - action: "create"
    new_tests_for: [TC-301, TC-302, TC-303]
    spec: { ... }

  - action: "delete"
    file: "contest-creation.spec.ts"
    test_block: "TC-042"
```

---

### State U3: Updated Execution Plan

**Goal:** Produce modification instructions for Claude Code.

**Model:** `claude-sonnet-4-20250514`

**Context:**
- State U2 output
- Tech stack constraints

**API configuration:**

```typescript
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 12000,
  temperature: 0,
  system: "loaded from DB — state_prompts table, key: state_u3_update_plan",
  tools: []
}
```

**Tools:** None — structured assembly of modification instructions.

**Output:**

```yaml
file_operations:
  - file: "factories/contest.factory.ts"
    operation: "modify"
    instruction: "Add max_participants field with default faker value"

  - file: "tests/cancel-contest.spec.ts"
    operation: "create"
    spec: { ... full spec ... }

  - file: "tests/contest-creation.spec.ts"
    operation: "modify"
    instruction: "Remove test block for TC-042"
```

---

## Tool Definitions

### ask_context

The primary lookup tool. Exposes Haiku as a sub-agent for the main model.

```typescript
{
  name: "ask_context",
  description: "Ask a question about the service codebase. Reads raw source files and returns a focused answer.",
  is_subagent: true,
  subagent_model: "claude-haiku-4-5-20251001",
  prompt_key: "tool_ask_context",       // loaded from state_prompts table
  input_schema: {
    question: {
      type: "string",
      description: "Specific question about the codebase"
      // Examples:
      // "List all RPCs in ContestEngineGrpcService with their request/response types"
      // "What fields are required vs optional in CreateContestRequest?"
      // "What columns does the contests table have?"
      // "What does the contest-accounts-updates event payload look like?"
    },
    files: {
      type: "array",
      items: { type: "string" },
      description: "File paths to read for answering the question"
    }
  },
  // Backend implementation:
  // 1. Reads raw file contents from the file paths
  // 2. Loads system prompt from DB (key: tool_ask_context)
  // 3. Sends to Haiku: system prompt + files + question
  // 4. Returns Haiku's answer to the main agent
}
```

**Used in:** State 1, Phase 2b, State U1, State U2

---

### classify_test_cases

Batch classification via Haiku sub-agent.

```typescript
{
  name: "classify_test_cases",
  description: "Classify and group test cases by pattern and primary surface.",
  is_subagent: true,
  subagent_model: "claude-haiku-4-5-20251001",
  prompt_key: "tool_classify",
  input_schema: {
    test_cases: {
      type: "array",
      description: "Test cases to classify"
    },
    inventory_summary: {
      type: "string",
      description: "Brief summary of service inventory for context"
    }
  },
  // Backend implementation:
  // 1. Loads system prompt from DB (key: tool_classify)
  // 2. Sends test cases + inventory to Haiku
  // 3. Haiku groups by pattern, selects representatives
  // 4. Returns pattern groups
}
```

**Used in:** Phase 2a

---

### check_conflicts

Conflict detection via Haiku sub-agent.

```typescript
{
  name: "check_conflicts",
  description: "Check if two test cases have conflicting DB state requirements.",
  is_subagent: true,
  subagent_model: "claude-haiku-4-5-20251001",
  prompt_key: "tool_check_conflicts",
  input_schema: {
    case_a: { type: "object", description: "First test case spec" },
    case_b: { type: "object", description: "Second test case spec" }
  },
  // Backend implementation:
  // 1. Loads system prompt from DB (key: tool_check_conflicts)
  // 2. Sends both cases to Haiku
  // 3. Haiku checks for conflicting preconditions or side effects
  // 4. Returns conflict analysis
}
```

**Used in:** State 3

---

### generate_test_data_pattern

Faker.js pattern generation via Haiku sub-agent.

```typescript
{
  name: "generate_test_data_pattern",
  description: "Generate faker.js data generation patterns for a given proto message type.",
  is_subagent: true,
  subagent_model: "claude-haiku-4-5-20251001",
  prompt_key: "tool_faker_patterns",
  input_schema: {
    message_name: {
      type: "string",
      description: "Proto message type name"
    },
    fields: {
      type: "array",
      description: "Fields with their types"
    }
  },
  // Backend implementation:
  // 1. Loads system prompt from DB (key: tool_faker_patterns)
  // 2. Sends message definition to Haiku
  // 3. Haiku maps each field type to appropriate faker method
  // 4. Returns faker patterns per field
}
```

**Used in:** State 4

---

## Precondition Strategy

For each test case precondition, the agent decides between two setup strategies:

| Strategy | When to use | Example |
|----------|-------------|---------|
| **gRPC call** | Standard entity creation, happy path states | Create user, fund wallet |
| **Direct DB insert** | Edge case states the API doesn't allow, speed-critical setup | Zero balance, expired records, banned status, corrupted data, specific timestamps |

The agent determines this per precondition based on what the QA test case requires. If the precondition describes a state achievable through the API, use gRPC. If it describes an unusual or invalid state, use direct DB.

---

## Test Mapping Output Structure

For each mapped test case, the agent produces:

```yaml
test_case_id: string          # from QA DB
title: string                 # from QA DB
type: string                  # happy_path / negative / edge_cases / e2e
pattern_group: string | null  # null for happy path, pattern name for negative/edge

preconditions:
  - type: "grpc_call" | "db_insert" | "redis_set" | "publish_event"
    service: string            # which service to call / which DB
    rpc: string               # if grpc_call
    table: string             # if db_insert
    input: object             # request payload or row data
    save_as: string           # variable name to reference in later steps

action:
  type: "grpc_call" | "publish_event"
  service: string
  rpc: string | null
  queue: string | null
  input: object               # with $variable references to precondition outputs

assertions:
  - type: "grpc_response" | "grpc_error" | "db_present" | "db_absent" | "db_field_equals" | "event_published" | "event_not_published" | "redis_key_exists" | "redis_key_absent"
    # type-specific fields:
    expected_code: string     # for grpc_error
    table: string             # for db_*
    where: object             # for db_*
    queue: string             # for event_*
    timeout_ms: number        # for event_*
    expected_fields: object   # for event_published / grpc_response
```

---

## Execution Plan Schema

The final output of State 4, consumed by Claude Code. Specifies what to write, not how to write it — Claude Code handles implementation details.

```yaml
execution_plan:
  service: "contest-engine-grpc"

  tech_stack:
    runtime: "ts-node"
    test_runner: "playwright 1.48"    # @playwright/test
    grpc: "@grpc/grpc-js + google-protobuf"
    faker: "@faker-js/faker"
    db: "pg"                          # node-postgres

  environment:
    services:
      contest-engine:
        host: "${CONTEST_ENGINE_HOST}"
        port: "${CONTEST_ENGINE_PORT}"
      users:
        host: "${USERS_HOST}"
        port: "${USERS_PORT}"
      wallets:
        host: "${WALLETS_HOST}"
        port: "${WALLETS_PORT}"
    databases:
      contest-engine-db:
        connection: "${CONTEST_ENGINE_DB_URL}"
      wallets-db:
        connection: "${WALLETS_DB_URL}"
      users-db:
        connection: "${USERS_DB_URL}"
    queues:
      connection: "${QUEUE_URL}"

  helpers:
    - name: "grpcClient"
      file: "helpers/grpc-client.ts"
      description: "Typed gRPC client wrapper"
      services:
        - name: "ContestEngineGrpcService"
          proto_file: "contest-engine.proto"
          rpcs: ["CreateContest", "JoinContest", "CancelContest"]
        - name: "UsersGrpcService"
          proto_file: "users.proto"
          rpcs: ["CreateUser", "GetUser"]
        - name: "ClientWalletsGrpcService"
          proto_file: "wallets.proto"
          rpcs: ["GetBalance", "SetBalance"]

    - name: "eventListener"
      file: "helpers/event-listener.ts"
      description: "Queue consumer that captures events for assertion"
      queues: ["contest-registration-update"]

    - name: "dbHelper"
      file: "helpers/db-helper.ts"
      description: "Direct DB operations — insert, query, cleanup"
      connections:
        - name: "contest-engine-db"
          tables: ["contests", "contest_participants"]
        - name: "wallets-db"
          tables: ["wallets"]
        - name: "users-db"
          tables: ["users"]

  factories:
    - name: "createTestUser"
      file: "factories/user.factory.ts"
      implementation:
        calls: ["UsersGrpcService.CreateUser"]
        faker_fields:
          name: "faker.person.fullName()"
          email: "faker.internet.email()"
        returns: { id: "string", name: "string", email: "string" }

    - name: "createFundedUser"
      file: "factories/user.factory.ts"
      implementation:
        calls: ["createTestUser", "db_insert:wallets"]
        params: { balance: "number" }
        returns: { user: "User", wallet: "Wallet" }

    - name: "createContestRequest"
      file: "factories/contest.factory.ts"
      implementation:
        faker_fields:
          title: "faker.lorem.words(3)"
          entry_fee: "faker.number.int({min:100, max:10000})"
          max_participants: "faker.number.int({min:2, max:100})"
        returns: "CreateContestRequest"

  test_files:
    # Happy path — individual detailed tests
    - file: "tests/contest-creation-happy.spec.ts"
      group: "contest-creation-happy"
      setup: "createFundedUser"
      parallel: true
      tests:
        - test_case_id: "TC-041"
          title: "Successfully create contest with valid data"
          preconditions: [...]
          action: { ... }
          assertions: [...]
        - test_case_id: "TC-042"
          title: "..."
          # ... full spec per test

    # Negative — parameterized via test.each
    - file: "tests/contest-creation-negative.spec.ts"
      group: "contest-creation-invalid-fields"
      setup: "createFundedUser"
      parallel: true
      parameterized: true
      template:
        preconditions: [...]
        action:
          type: "grpc_call"
          service: "ContestEngineGrpcService"
          rpc: "CreateContest"
          input: "template — field overridden per case"
        assertions:
          - type: "grpc_error"
            expected_code: "INVALID_ARGUMENT"
      cases:
        - { test_case_id: "TC-101", field: "title", value: null, error: "title is required" }
        - { test_case_id: "TC-102", field: "title", value: "", error: "title cannot be empty" }
        - { test_case_id: "TC-103", field: "title", value: "x.repeat(256)", error: "title exceeds max length" }
        # ... all cases in the pattern group

    # Sequential lifecycle tests
    - file: "tests/contest-lifecycle.spec.ts"
      group: "contest-lifecycle"
      sequential: true
      tests:
        - test_case_id: "TC-050"
          title: "Create → Join → Cancel contest lifecycle"
          # ... full spec
```

---

## Web App Architecture

### System Components

```
┌──────────────────────────────────────────────────────────────────┐
│  Frontend (React)                                                │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Dashboard                                                 │  │
│  │  • Pipeline runs list (status badges, cost, duration)      │  │
│  │  • Run detail view (state-by-state timeline)               │  │
│  │  • Expandable state outputs (syntax-highlighted JSON)      │  │
│  │  • Tool call log (every sub-agent call with in/out)        │  │
│  │  • Claude Code execution output (streaming terminal)       │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Admin                                                     │  │
│  │  • System prompt editor (per state, versioned)             │  │
│  │  • Service descriptor management                           │  │
│  │  • Context file uploads                                    │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
        │
        │  REST API + WebSocket (live updates)
        ▼
┌──────────────────────────────────────────────────────────────────┐
│  Backend (Node.js / Fastify)                                     │
│                                                                  │
│  ┌──────────────────┐   ┌──────────────────────────────────┐    │
│  │  REST API         │   │  State Machine Engine             │    │
│  │                   │   │                                    │    │
│  │  POST /runs       │──▶│  Loads prompts from DB             │    │
│  │  GET  /runs       │   │  Executes states sequentially     │    │
│  │  GET  /runs/:id   │   │  Handles sub-agent tool calls     │    │
│  │  GET  /runs/:id/  │   │  Stores all intermediate outputs  │    │
│  │       states/:s   │   │  Emits events via WebSocket       │    │
│  │  POST /runs/:id/  │   │                                    │    │
│  │       execute     │   │                                    │    │
│  │  GET  /prompts    │   │                                    │    │
│  │  PUT  /prompts/:k │   │                                    │    │
│  └──────────────────┘   └──────────────────────────────────┘    │
│                                                                  │
│  ┌──────────────────┐   ┌──────────────────────────────────┐    │
│  │  File Store       │   │  WebSocket Server                 │    │
│  │                   │   │                                    │    │
│  │  Raw context      │   │  Events emitted:                  │    │
│  │  files per run    │   │  • state_started                  │    │
│  │                   │   │  • state_completed (with output)  │    │
│  │                   │   │  • tool_call (sub-agent in/out)   │    │
│  │                   │   │  • run_completed                  │    │
│  │                   │   │  • run_failed (with error)        │    │
│  │                   │   │  • claude_code_output (streaming) │    │
│  └──────────────────┘   └──────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────┐
│  PostgreSQL                                                      │
│                                                                  │
│  state_prompts:     id, state_key, model, prompt, version,       │
│                     is_active, created_at                        │
│                                                                  │
│  runs:              id, service_name, mode, status, started_at,  │
│                     completed_at, error, total_cost              │
│                                                                  │
│  state_outputs:     id, run_id, state_name, output_json,         │
│                     model_used, input_tokens, output_tokens,     │
│                     cost, duration_ms, created_at                │
│                                                                  │
│  tool_calls:        id, run_id, state_name, tool_name,           │
│                     input_json, output_json, subagent_model,     │
│                     input_tokens, output_tokens, cost,           │
│                     duration_ms, created_at                      │
│                                                                  │
│  context_files:     id, run_id, file_name, file_path,            │
│                     file_content, file_type, created_at          │
└──────────────────────────────────────────────────────────────────┘
```

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/runs` | Start new pipeline run. Body: `{ service_name, mode, context_files[] }` |
| `GET` | `/runs` | List all runs with status, filterable by service/status |
| `GET` | `/runs/:id` | Full run detail: status, all state outputs, tool calls, timing, costs |
| `GET` | `/runs/:id/states/:state` | Single state output with all tool calls for that state |
| `POST` | `/runs/:id/execute` | Trigger Claude Code execution |
| `GET` | `/prompts` | List all system prompts with versions |
| `PUT` | `/prompts/:key` | Update a system prompt (creates new version) |

### State Machine Engine

```typescript
async function runPipeline(runId: string, mode: "fresh" | "update") {
  const context = await loadContextBundle(runId);

  const states = mode === "fresh"
    ? [state1, phase2a, phase2b, phase2c, state3, state4]
    : [stateU1, stateU2, stateU3];

  let accumulated = {};

  for (const state of states) {
    ws.emit("state_started", { runId, state: state.name });

    // Load prompt from DB (active version)
    const prompt = await loadPrompt(state.promptKey);

    const result = await executeState(state, prompt, context, accumulated);
    accumulated[state.name] = result;

    await saveStateOutput(runId, state.name, result);
    ws.emit("state_completed", { runId, state: state.name, output: result });
  }

  ws.emit("run_completed", { runId, plan: accumulated.execution_plan });
}
```

### Sub-Agent Tool Call Handling

When the Claude API returns a `tool_use` block for a sub-agent tool:

```typescript
async function handleToolCall(runId: string, stateName: string, toolCall: ToolUse) {
  const tool = tools[toolCall.name];

  // Load sub-agent prompt from DB
  const subPrompt = await loadPrompt(tool.promptKey);

  // Build sub-agent context (e.g., read files for ask_context)
  const subContext = await buildSubAgentContext(toolCall.input);

  // Call Haiku
  const response = await anthropic.messages.create({
    model: tool.subagent_model,
    max_tokens: 2000,
    system: subPrompt,
    messages: [{ role: "user", content: subContext }]
  });

  const result = extractText(response);

  // Log everything
  await saveToolCall(runId, stateName, toolCall, result);
  ws.emit("tool_call", {
    runId, stateName,
    tool: toolCall.name,
    input: toolCall.input,
    output: result
  });

  return result;
}
```

### Dashboard UI

**Run List View:**
- Table of all runs: service name, mode (fresh/update), status badge (running/completed/failed), started time, duration, total cost
- Filter by service, status, mode
- Click a run to open detail view

**Run Detail View:**
- Vertical timeline of states, each expandable:
  - State header: name, model used, status badge, duration, token count, cost
  - Expanded: formatted output (JSON with syntax highlighting), collapsible sections for large outputs
  - Tool calls nested under their state: tool name, input preview, output preview, sub-agent model, cost
- For parameterized test groups: summary view ("15 pattern groups, 203 total cases") with drill-down to individual case mappings
- Final execution plan: rendered as a file tree with expandable specs per file

**Claude Code Output (when executing):**
- Streaming terminal-style output
- File creation events highlighted
- Progress indicator (files written / total)

---

## System Prompts — Database Schema

All prompts are versioned and stored in the `state_prompts` table:

```sql
CREATE TABLE state_prompts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_key VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  prompt TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT now(),

  UNIQUE(state_key, version)
);
```

**Prompt keys:**

| Key | Model | Used in |
|-----|-------|---------|
| `state_1_inventory` | Sonnet | State 1 |
| `phase_2a_classify` | Haiku | Phase 2a |
| `phase_2b_mapping` | Opus | Phase 2b |
| `phase_2c_expand` | Sonnet | Phase 2c |
| `state_3_dependencies` | Sonnet | State 3 |
| `state_4_execution_plan` | Sonnet | State 4 |
| `state_u1_diff_analysis` | Sonnet | State U1 |
| `state_u2_impact_mapping` | Opus | State U2 |
| `state_u3_update_plan` | Sonnet | State U3 |
| `tool_ask_context` | Haiku | ask_context sub-agent |
| `tool_classify` | Haiku | classify_test_cases sub-agent |
| `tool_check_conflicts` | Haiku | check_conflicts sub-agent |
| `tool_faker_patterns` | Haiku | generate_test_data_pattern sub-agent |

The admin UI allows editing prompts and creating new versions. The engine always loads the row where `is_active = true` for a given `state_key`.

---

## Error Handling

### State Failure

If a state's LLM call fails (API error, timeout, malformed output):

1. Mark state as `failed` in DB with error details
2. Emit `run_failed` via WebSocket with error context
3. Mark entire run as `failed`
4. Store the raw response (even if malformed) for debugging in the dashboard
5. UI shows the error inline at the failed state with the raw output visible

No automatic retry — the user reviews the error in the dashboard and can re-trigger the run after adjusting prompts or context if needed.

### Partial Pipeline Recovery

If a run fails at State 3, the outputs of States 1, 2a, 2b, 2c are preserved and visible in the dashboard. A future enhancement could allow restarting from the failed state, but for v1 the user re-runs the entire pipeline.

### Claude Code Failure

If Claude Code exits with an error or fails to produce expected files:
1. Capture all stdout/stderr
2. Store as execution output on the run
3. Display in the dashboard's streaming terminal panel
4. The user reviews and can re-trigger execution or adjust the plan

---

## Cost Estimates

### Fresh Mode (~24 happy + ~200 negative test cases)

| State | Model | Input tokens | Output tokens | Haiku calls | Cost |
|-------|-------|-------------|--------------|-------------|------|
| State 1 | Sonnet | ~5k | ~3k | ~6 | ~$0.03 |
| Phase 2a | Haiku | ~8k | ~2k | — | ~$0.02 |
| Phase 2b | Opus | ~15k | ~10k | ~15 | ~$0.15 |
| Phase 2c | Sonnet | ~10k | ~6k | — | ~$0.05 |
| State 3 | Sonnet | ~12k | ~4k | ~3 | ~$0.06 |
| State 4 | Sonnet | ~18k | ~8k | ~5 | ~$0.10 |
| **Total** | | | | | **~$0.41** |

### Update Mode (typical small change)

| State | Model | Input tokens | Output tokens | Cost |
|-------|-------|-------------|--------------|------|
| State U1 | Sonnet | ~4k | ~2k | ~$0.02 |
| State U2 | Opus | ~10k | ~6k | ~$0.10 |
| State U3 | Sonnet | ~8k | ~4k | ~$0.04 |
| **Total** | | | | **~$0.16** |

import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageNumber, Header, Footer, ExternalHyperlink,
} from "docx";
import fs from "fs";

// ─── Helpers ─────────────────────────────────────────────────

const ACCENT   = "00B4CC";
const DARK     = "1A1D23";
const MID      = "2D3139";
const LIGHT_BG = "F4F6F9";
const BORDER_C = "D0D5DE";
const WHITE    = "FFFFFF";
const TEXT     = "2C3142";
const MUTED    = "6B7280";

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 120 },
    children: [new TextRun({ text, bold: true, size: 36, font: "Arial", color: DARK })],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 100 },
    children: [new TextRun({ text, bold: true, size: 28, font: "Arial", color: DARK })],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, bold: true, size: 24, font: "Arial", color: MID })],
  });
}

function p(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 160 },
    children: [new TextRun({ text, size: 22, font: "Arial", color: TEXT, ...opts })],
  });
}

function bullet(text, bold = false) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 80 },
    children: [new TextRun({ text, size: 22, font: "Arial", color: TEXT, bold })],
  });
}

function subbullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 1 },
    spacing: { after: 60 },
    children: [new TextRun({ text, size: 20, font: "Arial", color: MUTED })],
  });
}

function divider() {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_C } },
    spacing: { before: 200, after: 200 },
    children: [],
  });
}

function spacer() {
  return new Paragraph({ spacing: { after: 160 }, children: [] });
}

function code(text) {
  return new Paragraph({
    spacing: { after: 80 },
    indent: { left: 720 },
    children: [new TextRun({ text, size: 18, font: "Courier New", color: "2E7D32" })],
  });
}

function label(text) {
  return new Paragraph({
    spacing: { after: 60 },
    children: [new TextRun({ text, size: 18, font: "Arial", color: MUTED, allCaps: true })],
  });
}

const cellBorder = { style: BorderStyle.SINGLE, size: 1, color: BORDER_C };
const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

function headerCell(text) {
  return new TableCell({
    borders,
    shading: { fill: DARK, type: ShadingType.CLEAR },
    margins: { top: 100, bottom: 100, left: 140, right: 140 },
    width: { size: 2340, type: WidthType.DXA },
    children: [new Paragraph({
      children: [new TextRun({ text, bold: true, size: 18, font: "Arial", color: WHITE })],
    })],
  });
}

function dataCell(text, shade = false) {
  return new TableCell({
    borders,
    shading: { fill: shade ? LIGHT_BG : WHITE, type: ShadingType.CLEAR },
    margins: { top: 80, bottom: 80, left: 140, right: 140 },
    width: { size: 2340, type: WidthType.DXA },
    children: [new Paragraph({
      children: [new TextRun({ text, size: 20, font: "Arial", color: TEXT })],
    })],
  });
}

function table4(headers, rows) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [2340, 2340, 2340, 2340],
    rows: [
      new TableRow({ children: headers.map(h => headerCell(h)) }),
      ...rows.map((r, i) => new TableRow({
        children: r.map(c => dataCell(c, i % 2 === 0)),
      })),
    ],
  });
}

function table2(headers, rows, widths = [3120, 6240]) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({ children: headers.map((h, idx) => new TableCell({
        borders,
        shading: { fill: DARK, type: ShadingType.CLEAR },
        margins: { top: 100, bottom: 100, left: 140, right: 140 },
        width: { size: widths[idx], type: WidthType.DXA },
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 18, font: "Arial", color: WHITE })] })],
      })) }),
      ...rows.map((r, i) => new TableRow({
        children: r.map((c, idx) => new TableCell({
          borders,
          shading: { fill: i % 2 === 0 ? LIGHT_BG : WHITE, type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 80, left: 140, right: 140 },
          width: { size: widths[idx], type: WidthType.DXA },
          children: [new Paragraph({ children: [new TextRun({ text: c, size: 20, font: "Arial", color: TEXT })] })],
        })),
      })),
    ],
  });
}

function accentBox(title, bodyLines) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [9360],
    rows: [
      new TableRow({ children: [new TableCell({
        borders: { top: { style: BorderStyle.SINGLE, size: 6, color: ACCENT },
                   bottom: cellBorder, left: { style: BorderStyle.SINGLE, size: 6, color: ACCENT }, right: cellBorder },
        shading: { fill: "E8F9FB", type: ShadingType.CLEAR },
        margins: { top: 140, bottom: 140, left: 200, right: 200 },
        width: { size: 9360, type: WidthType.DXA },
        children: [
          new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 22, font: "Arial", color: ACCENT })] }),
          ...bodyLines.map(l => new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: l, size: 20, font: "Arial", color: TEXT })] })),
        ],
      })] }),
    ],
  });
}

// ─── Document ─────────────────────────────────────────────────

const doc = new Document({
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 1, format: LevelFormat.BULLET, text: "\u25E6", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1080, hanging: 360 } } } },
        ],
      },
      {
        reference: "numbered",
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
        ],
      },
    ],
  },
  styles: {
    default: { document: { run: { font: "Arial", size: 22, color: TEXT } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial", color: DARK },
        paragraph: { spacing: { before: 360, after: 120 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: DARK },
        paragraph: { spacing: { before: 280, after: 100 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Arial", color: MID },
        paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2 } },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1260, bottom: 1440, left: 1260 },
      },
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_C } },
          children: [
            new TextRun({ text: "AQA Agent", bold: true, size: 20, font: "Arial", color: ACCENT }),
            new TextRun({ text: "  \u2014  System Documentation", size: 20, font: "Arial", color: MUTED }),
            new TextRun({ text: "\t", size: 20 }),
            new TextRun({ text: "CONFIDENTIAL  \u00B7  CypherTrade / skill-trade", size: 18, font: "Arial", color: MUTED }),
          ],
        })],
      }),
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_C } },
          children: [
            new TextRun({ text: "Page ", size: 18, font: "Arial", color: MUTED }),
            new TextRun({ children: [PageNumber.CURRENT], size: 18, font: "Arial", color: MUTED }),
            new TextRun({ text: " of ", size: 18, font: "Arial", color: MUTED }),
            new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18, font: "Arial", color: MUTED }),
            new TextRun({ text: "\t\u00A9 2026 CypherTrade. Internal use only.", size: 18, font: "Arial", color: MUTED }),
          ],
        })],
      }),
    },
    children: [

      // ═══════════════════════════════════════════════════════
      // TITLE PAGE
      // ═══════════════════════════════════════════════════════
      spacer(), spacer(), spacer(),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 80 },
        children: [new TextRun({ text: "AQA AGENT", bold: true, size: 64, font: "Arial", color: ACCENT })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 40 },
        children: [new TextRun({ text: "Automated Quality Assurance Agent", size: 32, font: "Arial", color: DARK })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 320 },
        children: [new TextRun({ text: "System Documentation & Architecture Overview", size: 24, font: "Arial", color: MUTED })],
      }),
      new Table({
        width: { size: 4680, type: WidthType.DXA },
        columnWidths: [4680],
        rows: [new TableRow({ children: [new TableCell({
          borders: { top: { style: BorderStyle.SINGLE, size: 6, color: ACCENT },
                     bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT },
                     left: cellBorder, right: cellBorder },
          shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
          margins: { top: 180, bottom: 180, left: 240, right: 240 },
          width: { size: 4680, type: WidthType.DXA },
          children: [
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
              children: [new TextRun({ text: "Project", bold: true, size: 18, font: "Arial", color: MUTED, allCaps: true })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 },
              children: [new TextRun({ text: "CypherTrade / skill-trade", size: 22, font: "Arial", color: DARK, bold: true })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
              children: [new TextRun({ text: "Stack", bold: true, size: 18, font: "Arial", color: MUTED, allCaps: true })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 100 },
              children: [new TextRun({ text: "TypeScript \u00B7 Claude API \u00B7 Playwright \u00B7 gRPC", size: 22, font: "Arial", color: TEXT })] }),
            new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
              children: [new TextRun({ text: "Version", bold: true, size: 18, font: "Arial", color: MUTED, allCaps: true })] }),
            new Paragraph({ alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: "March 2026 \u00B7 Internal Draft", size: 22, font: "Arial", color: TEXT })] }),
          ],
        })] })],
      }),
      new Paragraph({ pageBreakBefore: true, children: [] }),

      // ═══════════════════════════════════════════════════════
      // 1. WHAT IS IT? — SYSTEM OVERVIEW
      // ═══════════════════════════════════════════════════════
      h1("1. What Is It? \u2014 System Overview"),
      divider(),

      h2("1.1 Core Concept"),
      p("AQA Agent is an AI-driven test automation system that automatically generates, runs, debugs, and maintains gRPC integration tests for the CypherTrade platform. Instead of engineers manually writing tests for every new gRPC method, the agent reads the proto contract, reasons about edge cases, writes TypeScript/Playwright test files, runs them, and iterates until they pass \u2014 all autonomously."),
      spacer(),
      accentBox("One-line definition", [
        "AQA Agent turns a service name into a passing test suite \u2014 end to end \u2014 with no human intervention."
      ]),
      spacer(),

      h2("1.2 Scope and Boundaries"),
      p("In scope:"),
      bullet("gRPC integration tests for all services in the skill-trade repo"),
      bullet("Proto contract parsing and schema validation"),
      bullet("Test coverage analysis and gap detection"),
      bullet("Test plan generation (structured, prioritised test cases)"),
      bullet("Test code writing, execution, and auto-debugging"),
      bullet("Real-time monitoring via web dashboard (localhost:3000)"),
      bullet("Cost tracking per run, per agent, per phase"),
      spacer(),
      p("Out of scope:"),
      bullet("UI / E2E browser tests"),
      bullet("Performance or load testing"),
      bullet("Tests for non-gRPC (REST) endpoints"),
      bullet("Production deployment of tests"),
      spacer(),

      h2("1.3 Key Components"),
      table2(
        ["Component", "Description"],
        [
          ["Orchestrator", "Entry point. Initialises RunState, runs setup phases, dispatches per-method actions, saves ledger."],
          ["State Machine", "Validates all phase transitions against PHASE_TRANSITIONS table. Throws on invalid transitions. Records every transition reason in state.notes."],
          ["Pipeline Setup", "Deterministic phases: resolve \u2192 parse \u2192 coverage. No LLM involved."],
          ["Pipeline Actions", "Per-action handlers: cover, plan, fix, validate_only, implement_only."],
          ["Agentic Loop", "LLM loop per agent call. Handles extended thinking, tool calls (save_notes, complete_phase), and history compression."],
          ["Context Builder (RAG)", "Assembles system prompts per agent role: planner vs. coder vs. debugger. Injects proto contract, example tests, wrapper code, failure patterns."],
          ["Cost Tracker", "Tracks input/output/cache tokens and USD cost per step, per agent, per phase. Budget limits per agent and per run."],
          ["Web Dashboard", "Single-page app (SSE + localStorage). Shows pipeline phases, phase inspector, live log, run history, cost, chat."],
          ["Memory / Persistence", "Project index (coverage %), run history (JSON), plan artifacts (resumable), run ledger (per-run decisions + facts)."],
        ],
        [3120, 6240],
      ),
      spacer(),

      h2("1.4 Features"),
      bullet("Full pipeline automation: resolve \u2192 parse \u2192 coverage \u2192 plan \u2192 implement \u2192 validate \u2192 debug \u2192 done"),
      bullet("Six run actions: cover, plan, fix, analyze, validate_only, implement_only"),
      bullet("Resumable runs: save plan artifacts, resume implement_only separately"),
      bullet("Extended thinking (Claude adaptive thinking) for complex reasoning"),
      bullet("History compression: last 2 turns full, older tool results compressed to save tokens"),
      bullet("Agent notes via save_notes tool: planner insights travel to coder via state.notes"),
      bullet("Proto snapshot tracking: detect contract changes between syncs"),
      bullet("Run ledger: full audit trail of facts, decisions, and attempts per run"),
      bullet("Failure classification: 7 failure classes (A_PROMPT through G_SPEC) with auto-fix strategies"),
      bullet("Real-time SSE events: every phase transition and log line streamed to dashboard"),
      spacer(),

      h2("1.5 Guardrail Architecture"),
      p("Multiple layers prevent silent failures and cost overruns:"),
      spacer(),
      table2(
        ["Guardrail", "Mechanism"],
        [
          ["Invalid phase transition", "State machine throws immediately: 'Invalid transition: X \u2192 Y'. No silent state corruption."],
          ["Budget limit", "AgentConfig.budgetLimit per agent. CostAccumulator checked before each LLM call."],
          ["Max retries", "state.maxRetries = 2. Each failed implement attempt increments state.retries."],
          ["Abort signal", "AbortSignal passed through entire pipeline. Checked before each method iteration."],
          ["Guardrail result type", "Every agent output validated via GuardrailResult \u2014 errors block, warnings log."],
          ["Proto source of truth", "NEVER edit generated/ code. Proto files are canonical. Tests import only from wrappers."],
          ["Hard code constraints", "No sleep(), no hardcoded IDs, no production PII in tests (enforced by code review rules)."],
        ],
        [3000, 6360],
      ),
      new Paragraph({ pageBreakBefore: true, children: [] }),

      // ═══════════════════════════════════════════════════════
      // 2. WHAT PROBLEM IT SOLVES
      // ═══════════════════════════════════════════════════════
      h1("2. What Problem Does It Solve?"),
      divider(),
      p("The skill-trade platform has 8 gRPC services with dozens of methods. Manually writing, maintaining, and running integration tests for all of them is:"),
      spacer(),
      table4(
        ["Problem", "Impact", "Before", "After AQA Agent"],
        [
          ["Manual test authoring", "High engineer time cost", "Hours per method", "Automated"],
          ["Coverage gaps", "Untested methods ship to prod", "Unknown coverage", "Real-time % per service"],
          ["Contract drift", "Proto changes break tests silently", "Discovered in CI failures", "Proto snapshot diff on every sync"],
          ["Debugging loops", "Engineers debug flaky tests manually", "Slow, expensive", "Auto-debug with classified failure strategies"],
          ["Context switching", "QA blocks dev velocity", "QA team bottleneck", "Agent runs async, unblocks team"],
          ["Cost visibility", "LLM usage untracked", "Black box", "USD cost per run, per agent, per phase"],
        ],
      ),
      spacer(),
      p("The agent does not replace QA engineers \u2014 it eliminates the repetitive, mechanical part of test writing so engineers can focus on complex scenarios, business logic validation, and architecture decisions."),
      new Paragraph({ pageBreakBefore: true, children: [] }),

      // ═══════════════════════════════════════════════════════
      // 3. DECISIONS TAKEN
      // ═══════════════════════════════════════════════════════
      h1("3. What Decisions Were Taken?"),
      divider(),

      h2("3.1 Architecture Decisions"),
      table2(
        ["Decision", "Rationale"],
        [
          ["State machine with explicit transition table", "Prevents silent phase corruption. Every invalid transition throws with full context. Every transition reason is recorded in state.notes for post-mortem audit."],
          ["Artifact-first types (NormalizedContract, CoverageReport, TestPlan)", "Each pipeline phase produces a strongly-typed artifact. Downstream phases receive clean, validated data \u2014 not raw strings."],
          ["History compression (compressOldToolResults)", "LLM context grows linearly with tool calls. Keeping last 2 turns full + compressing older results reduces token cost by 40\u201360% on long implement runs."],
          ["save_notes as agent-to-agent communication", "Planner explicitly writes schema insights via tool call. Coder reads them from state.notes. This is intentional: agents don\u2019t share memory implicitly \u2014 they communicate through structured notes."],
          ["Resumable plan/implement split", "Plan artifacts saved as JSON. implement_only action loads them without re-running the LLM planner. Allows re-implementing after prompt changes without paying for re-planning."],
          ["RAG context builder per agent role", "Planner prompt \u2260 coder prompt \u2260 debugger prompt. Each role gets only the context it needs: proto contract, example tests, wrapper code, failure patterns. Reduces noise and token waste."],
          ["Six run actions (cover, plan, fix, analyze, validate_only, implement_only)", "Different team needs require different modes. Analyze-only for coverage reporting. Plan-only for review before implementation. validate_only for CI without re-writing."],
        ],
        [2880, 6480],
      ),
      spacer(),

      h2("3.2 Tooling Decisions"),
      table2(
        ["Decision", "Rationale"],
        [
          ["Playwright + TypeScript (not Jest/Mocha)", "Existing team expertise. gRPC client wrappers already built. Fixtures pattern established. No reason to introduce a second test runner."],
          ["Proto files as source of truth", "gRPC contracts are defined in proto. Generated TypeScript code must never be edited manually. This prevents drift between contract and test assumptions."],
          ["ts-interface-checker for schema validation", "Runtime schema checks on every gRPC response. First test in every file validates contract shape. Catches breaking API changes before business logic tests."],
          ["Claude API with adaptive thinking", "Extended thinking improves reasoning quality for complex proto schemas and test case generation. Thinking tokens are not charged at full rate."],
          ["SSE (Server-Sent Events) for dashboard", "Simple, no WebSocket server needed. Node.js built-in. Dashboard reconnects automatically on disconnect."],
        ],
        [2880, 6480],
      ),
      new Paragraph({ pageBreakBefore: true, children: [] }),

      // ═══════════════════════════════════════════════════════
      // 4. COST EFFECTIVENESS
      // ═══════════════════════════════════════════════════════
      h1("4. Cost Effectiveness & Approach"),
      divider(),

      h2("4.1 Model Tier Strategy"),
      p("The agent selects model tier based on task complexity:"),
      spacer(),
      table4(
        ["Tier", "Model", "Used For", "Cost Profile"],
        [
          ["haiku", "claude-haiku-3-5", "Researcher, simple queries, context retrieval", "Cheapest \u2014 ~$0.0008/1K tokens"],
          ["sonnet", "claude-sonnet-3-7", "Planner, reviewer, structured reasoning", "Mid \u2014 ~$0.003/1K tokens"],
          ["opus", "claude-opus-4-5", "Coder (implement), debugger (complex fixes)", "Most capable, higher cost"],
        ],
      ),
      spacer(),

      h2("4.2 Cost Reduction Techniques"),
      bullet("History compression \u2014 compresses tool results older than last 2 turns. Reduces context size by 40\u201360% on long runs."),
      bullet("Prompt caching \u2014 system prompts marked for cache. Cache read tokens cost 90% less than input tokens."),
      bullet("Budget limits per agent \u2014 each AgentConfig has budgetLimit. Agent stops before exceeding it."),
      bullet("Per-run budget \u2014 total run cost capped. Prevents runaway loops."),
      bullet("implement_only action \u2014 skips re-planning. Pay for implement only, not plan again."),
      bullet("analyze action \u2014 coverage report only, zero LLM cost."),
      spacer(),

      h2("4.3 Observed Cost Range"),
      accentBox("Real production run data (from run history)", [
        "analyze run: $0.0000 \u2014 fully deterministic, no LLM",
        "plan run (1 method): ~$0.02\u20130.04",
        "cover run (1 method, 10 test cases): ~$0.15\u20130.25",
        "fix run (debugging existing tests): ~$0.10\u20130.20",
        "Full pipeline (plan + implement + validate + debug): ~$0.50\u20131.50 per service",
      ]),
      spacer(),
      p("Compare: a QA engineer spending 4\u20138 hours writing tests for one service at market rate vastly exceeds the agent cost per service."),
      new Paragraph({ pageBreakBefore: true, children: [] }),

      // ═══════════════════════════════════════════════════════
      // 5. WORKFLOW
      // ═══════════════════════════════════════════════════════
      h1("5. Workflow"),
      divider(),

      h2("5.1 Pipeline Phases"),
      table2(
        ["Phase", "Description"],
        [
          ["init", "RunState created. runId assigned. Cost accumulator initialised."],
          ["resolve", "DETERMINISTIC. Finds proto file, service wrapper, types, test directory for the given service name."],
          ["parse", "DETERMINISTIC. Parses proto contract into NormalizedContract: methods, messages, enums, field types."],
          ["coverage", "DETERMINISTIC. Scans existing test files. Builds CoverageReport: covered methods %, uncovered methods list."],
          ["plan", "LLM (Planner / sonnet). Per method: generates structured TestPlan with schema test + typed test cases (positive, negative, boundary, edge). Saves notes via save_notes tool."],
          ["implement", "LLM (Coder / opus). Per method: reads proto, wrapper, example tests. Writes TypeScript test file. Uses adaptive thinking for complex schemas."],
          ["validate", "DETERMINISTIC. Runs Playwright. Returns TestResult: passed, failed, skipped, errors per test."],
          ["debug", "LLM (Debugger / opus). Classifies failure (A\u2013G). Applies auto-fix or LLM-debug strategy. Re-runs validate."],
          ["save", "Saves plan artifacts (plan action) or last implement run (cover/implement_only). Updates service index and run history."],
          ["report", "Prints per-method result table to console. Emits complete SSE event to dashboard."],
          ["done / failed / stopped", "Terminal states. Pipeline ends. Ledger saved regardless (finally block)."],
        ],
        [1800, 7560],
      ),
      spacer(),

      h2("5.2 Run Actions"),
      table2(
        ["Action", "What it does"],
        [
          ["cover", "Full pipeline: plan \u2192 implement \u2192 validate \u2192 debug. Targets uncovered methods only."],
          ["plan", "Plan only. Saves plan artifacts as JSON. No test files written."],
          ["implement_only", "Loads saved plans. Implements without re-planning. For when prompt changed or code generation failed."],
          ["fix", "Re-runs implement \u2192 validate \u2192 debug on already-covered methods (existing tests failing)."],
          ["validate_only", "Run tests only. No write, no debug. Used in CI to check current state."],
          ["analyze", "Coverage report only. No LLM. Cheapest action \u2014 $0."],
        ],
        [2340, 7020],
      ),
      spacer(),

      h2("5.3 How to Run"),
      label("Start the dashboard server"),
      code("cd /Users/brudni/aqa-agent && npm run dev"),
      label("Open dashboard"),
      code("http://localhost:3000"),
      label("Or use CLI directly"),
      code("cd /Users/brudni/skill-trade"),
      code("claude --agent main-agent"),
      label("Example prompts"),
      code("plan tests for MissionEngine"),
      code("cover InsertOrReplaceMissionsGroup in MissionEngine"),
      code("analyze MissionEngine"),
      code("fix tests for MissionEngine"),
      new Paragraph({ pageBreakBefore: true, children: [] }),

      // ═══════════════════════════════════════════════════════
      // 6. HOW TO MAINTAIN & UPDATE
      // ═══════════════════════════════════════════════════════
      h1("6. How to Maintain & Update"),
      divider(),

      h2("6.1 Adding a New gRPC Service"),
      new Paragraph({ numbering: { reference: "numbered", level: 0 }, spacing: { after: 80 },
        children: [new TextRun({ text: "Add proto file to skill-trade/lib/clients/gRPC/proto/", size: 22, font: "Arial", color: TEXT })] }),
      new Paragraph({ numbering: { reference: "numbered", level: 0 }, spacing: { after: 80 },
        children: [new TextRun({ text: "Run npm run proto inside skill-trade to regenerate generated/ code", size: 22, font: "Arial", color: TEXT })] }),
      new Paragraph({ numbering: { reference: "numbered", level: 0 }, spacing: { after: 80 },
        children: [new TextRun({ text: "Create service wrapper: lib/clients/gRPC/services/{ServiceName}.ts", size: 22, font: "Arial", color: TEXT })] }),
      new Paragraph({ numbering: { reference: "numbered", level: 0 }, spacing: { after: 80 },
        children: [new TextRun({ text: "Add type definitions to lib/clients/gRPC/types/{service}/", size: 22, font: "Arial", color: TEXT })] }),
      new Paragraph({ numbering: { reference: "numbered", level: 0 }, spacing: { after: 80 },
        children: [new TextRun({ text: "Register client in lib/fixtures.ts under gRPC fixture", size: 22, font: "Arial", color: TEXT })] }),
      new Paragraph({ numbering: { reference: "numbered", level: 0 }, spacing: { after: 80 },
        children: [new TextRun({ text: "Run: cover {ServiceName} \u2014 agent handles the rest", size: 22, font: "Arial", color: TEXT })] }),
      spacer(),

      h2("6.2 Updating Agent Prompts"),
      bullet("System prompts live in: src/rag/context-builder.ts"),
      bullet("Planner prompt \u2014 modify when test plan quality degrades or new test case types needed"),
      bullet("Coder prompt \u2014 modify when generated code style drifts from team conventions"),
      bullet("Debugger prompt \u2014 modify when new failure patterns emerge"),
      bullet("After prompt change: run implement_only (skips re-planning, applies new coder prompt only)"),
      spacer(),

      h2("6.3 Adding a New Run Action"),
      bullet("Add new action to ParsedIntent.action union type in src/types.ts"),
      bullet("Add handler in src/engine/pipeline-actions.ts"),
      bullet("Add case to switch in src/engine/orchestrator.ts"),
      bullet("Update selectMethods() logic if needed"),
      bullet("Add to PHASE_TRANSITIONS if new phases are introduced"),
      spacer(),

      h2("6.4 Model Updates"),
      bullet("Model tiers configured in src/types.ts (ModelTier) and per-agent AgentConfig"),
      bullet("To upgrade a model: change the model string in the relevant step file (plan-tests.ts, write-tests.ts)"),
      bullet("Run a test cover on a known service to validate output quality before rolling out"),
      spacer(),

      h2("6.5 Monitoring & Debugging"),
      table2(
        ["What to check", "Where"],
        [
          ["Live run status", "Dashboard \u2192 Live Log (left column)"],
          ["Phase-by-phase output", "Dashboard \u2192 Phase Inspector (center column)"],
          ["Run history with costs", "Dashboard \u2192 Run History + Cost panel"],
          ["Full ledger per run", "aqa-agent/memory/ledger/{runId}.json"],
          ["Service coverage index", "aqa-agent/memory/project-index.json"],
          ["Proto contract snapshots", "aqa-agent/memory/proto-snapshots.json"],
          ["Failed test details", "Phase Inspector \u2192 Output tab \u2192 expand method"],
        ],
        [3120, 6240],
      ),
      spacer(),

      h2("6.6 Coverage Targets (from project policy)"),
      table4(
        ["Module", "Target", "Priority", "SLA"],
        [
          ["Users (auth, register)", "100%", "P1", "Fix same day if drops"],
          ["ContestEngine", "100%", "P1", "Fix same day if drops"],
          ["XpEngine", "100%", "P1", "Fix same day if drops"],
          ["ClientWallets", "100%", "P1", "Fix same day if drops"],
          ["All other services", "80% minimum", "P2", "Fix within sprint"],
        ],
      ),
      spacer(),
      divider(),
      spacer(),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: "End of Document  \u00B7  AQA Agent System Documentation  \u00B7  March 2026", size: 18, font: "Arial", color: MUTED })],
      }),
    ],
  }],
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync("AQA-Agent-System-Documentation.docx", buffer);
  console.log("Done: AQA-Agent-System-Documentation.docx");
});

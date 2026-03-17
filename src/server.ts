import "dotenv/config";
import express from "express";
import { join, basename } from "path";
import { existsSync, appendFileSync, mkdirSync } from "fs";
import { globSync } from "glob";
import Anthropic from "@anthropic-ai/sdk";
import { pipelineEvents, emitPipelineEvent } from "./events.js";
import type { PipelineEvent } from "./events.js";
import { loadRunHistory, loadRunLedger } from "./memory/run-history.js";
import { getSessionCost, addRunCost, resetSessionCost } from "./memory/session-cost.js";
import { loadLastPlanRun, loadLastImplementRun } from "./memory/resumable-context.js";
import { loadProjectIndex } from "./memory/project-index.js";
import {
  loadProtoChangeReport,
  saveProtoChangeReport,
  saveProtoSnapshots,
} from "./memory/proto-changes.js";
import { runPipeline } from "./engine/orchestrator.js";
import { chatTurn } from "./chat-agent.js";
import { syncProtos, buildProtoSnapshots } from "./scripts/sync-protos.js";
import type { ParsedIntent, ProtoChangeReport } from "./types.js";

const CHAT_LOG_PATH = join(import.meta.dirname, "../state/chat-log.jsonl");

function logChat(entry: Record<string, unknown>): void {
  try {
    mkdirSync(join(import.meta.dirname, "../state"), { recursive: true });
    appendFileSync(
      CHAT_LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    );
  } catch {}
}

// Reset session cost on each server boot so every UI/server start
// begins with a fresh accounting window for costs.
resetSessionCost();

const app = express();
app.use(express.json());
app.use(express.static(join(import.meta.dirname, "../web")));

const serverBootId = `${Date.now()}`;
let pipelineRunning = false;
let activeAbortController: AbortController | null = null;
let chatHistory: Anthropic.MessageParam[] = [];
const MAX_HISTORY = 30;
const SYNC_CACHE_MS = 60_000;
let lastProtoSyncAt = 0;
let activeProtoSync: Promise<void> | null = null;
let lastProtoSyncReport: ProtoChangeReport | null = loadProtoChangeReport();

// Accumulate cost on every pipeline complete (SSE or CLI)
pipelineEvents.on("pipeline", (event: PipelineEvent) => {
  if (
    event.type === "complete" &&
    event.data &&
    typeof (event.data as { totalCost?: number }).totalCost === "number"
  ) {
    const d = event.data as {
      totalCost: number;
      totalInputTokens?: number;
      totalOutputTokens?: number;
    };
    addRunCost({
      totalUsd: d.totalCost,
      totalInputTokens: d.totalInputTokens,
      totalOutputTokens: d.totalOutputTokens,
    });
  }
});

async function ensureProtoSync(
  force = false,
): Promise<ProtoChangeReport | null> {
  if (activeProtoSync) {
    await activeProtoSync;
    return lastProtoSyncReport;
  }

  if (!force && Date.now() - lastProtoSyncAt < SYNC_CACHE_MS) {
    return lastProtoSyncReport;
  }

  activeProtoSync = syncProtos()
    .then((report) => {
      lastProtoSyncAt = Date.now();
      lastProtoSyncReport = report;
    })
    .finally(() => {
      activeProtoSync = null;
    });

  await activeProtoSync;
  return lastProtoSyncReport;
}

function buildProtoUpdateIntents(
  report: ProtoChangeReport | null,
): ParsedIntent[] {
  if (!report?.changedServices?.length) return [];

  const intents: ParsedIntent[] = [];

  for (const change of report.changedServices) {
    const methods = [
      ...new Set([
        ...(change.addedMethods ?? []),
        ...(change.changedMethods ?? []),
      ]),
    ];

    if (!methods.length) continue;

    intents.push({
      action: null,
      service: change.service,
      methods,
      raw: `update tests for proto changes: ${change.service}`,
    });
  }

  return intents;
}

async function runProtoUpdateBatch(report: ProtoChangeReport | null): Promise<{
  intents: ParsedIntent[];
  report: ProtoChangeReport | null;
}> {
  const intents = buildProtoUpdateIntents(report);
  for (const intent of intents) {
    await runPipeline(intent);
  }
  return { intents, report };
}

// ─── API: available services ─────────────────────────────────

app.get("/api/services", async (_req, res) => {
  const skillTradePath = process.env.SKILL_TRADE_PATH;
  if (!skillTradePath) {
    res.json({ services: [], index: { services: {} } });
    return;
  }

  try {
    await ensureProtoSync();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
    return;
  }

  const protoDir = join(skillTradePath, "lib/clients/gRPC/proto");
  let services: string[] = [];
  if (existsSync(protoDir)) {
    services = globSync("*.proto", { cwd: protoDir })
      .map((f) => basename(f, ".proto"))
      .sort();
  }

  const index = loadProjectIndex();
  const lastPlanRun = loadLastPlanRun();
  const lastImplementRun = loadLastImplementRun();
  res.json({
    services,
    index,
    protoSync: lastProtoSyncReport,
    lastPlanRun,
    lastImplementRun,
  });
});

// ─── API: run history ────────────────────────────────────────

app.get("/api/history", (_req, res) => {
  const history = loadRunHistory();
  res.json(history.reverse());
});

app.get("/api/runs/:id", (req, res) => {
  const ledger = loadRunLedger(req.params.id);
  if (!ledger) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json(ledger);
});

app.get("/api/status", (_req, res) => {
  res.json({
    running: pipelineRunning,
    bootId: serverBootId,
    protoSync: lastProtoSyncReport,
    sessionCost: getSessionCost(),
  });
});

// ─── API: chat (LLM-powered intent parsing) ─────────────────

app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const skillTradePath = process.env.SKILL_TRADE_PATH;
  if (!skillTradePath) {
    res.status(500).json({ error: "SKILL_TRADE_PATH not configured" });
    return;
  }

  try {
    await ensureProtoSync();
    const result = await chatTurn(message, chatHistory, skillTradePath);
    // "clarification" is treated as a message from the API's perspective
    let responseType: "message" | "pipeline" = result.type === "pipeline" ? "pipeline" : "message";
    let responseText = result.text;
    let responseIntent = result.intent;

    if (result.type === "pipeline" && result.intent) {
      if (pipelineRunning) {
        responseType = "message";
        responseText =
          "Pipeline is already running. Please wait for it to finish.";
        responseIntent = undefined;
      } else {
        pipelineRunning = true;
        activeAbortController = new AbortController();
        runPipeline(result.intent, activeAbortController.signal)
          .catch((err) => {
            emitPipelineEvent("error", "unknown", {
              message: (err as Error).message,
            });
          })
          .finally(() => {
            pipelineRunning = false;
            activeAbortController = null;
          });
      }
    }

    // Keep only plain-text chat context between turns.
    chatHistory.push({ role: "user", content: message });
    chatHistory.push({ role: "assistant", content: responseText });

    if (chatHistory.length > MAX_HISTORY) {
      chatHistory = chatHistory.slice(-MAX_HISTORY);
    }

    logChat({ role: "user", text: message });
    logChat({
      role: "agent",
      type: responseType,
      text: responseText,
      thinking: result.thinking,
      intent: responseIntent,
    });

    res.json({
      type: responseType,
      text: responseText,
      thinking: result.thinking,
      intent: responseIntent,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/chat/clear", (_req, res) => {
  chatHistory = [];
  resetSessionCost();
  res.json({ cleared: true, sessionCost: getSessionCost() });
});

app.post("/api/session/reset", (_req, res) => {
  res.json(resetSessionCost());
});

app.post("/api/proto/update-tests", async (_req, res) => {
  if (pipelineRunning) {
    res.status(409).json({ error: "Pipeline already running" });
    return;
  }

  let report: ProtoChangeReport | null = null;
  try {
    report = await ensureProtoSync(true);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
    return;
  }

  const intents = buildProtoUpdateIntents(report);
  if (!intents.length) {
    res.json({
      started: false,
      message: "No changed proto methods detected. Nothing to update.",
      protoSync: report,
    });
    return;
  }

  pipelineRunning = true;
  runProtoUpdateBatch(report)
    .catch((err) => {
      emitPipelineEvent("error", "proto-update", {
        message: (err as Error).message,
      });
    })
    .finally(() => {
      pipelineRunning = false;
    });

  res.json({
    started: true,
    services: intents.map((intent) => intent.service),
    methodsByService: intents.map((intent) => ({
      service: intent.service,
      methods: intent.methods ?? [],
    })),
    protoSync: report,
  });
});

app.post("/api/proto/update-snapshot", async (_req, res) => {
  const skillTradePath = process.env.SKILL_TRADE_PATH;
  if (!skillTradePath) {
    res.status(500).json({ error: "SKILL_TRADE_PATH not configured" });
    return;
  }

  try {
    const protoDir = join(skillTradePath, "lib/clients/gRPC/proto");
    const snapshots = buildProtoSnapshots(protoDir);

    saveProtoSnapshots(snapshots);

    const baselineReport: ProtoChangeReport = {
      syncedAt: new Date().toISOString(),
      hasChanges: false,
      changedFiles: [],
      changedServices: [],
    };

    saveProtoChangeReport(baselineReport);
    lastProtoSyncReport = baselineReport;

    res.json({
      updated: true,
      protoSync: baselineReport,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ─── API: direct run (backward compat for CLI/API) ──────────

app.post("/api/run", async (req, res) => {
  if (pipelineRunning) {
    res.status(409).json({ error: "Pipeline already running" });
    return;
  }

  const { action = null, service, methods } = req.body;
  if (!service) {
    res.status(400).json({ error: "service is required" });
    return;
  }

  const intent: ParsedIntent = {
    action,
    service,
    methods: methods?.length ? methods : undefined,
    raw: `${action} ${service}`,
  };

  try {
    await ensureProtoSync(true);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
    return;
  }

  pipelineRunning = true;
  activeAbortController = new AbortController();
  runPipeline(intent, activeAbortController.signal)
    .catch((err) => {
      emitPipelineEvent("error", "unknown", {
        message: (err as Error).message,
      });
    })
    .finally(() => {
      pipelineRunning = false;
      activeAbortController = null;
    });

  res.json({ started: true, action, service });
});

// ─── API: abort running pipeline ─────────────────────────────

app.post("/api/abort", (_req, res) => {
  if (!pipelineRunning || !activeAbortController) {
    res.status(409).json({ error: "No pipeline running" });
    return;
  }
  activeAbortController.abort();
  res.json({ aborted: true });
});

// ─── SSE: real-time event stream ─────────────────────────────

app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  const handler = (event: PipelineEvent) => {
    if (event.type === "complete" && event.data) {
      (event.data as Record<string, unknown>).sessionCost = getSessionCost();
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  pipelineEvents.on("pipeline", handler);

  const keepalive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 15_000);

  req.on("close", () => {
    pipelineEvents.off("pipeline", handler);
    clearInterval(keepalive);
  });
});

// ─── Start ───────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000");
app.listen(PORT, () => {
  console.log(`\n  ⬡ AQA Agent UI: http://localhost:${PORT}\n`);
});

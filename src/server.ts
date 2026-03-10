import "dotenv/config";
import express from "express";
import { join, basename } from "path";
import { existsSync, appendFileSync, mkdirSync } from "fs";
import { globSync } from "glob";
import Anthropic from "@anthropic-ai/sdk";
import { pipelineEvents, emitPipelineEvent } from "./events.js";
import type { PipelineEvent } from "./events.js";
import { loadRunHistory, loadRunLedger } from "./memory/run-history.js";
import { loadProjectIndex } from "./memory/project-index.js";
import { loadProtoChangeReport } from "./memory/proto-changes.js";
import { runPipeline } from "./engine/orchestrator.js";
import { chatTurn } from "./chat-agent.js";
import { syncProtos } from "./scripts/sync-protos.js";
import type { ParsedIntent, ProtoChangeReport } from "./types.js";

const CHAT_LOG_PATH = join(import.meta.dirname, "../state/chat-log.jsonl");

function logChat(entry: Record<string, unknown>): void {
  try {
    mkdirSync(join(import.meta.dirname, "../state"), { recursive: true });
    appendFileSync(CHAT_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

const app = express();
app.use(express.json());
app.use(express.static(join(import.meta.dirname, "../web")));

const serverBootId = `${Date.now()}`;
let pipelineRunning = false;
let chatHistory: Anthropic.MessageParam[] = [];
const MAX_HISTORY = 30;
const SYNC_CACHE_MS = 60_000;
let lastProtoSyncAt = 0;
let activeProtoSync: Promise<void> | null = null;
let lastProtoSyncReport: ProtoChangeReport | null = loadProtoChangeReport();

async function ensureProtoSync(force = false): Promise<ProtoChangeReport | null> {
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
  res.json({ services, index, protoSync: lastProtoSyncReport });
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
  res.json({ running: pipelineRunning, bootId: serverBootId, protoSync: lastProtoSyncReport });
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
    let responseType: "message" | "pipeline" = result.type;
    let responseText = result.text;
    let responseIntent = result.intent;

    if (result.type === "pipeline" && result.intent) {
      if (pipelineRunning) {
        responseType = "message";
        responseText = "Pipeline is already running. Please wait for it to finish.";
        responseIntent = undefined;
      } else {
        pipelineRunning = true;
        runPipeline(result.intent)
          .catch((err) => {
            emitPipelineEvent("error", "unknown", {
              message: (err as Error).message,
            });
          })
          .finally(() => {
            pipelineRunning = false;
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
  res.json({ cleared: true });
});

// ─── API: direct run (backward compat for CLI/API) ──────────

app.post("/api/run", async (req, res) => {
  if (pipelineRunning) {
    res.status(409).json({ error: "Pipeline already running" });
    return;
  }

  const { action = "cover", service, methods } = req.body;
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
  runPipeline(intent)
    .catch((err) => {
      emitPipelineEvent("error", "unknown", { message: (err as Error).message });
    })
    .finally(() => {
      pipelineRunning = false;
    });

  res.json({ started: true, action, service });
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

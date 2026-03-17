// ============================================================
// Understand — single setup phase
// Absorbs: entity resolution, proto parse, coverage analysis,
//          testomatio sync, proto change detection.
// LLM (Haiku): only as fallback when script can't resolve entity.
// ============================================================

import { existsSync, readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { globSync } from "glob";
import Anthropic from "@anthropic-ai/sdk";
import type {
  ParsedIntent,
  ProtoChangeReport,
  ProtoChangeServiceReport,
  UnderstandContext,
} from "../types.js";
import { getServiceCoverage, type ServiceCoverage } from "../testomatio/client.js";
import { loadProtoChangeReport } from "../memory/proto-changes.js";
import { resolveService } from "../steps/resolve-service.js";
import { parseContract } from "../steps/parse-contract.js";
import { analyzeCoverage } from "../steps/analyze-coverage.js";

// ─── Re-exports ───────────────────────────────────────────────

export type { UnderstandContext };

// ─── Service Map ─────────────────────────────────────────────

export interface ServiceMapEntry {
  proto: string;
  testDir: string;
  testomatio: string | null;
}

export interface ServiceMap {
  [canonicalName: string]: ServiceMapEntry;
}

const SERVICE_MAP_PATH = resolve(import.meta.dirname, "../../config/service-map.json");

function loadServiceMap(): ServiceMap {
  if (!existsSync(SERVICE_MAP_PATH)) {
    throw new Error(`service-map.json not found at ${SERVICE_MAP_PATH}`);
  }
  return JSON.parse(readFileSync(SERVICE_MAP_PATH, "utf-8")) as ServiceMap;
}

/**
 * Normalize service name: strip common suffixes and separators.
 * "PartnersGrpcService" → "partners"
 * "Partners-service"   → "partners"
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/(grpcservice|grpc|service|proto)/g, "")
    .replace(/[-_\s]/g, "");
}

function resolveCanonical(
  serviceName: string,
  map: ServiceMap,
): { canonical: string; entry: ServiceMapEntry } | null {
  if (map[serviceName]) {
    return { canonical: serviceName, entry: map[serviceName] };
  }
  const normalizedInput = normalize(serviceName);
  for (const [canonical, entry] of Object.entries(map)) {
    if (normalize(canonical) === normalizedInput) {
      return { canonical, entry };
    }
  }
  return null;
}

function countLocalTestFiles(testDir: string, skillTradePath: string): number {
  const fullPath = join(skillTradePath, testDir);
  if (!existsSync(fullPath)) return 0;
  return readdirSync(fullPath).filter((f: string) => f.endsWith(".test.ts")).length;
}

// ─── Haiku fallback: resolve ambiguous service name ──────────
// Called only when script normalization fails to find a match.
// Haiku sees all proto files + test dirs and picks the best canonical name.

async function resolveCanonicalWithHaiku(
  serviceName: string,
  map: ServiceMap,
  skillTradePath: string,
): Promise<{ canonical: string; entry: ServiceMapEntry } | null> {
  const protoDir = join(skillTradePath, "lib/clients/gRPC/proto");
  const testDir = join(skillTradePath, "tests/grpc");

  const protos = existsSync(protoDir)
    ? globSync("*.proto", { cwd: protoDir })
    : [];
  const testDirs = existsSync(testDir)
    ? globSync("*/", { cwd: testDir }).map((d) => d.replace(/\/$/, ""))
    : [];
  const canonicals = Object.keys(map);

  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 100,
    system: [
      "You are a service name resolver for a gRPC test automation system.",
      "Given a service name from user input, find the best matching canonical name from the list.",
      "Reply with ONLY the matching canonical name, or null if no confident match.",
    ].join("\n"),
    messages: [{
      role: "user",
      content: [
        `User input: "${serviceName}"`,
        `Canonical names: ${canonicals.join(", ")}`,
        `Proto files: ${protos.join(", ")}`,
        `Test directories: ${testDirs.join(", ")}`,
        "Which canonical name best matches the user input? Reply with just the name or null.",
      ].join("\n"),
    }],
  });

  const text = response.content.find((b) => b.type === "text")?.text?.trim() ?? "";
  if (!text || text === "null") return null;

  const entry = map[text];
  if (!entry) return null;

  return { canonical: text, entry };
}

// ─── Main ────────────────────────────────────────────────────

export async function understand(
  intent: ParsedIntent,
  skillTradePath: string,
): Promise<UnderstandContext> {
  // 1. Entity resolution: script → Haiku → error
  const map = loadServiceMap();
  let resolved = resolveCanonical(intent.service, map);

  if (!resolved) {
    // Haiku fallback: try semantic matching
    resolved = await resolveCanonicalWithHaiku(intent.service, map, skillTradePath);
  }

  if (!resolved) {
    throw new Error(
      `Service "${intent.service}" not found. ` +
      `Available: ${Object.keys(map).join(", ")}`,
    );
  }

  const { canonical, entry } = resolved;
  const resolvedIntent = { ...intent, service: canonical };

  // 2. Proto changes
  const changeReport: ProtoChangeReport | null = loadProtoChangeReport();
  const protoChanges =
    changeReport?.changedServices?.find(
      (s) => normalize(s.service) === normalize(canonical),
    ) ?? null;

  const hasChanges =
    protoChanges &&
    (protoChanges.addedMethods.length > 0 || protoChanges.changedMethods.length > 0);
  const scope: UnderstandContext["scope"] = hasChanges ? "changed_only" : "all_methods";

  // 3. Testomatio (best-effort)
  let testomatioCoverage: ServiceCoverage | null = null;
  try {
    testomatioCoverage = await getServiceCoverage(entry.testomatio);
  } catch {
    testomatioCoverage = null;
  }

  // 4. Local test files count
  const localTestFilesCount = countLocalTestFiles(entry.testDir, skillTradePath);

  // 5. Resolve infrastructure (finds proto path, wrapper, types, etc.)
  const infrastructure = resolveService(canonical, skillTradePath);

  if (infrastructure.missingComponents.includes("proto")) {
    throw new Error(`Proto file not found for service "${canonical}"`);
  }

  // 6. Parse proto contract
  const contract = parseContract(infrastructure.protoPath, canonical);

  // 7. Analyze coverage
  const coverage = analyzeCoverage(contract, skillTradePath);

  return {
    intent: resolvedIntent,
    canonicalService: canonical,
    protoFile: entry.proto,
    testDir: entry.testDir,
    testomatioCoverage,
    protoChanges,
    scope,
    localTestFilesCount,
    infrastructure,
    contract,
    coverage,
  };
}

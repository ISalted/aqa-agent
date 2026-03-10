import "dotenv/config";
import { execSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  cpSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "fs";
import { join, basename } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { parseContract } from "../steps/parse-contract.js";
import {
  loadProtoSnapshots,
  saveProtoSnapshots,
  saveProtoChangeReport,
} from "../memory/proto-changes.js";
import type {
  ProtoChangeReport,
  ProtoChangeServiceReport,
  ProtoMessageSnapshot,
  ProtoMethodSnapshot,
  ProtoServiceSnapshot,
  ProtoSnapshotsStore,
} from "../types.js";

const PROTO_REPO = process.env.PROTO_CONTRACTS_REPO;
const SKILL_TRADE_PATH = process.env.SKILL_TRADE_PATH;
const TMP_DIR = "/tmp/aqa-proto-sync";
const PROTO_GENERATE_COMMAND = "npm run proto";

export async function syncProtos(): Promise<ProtoChangeReport> {
  if (!PROTO_REPO || !SKILL_TRADE_PATH) {
    throw new Error("Missing PROTO_CONTRACTS_REPO or SKILL_TRADE_PATH in .env");
  }

  const targetDir = join(SKILL_TRADE_PATH, "lib/clients/gRPC/proto");
  const previousSnapshots = loadProtoSnapshots();

  console.log("Syncing proto contracts...");
  console.log(`  Source: ${PROTO_REPO}`);
  console.log(`  Target: ${targetDir}`);

  if (existsSync(TMP_DIR)) {
    console.log("  Pulling latest...");
    execSync(`git -C ${TMP_DIR} pull --ff-only`, {
      stdio: "inherit",
      timeout: 30_000,
    });
  } else {
    console.log("  Cloning...");
    execSync(`git clone --depth 1 ${PROTO_REPO} ${TMP_DIR}`, {
      stdio: "inherit",
      timeout: 60_000,
    });
  }

  const protoFiles = findProtoFiles(TMP_DIR);
  console.log(`  Found ${protoFiles.length} proto files`);

  mkdirSync(targetDir, { recursive: true });
  removeDeletedProtoFiles(targetDir, protoFiles);

  let copied = 0;
  for (const protoFile of protoFiles) {
    const targetPath = join(targetDir, basename(protoFile));
    cpSync(protoFile, targetPath);
    console.log(`  ✓ ${basename(protoFile)}`);
    copied++;
  }

  console.log(`\nDone: ${copied} proto files synced.`);
  console.log("Regenerating generated gRPC/types in skill-trade...");
  execSync(PROTO_GENERATE_COMMAND, {
    cwd: SKILL_TRADE_PATH,
    stdio: "inherit",
    timeout: 120_000,
  });
  console.log("Generated types sync complete.");

  const currentSnapshots = buildProtoSnapshots(targetDir);
  const report = diffProtoSnapshots(previousSnapshots, currentSnapshots);
  saveProtoSnapshots(currentSnapshots);
  saveProtoChangeReport(report);
  logChangeSummary(report);
  return report;
}

function removeDeletedProtoFiles(targetDir: string, sourceProtoFiles: string[]): void {
  const sourceNames = new Set(sourceProtoFiles.map((file) => basename(file)));
  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".proto")) continue;
    if (sourceNames.has(entry.name)) continue;

    rmSync(join(targetDir, entry.name));
    console.log(`  - removed stale ${entry.name}`);
  }
}

function buildProtoSnapshots(protoDir: string): ProtoSnapshotsStore {
  const services: Record<string, ProtoServiceSnapshot> = {};
  const capturedAt = new Date().toISOString();

  for (const protoPath of findProtoFiles(protoDir)) {
    const serviceName = basename(protoPath, ".proto");
    const contract = parseContract(protoPath, serviceName);
    const methods: ProtoMethodSnapshot[] = contract.methods.map((method) => ({
      name: method.name,
      inputType: method.inputType,
      outputType: method.outputType,
      signature: `${method.name}:${method.inputType}->${method.outputType}`,
    }));
    const messages: ProtoMessageSnapshot[] = contract.messages.map((message) => ({
      name: message.name,
      signature: JSON.stringify({
        fields: message.fields.map((field) => ({
          name: field.name,
          type: field.type,
          number: field.number,
          required: field.required,
          repeated: field.repeated,
          optional: field.optional,
          mapKeyType: field.mapKeyType ?? null,
          mapValueType: field.mapValueType ?? null,
        })),
        oneofs: message.oneofs,
      }),
    }));

    services[serviceName] = {
      service: serviceName,
      protoFile: basename(protoPath),
      fileHash: hashFile(protoPath),
      methods,
      messages,
      capturedAt,
    };
  }

  return {
    services,
    lastUpdated: capturedAt,
  };
}

function diffProtoSnapshots(
  previous: ProtoSnapshotsStore,
  current: ProtoSnapshotsStore,
): ProtoChangeReport {
  const syncedAt = new Date().toISOString();
  if (Object.keys(previous.services).length === 0) {
    return {
      syncedAt,
      hasChanges: false,
      changedFiles: [],
      changedServices: [],
    };
  }

  const changedServices: ProtoChangeServiceReport[] = [];

  const serviceNames = new Set([
    ...Object.keys(previous.services),
    ...Object.keys(current.services),
  ]);

  for (const serviceName of [...serviceNames].sort()) {
    const before = previous.services[serviceName];
    const after = current.services[serviceName];

    if (!before && after) {
      changedServices.push({
        service: serviceName,
        protoFile: after.protoFile,
        status: "added",
        addedMethods: after.methods.map((method) => method.name),
        removedMethods: [],
        changedMethods: [],
        changedMessages: after.messages.map((message) => message.name),
      });
      continue;
    }

    if (before && !after) {
      changedServices.push({
        service: serviceName,
        protoFile: before.protoFile,
        status: "removed",
        addedMethods: [],
        removedMethods: before.methods.map((method) => method.name),
        changedMethods: [],
        changedMessages: before.messages.map((message) => message.name),
      });
      continue;
    }

    if (!before || !after || before.fileHash === after.fileHash) {
      continue;
    }

    const beforeMethods = new Map(before.methods.map((method) => [method.name, method]));
    const afterMethods = new Map(after.methods.map((method) => [method.name, method]));
    const beforeMessages = new Map(before.messages.map((message) => [message.name, message]));
    const afterMessages = new Map(after.messages.map((message) => [message.name, message]));

    const addedMethods = after.methods
      .filter((method) => !beforeMethods.has(method.name))
      .map((method) => method.name);
    const removedMethods = before.methods
      .filter((method) => !afterMethods.has(method.name))
      .map((method) => method.name);
    const changedMethods = new Set(
      after.methods
        .filter((method) => {
          const previousMethod = beforeMethods.get(method.name);
          return previousMethod && previousMethod.signature !== method.signature;
        })
        .map((method) => method.name),
    );

    const changedMessages = new Set<string>();
    for (const message of after.messages) {
      const previousMessage = beforeMessages.get(message.name);
      if (!previousMessage || previousMessage.signature !== message.signature) {
        changedMessages.add(message.name);
      }
    }
    for (const message of before.messages) {
      if (!afterMessages.has(message.name)) {
        changedMessages.add(message.name);
      }
    }

    for (const method of after.methods) {
      if (
        changedMessages.has(method.inputType) ||
        changedMessages.has(method.outputType)
      ) {
        changedMethods.add(method.name);
      }
    }

    changedServices.push({
      service: serviceName,
      protoFile: after.protoFile,
      status: "updated",
      addedMethods: addedMethods.sort(),
      removedMethods: removedMethods.sort(),
      changedMethods: [...changedMethods].sort(),
      changedMessages: [...changedMessages].sort(),
    });
  }

  return {
    syncedAt,
    hasChanges: changedServices.length > 0,
    changedFiles: changedServices.map((service) => service.protoFile),
    changedServices,
  };
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function logChangeSummary(report: ProtoChangeReport): void {
  if (!report.hasChanges) {
    console.log("Proto change report: no contract changes detected.");
    return;
  }

  console.log(
    `Proto change report: ${report.changedFiles.length} file(s) changed across ${report.changedServices.length} service(s).`,
  );
  for (const change of report.changedServices.slice(0, 8)) {
    const details = [
      change.addedMethods.length
        ? `+${change.addedMethods.length} methods`
        : null,
      change.removedMethods.length
        ? `-${change.removedMethods.length} methods`
        : null,
      change.changedMethods.length
        ? `~${change.changedMethods.length} methods`
        : null,
    ].filter(Boolean);
    console.log(`  • ${change.service}: ${details.join(", ") || change.status}`);
  }
}

function findProtoFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        walk(fullPath);
      } else if (entry.name.endsWith(".proto")) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  syncProtos().catch((e) => {
    console.error("Sync failed:", e.message);
    process.exit(1);
  });
}

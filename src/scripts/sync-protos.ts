import "dotenv/config";
import { execSync } from "child_process";
import { existsSync, mkdirSync, cpSync, readdirSync } from "fs";
import { join, basename } from "path";

const PROTO_REPO = process.env.PROTO_CONTRACTS_REPO;
const SKILL_TRADE_PATH = process.env.SKILL_TRADE_PATH;
const TMP_DIR = "/tmp/aqa-proto-sync";

async function syncProtos(): Promise<void> {
  if (!PROTO_REPO || !SKILL_TRADE_PATH) {
    console.error("Missing PROTO_CONTRACTS_REPO or SKILL_TRADE_PATH in .env");
    process.exit(1);
  }

  const targetDir = join(SKILL_TRADE_PATH, "lib/clients/gRPC/proto");

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

  let copied = 0;
  for (const protoFile of protoFiles) {
    const targetPath = join(targetDir, basename(protoFile));
    cpSync(protoFile, targetPath);
    console.log(`  ✓ ${basename(protoFile)}`);
    copied++;
  }

  console.log(`\nDone: ${copied} proto files synced.`);
  console.log("Run 'npm run proto' in skill-trade to regenerate types.");
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

syncProtos().catch((e) => {
  console.error("Sync failed:", e.message);
  process.exit(1);
});

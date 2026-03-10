import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from "fs";
import { execSync } from "child_process";
import { globSync } from "glob";
import { join, basename } from "path";
import { agenticLoop } from "../engine/agentic-loop.js";
import { getModelForAgent } from "../engine/model-router.js";
import type {
  ServiceInfrastructure,
  InfraComponent,
  CostAccumulator,
} from "../types.js";
import { TOOLS_FOR_AGENT } from "../tools/index.js";

export interface ResolveOptions {
  readOnly?: boolean;
}

/**
 * Hybrid step: resolves service infrastructure.
 * In readOnly mode: only scans, never creates/syncs anything.
 * In mutating mode: syncs proto, scaffolds wrappers, creates test dirs.
 */
export async function resolveService(
  serviceName: string,
  skillTradePath: string,
  costAccumulator: CostAccumulator,
  options: ResolveOptions = {},
): Promise<ServiceInfrastructure> {
  const { readOnly = false } = options;
  const dirs = resolveDirs(skillTradePath);

  let snapshot = scanInfrastructure(dirs, serviceName, skillTradePath);

  if (readOnly) {
    const testDir = findTestDir(dirs.testDir, serviceName);
    return {
      ...snapshot,
      testDir: testDir ?? join(dirs.testDir, serviceName.charAt(0).toLowerCase() + serviceName.slice(1)),
    };
  }

  if (snapshot.missingComponents.includes("proto")) {
    const synced = await syncProtoFromRepo(serviceName, dirs.protoDir);
    if (synced) {
      snapshot = scanInfrastructure(dirs, serviceName, skillTradePath);
    }
  }

  if (
    snapshot.missingComponents.includes("wrapper") ||
    snapshot.missingComponents.includes("types") ||
    snapshot.missingComponents.includes("fixture")
  ) {
    await scaffoldMissingInfra(
      serviceName,
      snapshot.missingComponents,
      skillTradePath,
      costAccumulator,
    );
    snapshot = scanInfrastructure(dirs, serviceName, skillTradePath);
  }

  const serviceTestDir = findOrCreateTestDir(dirs.testDir, serviceName);

  return { ...snapshot, testDir: serviceTestDir };
}

interface InfraDirs {
  protoDir: string;
  servicesDir: string;
  generatedDir: string;
  typesDir: string;
  testDir: string;
}

function resolveDirs(skillTradePath: string): InfraDirs {
  return {
    protoDir: join(skillTradePath, "lib/clients/gRPC/proto"),
    servicesDir: join(skillTradePath, "lib/clients/gRPC/services"),
    generatedDir: join(skillTradePath, "lib/clients/gRPC/generated"),
    typesDir: join(skillTradePath, "lib/clients/gRPC"),
    testDir: join(skillTradePath, "tests/grpc"),
  };
}

function scanInfrastructure(
  dirs: InfraDirs,
  serviceName: string,
  skillTradePath: string,
): Omit<ServiceInfrastructure, "testDir"> & { testDir: string } {
  const protoPath = findProtoFile(dirs.protoDir, serviceName);
  const wrapperPath = findFile(dirs.servicesDir, serviceName, "Service.ts");
  const typesPath = findFile(dirs.typesDir, serviceName, ".ts");
  const generatedPath = findGeneratedDir(dirs.generatedDir, serviceName);
  const fixtureConnected = checkFixtureConnection(skillTradePath, serviceName);

  const missingComponents: InfraComponent[] = [];
  if (!protoPath) missingComponents.push("proto");
  if (!generatedPath) missingComponents.push("generated");
  if (!wrapperPath) missingComponents.push("wrapper");
  if (!typesPath) missingComponents.push("types");
  if (!fixtureConnected) missingComponents.push("fixture");

  return {
    service: serviceName,
    protoPath: protoPath ?? join(dirs.protoDir, `${serviceName}.proto`),
    wrapperPath,
    typesPath,
    generatedPath,
    fixtureConnected,
    testDir: findTestDir(dirs.testDir, serviceName) ?? "",
    missingComponents,
  };
}

// ─── Proto Sync ─────────────────────────────────────────────

async function syncProtoFromRepo(
  serviceName: string,
  protoDir: string,
): Promise<boolean> {
  const protoRepo = process.env.PROTO_CONTRACTS_REPO;
  if (!protoRepo) return false;

  const tmpDir = join("/tmp", "aqa-proto-sync");
  try {
    if (existsSync(tmpDir)) {
      execSync(`git -C ${tmpDir} pull --ff-only`, { timeout: 30_000 });
    } else {
      execSync(`git clone --depth 1 ${protoRepo} ${tmpDir}`, { timeout: 60_000 });
    }

    const protoFiles = globSync("**/*.proto", { cwd: tmpDir, absolute: true });
    const matchingProto = protoFiles.find((f) => {
      const name = basename(f, ".proto").toLowerCase();
      return (
        name === serviceName.toLowerCase() ||
        name.includes(serviceName.toLowerCase())
      );
    });

    if (matchingProto) {
      mkdirSync(protoDir, { recursive: true });
      const target = join(protoDir, basename(matchingProto));
      cpSync(matchingProto, target);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

// ─── Scaffold Missing Infrastructure ────────────────────────

async function scaffoldMissingInfra(
  serviceName: string,
  missing: InfraComponent[],
  skillTradePath: string,
  costAccumulator: CostAccumulator,
): Promise<void> {
  const model = getModelForAgent("resolver");

  const existingWrapperExample = findExampleWrapper(skillTradePath);
  const existingFixtureFile = readFileSafe(join(skillTradePath, "lib/fixtures.ts"));

  const userMessage = `Service "${serviceName}" is missing these infrastructure components: ${missing.join(", ")}.

Working directory: ${skillTradePath}

${existingWrapperExample ? `## Example existing service wrapper:\n\`\`\`typescript\n${existingWrapperExample}\n\`\`\`` : ""}

${existingFixtureFile ? `## Current fixtures file:\n\`\`\`typescript\n${existingFixtureFile}\n\`\`\`` : ""}

Tasks:
${missing.includes("generated") ? "1. Run 'npm run proto' to generate gRPC types (use run_command tool)" : ""}
${missing.includes("wrapper") ? "2. Create a service wrapper following the existing pattern (use write_file tool)" : ""}
${missing.includes("types") ? "3. Create TypeScript interface definitions if needed (use write_file tool)" : ""}
${missing.includes("fixture") ? "4. Add the service to fixtures.ts (use read_file to check current state, then write_file)" : ""}

Use tools to inspect existing files and create what's needed. Follow existing patterns exactly.`;

  await agenticLoop({
    model,
    systemPrompt: `You are an infrastructure scaffolding agent for a Playwright + gRPC project.
Your job: create missing service infrastructure (wrappers, types, fixtures) following existing project patterns exactly.
You have tools: read_file, write_file, list_files, grep_files, run_command.
IMPORTANT: Always read existing examples before creating new files. Match the exact style and structure.`,
    userMessage,
    tools: TOOLS_FOR_AGENT.resolver,
    effort: "high",
    maxTurns: 20,
    costAccumulator,
    agentName: "resolver",
    stepName: `resolve:${serviceName}`,
  });
}

// ─── Helpers ────────────────────────────────────────────────

function findProtoFile(protoDir: string, service: string): string | null {
  if (!existsSync(protoDir)) return null;
  const protos = globSync("*.proto", { cwd: protoDir, absolute: true });
  return (
    protos.find((f) => {
      const name = basename(f, ".proto").toLowerCase();
      return name === service.toLowerCase() || name.includes(service.toLowerCase());
    }) ?? null
  );
}

function findFile(dir: string, service: string, suffix: string): string | null {
  if (!existsSync(dir)) return null;
  const files = globSync(`*${suffix}`, { cwd: dir, absolute: true });
  return (
    files.find((f) => basename(f).toLowerCase().includes(service.toLowerCase())) ??
    null
  );
}

function findGeneratedDir(generatedDir: string, service: string): string | null {
  if (!existsSync(generatedDir)) return null;
  const dirs = globSync("*/", { cwd: generatedDir });
  const match = dirs.find((d) => d.toLowerCase().includes(service.toLowerCase()));
  return match ? join(generatedDir, match) : null;
}

function checkFixtureConnection(skillTradePath: string, service: string): boolean {
  const fixturesPath = join(skillTradePath, "lib/fixtures.ts");
  if (!existsSync(fixturesPath)) return false;
  const content = readFileSync(fixturesPath, "utf-8");
  return content.toLowerCase().includes(service.toLowerCase());
}

function findTestDir(testRoot: string, service: string): string | null {
  if (!existsSync(testRoot)) return null;
  const candidates = globSync("*/", { cwd: testRoot });
  const match = candidates.find((d) =>
    d.replace(/\/$/, "").toLowerCase().includes(service.toLowerCase()),
  );
  return match ? join(testRoot, match) : null;
}

function findOrCreateTestDir(testRoot: string, service: string): string {
  const existing = findTestDir(testRoot, service);
  if (existing) return existing;

  const dirName = service.charAt(0).toLowerCase() + service.slice(1);
  const newDir = join(testRoot, dirName);
  mkdirSync(newDir, { recursive: true });
  return newDir;
}

function findExampleWrapper(skillTradePath: string): string | null {
  const servicesDir = join(skillTradePath, "lib/clients/gRPC/services");
  if (!existsSync(servicesDir)) return null;
  const wrappers = globSync("*.ts", { cwd: servicesDir, absolute: true });
  if (wrappers.length === 0) return null;
  return readFileSafe(wrappers[0]);
}

function readFileSafe(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

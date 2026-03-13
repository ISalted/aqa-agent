import { existsSync, readFileSync } from "fs";
import { globSync } from "glob";
import { join, basename } from "path";
import type { ServiceInfrastructure, InfraComponent } from "../types.js";

/**
 * Scans service infrastructure — read-only, no scaffolding.
 * Missing components are reported in missingComponents[] for the caller to handle.
 */
export function resolveService(
  serviceName: string,
  skillTradePath: string,
): ServiceInfrastructure {
  const dirs = resolveDirs(skillTradePath);
  const snapshot = scanInfrastructure(dirs, serviceName, skillTradePath);
  const testDir =
    findTestDir(dirs.testDir, serviceName) ??
    join(dirs.testDir, serviceNameToTestDirName(serviceName));

  return { ...snapshot, testDir };
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

/** PascalCase → kebab-case (e.g. MissionEngine → mission-engine). */
export function serviceNameToTestDirName(service: string): string {
  const withHyphens = service.replace(/([A-Z])/g, "-$1").toLowerCase();
  return withHyphens.startsWith("-") ? withHyphens.slice(1) : withHyphens;
}

function findTestDir(testRoot: string, service: string): string | null {
  if (!existsSync(testRoot)) return null;
  const expectedDirName = serviceNameToTestDirName(service);
  const candidatePath = join(testRoot, expectedDirName);
  if (existsSync(candidatePath)) return candidatePath;
  return null;
}

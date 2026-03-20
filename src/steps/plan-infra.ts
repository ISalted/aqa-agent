import { existsSync, readFileSync } from "fs";
import { globSync } from "glob";
import { join, basename } from "path";
import type { NormalizedContract, ServiceInfrastructure, ImplementationContext, RelevantSetting } from "../types.js";

export function analyzeImplementationContext(
  contract: NormalizedContract,
  infrastructure: ServiceInfrastructure,
  skillTradePath: string,
  method: string,
): ImplementationContext {
  const methodDef = contract.methods.find(m => m.name === method) ?? null;

  // 1. Check wrapper
  const serviceWrapperExists = !!infrastructure.wrapperPath && existsSync(infrastructure.wrapperPath);
  const typesExist = !!infrastructure.typesPath && existsSync(infrastructure.typesPath);

  // 2. Read fixtures.ts to detect available fixtures
  const availableFixtures = detectAvailableFixtures(skillTradePath);
  const fixtureConnected = availableFixtures.includes("gRPC");

  // 3. Find relevant noSQL tables
  const relevantSettings = findRelevantSettings(contract, skillTradePath);

  // 4. Missing components
  const missingComponents: string[] = [];
  if (!serviceWrapperExists) missingComponents.push("service-wrapper");
  if (!typesExist) missingComponents.push("types");
  if (!fixtureConnected) missingComponents.push("fixture");

  const testDir = infrastructure.testDir;
  const fileName = `${method.charAt(0).toLowerCase()}${method.slice(1)}.test.ts`;
  const testFile = join(testDir, fileName);

  return {
    serviceWrapperExists,
    serviceWrapperPath: infrastructure.wrapperPath,
    typesExist,
    fixtureConnected,
    availableFixtures,
    missingComponents,
    relevantSettings,
    methodSignature: methodDef ? {
      name: methodDef.name,
      inputType: methodDef.inputType,
      outputType: methodDef.outputType,
    } : null,
    testFile,
  };
}

function detectAvailableFixtures(skillTradePath: string): string[] {
  const fixturesPath = join(skillTradePath, "lib/fixtures.ts");
  if (!existsSync(fixturesPath)) return [];

  const content = readFileSync(fixturesPath, "utf-8");
  const fixtures: string[] = [];

  // Detect fixture keys from the extend<{...}> block
  if (content.includes("gRPC:") || content.includes("gRPC ")) fixtures.push("gRPC");
  if (content.includes("noSQL:") || content.includes("noSQL ")) fixtures.push("noSQL");
  if (content.includes("db:") || content.includes("db ")) fixtures.push("db");
  if (content.includes("helpers:") || content.includes("helpers ")) fixtures.push("helpers");
  if (content.includes("gRPCUAT:") || content.includes("gRPCUAT ")) fixtures.push("gRPCUAT");

  return fixtures;
}

function findRelevantSettings(contract: NormalizedContract, skillTradePath: string): RelevantSetting[] {
  const tablesDir = join(skillTradePath, "lib/clients/noSQL/tables");
  if (!existsSync(tablesDir)) return [];

  const tableFiles = globSync("*.table.ts", { cwd: tablesDir, absolute: true });
  const serviceKeyword = extractServiceKeyword(contract.intentName ?? contract.service);

  const relevant: RelevantSetting[] = [];

  for (const tableFile of tableFiles) {
    const fileName = basename(tableFile, ".table.ts"); // e.g. "contest-settings"
    const tableName = toCamelCase(fileName); // e.g. "contestSettings"

    // Check if table is relevant to service (keyword match)
    const isRelevant = serviceKeyword.some(kw =>
      fileName.toLowerCase().includes(kw.toLowerCase())
    );

    if (isRelevant) {
      const content = readFileSync(tableFile, "utf-8");
      const description = extractTableDescription(content, tableName);
      relevant.push({
        tableName,
        tableFile,
        description,
        accessPattern: `noSQL.${tableName}.get()`,
      });
    }
  }

  return relevant;
}

function extractServiceKeyword(serviceName: string): string[] {
  // ContestEngine → ["Contest", "contest"]
  // MissionEngine → ["Mission", "mission"]
  const words = serviceName.match(/[A-Z][a-z]*/g) ?? [];
  const filtered = words.filter(w => !["Engine", "Service", "Grpc", "Client"].includes(w));
  return filtered.flatMap(w => [w, w.toLowerCase()]);
}

function toCamelCase(hyphenated: string): string {
  return hyphenated.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function extractTableDescription(content: string, tableName: string): string {
  // Extract class name and key method signatures
  const classMatch = content.match(/class\s+(\w+)/);
  const className = classMatch?.[1] ?? tableName;

  // Look for get/set method signatures
  const methods: string[] = [];
  const getMatch = content.match(/async\s+get\s*\([^)]*\)/);
  if (getMatch) methods.push("get()");
  const setMatch = content.match(/async\s+set\s*\([^)]*\)/);
  if (setMatch) methods.push("set()");

  // Extract table name from URL
  const urlMatch = content.match(/tableName=([a-z-]+)/i);
  const tblName = urlMatch?.[1] ?? tableName;

  return `Table: ${tblName} (class: ${className}, methods: ${methods.join(", ") || "get, set"})`;
}

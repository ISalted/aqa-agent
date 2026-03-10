import { readFileSync, existsSync } from "fs";
import { globSync } from "glob";
import { basename, join } from "path";
import type {
  CoverageReport,
  CoveredMethod,
  NormalizedContract,
  ExistingPatterns,
} from "../types.js";

/**
 * Deterministic coverage analyzer — zero LLM tokens.
 * Scans existing test files against the proto contract to find gaps.
 */
export function analyzeCoverage(
  contract: NormalizedContract,
  skillTradePath: string,
): CoverageReport {
  const testDir = join(skillTradePath, "tests/grpc");
  const serviceTestDir =
    findServiceTestDir(testDir, contract.intentName) ??
    findServiceTestDir(testDir, contract.service);

  const testFiles = serviceTestDir
    ? globSync("**/*.test.ts", { cwd: serviceTestDir, absolute: true })
    : [];

  const coveredMethods = matchTestsToMethods(
    contract.methods.map((m) => m.name),
    testFiles,
  );

  const uncoveredMethods = contract.methods
    .map((m) => m.name)
    .filter((name) => !coveredMethods.some((c) => c.method === name));

  const patterns = extractExistingPatterns(skillTradePath, testFiles);

  return {
    service: contract.service,
    totalMethods: contract.methods.length,
    coveredMethods,
    uncoveredMethods,
    coveragePercent:
      contract.methods.length > 0
        ? Math.round((coveredMethods.length / contract.methods.length) * 100)
        : 0,
    existingPatterns: patterns,
  };
}

function findServiceTestDir(testRoot: string, serviceName: string): string | null {
  const normalized = serviceName
    .replace(/Service$/, "")
    .replace(/Grpc$/, "");

  const candidates = [
    serviceName,
    normalized,
    camelToKebab(normalized),
    camelToSnake(normalized),
    normalized.toLowerCase(),
  ];

  for (const candidate of candidates) {
    const dir = join(testRoot, candidate);
    if (existsSync(dir)) return dir;
  }

  const allDirs = globSync("*/", { cwd: testRoot });
  for (const dir of allDirs) {
    const dirLower = dir.replace(/\/$/, "").toLowerCase();
    if (dirLower.includes(normalized.toLowerCase())) {
      return join(testRoot, dir);
    }
  }

  return null;
}

function matchTestsToMethods(
  methodNames: string[],
  testFiles: string[],
): CoveredMethod[] {
  const covered: CoveredMethod[] = [];

  for (const method of methodNames) {
    const matchingFile = testFiles.find((f) => {
      const fileName = basename(f, ".test.ts");
      return (
        fileName.toLowerCase() === method.toLowerCase() ||
        fileName.toLowerCase() === camelToKebab(method).toLowerCase()
      );
    });

    if (matchingFile) {
      const content = readFileSync(matchingFile, "utf-8");
      const testCount = (content.match(/test\s*\(/g) || []).length;
      covered.push({
        method,
        testFile: matchingFile,
        testCount,
      });
    }
  }

  return covered;
}

function extractExistingPatterns(
  skillTradePath: string,
  serviceTestFiles: string[],
): ExistingPatterns {
  let sampleFiles: string[];

  if (serviceTestFiles.length > 0) {
    sampleFiles = serviceTestFiles.slice(0, 3);
  } else {
    const allTestFiles = globSync("tests/grpc/**/*.test.ts", {
      cwd: skillTradePath,
      absolute: true,
    });
    sampleFiles = allTestFiles.slice(0, 3);
  }

  const imports = new Set<string>();
  const helpers = new Set<string>();
  let assertionStyle = "expect()";
  let dataGeneration = "unknown";

  for (const file of sampleFiles) {
    const content = readFileSync(file, "utf-8");

    const importMatches = content.match(/^import\s+.*?from\s+['"].*?['"]/gm);
    if (importMatches) importMatches.forEach((i) => imports.add(i));

    if (content.includes("generateProcessId")) helpers.add("generateProcessId");
    if (content.includes("generateUUID")) helpers.add("generateUUID");
    if (content.includes("ts-interface-checker")) helpers.add("ts-interface-checker");

    if (content.includes("expect(")) assertionStyle = "expect()";
    if (content.includes("generateProcessId") || content.includes("Date.now()")) {
      dataGeneration = "dynamic with helpers";
    }
  }

  return {
    imports: [...imports],
    helpers: [...helpers],
    assertionStyle,
    dataGeneration,
    exampleTestFiles: sampleFiles,
  };
}

function camelToKebab(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function camelToSnake(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

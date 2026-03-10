import { readFileSync } from "fs";
import type {
  NormalizedContract,
  ProtoMethod,
  ProtoMessage,
  ProtoField,
  ProtoEnum,
  ProtoOneof,
} from "../types.js";

/**
 * Deterministic proto parser — zero LLM tokens.
 * Converts a .proto file into a structured NormalizedContract.
 * @param intentName - the service name the user requested (may differ from proto's internal service name)
 */
export function parseContract(protoPath: string, intentName: string): NormalizedContract {
  const raw = sanitizeProto(readFileSync(protoPath, "utf-8"));
  validateBraceBalance(raw, protoPath);

  const service = extractServiceName(raw);
  const methods = extractMethods(raw);
  const enums = extractEnums(raw);
  const messages = extractMessages(raw);

  const contract: NormalizedContract = {
    service,
    intentName,
    package: extractPackage(raw),
    protoFile: protoPath,
    methods,
    enums,
    messages,
  };

  validateContract(contract, protoPath);
  return contract;
}

function extractPackage(raw: string): string {
  const match = raw.match(/^package\s+([\w.]+);/m);
  return match?.[1] ?? "unknown";
}

function extractServiceName(raw: string): string {
  const block = extractTopLevelBlocks(raw, "service")[0];
  if (!block) {
    throw new Error(`Proto contract has no top-level service declaration`);
  }
  return block.name;
}

function extractMethods(raw: string): ProtoMethod[] {
  const methods: ProtoMethod[] = [];
  const serviceBlock = extractTopLevelBlocks(raw, "service")[0];
  if (!serviceBlock) return methods;

  const rpcPattern = /rpc\s+(\w+)\s*\(\s*(\w+)\s*\)\s*returns\s*\(\s*(\w+)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = rpcPattern.exec(serviceBlock.body)) !== null) {
    methods.push({
      name: match[1],
      inputType: match[2],
      outputType: match[3],
    });
  }
  return methods;
}

function extractEnums(raw: string): ProtoEnum[] {
  const enums: ProtoEnum[] = [];
  for (const block of extractTopLevelBlocks(raw, "enum")) {
    const values: { name: string; number: number }[] = [];
    const valuePattern = /(\w+)\s*=\s*(\d+)/g;
    let vMatch: RegExpExecArray | null;
    while ((vMatch = valuePattern.exec(block.body)) !== null) {
      values.push({ name: vMatch[1], number: parseInt(vMatch[2]) });
    }
    enums.push({ name: block.name, values });
  }
  return enums;
}

function extractMessages(raw: string): ProtoMessage[] {
  const messages: ProtoMessage[] = [];
  for (const block of extractTopLevelBlocks(raw, "message")) {
    messages.push({
      name: block.name,
      fields: extractFields(block.body),
      oneofs: extractOneofs(block.body),
    });
  }
  return messages;
}

function extractFields(body: string): ProtoField[] {
  const fields: ProtoField[] = [];
  const fieldPattern =
    /^\s*(optional\s+|repeated\s+)?(?:map\s*<\s*(\w+)\s*,\s*(\w+)\s*>|(\w+(?:\.\w+)*))\s+(\w+)\s*=\s*(\d+)/gm;
  let match: RegExpExecArray | null;

  while ((match = fieldPattern.exec(body)) !== null) {
    const modifier = match[1]?.trim();
    const mapKey = match[2];
    const mapValue = match[3];
    const fieldType = match[4] ?? `map<${mapKey}, ${mapValue}>`;
    const fieldName = match[5];
    const fieldNumber = parseInt(match[6]);

    fields.push({
      name: fieldName,
      type: fieldType,
      number: fieldNumber,
      required: !modifier,
      repeated: modifier === "repeated",
      optional: modifier === "optional",
      ...(mapKey ? { mapKeyType: mapKey, mapValueType: mapValue } : {}),
    });
  }
  return fields;
}

function extractOneofs(body: string): ProtoOneof[] {
  const oneofs: ProtoOneof[] = [];
  for (const block of extractNestedBlocks(body, "oneof")) {
    const fieldNames: string[] = [];
    const fieldPattern = /\w+\s+(\w+)\s*=/g;
    let fMatch: RegExpExecArray | null;
    while ((fMatch = fieldPattern.exec(block.body)) !== null) {
      fieldNames.push(fMatch[1]);
    }
    oneofs.push({ name: block.name, fields: fieldNames });
  }
  return oneofs;
}

interface NamedBlock {
  name: string;
  body: string;
}

function sanitizeProto(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function validateBraceBalance(raw: string, protoPath: string): void {
  let depth = 0;
  for (const char of raw) {
    if (char === "{") depth++;
    if (char === "}") depth--;
    if (depth < 0) {
      throw new Error(`Proto parse failed for ${protoPath}: unexpected closing brace`);
    }
  }
  if (depth !== 0) {
    throw new Error(`Proto parse failed for ${protoPath}: unbalanced braces`);
  }
}

function validateContract(contract: NormalizedContract, protoPath: string): void {
  if (contract.service === "UnknownService") {
    throw new Error(`Proto parse failed for ${protoPath}: service name not found`);
  }

  if (contract.methods.length === 0) {
    throw new Error(`Proto parse failed for ${protoPath}: no RPC methods found`);
  }

  const messageNames = new Set(contract.messages.map((message) => message.name));
  const missingMessageTypes = contract.methods
    .flatMap((method) => [method.inputType, method.outputType])
    .filter((type) => !messageNames.has(type));

  if (missingMessageTypes.length > 0) {
    throw new Error(
      `Proto parse failed for ${protoPath}: missing message definitions for ${[...new Set(missingMessageTypes)].join(", ")}`,
    );
  }
}

function extractTopLevelBlocks(raw: string, keyword: "service" | "message" | "enum"): NamedBlock[] {
  return extractBlocks(raw, keyword, true);
}

function extractNestedBlocks(raw: string, keyword: "oneof"): NamedBlock[] {
  return extractBlocks(raw, keyword, false);
}

function extractBlocks(
  raw: string,
  keyword: "service" | "message" | "enum" | "oneof",
  topLevelOnly: boolean,
): NamedBlock[] {
  const blocks: NamedBlock[] = [];
  const pattern = new RegExp(`\\b${keyword}\\s+(\\w+)\\s*\\{`, "g");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    const openBraceIndex = raw.indexOf("{", match.index);
    if (openBraceIndex === -1) continue;
    if (topLevelOnly && getBraceDepthAt(raw, openBraceIndex) !== 0) continue;

    const closeBraceIndex = findMatchingBrace(raw, openBraceIndex);
    blocks.push({
      name: match[1],
      body: raw.slice(openBraceIndex + 1, closeBraceIndex),
    });
    pattern.lastIndex = closeBraceIndex + 1;
  }

  return blocks;
}

function getBraceDepthAt(raw: string, endIndexExclusive: number): number {
  let depth = 0;
  for (let i = 0; i < endIndexExclusive; i++) {
    if (raw[i] === "{") depth++;
    if (raw[i] === "}") depth--;
  }
  return depth;
}

function findMatchingBrace(raw: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    if (raw[i] === "}") depth--;
    if (depth === 0) return i;
  }
  throw new Error("Unmatched brace while parsing proto block");
}

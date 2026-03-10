import { readFile, readFileSchema } from "./read-file.js";
import { writeFile, writeFileSchema } from "./write-file.js";
import { listFiles, listFilesSchema } from "./list-files.js";
import { grepFiles, grepFilesSchema } from "./grep-files.js";
import { runCommand, runCommandSchema } from "./run-command.js";
import type { ToolDefinition } from "../types.js";

export const ALL_TOOLS: ToolDefinition[] = [
  readFileSchema,
  writeFileSchema,
  listFilesSchema,
  grepFilesSchema,
  runCommandSchema,
];

export const READ_ONLY_TOOLS: ToolDefinition[] = [
  readFileSchema,
  listFilesSchema,
  grepFilesSchema,
  runCommandSchema,
];

export const TOOLS_FOR_AGENT: Record<string, ToolDefinition[]> = {
  analyst: READ_ONLY_TOOLS,
  planner: [readFileSchema],
  coder: ALL_TOOLS,
  debugger: ALL_TOOLS,
  resolver: ALL_TOOLS,
  reporter: [readFileSchema],
};

export function executeTool(
  toolName: string,
  input: Record<string, unknown>,
): string {
  switch (toolName) {
    case "read_file":
      return readFile(input.path as string);
    case "write_file":
      return writeFile(input.path as string, input.content as string);
    case "list_files":
      return listFiles(input.pattern as string, input.cwd as string);
    case "grep_files":
      return grepFiles(input.pattern as string, input.path as string);
    case "run_command":
      return runCommand(input.command as string, input.cwd as string);
    default:
      return `Error: Unknown tool "${toolName}"`;
  }
}

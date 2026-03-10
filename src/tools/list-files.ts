import { globSync } from "glob";

export function listFiles(pattern: string, cwd: string): string {
  try {
    const files = globSync(pattern, { cwd, absolute: true });
    if (files.length === 0) return "No files found matching the pattern.";
    return files.join("\n");
  } catch (e) {
    return `Error listing files: ${(e as Error).message}`;
  }
}

export const listFilesSchema = {
  name: "list_files",
  description:
    "List files matching a glob pattern within a directory. Returns one file path per line.",
  input_schema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern (e.g. '**/*.test.ts', '*.proto')",
      },
      cwd: {
        type: "string",
        description: "Absolute path to the directory to search in",
      },
    },
    required: ["pattern", "cwd"],
  },
};

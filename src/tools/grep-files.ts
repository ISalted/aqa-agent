import { execSync } from "child_process";

export function grepFiles(
  pattern: string,
  path: string,
  options?: { maxResults?: number },
): string {
  const maxResults = options?.maxResults ?? 50;
  try {
    const result = execSync(
      `rg --no-heading --line-number --max-count ${maxResults} ${JSON.stringify(pattern)} ${JSON.stringify(path)}`,
      { encoding: "utf-8", timeout: 10_000 },
    );
    return result.trim() || "No matches found.";
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return "No matches found.";
    return `Error searching: ${(e as Error).message}`;
  }
}

export const grepFilesSchema = {
  name: "grep_files",
  description:
    "Search for a text pattern in files using ripgrep. Returns matching lines with file paths and line numbers.",
  input_schema: {
    type: "object" as const,
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      path: {
        type: "string",
        description: "Absolute path to file or directory to search",
      },
    },
    required: ["pattern", "path"],
  },
};

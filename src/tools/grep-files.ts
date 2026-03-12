import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { globSync } from "glob";

const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_RESULTS = 50;

/**
 * Search for a regex pattern in files (Node-only, no external rg).
 * Returns matching lines in "path:lineNum:lineContent" format, same as ripgrep --no-heading --line-number.
 */
export function grepFiles(
  pattern: string,
  path: string,
  options?: { maxResults?: number },
): string {
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return `Error: Invalid regex pattern "${pattern}"`;
  }

  const results: string[] = [];
  const files = getFilesToSearch(path);
  if (files.length === 0) return "No matches found.";

  for (const file of files) {
    if (results.length >= maxResults) break;
    const lines = readFileLines(file);
    if (lines === null) continue;
    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
      if (regex.test(lines[i])) {
        results.push(`${file}:${i + 1}:${lines[i]}`);
      }
    }
  }

  return results.length > 0 ? results.join("\n") : "No matches found.";
}

function getFilesToSearch(pathInput: string): string[] {
  if (!existsSync(pathInput)) return [];
  const stat = statSync(pathInput);
  if (stat.isFile()) return [pathInput];
  const pattern = join(pathInput, "**", "*");
  const files = globSync(pattern, {
    nodir: true,
    absolute: true,
    ignore: ["**/node_modules/**", "**/.git/**"],
  });
  return files;
}

function readFileLines(filePath: string): string[] | null {
  try {
    const stat = statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) return null;
    const content = readFileSync(filePath, "utf-8");
    return content.split(/\r?\n/);
  } catch {
    return null;
  }
}

export const grepFilesSchema = {
  name: "grep_files",
  description:
    "Search for a text pattern in files (regex). Returns matching lines with file paths and line numbers.",
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

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export function writeFile(path: string, content: string): string {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
    return `File written successfully: ${path}`;
  } catch (e) {
    return `Error writing file: ${(e as Error).message}`;
  }
}

export const writeFileSchema = {
  name: "write_file",
  description:
    "Write content to a file. Creates parent directories if they don't exist. Overwrites existing content.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to write",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    required: ["path", "content"],
  },
};

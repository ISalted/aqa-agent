import { readFileSync, existsSync } from "fs";

export function readFile(path: string): string {
  if (!existsSync(path)) {
    return `Error: File not found: ${path}`;
  }
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    return `Error reading file: ${(e as Error).message}`;
  }
}

export const readFileSchema = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns the full text content or an error message.",
  input_schema: {
    type: "object" as const,
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to read",
      },
    },
    required: ["path"],
  },
};

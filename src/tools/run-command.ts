import { execSync } from "child_process";

const ALLOWED_PREFIXES = [
  "npx playwright",
  "npx tsc",
  "npm run proto",
  "npm run test",
  "npm run typecheck",
  "cat ",
  "ls ",
  "head ",
  "wc ",
  "git log",
  "git diff",
  "git status",
];

const BLOCKED_PATTERNS = [
  /rm\s+-rf/,
  /sudo/,
  /git\s+push/,
  /git\s+reset\s+--hard/,
  /curl.*\$/,
  /wget/,
];

export function runCommand(
  command: string,
  cwd: string,
  options?: { timeout?: number },
): string {
  for (const blocked of BLOCKED_PATTERNS) {
    if (blocked.test(command)) {
      return `Error: Command blocked by security policy: ${command}`;
    }
  }

  const isAllowed = ALLOWED_PREFIXES.some((prefix) =>
    command.startsWith(prefix),
  );
  if (!isAllowed) {
    return `Error: Command not in allowlist. Allowed prefixes: ${ALLOWED_PREFIXES.join(", ")}`;
  }

  const timeout = options?.timeout ?? 120_000;
  try {
    const result = execSync(command, {
      cwd,
      encoding: "utf-8",
      timeout,
      maxBuffer: 1024 * 1024 * 5,
    });
    return result;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    const output = [
      err.stdout ?? "",
      err.stderr ?? "",
      `Exit code: ${err.status ?? "unknown"}`,
    ]
      .filter(Boolean)
      .join("\n");
    return output || `Command failed: ${(e as Error).message}`;
  }
}

export const runCommandSchema = {
  name: "run_command",
  description:
    "Execute a shell command in a specified directory. Only allows safe commands (test runners, type checkers, git read operations). Returns stdout/stderr.",
  input_schema: {
    type: "object" as const,
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
      cwd: {
        type: "string",
        description: "Working directory for the command",
      },
    },
    required: ["command", "cwd"],
  },
};

import "dotenv/config";
import { runPipeline } from "./engine/orchestrator.js";
import type { ParsedIntent } from "./types.js";

const USAGE = `
AQA Agent — AI-powered test automation for gRPC services

Usage:
  npm start -- cover <ServiceName>           Full cycle: plan + write tests
  npm start -- analyze <ServiceName>         Show coverage report
  npm start -- plan <ServiceName>            Generate test plans only (saves for implement_only)
  npm start -- implement_only <ServiceName>  Write tests from saved plans
  npm start -- validate_only <ServiceName>  Run tests only (no write/debug)
  npm start -- fix <ServiceName>             Re-run and fix failing tests

Examples:
  npm start -- cover ClientWallets
  npm start -- plan MissionEngine
  npm start -- implement_only MissionEngine
  npm start -- validate_only MissionEngine
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  const intent = parseIntent(args);
  if (!intent) {
    console.error("Could not parse intent from arguments.");
    console.log(USAGE);
    process.exit(1);
  }

  console.log(`\nAction: ${intent.action}`);
  console.log(`Service: ${intent.service}`);
  if (intent.methods?.length) {
    console.log(`Methods: ${intent.methods.join(", ")}`);
  }
  console.log("");

  await runPipeline(intent);
}

function parseIntent(args: string[]): ParsedIntent | null {
  const action = args[0]?.toLowerCase();
  const service = args[1];

  if (!service) return null;

  const validActions = ["cover", "fix", "analyze", "plan", "implement_only", "validate_only"];
  if (!validActions.includes(action)) {
    return {
      action: "cover",
      service: args[0],
      raw: args.join(" "),
    };
  }

  const methods = args.slice(2).filter((a) => !a.startsWith("-"));

  return {
    action: action as ParsedIntent["action"],
    service,
    methods: methods.length > 0 ? methods : undefined,
    raw: args.join(" "),
  };
}

main().catch((error) => {
  console.error("\nFatal error:", error.message);
  process.exit(1);
});

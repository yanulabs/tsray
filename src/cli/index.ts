#!/usr/bin/env node
import { parseArgs } from "node:util";
import { formatVersion } from "../version.js";
import {
  boolValue,
  UsageError,
  type CliValues,
} from "./command-context.js";
import { handleDb } from "./commands/db-command.js";
import { handleDiff } from "./commands/diff-command.js";
import { handleExport } from "./commands/export-command.js";
import { handleIndex } from "./commands/index-command.js";
import { handleIntegrationCommand } from "./commands/integration-commands.js";
import { handleServe } from "./commands/serve.js";
import { USAGE } from "./usage.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      db: { type: "string" },
      out: { type: "string", short: "o" },
      port: { type: "string" },
      "port-range": { type: "string" },
      "strict-port": { type: "boolean", default: false },
      host: { type: "string" },
      "no-watch": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "fail-on": { type: "string", default: "" },
      format: { type: "string" },
      open: { type: "boolean", default: false },
      "port-file": { type: "string" },
      tsconfig: { type: "string" },
      workspace: { type: "boolean", default: false },
      "allow-errors": { type: "boolean" },
      "log-level": { type: "string" },
      scope: { type: "string" },
      root: { type: "string" },
      depth: { type: "string" },
      summaries: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      name: { type: "string" },
      target: { type: "string" },
      args: { type: "string" },
      command: { type: "string" },
      cwd: { type: "string" },
      config: { type: "string" },
      mode: { type: "string" },
      dir: { type: "string" },
      "project-root": { type: "string" },
      yes: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const cliValues = values as CliValues;

  if (boolValue(cliValues.version)) {
    process.stdout.write(`${formatVersion()}\n`);
    return;
  }
  if (boolValue(cliValues.help)) {
    process.stdout.write(USAGE);
    return;
  }

  const [command, ...rest] = positionals;
  if (!command) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (command === "version") {
    process.stdout.write(`${formatVersion()}\n`);
    return;
  }
  if (command === "help") {
    process.stdout.write(USAGE);
    return;
  }

  if (await handleIntegrationCommand(command, rest, cliValues)) return;

  switch (command) {
    case "serve":
      await handleServe(rest, cliValues);
      return;
    case "index":
      handleIndex(rest, cliValues);
      return;
    case "export":
      handleExport(rest, cliValues);
      return;
    case "diff":
      handleDiff(rest, cliValues);
      return;
    case "db":
      handleDb(rest, cliValues);
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 2;
  }
}

main().catch((error) => {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (error instanceof UsageError || code.startsWith("ERR_PARSE_ARGS")) {
    process.stderr.write(
      `[tsray] ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 2;
    return;
  }
  process.stderr.write(
    `[tsray] fatal: ${error instanceof Error ? error.message : String(error)}\n`
  );
  if (process.env.TSRAY_DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});

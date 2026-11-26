import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  detectLintRunner,
  detectTestRunner,
  detectTypecheckRunner,
  runCommand,
} from "../runner.js";
import type { CommandResult } from "../runner.js";
import { truncateLog } from "../response.js";
import { numberArg } from "../shared/args.js";
import type { ToolContext } from "../shared/context.js";
import { errorResult, jsonResult } from "../shared/results.js";
import { maxCharsOptional, outputChars } from "../shared/schema.js";

function commandResult(
  runner: string,
  result: CommandResult,
  outputLimit: number,
  maxChars: number
): CallToolResult {
  let streamLimit = outputLimit;
  let payload: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 12; attempt++) {
    const stdout = truncateLog(result.stdout, streamLimit);
    const stderr = truncateLog(result.stderr, streamLimit);
    payload = {
      runner,
      command: result.command,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      duration_ms: result.duration_ms,
      stdout: stdout.text,
      stderr: stderr.text,
      stdout_original_chars: result.stdout_chars,
      stderr_original_chars: result.stderr_chars,
      truncated: result.truncated || stdout.truncated || stderr.truncated,
    };
    if (!Number.isFinite(maxChars) || JSON.stringify(payload, null, 2).length <= maxChars) {
      break;
    }
    streamLimit = Math.floor(streamLimit / 2);
  }
  return jsonResult(payload, maxChars);
}

export function registerCommandTools(context: ToolContext): void {
  const { controller, register } = context;

  register(
    "run_tests",
    "Run the project's configured test runner with bounded stdout/stderr.",
    {
      timeout_seconds: z.number().int().min(10).max(1800).default(900),
      output_chars: outputChars,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const runner = detectTestRunner(snapshot.root, controller.indexer.config);
      if (!runner.available || !runner.command) {
        return errorResult({
          error: "test_runner_not_found",
          hint: runner.hint,
          source: runner.source,
        });
      }
      const result = await runCommand(
        snapshot.root,
        runner.command,
        numberArg(args, "timeout_seconds", 900) * 1000
      );
      return {
        ...commandResult(
          runner.source,
          result,
          numberArg(args, "output_chars", 12_000),
          numberArg(args, "max_chars", 30_000)
        ),
        ...(result.exit_code === 0 && !result.timed_out ? {} : { isError: true }),
      };
    }
  );

  register(
    "run_typecheck",
    "Run the project's type checker (tsc --noEmit by default) with bounded stdout/stderr.",
    {
      timeout_seconds: z.number().int().min(10).max(1800).default(900),
      output_chars: outputChars,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const runner = detectTypecheckRunner(snapshot.root, controller.indexer.config);
      if (!runner.available || !runner.command) {
        return errorResult({
          error: "typecheck_runner_not_found",
          hint: runner.hint,
          source: runner.source,
        });
      }
      const result = await runCommand(
        snapshot.root,
        runner.command,
        numberArg(args, "timeout_seconds", 900) * 1000
      );
      return {
        ...commandResult(
          runner.source,
          result,
          numberArg(args, "output_chars", 12_000),
          numberArg(args, "max_chars", 30_000)
        ),
        ...(result.exit_code === 0 && !result.timed_out ? {} : { isError: true }),
      };
    }
  );

  register(
    "run_lint",
    "Run the project's configured linter with bounded stdout/stderr.",
    {
      timeout_seconds: z.number().int().min(10).max(1800).default(600),
      output_chars: outputChars,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const runner = detectLintRunner(snapshot.root, controller.indexer.config);
      if (!runner.available || !runner.command) {
        return errorResult({
          error: "lint_runner_not_found",
          hint: runner.hint,
          source: runner.source,
        });
      }
      const result = await runCommand(
        snapshot.root,
        runner.command,
        numberArg(args, "timeout_seconds", 600) * 1000
      );
      return {
        ...commandResult(
          runner.source,
          result,
          numberArg(args, "output_chars", 12_000),
          numberArg(args, "max_chars", 30_000)
        ),
        ...(result.exit_code === 0 && !result.timed_out ? {} : { isError: true }),
      };
    }
  );
}

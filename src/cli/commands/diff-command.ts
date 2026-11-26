import {
  GitDiffError,
  diffMarkdown,
  runArchitecturalDiff,
} from "../diff.js";
import {
  boolValue,
  stringValue,
  type CliValues,
} from "../command-context.js";

export function handleDiff(rest: string[], values: CliValues): void {
  const baseRef = rest[0] ?? "HEAD";
  const target = rest[1] ?? ".";
  const gates = (stringValue(values["fail-on"]) ?? "")
    .split(",")
    .map((gate) => gate.trim())
    .filter(Boolean);
  try {
    const result = runArchitecturalDiff(target, baseRef, gates, {
      tsconfig: stringValue(values.tsconfig),
      workspace: boolValue(values.workspace),
    });
    const format = stringValue(values.format) ?? "json";
    process.stdout.write(
      format === "md"
        ? diffMarkdown(result)
        : `${JSON.stringify(result, null, 2)}\n`
    );
    process.exitCode = result.failed_gates.length > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof GitDiffError) {
      process.stderr.write(`[tsray] git error: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

import {
  planDatabaseRemoval,
  pruneWorktreeDatabases,
  removeDatabases,
  resolveDbPaths,
} from "../../cache/store.js";
import { resolveProject } from "../../util/paths.js";
import {
  boolValue,
  createContext,
  stringValue,
  UsageError,
  type CliValues,
} from "../command-context.js";

export function handleDb(rest: string[], values: CliValues): void {
  const sub = rest[0];
  const target = rest[1] ?? ".";
  const overrideDb = stringValue(values.db) ?? process.env.TSRAY_DB;
  if (sub === "path") {
    const project = resolveProject(target, {
      tsconfig: stringValue(values.tsconfig),
      workspace: boolValue(values.workspace),
    });
    const paths = resolveDbPaths(project.root, project.projectId, overrideDb);
    process.stdout.write(
      `${boolValue(values.summaries) ? paths.summaryPath : paths.workingPath}\n`
    );
    return;
  }
  if (sub === "info") {
    const { store } = createContext(target, values);
    try {
      process.stdout.write(`${JSON.stringify(store.getInfo(), null, 2)}\n`);
    } finally {
      store.close();
    }
    return;
  }
  if (sub === "rm") {
    if (overrideDb === ":memory:") {
      throw new UsageError(
        "db rm cannot remove an in-memory database (--db :memory:)"
      );
    }
    const project = resolveProject(target, {
      tsconfig: stringValue(values.tsconfig),
      workspace: boolValue(values.workspace),
    });
    const plan = planDatabaseRemoval(project.root, project.projectId, {
      overrideDb,
      summaries: boolValue(values.summaries),
      all: boolValue(values.all),
    });
    if (boolValue(values["dry-run"])) {
      process.stdout.write(
        `${JSON.stringify(
          {
            dry_run: true,
            files: plan.existing,
            total_bytes: plan.totalBytes,
          },
          null,
          2
        )}\n`
      );
      return;
    }
    const result = removeDatabases(plan, {
      force: boolValue(values.force),
    });
    if (result.removed.length === 0 && result.skipped.length === 0) {
      process.stdout.write("nothing to remove\n");
    } else {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    if (result.skipped.length > 0) process.exitCode = 1;
    return;
  }
  if (sub === "prune") {
    const result = pruneWorktreeDatabases({
      dryRun: boolValue(values["dry-run"]),
    });
    process.stdout.write(
      `${JSON.stringify(
        { dry_run: boolValue(values["dry-run"]), ...result },
        null,
        2
      )}\n`
    );
    return;
  }
  throw new UsageError(`Unknown db subcommand: ${sub ?? "(missing)"}`);
}

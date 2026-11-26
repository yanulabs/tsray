import {
  DualCacheStore,
} from "../../cache/store.js";
import { TsReactIndexer, type IndexerOptions } from "../../index/indexer.js";
import { IndexController } from "../../index/watch.js";
import { startServe } from "../../mcp/server.js";
import {
  allowErrorsValue,
  boolValue,
  stringValue,
  storeOptions,
  UsageError,
  type CliValues,
} from "../command-context.js";

export async function handleServe(
  rest: string[],
  values: CliValues
): Promise<void> {
  const target = rest[0] ?? ".";
  const indexerOptions: IndexerOptions = {
    tsconfig: stringValue(values.tsconfig),
    workspace: boolValue(values.workspace),
    allowErrors: allowErrorsValue(values),
  };
  const indexer = new TsReactIndexer(target, indexerOptions);
  const store = new DualCacheStore(
    indexer.root,
    indexer.projectId,
    storeOptions(values, indexer)
  );
  indexer.setProjectCache(store);
  const logLevel = (stringValue(values["log-level"]) ??
    process.env.TSRAY_LOG_LEVEL ??
    "info") as "off" | "error" | "info";
  if (!["off", "error", "info"].includes(logLevel)) {
    store.close();
    throw new Error(`Invalid --log-level: ${logLevel}`);
  }
  const log = (message: string): void => {
    if (logLevel === "off") return;
    if (logLevel === "error" && !/error|failed|warning/i.test(message)) return;
    process.stderr.write(`${message}\n`);
  };
  const controller = new IndexController(indexer, store, log);
  const port = Number(
    stringValue(values.port) ?? process.env.TSRAY_PORT ?? "4321"
  );
  const portRange = Number(
    stringValue(values["port-range"]) ?? process.env.TSRAY_PORT_RANGE ?? "100"
  );
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    store.close();
    throw new UsageError(
      `Invalid port: ${String(values.port ?? process.env.TSRAY_PORT)}`
    );
  }
  if (!Number.isInteger(portRange) || portRange < 0) {
    store.close();
    throw new UsageError(
      `Invalid port range: ${String(
        values["port-range"] ?? process.env.TSRAY_PORT_RANGE
      )}`
    );
  }
  try {
    await startServe(controller, store, {
      host: stringValue(values.host) ?? process.env.TSRAY_HOST ?? "127.0.0.1",
      port,
      portRange,
      strictPort:
        boolValue(values["strict-port"]) ||
        process.env.TSRAY_STRICT_PORT === "true",
      watch: !boolValue(values["no-watch"]),
      open: boolValue(values.open),
      portFile: stringValue(values["port-file"]) ?? process.env.TSRAY_PORT_FILE,
      logLevel,
    });
  } catch (error) {
    store.close();
    throw error;
  }
}

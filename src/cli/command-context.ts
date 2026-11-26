import {
  DualCacheStore,
  type StoreOptions,
} from "../cache/store.js";
import { TsReactIndexer, type IndexerOptions } from "../index/indexer.js";

export type CliValues = Record<string, string | boolean | undefined>;

export interface Context {
  indexer: TsReactIndexer;
  store: DualCacheStore;
}

export class UsageError extends Error {}

export function stringValue(
  value: string | boolean | undefined
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function boolValue(value: string | boolean | undefined): boolean {
  return value === true;
}

export function allowErrorsValue(values: CliValues): boolean | undefined {
  if (boolValue(values["allow-errors"])) return true;
  const environment = process.env.TSRAY_ALLOW_ERRORS;
  if (environment === "true") return true;
  if (environment === "false") return false;
  return undefined;
}

export function storeOptions(
  values: CliValues,
  indexer: TsReactIndexer
): StoreOptions {
  return {
    overrideDb: stringValue(values.db) ?? process.env.TSRAY_DB,
    promptVersion:
      process.env.TSRAY_PROMPT_VERSION ?? indexer.config.summaries.promptVersion,
  };
}

export function createContext(target: string, values: CliValues): Context {
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
  return { indexer, store };
}

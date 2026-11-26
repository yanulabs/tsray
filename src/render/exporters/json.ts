import type { DualCacheStore } from "../../cache/store.js";
import type { IndexSnapshot } from "../../index/types.js";
import { buildReportPayload } from "./payload.js";

export function exportJson(snapshot: IndexSnapshot, store: DualCacheStore): string {
  return `${JSON.stringify(buildReportPayload(snapshot, store), null, 2)}\n`;
}

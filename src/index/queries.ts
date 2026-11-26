/**
 * Query facade. Domain implementations live under `src/index/queries/` so
 * callers keep stable imports while graph, module, symbol, audit, and impact
 * concerns remain independently testable.
 */
export * from "./queries/audit.js";
export * from "./queries/graphs.js";
export * from "./queries/impact.js";
export * from "./queries/implementations.js";
export * from "./queries/modules.js";
export * from "./queries/symbols.js";

/**
 * Cache store facade. Database paths/removal, schemas, summary helpers, the
 * read-only cache, and the dual working/summary store live under
 * `src/cache/store/` so callers keep stable imports.
 */
export * from "./store/dual-cache-store.js";
export * from "./store/paths.js";
export * from "./store/read-only-project-cache.js";
export * from "./store/types.js";

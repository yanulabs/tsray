/**
 * Architectural diff facade. Git snapshotting, worktree preparation, diff
 * execution, and Markdown rendering live under `src/cli/diff/`.
 */
export * from "./diff/errors.js";
export * from "./diff/markdown.js";
export * from "./diff/run.js";
export * from "./diff/types.js";
export * from "./diff/worktree.js";

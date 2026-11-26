/**
 * MCP client configuration facade. Types, argument parsing, atomic writes,
 * JSON/TOML editing, format detection, and apply logic live under
 * `src/integration/config/`.
 */
export * from "./config/apply.js";
export * from "./config/args.js";
export * from "./config/detect.js";
export * from "./config/fs.js";
export * from "./config/types.js";

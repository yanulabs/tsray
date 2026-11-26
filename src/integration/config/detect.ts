import type { ConfigFormat, ConfigLocation } from "./types.js";
import { readText, writablePath } from "./fs.js";
import { hasCodex } from "./codex.js";
import { hasJson, loadJson } from "./json.js";

export function inferConfigFormat(file: string): ConfigFormat {
  const normalized = file.replace(/\\/g, "/");
  if (/(^|\/)opencode\.jsonc?$/.test(normalized)) return "opencode";
  if (normalized.endsWith("config.toml")) return "codex";
  if (normalized.endsWith("mcp_config.json")) return "antigravity";
  if (normalized.endsWith(".mcp.json") || normalized.endsWith("claude.json")) return "claude";
  if (normalized.includes("/.cursor/")) return "cursor";
  if (normalized.includes("/.gemini/")) return "gemini";
  if (normalized.includes("/.agents/")) return "agents";
  return "generic";
}

export function isMcpConfigured(location: ConfigLocation, name: string): boolean {
  if (location.format === "codex") {
    const file = writablePath(location.path);
    const text = readText(file);
    return text !== null && hasCodex(text, file, name);
  }
  const { data } = loadJson(location.path);
  return hasJson(data, location.format, name);
}

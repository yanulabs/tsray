import os from "node:os";
import path from "node:path";
import { ConfigError } from "./types.js";

export function validateServerName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new ConfigError(
      `invalid MCP server name ${JSON.stringify(name)} (use letters, digits, _ or -)`
    );
  }
}

/** Shell-like argument splitting without executing a shell. */
export function splitArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (escaped) current += "\\";
  if (quote) throw new ConfigError("unterminated quote in --args");
  if (started) args.push(current);
  return args;
}

function expandHome(value: string): string {
  if (value === "~") return osHome();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(osHome(), value.slice(2));
  }
  return value;
}

function osHome(): string {
  return os.homedir();
}

export function resolveConfigPath(raw: string): string {
  return path.resolve(expandHome(raw));
}

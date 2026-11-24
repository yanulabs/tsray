import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseToml } from "smol-toml";

export const MCP_TARGETS = [
  "opencode",
  "claude",
  "codex",
  "cursor",
  "gemini",
  "antigravity",
  "agents",
] as const;

export type McpTarget = (typeof MCP_TARGETS)[number];
export type ConfigFormat = McpTarget | "generic";
export type ConfigAction = "install" | "uninstall" | "status";

export interface ConfigLocation {
  target?: McpTarget;
  format: ConfigFormat;
  path: string;
}

export interface McpCommand {
  command: string;
  args: string[];
  cwd?: string;
}

export interface ConfigChange {
  path: string;
  format: ConfigFormat;
  before: string;
  after: string;
  changed: boolean;
  result: "installed" | "already_installed" | "removed" | "not_configured";
}

type JsonObject = Record<string, unknown>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

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

function writablePath(file: string): string {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      try {
        return fs.realpathSync(file);
      } catch (error) {
        throw new ConfigError(`${file}: broken symlink: ${String(error)}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return file;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`${file}: ${String(error)}`);
  }
}

function fileMode(file: string): number | null {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigError(`${file}: ${String(error)}`);
  }
}

export function writeAtomicText(file: string, text: string, mode: number | null): void {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", mode ?? 0o600);
  try {
    fs.writeFileSync(descriptor, text, "utf8");
    fs.fchmodSync(descriptor, mode ?? 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EEXIST") {
      fs.rmSync(temporary, { force: true });
      throw error;
    }
    try {
      fs.copyFileSync(temporary, file);
      fs.chmodSync(file, mode ?? 0o600);
      fs.rmSync(temporary, { force: true });
    } catch (copyError) {
      fs.rmSync(temporary, { force: true });
      throw copyError;
    }
  }
}

function loadJson(file: string): { data: JsonObject; mode: number | null; before: string } {
  const resolved = writablePath(file);
  const before = readText(resolved);
  if (before === null || before.trim() === "") return { data: {}, mode: null, before: "" };
  let data: unknown;
  try {
    data = JSON.parse(before);
  } catch (error) {
    throw new ConfigError(`${resolved}: invalid JSON: ${String(error)}`);
  }
  if (!isObject(data)) throw new ConfigError(`${resolved}: root must be a JSON object`);
  return { data, mode: fileMode(resolved), before };
}

function saveJson(file: string, data: JsonObject, mode: number | null): string {
  const resolved = writablePath(file);
  const after = `${JSON.stringify(data, null, 2)}\n`;
  writeAtomicText(resolved, after, mode);
  return after;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectChild(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (value === undefined || value === null) {
    parent[key] = {};
    return parent[key] as JsonObject;
  }
  if (!isObject(value)) throw new ConfigError(`${JSON.stringify(key)} must be a JSON object`);
  return value;
}

function jsonEntry(format: ConfigFormat, command: McpCommand): JsonObject {
  if (format === "opencode") {
    return {
      type: "local",
      command: [command.command, ...command.args],
      ...(command.cwd ? { cwd: command.cwd } : {}),
    };
  }
  if (format === "claude" || format === "agents") {
    return {
      type: "stdio",
      command: command.command,
      args: command.args,
      ...(command.cwd ? { cwd: command.cwd } : {}),
    };
  }
  if (format === "antigravity") {
    const serveIndex = command.args.indexOf("serve");
    const args = serveIndex >= 0 && serveIndex === command.args.length - 1
      ? [...command.args, "${workspaceFolder}"]
      : command.args;
    return {
      command: command.command,
      args,
      disabled: false,
      ...(command.cwd ? { cwd: command.cwd } : {}),
    };
  }
  return {
    command: command.command,
    args: command.args,
  };
}

function installJson(data: JsonObject, format: ConfigFormat, name: string, command: McpCommand): void {
  if (format === "opencode") {
    const mcp = objectChild(data, "mcp");
    const servers = objectChild(mcp, "servers");
    delete mcp[name];
    servers[name] = jsonEntry(format, command);
    if (!("$schema" in data)) {
      const ordered = { $schema: "https://opencode.ai/config.json", ...data };
      for (const key of Object.keys(data)) delete data[key];
      Object.assign(data, ordered);
    }
    return;
  }
  const servers = objectChild(data, "mcpServers");
  servers[name] = jsonEntry(format, command);
}

function removeJson(data: JsonObject, format: ConfigFormat, name: string): boolean {
  if (format === "opencode") {
    const mcp = data.mcp;
    if (!isObject(mcp)) return false;
    let removed = false;
    const servers = mcp.servers;
    if (isObject(servers) && name in servers) {
      delete servers[name];
      removed = true;
      if (Object.keys(servers).length === 0) delete mcp.servers;
    }
    if (name in mcp) {
      delete mcp[name];
      removed = true;
    }
    if (Object.keys(mcp).length === 0) delete data.mcp;
    return removed;
  }
  const servers = data.mcpServers;
  if (!isObject(servers) || !(name in servers)) return false;
  delete servers[name];
  if (Object.keys(servers).length === 0) delete data.mcpServers;
  return true;
}

function hasJson(data: JsonObject, format: ConfigFormat, name: string): boolean {
  if (format === "opencode") {
    const mcp = data.mcp;
    if (!isObject(mcp)) return false;
    return (isObject(mcp.servers) && name in mcp.servers) || name in mcp;
  }
  const servers = data.mcpServers;
  return isObject(servers) && name in servers;
}

const TOML_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;

function splitTomlKey(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of raw.trim()) {
    if (quote) {
      if (escaped) {
        current += char;
        escaped = false;
      } else if (char === "\\" && quote === '"') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === ".") {
      parts.push(current.trim());
      current = "";
    } else if (!/\s/.test(char)) {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts;
}

function tomlHeaderPath(line: string): string[] | null {
  const stripped = line.trimStart();
  if (stripped.startsWith('["') || stripped.startsWith("['")) return null;
  const match = TOML_HEADER.exec(line);
  return match ? splitTomlKey(match[1]!) : null;
}

function codexMatches(header: string[], name: string): boolean {
  return header.length >= 2 && header[0] === "mcp_servers" && header[1] === name;
}

function codexBlocks(lines: string[], name: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let index = 0;
  while (index < lines.length) {
    const header = tomlHeaderPath(lines[index]!);
    if (!header || !codexMatches(header, name)) {
      index++;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && tomlHeaderPath(lines[end]!) === null) end++;
    ranges.push([index, end]);
    index = end;
  }
  return ranges;
}

function removeCodexBlocks(text: string, name: string): string {
  const lines = text.split(/\r?\n/);
  for (const [start, end] of codexBlocks(lines, name).reverse()) lines.splice(start, end - start);
  return lines.join("\n");
}

function parseTomlConfig(text: string, file: string): JsonObject {
  try {
    const parsed = parseToml(text);
    if (!isObject(parsed)) throw new ConfigError(`${file}: TOML root must be a table`);
    return parsed;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${file}: invalid TOML: ${String(error)}`);
  }
}

function hasCodex(text: string, file: string, name: string): boolean {
  const data = parseTomlConfig(text, file);
  const servers = data.mcp_servers;
  return isObject(servers) && name in servers;
}

function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\b") out += "\\b";
    else if (char === "\t") out += "\\t";
    else if (char === "\n") out += "\\n";
    else if (char === "\f") out += "\\f";
    else if (char === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

function renderCodex(name: string, command: McpCommand): string {
  const lines = [
    `[mcp_servers.${tomlString(name)}]`,
    `command = ${tomlString(command.command)}`,
  ];
  if (command.args.length > 0) {
    lines.push(`args = [${command.args.map(tomlString).join(", ")}]`);
  }
  return lines.join("\n");
}

function codexHasDottedKey(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\s*(?:"${escaped}"|'${escaped}'|${escaped})\\s*=`);
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const header = tomlHeaderPath(line);
    if (header) {
      current = header;
      continue;
    }
    if (current?.length === 1 && current[0] === "mcp_servers" && pattern.test(line)) return true;
  }
  return false;
}

function installCodex(file: string, name: string, command: McpCommand): { before: string; after: string } {
  const resolved = writablePath(file);
  const before = readText(resolved) ?? "";
  if (/^\s*mcp_servers\s*=/m.test(before)) {
    throw new ConfigError(`${resolved}: mcp_servers is an inline table; edit it manually`);
  }
  if (codexHasDottedKey(before, name)) {
    throw new ConfigError(`${resolved}: mcp_servers.${name} is a dotted key; edit it manually`);
  }
  const trimmed = removeCodexBlocks(before, name).trimEnd();
  const block = renderCodex(name, command);
  const after = `${trimmed ? `${trimmed}\n\n` : ""}${block}\n`;
  const parsed = parseTomlConfig(after, resolved);
  const servers = parsed.mcp_servers;
  if (!isObject(servers) || !(name in servers)) {
    throw new ConfigError(`${resolved}: generated TOML is missing mcp_servers.${name}`);
  }
  return { before, after };
}

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

export function applyMcpConfig(
  location: ConfigLocation,
  action: Exclude<ConfigAction, "status">,
  name: string,
  command: McpCommand,
  options: { dryRun?: boolean } = {}
): ConfigChange {
  validateServerName(name);
  if (location.format === "codex") {
    const file = writablePath(location.path);
    const before = readText(file) ?? "";
    const configured = before.trim() !== "" && hasCodex(before, file, name);
    if (action === "uninstall") {
      if (!configured) {
        return { path: file, format: location.format, before, after: before, changed: false, result: "not_configured" };
      }
      const after = `${removeCodexBlocks(before, name).trimEnd()}${before.trim() ? "\n" : ""}`;
      if (after.trim()) parseTomlConfig(after, file);
      if (!options.dryRun) writeAtomicText(file, after, fileMode(file));
      return { path: file, format: location.format, before, after, changed: true, result: "removed" };
    }
    const rendered = installCodex(file, name, command);
    const changed = rendered.before !== rendered.after;
    if (!options.dryRun && changed) writeAtomicText(file, rendered.after, fileMode(file));
    return {
      path: file,
      format: location.format,
      before: rendered.before,
      after: rendered.after,
      changed,
      result: changed ? "installed" : "already_installed",
    };
  }

  const { data, mode, before } = loadJson(location.path);
  if (action === "uninstall") {
    const removed = removeJson(data, location.format, name);
    if (!removed) {
      return { path: writablePath(location.path), format: location.format, before, after: before, changed: false, result: "not_configured" };
    }
    const after = options.dryRun ? `${JSON.stringify(data, null, 2)}\n` : saveJson(location.path, data, mode);
    return { path: writablePath(location.path), format: location.format, before, after, changed: true, result: "removed" };
  }

  installJson(data, location.format, name, command);
  const rendered = `${JSON.stringify(data, null, 2)}\n`;
  const changed = before !== rendered;
  if (!options.dryRun && changed) saveJson(location.path, data, mode);
  return {
    path: writablePath(location.path),
    format: location.format,
    before,
    after: rendered,
    changed,
    result: changed ? "installed" : "already_installed",
  };
}

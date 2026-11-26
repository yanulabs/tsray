import type { ConfigFormat, JsonObject, McpCommand } from "./types.js";
import { ConfigError } from "./types.js";
import { fileMode, readText, writablePath, writeAtomicText } from "./fs.js";

export function loadJson(file: string): { data: JsonObject; mode: number | null; before: string } {
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

export function saveJson(file: string, data: JsonObject, mode: number | null): string {
  const resolved = writablePath(file);
  const after = `${JSON.stringify(data, null, 2)}\n`;
  writeAtomicText(resolved, after, mode);
  return after;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectChild(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (value === undefined || value === null) {
    parent[key] = {};
    return parent[key] as JsonObject;
  }
  if (!isObject(value)) throw new ConfigError(`${JSON.stringify(key)} must be a JSON object`);
  return value;
}

export function jsonEntry(format: ConfigFormat, command: McpCommand): JsonObject {
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

export function installJson(data: JsonObject, format: ConfigFormat, name: string, command: McpCommand): void {
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

export function removeJson(data: JsonObject, format: ConfigFormat, name: string): boolean {
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

export function hasJson(data: JsonObject, format: ConfigFormat, name: string): boolean {
  if (format === "opencode") {
    const mcp = data.mcp;
    if (!isObject(mcp)) return false;
    return (isObject(mcp.servers) && name in mcp.servers) || name in mcp;
  }
  const servers = data.mcpServers;
  return isObject(servers) && name in servers;
}

import { parse as parseToml } from "smol-toml";
import { ConfigError, type JsonObject, type McpCommand } from "./types.js";
import { readText, writablePath } from "./fs.js";
import { isObject } from "./json.js";

const TOML_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;

export function splitTomlKey(raw: string): string[] {
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

export function tomlHeaderPath(line: string): string[] | null {
  const stripped = line.trimStart();
  if (stripped.startsWith('["') || stripped.startsWith("['")) return null;
  const match = TOML_HEADER.exec(line);
  return match ? splitTomlKey(match[1]!) : null;
}

export function codexMatches(header: string[], name: string): boolean {
  return header.length >= 2 && header[0] === "mcp_servers" && header[1] === name;
}

export function codexBlocks(lines: string[], name: string): Array<[number, number]> {
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

export function removeCodexBlocks(text: string, name: string): string {
  const lines = text.split(/\r?\n/);
  for (const [start, end] of codexBlocks(lines, name).reverse()) lines.splice(start, end - start);
  return lines.join("\n");
}

export function parseTomlConfig(text: string, file: string): JsonObject {
  try {
    const parsed = parseToml(text);
    if (!isObject(parsed)) throw new ConfigError(`${file}: TOML root must be a table`);
    return parsed;
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${file}: invalid TOML: ${String(error)}`);
  }
}

export function hasCodex(text: string, file: string, name: string): boolean {
  const data = parseTomlConfig(text, file);
  const servers = data.mcp_servers;
  return isObject(servers) && name in servers;
}

export function tomlString(value: string): string {
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

export function renderCodex(name: string, command: McpCommand): string {
  const lines = [
    `[mcp_servers.${tomlString(name)}]`,
    `command = ${tomlString(command.command)}`,
  ];
  if (command.args.length > 0) {
    lines.push(`args = [${command.args.map(tomlString).join(", ")}]`);
  }
  return lines.join("\n");
}

export function codexHasDottedKey(text: string, name: string): boolean {
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

export function installCodex(file: string, name: string, command: McpCommand): { before: string; after: string } {
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

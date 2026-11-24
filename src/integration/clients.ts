import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MCP_TARGETS,
  ConfigError,
  type ConfigFormat,
  type ConfigLocation,
  type McpTarget,
} from "./config.js";

export const SKILL_TARGETS = [
  "opencode",
  "claude",
  "codex",
  "cursor",
  "gemini",
  "agents",
] as const;

export type SkillTarget = (typeof SKILL_TARGETS)[number];
export type IntegrationScope = "global" | "project";

export interface ClientPathOptions {
  home?: string;
  configHome?: string;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function defaults(options: ClientPathOptions): {
  home: string;
  configHome: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
} {
  const home = options.home ?? os.homedir();
  return {
    home,
    configHome: options.configHome ?? options.env?.XDG_CONFIG_HOME ?? path.join(home, ".config"),
    projectRoot: path.resolve(options.projectRoot ?? process.cwd()),
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
  };
}

export function displayPath(file: string, options: ClientPathOptions = {}): string {
  const { home } = defaults(options);
  if (file === home) return "~";
  if (file.startsWith(`${home}${path.sep}`)) return `~${path.sep}${file.slice(home.length + 1)}`;
  return file;
}

export function getMcpConfigPath(
  target: McpTarget,
  scope: IntegrationScope,
  options: ClientPathOptions = {}
): string {
  const { home, configHome, projectRoot, env } = defaults(options);
  if (scope === "project") {
    switch (target) {
      case "opencode":
        return path.join(projectRoot, "opencode.json");
      case "claude":
        return path.join(projectRoot, ".mcp.json");
      case "codex":
        return path.join(projectRoot, ".codex", "config.toml");
      case "cursor":
        return path.join(projectRoot, ".cursor", "mcp.json");
      case "gemini":
        return path.join(projectRoot, ".gemini", "settings.json");
      case "antigravity":
        return path.join(projectRoot, ".agents", "mcp_config.json");
      case "agents":
        return path.join(projectRoot, ".agents", "mcp.json");
    }
  }

  switch (target) {
    case "opencode":
      return env.OPENCODE_CONFIG
        ? path.resolve(expandHome(env.OPENCODE_CONFIG, home))
        : path.join(configHome, "opencode", "opencode.json");
    case "claude":
      return path.join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json");
    case "codex":
      return path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml");
    case "cursor":
      return path.join(home, ".cursor", "mcp.json");
    case "gemini":
      return path.join(home, ".gemini", "settings.json");
    case "antigravity":
      return path.join(home, ".gemini", "config", "mcp_config.json");
    case "agents":
      return path.join(home, ".agents", "mcp.json");
  }
}

export function getSkillBasePath(
  target: SkillTarget,
  scope: IntegrationScope,
  options: ClientPathOptions = {}
): string {
  const { home, configHome, projectRoot, env } = defaults(options);
  if (scope === "project") {
    switch (target) {
      case "opencode":
        return path.join(projectRoot, ".opencode", "skills");
      case "claude":
        return path.join(projectRoot, ".claude", "skills");
      case "codex":
        return path.join(projectRoot, ".codex", "skills");
      case "cursor":
        return path.join(projectRoot, ".cursor", "skills");
      case "gemini":
        return path.join(projectRoot, ".gemini", "skills");
      case "agents":
        return path.join(projectRoot, ".agents", "skills");
    }
  }

  switch (target) {
    case "opencode":
      return path.join(configHome, "opencode", "skills");
    case "claude":
      return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "skills");
    case "codex":
      return path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "skills");
    case "cursor":
      return path.join(home, ".cursor", "skills");
    case "gemini":
      return path.join(home, ".gemini", "skills");
    case "agents":
      return path.join(home, ".agents", "skills");
  }
}

export function configLocationForTarget(
  target: McpTarget,
  scope: IntegrationScope,
  options: ClientPathOptions = {}
): ConfigLocation {
  return { target, format: target, path: getMcpConfigPath(target, scope, options) };
}

export function targetFromToken(token: string): McpTarget | null {
  const numeric: Record<string, McpTarget> = {
    "1": "opencode",
    "2": "claude",
    "3": "codex",
    "4": "cursor",
    "5": "gemini",
    "6": "antigravity",
    "7": "agents",
  };
  if (token in numeric) return numeric[token]!;
  return (MCP_TARGETS as readonly string[]).includes(token) ? (token as McpTarget) : null;
}

export function skillTargetFromToken(token: string): SkillTarget | null {
  const numeric: Record<string, SkillTarget> = {
    "1": "opencode",
    "2": "claude",
    "3": "codex",
    "4": "cursor",
    "5": "gemini",
    "6": "agents",
  };
  if (token in numeric) return numeric[token]!;
  return (SKILL_TARGETS as readonly string[]).includes(token) ? (token as SkillTarget) : null;
}

export function isCustomPath(token: string): boolean {
  return (
    token === "~" ||
    token.startsWith("~/") ||
    token.startsWith("~\\") ||
    path.isAbsolute(token) ||
    token.startsWith("./") ||
    token.startsWith("../")
  );
}

export function expandHome(raw: string, home: string): string {
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(home, raw.slice(2));
  return raw;
}

export function commandExists(command: string, options: ClientPathOptions = {}): boolean {
  const { env, platform } = defaults(options);
  const pathValue = env.PATH ?? "";
  const suffixes = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${command}${suffix}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        // Keep searching.
      }
    }
  }
  return false;
}

export function isTargetDetected(
  target: McpTarget,
  options: ClientPathOptions = {}
): boolean {
  const { home, configHome, projectRoot, platform, env } = defaults(options);
  const exists = (file: string): boolean => fs.existsSync(file);
  switch (target) {
    case "opencode":
      return (
        exists(path.join(configHome, "opencode")) ||
        exists(path.join(projectRoot, "opencode.json")) ||
        exists(path.join(projectRoot, "opencode.jsonc")) ||
        exists(path.join(projectRoot, ".opencode")) ||
        commandExists("opencode", options)
      );
    case "claude": {
      const claudeDir = env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
      return (
        exists(claudeDir) ||
        exists(path.join(claudeDir, ".claude.json")) ||
        exists(path.join(projectRoot, ".mcp.json")) ||
        exists(path.join(projectRoot, ".claude")) ||
        commandExists("claude", options)
      );
    }
    case "codex": {
      const codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
      return (
        exists(codexHome) ||
        exists(path.join(projectRoot, ".codex")) ||
        commandExists("codex", options)
      );
    }
    case "cursor":
      return (
        exists(path.join(home, ".cursor")) ||
        exists(path.join(projectRoot, ".cursor")) ||
        (platform === "darwin" && exists("/Applications/Cursor.app"))
      );
    case "gemini":
      return (
        exists(path.join(home, ".gemini")) ||
        exists(path.join(projectRoot, ".gemini")) ||
        commandExists("gemini", options)
      );
    case "antigravity":
      return (
        exists(path.join(home, ".gemini", "antigravity")) ||
        exists(path.join(home, ".gemini", "antigravity-cli")) ||
        exists(path.join(home, ".gemini", "config", "mcp_config.json")) ||
        exists(path.join(projectRoot, ".agents", "mcp_config.json")) ||
        (platform === "darwin" && exists("/Applications/Antigravity.app")) ||
        commandExists("antigravity", options)
      );
    case "agents":
      return exists(path.join(home, ".agents")) || exists(path.join(projectRoot, ".agents"));
  }
}

export function validateFormat(format: string): ConfigFormat {
  if (format === "generic" || (MCP_TARGETS as readonly string[]).includes(format)) {
    return format as ConfigFormat;
  }
  throw new ConfigError(
    `invalid MCP format ${JSON.stringify(format)} (use ${[...MCP_TARGETS, "generic"].join(", ")})`
  );
}

export function openCodeJsoncSibling(file: string): string | null {
  if (!/(^|[/\\])opencode\.json$/.test(file)) return null;
  const sibling = `${file.slice(0, -5)}.jsonc`;
  return fs.existsSync(sibling) ? sibling : null;
}

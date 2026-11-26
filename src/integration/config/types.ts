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

export type JsonObject = Record<string, unknown>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

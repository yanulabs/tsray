import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  applyMcpConfig,
  inferConfigFormat,
  isMcpConfigured,
  splitArgs,
  validateServerName,
} from "../src/integration/config.js";
import {
  getMcpConfigPath,
  getSkillBasePath,
  openCodeJsoncSibling,
} from "../src/integration/clients.js";
import {
  applySkill,
  skillDestination,
  skillStatus,
  validateSkillName,
} from "../src/integration/skills.js";

const cleanup: string[] = [];

afterAll(() => {
  for (const directory of cleanup) fs.rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tsray-integration-"));
  cleanup.push(directory);
  return directory;
}

function writeJson(file: string, value: unknown, mode = 0o640): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

const command = { command: "/usr/bin/node", args: ["/tmp/tsray.js", "serve"] };

describe("MCP JSON configuration", () => {
  it("installs OpenCode V2 entries, removes legacy duplicates, and preserves settings", () => {
    const root = temporary();
    const file = path.join(root, "opencode.json");
    writeJson(file, {
      theme: "dark",
      mcp: {
        tsray: { command: "old" },
        servers: { other: { type: "local", command: ["other"] } },
        timeout: { startup: 45000 },
      },
    });

    const change = applyMcpConfig(
      { format: "opencode", path: file },
      "install",
      "tsray",
      { ...command, cwd: "/workspace" }
    );
    expect(change.result).toBe("installed");
    const data = readJson(file);
    expect(data.$schema).toBe("https://opencode.ai/config.json");
    expect(data.theme).toBe("dark");
    expect(data.mcp).toEqual({
      servers: {
        other: { type: "local", command: ["other"] },
        tsray: {
          type: "local",
          command: ["/usr/bin/node", "/tmp/tsray.js", "serve"],
          cwd: "/workspace",
        },
      },
      timeout: { startup: 45000 },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(isMcpConfigured({ format: "opencode", path: file }, "tsray")).toBe(true);

    const second = applyMcpConfig(
      { format: "opencode", path: file },
      "install",
      "tsray",
      { ...command, cwd: "/workspace" }
    );
    expect(second.result).toBe("already_installed");
    expect(second.changed).toBe(false);

    const removed = applyMcpConfig({ format: "opencode", path: file }, "uninstall", "tsray", command);
    expect(removed.result).toBe("removed");
    const after = readJson(file);
    expect(after.mcp).toEqual({
      servers: { other: { type: "local", command: ["other"] } },
      timeout: { startup: 45000 },
    });
  });

  it("writes Claude and Antigravity stdio entries", () => {
    const root = temporary();
    const claude = path.join(root, ".mcp.json");
    applyMcpConfig({ format: "claude", path: claude }, "install", "tsray", command);
    expect(readJson(claude).mcpServers).toEqual({
      tsray: { type: "stdio", command: command.command, args: command.args },
    });
    expect(fs.statSync(claude).mode & 0o777).toBe(0o600);

    const antigravity = path.join(root, "mcp_config.json");
    applyMcpConfig(
      { format: "antigravity", path: antigravity },
      "install",
      "tsray",
      { command: command.command, args: ["serve"] }
    );
    expect(readJson(antigravity).mcpServers).toEqual({
      tsray: {
        command: command.command,
        args: ["serve", "${workspaceFolder}"],
        disabled: false,
      },
    });

    const nodeStyle = path.join(root, "node-antigravity.json");
    applyMcpConfig(
      { format: "antigravity", path: nodeStyle },
      "install",
      "tsray",
      { command: command.command, args: ["/tmp/tsray.js", "serve"] }
    );
    expect(readJson(nodeStyle).mcpServers).toEqual({
      tsray: {
        command: command.command,
        args: ["/tmp/tsray.js", "serve", "${workspaceFolder}"],
        disabled: false,
      },
    });
  });

  it("follows symlinks without replacing them", () => {
    const root = temporary();
    const target = path.join(root, "real.json");
    const link = path.join(root, "opencode.json");
    writeJson(target, {});
    fs.symlinkSync(target, link);

    applyMcpConfig({ format: "opencode", path: link }, "install", "tsray", command);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readJson(target).mcp).toBeDefined();
  });

  it("supports dry runs and rejects malformed roots", () => {
    const root = temporary();
    const file = path.join(root, "new.json");
    const dry = applyMcpConfig(
      { format: "generic", path: file },
      "install",
      "tsray",
      command,
      { dryRun: true }
    );
    expect(dry.changed).toBe(true);
    expect(fs.existsSync(file)).toBe(false);

    fs.writeFileSync(file, "[]\n");
    expect(() => applyMcpConfig({ format: "generic", path: file }, "install", "tsray", command)).toThrow(
      ConfigError
    );
    fs.writeFileSync(file, "{ comments are not JSON }\n");
    expect(() => applyMcpConfig({ format: "generic", path: file }, "install", "tsray", command)).toThrow(
      /invalid JSON/
    );
  });
});

describe("Codex TOML configuration", () => {
  it("preserves unrelated TOML and replaces only the selected server block", () => {
    const root = temporary();
    const file = path.join(root, "config.toml");
    fs.writeFileSync(
      file,
      `# keep this comment\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["serve"]\n\n[mcp_servers.tsray]\ncommand = "old"\n`
    );

    const installed = applyMcpConfig({ format: "codex", path: file }, "install", "tsray", command);
    expect(installed.result).toBe("installed");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# keep this comment");
    expect(text).toContain('model = "gpt-5"');
    expect(text).not.toContain('command = "old"');
    const data = parseToml(text) as { mcp_servers: Record<string, unknown> };
    expect(data.mcp_servers.tsray).toEqual({ command: command.command, args: command.args });
    expect(data.mcp_servers.other).toEqual({ command: "other", args: ["serve"] });

    const removed = applyMcpConfig({ format: "codex", path: file }, "uninstall", "tsray", command);
    expect(removed.result).toBe("removed");
    const after = parseToml(fs.readFileSync(file, "utf8")) as { mcp_servers: Record<string, unknown> };
    expect(after.mcp_servers.tsray).toBeUndefined();
    expect(after.mcp_servers.other).toBeDefined();
  });

  it("refuses inline and dotted mcp_servers definitions", () => {
    const root = temporary();
    const inline = path.join(root, "inline.toml");
    fs.writeFileSync(inline, "mcp_servers = {}\n");
    expect(() => applyMcpConfig({ format: "codex", path: inline }, "install", "tsray", command)).toThrow(
      /inline table/
    );

    const dotted = path.join(root, "dotted.toml");
    fs.writeFileSync(dotted, '[mcp_servers]\n"tsray" = { command = "old" }\n');
    expect(() => applyMcpConfig({ format: "codex", path: dotted }, "install", "tsray", command)).toThrow(
      /dotted key/
    );
  });
});

describe("client paths and validation", () => {
  it("resolves global and project paths with environment overrides", () => {
    const options = {
      home: "/home/test",
      configHome: "/home/test/.config",
      projectRoot: "/repo",
      env: {
        PATH: "",
        CLAUDE_CONFIG_DIR: "/claude",
        CODEX_HOME: "/codex",
        OPENCODE_CONFIG: "/custom/opencode.json",
      },
      platform: "linux" as const,
    };
    expect(getMcpConfigPath("opencode", "global", options)).toBe("/custom/opencode.json");
    expect(getMcpConfigPath("claude", "global", options)).toBe("/claude/.claude.json");
    expect(getMcpConfigPath("codex", "global", options)).toBe("/codex/config.toml");
    expect(getMcpConfigPath("cursor", "project", options)).toBe("/repo/.cursor/mcp.json");
    expect(getSkillBasePath("opencode", "global", options)).toBe("/home/test/.config/opencode/skills");
    expect(getSkillBasePath("agents", "project", options)).toBe("/repo/.agents/skills");
  });

  it("infers formats and detects OpenCode JSONC siblings", () => {
    expect(inferConfigFormat("/repo/opencode.json")).toBe("opencode");
    expect(inferConfigFormat("/repo/.codex/config.toml")).toBe("codex");
    expect(inferConfigFormat("/repo/.agents/mcp_config.json")).toBe("antigravity");
    expect(inferConfigFormat("/repo/.mcp.json")).toBe("claude");
    expect(inferConfigFormat("/repo/custom.json")).toBe("generic");

    const root = temporary();
    const jsonc = path.join(root, "opencode.jsonc");
    fs.writeFileSync(jsonc, "{}\n");
    expect(openCodeJsoncSibling(path.join(root, "opencode.json"))).toBe(jsonc);
  });

  it("splits quoted arguments and validates names", () => {
    expect(splitArgs('serve "/path with spaces" --flag')).toEqual([
      "serve",
      "/path with spaces",
      "--flag",
    ]);
    expect(splitArgs("serve ${workspaceFolder}")).toEqual(["serve", "${workspaceFolder}"]);
    expect(() => splitArgs('serve "unterminated')).toThrow(ConfigError);
    expect(() => validateServerName("bad name")).toThrow(ConfigError);
    expect(() => validateSkillName("../bad")).toThrow(ConfigError);
  });
});

describe("skill installation", () => {
  it("copies, links, reports, and removes a skill safely", () => {
    const root = temporary();
    const source = path.join(root, "source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: test\n---\n");

    const copyDestination = skillDestination(path.join(root, "copy"), "tsray");
    expect(applySkill("install", copyDestination, { source, mode: "copy" }).result).toBe("installed");
    expect(fs.existsSync(path.join(copyDestination, "SKILL.md"))).toBe(true);
    expect(skillStatus(copyDestination)).toBe("installed");
    expect(applySkill("uninstall", copyDestination, { source }).result).toBe("removed");
    expect(skillStatus(copyDestination)).toBe("missing");

    const linkDestination = skillDestination(path.join(root, "link"), "tsray");
    expect(applySkill("install", linkDestination, { source, mode: "link" }).result).toBe("installed");
    expect(fs.lstatSync(linkDestination).isSymbolicLink()).toBe(true);
    expect(skillStatus(linkDestination)).toBe("symlink");
    expect(applySkill("uninstall", linkDestination, { source }).result).toBe("removed");

    const dryDestination = skillDestination(path.join(root, "dry"), "tsray");
    expect(applySkill("install", dryDestination, { source, dryRun: true }).result).toBe("installed");
    expect(fs.existsSync(dryDestination)).toBe(false);
    expect(applySkill("install", source, { source }).result).toBe("skipped_source");
  });
});

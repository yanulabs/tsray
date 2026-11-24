import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import {
  applyMcpConfig,
  inferConfigFormat,
  isMcpConfigured,
  splitArgs,
  validateServerName,
  MCP_TARGETS,
  type ConfigAction,
  type ConfigLocation,
  type McpCommand,
  type McpTarget,
} from "../integration/config.js";
import {
  SKILL_TARGETS,
  configLocationForTarget,
  displayPath,
  getSkillBasePath,
  isCustomPath,
  isTargetDetected,
  openCodeJsoncSibling,
  skillTargetFromToken,
  targetFromToken,
  validateFormat,
  type ClientPathOptions,
  type IntegrationScope,
  type SkillTarget,
} from "../integration/clients.js";
import {
  applySkill,
  findSkillSource,
  skillDestination,
  skillStatus,
  validateSkillName,
  type SkillAction,
  type SkillMode,
} from "../integration/skills.js";

export interface McpIntegrationOptions extends ClientPathOptions {
  action: ConfigAction;
  targets: string[];
  scope: IntegrationScope;
  name: string;
  format?: string;
  configPath?: string;
  command?: string;
  args: string;
  cwd?: string;
  dryRun: boolean;
  yes: boolean;
  interactive: boolean;
}

export interface SkillIntegrationOptions extends ClientPathOptions {
  action: SkillAction;
  targets: string[];
  scope: IntegrationScope;
  name: string;
  directory?: string;
  mode: SkillMode;
  dryRun: boolean;
  yes: boolean;
  interactive: boolean;
}

export async function runMcpIntegration(options: McpIntegrationOptions): Promise<number> {
  validateServerName(options.name);
  if (options.scope !== "global" && options.scope !== "project") {
    throw new Error(`invalid scope ${JSON.stringify(options.scope)} (use global or project)`);
  }
  const command = resolveMcpCommand(options);
  const locations = MCP_TARGETS.map((target) => configLocationForTarget(target, options.scope, options));
  const detected = MCP_TARGETS.filter((target) => isTargetDetected(target, options));
  const installed = locations
    .filter((location) => {
      try {
        return isMcpConfigured(location, options.name);
      } catch {
        return false;
      }
    })
    .map((location) => location.target)
    .filter((target): target is McpTarget => Boolean(target));

  let selected: ConfigLocation[];
  if (options.configPath) {
    const file = path.resolve(expandHome(options.configPath, options));
    const hintedTarget = options.targets.length === 1 ? targetFromToken(options.targets[0]!) : null;
    const format = options.format
      ? validateFormat(options.format)
      : hintedTarget ?? inferConfigFormat(file);
    selected = [{ format, path: file }];
  } else {
    const selection = await selectTargets({
      action: options.action,
      tokens: options.targets,
      detected,
      installed,
      interactive: options.interactive && !options.yes,
      yes: options.yes,
      kind: "mcp",
      locations,
    });
    selected = selection.locations;
  }

  let failures = 0;
  const changes: Array<Record<string, unknown>> = [];
  for (const location of selected) {
    try {
      if (options.action === "status") {
        const configured = isMcpConfigured(location, options.name);
        changes.push({
          path: displayPath(location.path, options),
          format: location.format,
          configured,
        });
        if (!configured) failures++;
        continue;
      }

      if (location.path.endsWith(".jsonc")) {
        throw new Error(
          `${displayPath(location.path, options)} is JSONC; tsray edits JSON only. Use the client's own MCP command or convert the file to JSON.`
        );
      }
      const jsonc = openCodeJsoncSibling(location.path);
      if (options.action === "install" && location.format === "opencode" && !fs.existsSync(location.path) && jsonc) {
        throw new Error(
          `found ${displayPath(jsonc, options)}; refusing to create ${displayPath(location.path, options)} beside it`
        );
      }

      const change = applyMcpConfig(location, options.action, options.name, command, {
        dryRun: options.dryRun,
      });
      changes.push({
        path: displayPath(change.path, options),
        format: change.format,
        result: change.result,
        changed: change.changed,
        ...(options.dryRun ? { after: change.after } : {}),
      });
      if (options.action === "install") {
        const argsDisplay = command.args.join(" ");
        process.stdout.write(
          `${options.dryRun ? "would configure" : "configured"} MCP server ${JSON.stringify(options.name)} -> ${command.command} ${argsDisplay} in ${displayPath(change.path, options)}\n`
        );
      } else if (change.result === "removed") {
        process.stdout.write(
          `${options.dryRun ? "would remove" : "removed"} MCP server ${JSON.stringify(options.name)} from ${displayPath(change.path, options)}\n`
        );
      } else {
        process.stdout.write(
          `not configured: ${JSON.stringify(options.name)} in ${displayPath(change.path, options)}\n`
        );
      }
    } catch (error) {
      failures++;
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  if (options.dryRun || options.action === "status") {
    process.stdout.write(`${JSON.stringify(changes, null, 2)}\n`);
  } else if (options.action === "install" && changes.length > 0) {
    if (selected.some((location) => location.format === "opencode")) {
      process.stdout.write("OpenCode reloads MCP configuration automatically. Verify with: opencode mcp list\n");
    }
    if (selected.some((location) => location.format !== "opencode")) {
      process.stdout.write("Restart the other configured client(s) to pick up the change.\n");
    }
  }

  if (options.action === "status") return failures === 0 ? 0 : 1;
  return options.action === "install" && failures > 0 ? 1 : 0;
}

export async function runSkillIntegration(options: SkillIntegrationOptions): Promise<number> {
  validateSkillName(options.name);
  if (options.scope !== "global" && options.scope !== "project") {
    throw new Error(`invalid scope ${JSON.stringify(options.scope)} (use global or project)`);
  }
  if (options.mode !== "copy" && options.mode !== "link") {
    throw new Error(`invalid skill mode ${JSON.stringify(options.mode)} (use copy or link)`);
  }

  const source = findSkillSource(options.name);
  const bases = new Map<SkillTarget, string>();
  for (const target of SKILL_TARGETS) bases.set(target, getSkillBasePath(target, options.scope, options));
  const detected = SKILL_TARGETS.filter((target) => isTargetDetected(target, options));
  const installed = SKILL_TARGETS.filter(
    (target) => skillStatus(skillDestination(bases.get(target)!, options.name)) !== "missing"
  );

  let destinations: string[];
  if (options.directory) {
    destinations = [skillDestination(path.resolve(expandHome(options.directory, options)), options.name)];
  } else {
    const selection = await selectTargets({
      action: options.action,
      tokens: options.targets,
      detected,
      installed,
      interactive: options.interactive && !options.yes,
      yes: options.yes,
      kind: "skill",
    });
    destinations = selection.targets.map((target) => {
      const base = bases.get(target as SkillTarget);
      return skillDestination(base ?? target, options.name);
    });
  }

  let failures = 0;
  const changes: Array<Record<string, unknown>> = [];
  for (const destination of destinations) {
    try {
      const change = applySkill(options.action, destination, {
        source,
        mode: options.mode,
        dryRun: options.dryRun,
      });
      changes.push({
        path: displayPath(change.destination, options),
        result: change.result,
        mode: change.mode,
        source: change.source ? displayPath(change.source, options) : null,
      });
      if (options.action === "status") {
        if (change.result === "not_installed") failures++;
        continue;
      }
      if (change.result === "installed") {
        process.stdout.write(
          `${options.dryRun ? "would install" : "installed"} skill ${JSON.stringify(options.name)} (${change.mode}): ${displayPath(change.destination, options)}\n`
        );
      } else if (change.result === "removed") {
        process.stdout.write(
          `${options.dryRun ? "would remove" : "removed"} skill ${JSON.stringify(options.name)}: ${displayPath(change.destination, options)}\n`
        );
      } else if (change.result === "skipped_source") {
        process.stdout.write(`skipped ${displayPath(change.destination, options)} (source directory)\n`);
      } else {
        process.stdout.write(`not installed: ${displayPath(change.destination, options)}\n`);
      }
    } catch (error) {
      failures++;
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  if (options.dryRun || options.action === "status") {
    process.stdout.write(`${JSON.stringify(changes, null, 2)}\n`);
  }
  if (options.action === "status") return failures === 0 ? 0 : 1;
  return options.action === "install" && failures > 0 ? 1 : 0;
}

function resolveMcpCommand(options: McpIntegrationOptions): McpCommand {
  const override = options.command ?? options.env?.TSRAY_MCP_COMMAND;
  const args = splitArgs(options.args);
  if (override) {
    const expanded = expandHome(override, options);
    const command = path.isAbsolute(expanded) || expanded.startsWith(".")
      ? path.resolve(expanded)
      : expanded;
    return { command, args, cwd: options.cwd };
  }
  if (process.versions.bun) {
    return { command: process.execPath, args, cwd: options.cwd };
  }
  const cli = path.resolve(import.meta.dirname, "index.js");
  return { command: process.execPath, args: [cli, ...args], cwd: options.cwd };
}

async function selectTargets(context: {
  action: ConfigAction | SkillAction;
  tokens: string[];
  detected: string[];
  installed: string[];
  interactive: boolean;
  yes: boolean;
  kind: "mcp" | "skill";
  locations?: ConfigLocation[];
}): Promise<{ targets: string[]; locations: ConfigLocation[] }> {
  let raw = context.tokens.filter(Boolean);
  if (raw.length === 0) {
    if (context.interactive) {
      raw = [await promptSelection(context)];
    } else if (context.action === "install") {
      raw = ["opencode"];
    } else if (context.action === "uninstall") {
      raw = context.installed.length > 0 ? ["installed"] : [];
    } else {
      raw = context.detected.length > 0 ? ["detected"] : ["all"];
    }
  }

  const tokens = raw.flatMap((value) => {
    const commaParts = value.split(",").map((part) => part.trim()).filter(Boolean);
    return commaParts.flatMap((part) => {
      if (isCustomPath(part) || !/\s/.test(part)) return [part];
      return part.split(/\s+/).filter(Boolean);
    });
  });

  const targets: string[] = [];
  const locations: ConfigLocation[] = [];
  const seenPaths = new Set<string>();
  for (const token of tokens) {
    if (token === "q" || token === "quit") return { targets: [], locations: [] };
    if (token === "all") {
      for (const target of context.kind === "mcp" ? MCP_TARGETS : SKILL_TARGETS) addTarget(target);
      continue;
    }
    if (token === "detected") {
      if (context.detected.length === 0) {
        if (context.action === "uninstall") return { targets: [], locations: [] };
        throw new Error("no existing client directories detected; specify a target explicitly");
      }
      for (const target of context.detected) addTarget(target);
      continue;
    }
    if (token === "installed") {
      if (context.installed.length === 0) {
        if (context.action === "uninstall") return { targets: [], locations: [] };
        throw new Error(`no installed ${context.kind === "mcp" ? "MCP servers" : "skills"} found; specify a target explicitly`);
      }
      for (const target of context.installed) addTarget(target);
      continue;
    }
    if (isCustomPath(token)) {
      if (context.kind !== "mcp") {
        targets.push(path.resolve(expandHome(token, { env: process.env })));
      } else {
        const file = path.resolve(expandHome(token, { env: process.env }));
        const location = { format: inferConfigFormat(file), path: file };
        if (!seenPaths.has(location.path)) {
          seenPaths.add(location.path);
          locations.push(location);
        }
      }
      continue;
    }
    const target = context.kind === "mcp" ? targetFromToken(token) : skillTargetFromToken(token);
    if (!target) throw new Error(`unknown target ${JSON.stringify(token)}`);
    addTarget(target);
  }

  return { targets: [...new Set(targets)], locations };

  function addTarget(target: string): void {
    if (context.kind === "mcp") {
      const typed = target as McpTarget;
      const location = context.locations?.find((candidate) => candidate.target === typed);
      if (location && !seenPaths.has(location.path)) {
        seenPaths.add(location.path);
        locations.push(location);
      }
    } else {
      targets.push(target);
    }
  }
}

async function promptSelection(context: {
  action: ConfigAction | SkillAction;
  detected: string[];
  installed: string[];
  kind: "mcp" | "skill";
  locations?: ConfigLocation[];
}): Promise<string> {
  const candidates = context.kind === "mcp" ? MCP_TARGETS : SKILL_TARGETS;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      `${context.action === "install" ? "Install" : context.action === "uninstall" ? "Uninstall" : "Inspect"} ${context.kind === "mcp" ? "MCP server" : "skill"}. Available targets:\n`
    );
    candidates.forEach((target, index) => {
      const location = context.locations?.find((candidate) => candidate.target === target);
      const pathText = location ? displayPath(location.path) : target;
      const marks = [
        context.detected.includes(target) ? "detected" : "",
        context.installed.includes(target) ? "installed" : "",
      ].filter(Boolean);
      process.stderr.write(
        `  ${index + 1}) ${target.padEnd(12)} ${pathText}${marks.length ? ` [${marks.join(", ")}]` : ""}\n`
      );
    });
    const fallback = context.action === "install"
      ? context.detected.length > 0 ? "detected" : "opencode"
      : context.installed.length > 0 ? "installed" : "q";
    const answer = await rl.question(
      `Select target(s) [numbers/names, comma/space-separated, detected, installed, all, custom path, or q] (${fallback}): `
    );
    return answer.trim() || fallback;
  } finally {
    rl.close();
  }
}

function expandHome(raw: string, options: ClientPathOptions): string {
  const home = options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (raw === "~") return home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(home, raw.slice(2));
  return raw;
}

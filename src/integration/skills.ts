import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./config.js";

export type SkillMode = "copy" | "link";
export type SkillAction = "install" | "uninstall" | "status";

export interface SkillChange {
  source: string | null;
  destination: string;
  result: "installed" | "removed" | "not_installed" | "skipped_source";
  mode: SkillMode;
  dryRun: boolean;
}

export function validateSkillName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new ConfigError(
      `invalid skill name ${JSON.stringify(name)} (use letters, digits, _ or -)`
    );
  }
}

export function findSkillSource(name = "tsray"): string | null {
  const candidates = [
    path.resolve(import.meta.dirname, "..", "..", ".opencode", "skills", name),
    path.resolve(import.meta.dirname, "..", "..", "..", ".opencode", "skills", name),
    path.resolve(process.cwd(), ".opencode", "skills", name),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) return fs.realpathSync(candidate);
  }
  return null;
}

export function skillDestination(base: string, name: string): string {
  validateSkillName(name);
  return path.join(path.resolve(base), name);
}

export function skillStatus(destination: string): "missing" | "installed" | "symlink" | "broken_symlink" {
  try {
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink()) {
      return fs.existsSync(destination) ? "symlink" : "broken_symlink";
    }
    return stat.isDirectory() ? "installed" : "missing";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw new ConfigError(`${destination}: ${String(error)}`);
  }
}

function canonicalDestination(destination: string): string {
  const absolute = path.resolve(destination);
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isSymbolicLink()) return fs.realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  } catch {
    return absolute;
  }
}

export function applySkill(
  action: SkillAction,
  destination: string,
  options: { source?: string | null; mode?: SkillMode; dryRun?: boolean } = {}
): SkillChange {
  const mode = options.mode ?? "copy";
  if (mode !== "copy" && mode !== "link") {
    throw new ConfigError(`invalid skill mode ${JSON.stringify(mode)} (use copy or link)`);
  }
  const source = options.source === undefined ? findSkillSource(path.basename(destination)) : options.source;
  const resolvedSource = source ? fs.realpathSync(source) : null;
  const resolvedDestination = canonicalDestination(destination);

  if (action === "status") {
    return {
      source: resolvedSource,
      destination: resolvedDestination,
      result: skillStatus(resolvedDestination) === "missing" ? "not_installed" : "installed",
      mode,
      dryRun: false,
    };
  }

  if (action === "uninstall") {
    const status = skillStatus(resolvedDestination);
    if (status === "missing") {
      return { source: resolvedSource, destination: resolvedDestination, result: "not_installed", mode, dryRun: Boolean(options.dryRun) };
    }
    if (resolvedSource && resolvedSource === resolvedDestination) {
      return { source: resolvedSource, destination: resolvedDestination, result: "skipped_source", mode, dryRun: Boolean(options.dryRun) };
    }
    if (!options.dryRun) {
      if (status === "symlink" || status === "broken_symlink") fs.unlinkSync(resolvedDestination);
      else fs.rmSync(resolvedDestination, { recursive: true, force: true });
    }
    return { source: resolvedSource, destination: resolvedDestination, result: "removed", mode, dryRun: Boolean(options.dryRun) };
  }

  if (!resolvedSource) {
    throw new ConfigError(
      `skill source not found; expected .opencode/skills/${path.basename(resolvedDestination)}/SKILL.md in the package`
    );
  }
  if (!fs.existsSync(path.join(resolvedSource, "SKILL.md"))) {
    throw new ConfigError(`${resolvedSource}: SKILL.md not found`);
  }
  if (resolvedSource === resolvedDestination) {
    return { source: resolvedSource, destination: resolvedDestination, result: "skipped_source", mode, dryRun: Boolean(options.dryRun) };
  }

  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true, mode: 0o700 });
    fs.rmSync(resolvedDestination, { recursive: true, force: true });
    if (mode === "link") {
      fs.symlinkSync(resolvedSource, resolvedDestination, process.platform === "win32" ? "junction" : "dir");
    } else {
      fs.cpSync(resolvedSource, resolvedDestination, { recursive: true });
    }
  }
  return {
    source: resolvedSource,
    destination: resolvedDestination,
    result: "installed",
    mode,
    dryRun: Boolean(options.dryRun),
  };
}

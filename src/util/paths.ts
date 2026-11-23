import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { DEFAULT_ENTRYPOINTS, DEFAULT_EXCLUDES, matchesAny } from "./glob.js";
import type { ResolvedProject, TsrayConfig } from "../index/types.js";

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function isSourceFile(file: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(file);
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function isWorkspaceRoot(dir: string): boolean {
  if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
  const pkg = readJsonFile<{ workspaces?: unknown }>(path.join(dir, "package.json"));
  if (!pkg) return false;
  const workspaces = pkg.workspaces;
  return Array.isArray(workspaces) || (typeof workspaces === "object" && workspaces !== null);
}

function findUp(start: string, predicate: (dir: string) => boolean): string | null {
  let dir = start;
  while (true) {
    if (predicate(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function normalizeRoot(input: string): string {
  const absolute = path.resolve(input || ".");
  const stat = fs.statSync(absolute);
  const dir = stat.isDirectory() ? absolute : path.dirname(absolute);
  return fs.realpathSync(dir);
}

export function loadConfig(root: string): TsrayConfig {
  const candidates = [
    path.join(root, "tsray.json"),
    path.join(root, "tsray.config.json"),
  ];
  let raw: Record<string, unknown> = {};
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = readJsonFile<Record<string, unknown>>(candidate);
    if (!parsed) {
      throw new Error(`Invalid JSON in ${candidate}`);
    }
    raw = parsed;
    break;
  }

  const stringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  const summaries =
    raw.summaries && typeof raw.summaries === "object"
      ? (raw.summaries as Record<string, unknown>)
      : {};
  const runner =
    raw.runner && typeof raw.runner === "object" ? (raw.runner as Record<string, unknown>) : {};

  return {
    entrypoints: stringArray(raw.entrypoints),
    exclude: stringArray(raw.exclude),
    projectId: typeof raw.projectId === "string" && raw.projectId.trim() ? raw.projectId.trim() : undefined,
    summaries: {
      promptVersion:
        typeof summaries.promptVersion === "string" && summaries.promptVersion.trim()
          ? summaries.promptVersion.trim()
          : "v1",
    },
    runner: {
      test: typeof runner.test === "string" ? runner.test : undefined,
      typecheck: typeof runner.typecheck === "string" ? runner.typecheck : undefined,
      lint: typeof runner.lint === "string" ? runner.lint : undefined,
    },
  };
}

function readPackageName(root: string): string | null {
  const pkg = readJsonFile<{ name?: string }>(path.join(root, "package.json"));
  return typeof pkg?.name === "string" && pkg.name.trim() ? pkg.name.trim() : null;
}

function configReferences(configPath: string, seen: Set<string>): string[] {
  const resolved = path.resolve(configPath);
  if (seen.has(resolved)) return [];
  seen.add(resolved);

  const read = ts.readConfigFile(resolved, ts.sys.readFile);
  if (read.error || !read.config) return [];
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(resolved), undefined, resolved);
  const references = (parsed.projectReferences ?? [])
    .map((reference) => path.resolve(reference.path))
    .filter((reference) => fs.existsSync(reference) && fs.statSync(reference).isDirectory())
    .map((reference) => path.join(reference, "tsconfig.json"))
    .filter((reference) => fs.existsSync(reference));

  const nested: string[] = [];
  for (const reference of references) {
    nested.push(...configReferences(reference, seen));
  }
  return [...references, ...nested];
}

function discoverWorkspaceConfigs(root: string): string[] {
  const results = ts.sys.readDirectory(
    root,
    [".json"],
    ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**", "**/.turbo/**"],
    ["**/tsconfig.json", "**/tsconfig.*.json"],
    12
  );
  return results.filter((file) => path.basename(file).startsWith("tsconfig"));
}

/**
 * Resolves a path to the owning project. Supports a single tsconfig, a
 * solution-style root with project references, and pnpm/npm workspace roots.
 */
export function resolveProject(
  inputPath: string,
  options: { tsconfig?: string; workspace?: boolean } = {}
): ResolvedProject {
  const start = normalizeRoot(inputPath);

  let root: string;
  let primaryTsconfigPath: string | null = null;

  if (options.tsconfig) {
    primaryTsconfigPath = path.resolve(start, options.tsconfig);
    if (!fs.existsSync(primaryTsconfigPath)) {
      throw new Error(`tsconfig not found: ${primaryTsconfigPath}`);
    }
    root = fs.realpathSync(path.dirname(primaryTsconfigPath));
  } else if (options.workspace) {
    const workspaceRoot = findUp(start, isWorkspaceRoot);
    if (!workspaceRoot) {
      throw new Error(`No workspace root (pnpm-workspace.yaml or package.json#workspaces) found upward from ${inputPath}`);
    }
    root = fs.realpathSync(workspaceRoot);
  } else {
    const nearestConfig = findUp(start, (dir) => fs.existsSync(path.join(dir, "tsconfig.json")));
    if (nearestConfig) {
      root = fs.realpathSync(nearestConfig);
      primaryTsconfigPath = path.join(root, "tsconfig.json");
    } else {
      const workspaceRoot = findUp(start, isWorkspaceRoot);
      if (!workspaceRoot) {
        throw new Error(`No tsconfig.json found upward from ${inputPath}`);
      }
      root = fs.realpathSync(workspaceRoot);
    }
  }

  const config = loadConfig(root);
  const configSet = new Set<string>();

  if (primaryTsconfigPath) configSet.add(primaryTsconfigPath);

  if (primaryTsconfigPath) {
    for (const reference of configReferences(primaryTsconfigPath, new Set())) {
      configSet.add(reference);
    }
  }

  if (!primaryTsconfigPath || options.workspace || isWorkspaceRoot(root)) {
    for (const discovered of discoverWorkspaceConfigs(root)) {
      // Prefer leaf project configs. Solution roots are followed through references.
      configSet.add(discovered);
      for (const reference of configReferences(discovered, new Set())) configSet.add(reference);
    }
  }

  const tsconfigPaths = [...configSet].sort();
  if (tsconfigPaths.length === 0) {
    throw new Error(`No usable tsconfig.json found under ${root}`);
  }
  const primary = primaryTsconfigPath ?? tsconfigPaths[0]!;
  const projectId = config.projectId ?? readPackageName(root) ?? path.basename(root);

  return {
    root,
    projectId,
    tsconfigPaths,
    primaryTsconfigPath: primary,
    workspace: Boolean(options.workspace) || isWorkspaceRoot(root),
    config,
  };
}

/**
 * Groups a repo-relative file into a logical architecture module.
 */
export function deriveModuleName(relFile: string): string {
  const parts = relFile.split("/");
  if (parts[0] === "packages" || parts[0] === "apps") {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]!;
  }
  const clean = parts[0] === "src" ? parts.slice(1) : parts;
  if (clean.length <= 1) return "root";
  if (["features", "modules", "pages", "app", "routes", "domains"].includes(clean[0]!) && clean.length >= 3) {
    return `${clean[0]}/${clean[1]}`;
  }
  return clean[0]!;
}

export function isExcluded(relFile: string, config: TsrayConfig): boolean {
  return matchesAny([...DEFAULT_EXCLUDES, ...config.exclude], relFile);
}

export function isEntrypointFile(relFile: string, config: TsrayConfig, packageEntrypoints: string[]): boolean {
  return matchesAny([...DEFAULT_ENTRYPOINTS, ...config.entrypoints, ...packageEntrypoints], relFile);
}

/**
 * Reads package.json#exports/main/module/bin and maps them to source files.
 * This keeps library entrypoints alive in dead-code analysis.
 */
export function readPackageEntrypoints(root: string): string[] {
  const pkg = readJsonFile<Record<string, unknown>>(path.join(root, "package.json"));
  if (!pkg) return [];

  const candidates = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      candidates.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) visit(item);
    }
  };

  visit(pkg.exports);
  visit(pkg.main);
  visit(pkg.module);
  visit(pkg.bin);

  const patterns: string[] = [];
  for (const candidate of candidates) {
    const clean = toPosix(candidate).replace(/^\.\//, "");
    if (!clean || clean.includes("*")) continue;
    const absolute = path.resolve(root, clean);
    const relative = toPosix(path.relative(root, absolute));
    if (relative.startsWith("..")) continue;
    if (isSourceFile(relative)) {
      patterns.push(relative);
      continue;
    }
    const withoutExtension = relative.replace(/\.(mjs|cjs|js|mts|cts)$/, "");
    patterns.push(`${withoutExtension}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`);
  }
  return patterns;
}

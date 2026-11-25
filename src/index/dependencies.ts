import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { sha256, stableStringify } from "./hasher.js";
import { toPosix } from "../util/paths.js";

type DependencyFields = "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";

interface PackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  exports?: unknown;
  types?: unknown;
  typings?: unknown;
}

interface ResolvedDependency {
  name: string;
  version: string;
  integrity?: string;
  resolved?: string;
  local?: boolean;
}

export interface LocalWorkspaceDependency {
  name: string;
  directory: string;
  manifestHash: string;
}

const DEPENDENCY_FIELDS: DependencyFields[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function dependencySpecs(manifest: PackageManifest): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (typeof version === "string") result[name] = version;
    }
  }
  return result;
}

function productionDependencySpecs(manifest: PackageManifest): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (typeof version === "string") result[name] = version;
    }
  }
  return result;
}

function productionManifestPayload(manifest: PackageManifest): Record<string, unknown> {
  return {
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies ?? {},
    peerDependencies: manifest.peerDependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {},
    exports: manifest.exports,
    types: manifest.types ?? manifest.typings,
  };
}

function manifestPayload(manifest: PackageManifest): Record<string, unknown> {
  return {
    name: manifest.name,
    version: manifest.version,
    dependencies: manifest.dependencies ?? {},
    devDependencies: manifest.devDependencies ?? {},
    peerDependencies: manifest.peerDependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {},
    exports: manifest.exports,
    types: manifest.types ?? manifest.typings,
  };
}

function pnpmBaseVersion(version: string): string {
  return version.split("(")[0]!.replace(/^link:/, "");
}

export class WorkspaceDependencyIndex {
  private readonly manifests = new Map<string, { directory: string; manifest: PackageManifest; hash: string }>();
  private readonly packagesByName = new Map<string, string>();
  private readonly lock: { kind: "pnpm" | "npm" | "yarn"; data: Record<string, unknown> } | null;
  private readonly fingerprintCache = new Map<string, string>();

  constructor(private readonly root: string, projectPaths: string[]) {
    const directories = new Set<string>([root, ...projectPaths.map((file) => path.dirname(file))]);
    const pnpmFile = path.join(root, "pnpm-lock.yaml");
    const npmFile = path.join(root, "package-lock.json");
    const yarnFile = path.join(root, "yarn.lock");
    if (fs.existsSync(pnpmFile)) {
      try {
        this.lock = { kind: "pnpm", data: asRecord(parseYaml(fs.readFileSync(pnpmFile, "utf8"))) };
      } catch {
        this.lock = null;
      }
    } else if (fs.existsSync(npmFile)) {
      const data = readJson<Record<string, unknown>>(npmFile);
      this.lock = data ? { kind: "npm", data } : null;
    } else if (fs.existsSync(yarnFile)) {
      try {
        this.lock = { kind: "yarn", data: asRecord(parseYaml(fs.readFileSync(yarnFile, "utf8"))) };
      } catch {
        this.lock = null;
      }
    } else {
      this.lock = null;
    }

    if (this.lock?.kind === "pnpm") {
      for (const importer of Object.keys(asRecord(this.lock.data.importers))) {
        if (importer !== ".") directories.add(path.resolve(root, importer));
      }
    }
    if (this.lock?.kind === "npm") {
      for (const key of Object.keys(asRecord(this.lock.data.packages))) {
        if (!key || key.includes("node_modules/")) continue;
        const manifest = readJson<PackageManifest>(path.join(root, key, "package.json"));
        if (manifest?.name) directories.add(path.join(root, key));
      }
    }

    for (const directory of directories) {
      const manifest = readJson<PackageManifest>(path.join(directory, "package.json"));
      if (!manifest) continue;
      const hash = sha256(stableStringify(manifestPayload(manifest)));
      this.manifests.set(path.resolve(directory), { directory: path.resolve(directory), manifest, hash });
      if (manifest.name) this.packagesByName.set(manifest.name, path.resolve(directory));
    }
  }

  localDependencies(projectPath: string): LocalWorkspaceDependency[] {
    const project = this.manifests.get(path.dirname(projectPath));
    if (!project) return [];
    const locals: LocalWorkspaceDependency[] = [];
    for (const [name, specifier] of Object.entries(dependencySpecs(project.manifest))) {
      const directory = this.packagesByName.get(name);
      if (!directory) continue;
      const dependency = this.manifests.get(directory);
      if (!dependency || (specifier !== "workspace:*" && !specifier.startsWith("workspace:") && !specifier.startsWith("link:"))) {
        continue;
      }
      locals.push({ name, directory, manifestHash: dependency.hash });
    }
    return locals.sort((a, b) => a.name.localeCompare(b.name));
  }

  fingerprint(projectPath: string): string {
    const cached = this.fingerprintCache.get(projectPath);
    if (cached) return cached;
    const project = this.manifests.get(path.dirname(projectPath));
    const direct = project ? dependencySpecs(project.manifest) : {};
    const resolved: ResolvedDependency[] = [];
    const visited = new Set<string>();
    const visit = (name: string, specifier: string, importer: string, versionHint?: string): void => {
      const key = `${name}@${specifier}@${versionHint ?? ""}@${importer}`;
      if (visited.has(key)) return;
      visited.add(key);
      const localDirectory = this.packagesByName.get(name);
      if (localDirectory && (specifier.startsWith("workspace:") || specifier.startsWith("link:"))) {
        const local = this.manifests.get(localDirectory)!;
        const localHash = sha256(stableStringify(productionManifestPayload(local.manifest)));
        resolved.push({ name, version: specifier, integrity: localHash, local: true });
        this.visitManifest(local.manifest, localDirectory, visit, visited);
        return;
      }
      const entry = this.resolveExternal(name, importer, versionHint);
      resolved.push({ name, version: entry?.version ?? versionHint ?? specifier, integrity: entry?.integrity, resolved: entry?.resolved });
      for (const [child, childVersion] of Object.entries(entry?.dependencies ?? {})) {
        visit(child, String(childVersion), entry?.importer ?? importer, String(childVersion));
      }
    };
    if (project) {
      const importer = this.importerKey(path.dirname(projectPath));
      for (const [name, specifier] of Object.entries(direct)) {
        const locked = this.lockedDirect(name, importer);
        visit(name, specifier, importer, locked?.version);
      }
    }
    resolved.sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
    const fingerprint = sha256(stableStringify({
      project: project?.hash ?? "",
      dependencies: resolved,
    }));
    this.fingerprintCache.set(projectPath, fingerprint);
    return fingerprint;
  }

  private visitManifest(
    manifest: PackageManifest,
    directory: string,
    visit: (name: string, specifier: string, importer: string, versionHint?: string) => void,
    visited: Set<string>
  ): void {
    const importer = this.importerKey(directory);
    for (const [name, specifier] of Object.entries(productionDependencySpecs(manifest))) {
      const key = `local:${importer}:${name}:${specifier}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const locked = this.lockedDirect(name, importer);
      visit(name, specifier, importer, locked?.version);
    }
  }

  private importerKey(directory: string): string {
    const relative = toPosix(path.relative(this.root, directory));
    return relative || ".";
  }

  private lockedDirect(name: string, importer: string): { version?: string; integrity?: string; resolved?: string; dependencies?: Record<string, unknown>; importer?: string } | null {
    if (this.lock?.kind === "pnpm") {
      const importerRecord = asRecord(asRecord(this.lock.data.importers)[importer]);
      let entry: Record<string, unknown> = {};
      for (const field of DEPENDENCY_FIELDS) {
        const candidate = asRecord(importerRecord[field])[name];
        if (candidate) {
          entry = asRecord(candidate);
          break;
        }
      }
      const version = typeof entry.version === "string" ? entry.version : undefined;
      const resolved = this.pnpmPackage(name, version);
      return { version, integrity: resolved?.integrity, resolved: resolved?.resolved, dependencies: resolved?.dependencies, importer };
    }
    if (this.lock?.kind === "npm") {
      const resolved = this.npmPackage(name, importer);
      return { version: resolved?.version, integrity: resolved?.integrity, resolved: resolved?.resolved, dependencies: resolved?.dependencies, importer: resolved?.importer };
    }
    if (this.lock?.kind === "yarn") {
      const entry = Object.entries(this.lock.data).find(([key]) => key.startsWith(`${name}@`))?.[1];
      const record = asRecord(entry);
      return {
        version: typeof record.version === "string" ? record.version : undefined,
        integrity: typeof record.integrity === "string" ? record.integrity : undefined,
        resolved: typeof record.resolved === "string" ? record.resolved : undefined,
        dependencies: asRecord(record.dependencies),
        importer,
      };
    }
    return null;
  }

  private resolveExternal(name: string, importer: string, versionHint?: string): { version?: string; integrity?: string; resolved?: string; dependencies?: Record<string, unknown>; importer?: string } | null {
    if (this.lock?.kind === "pnpm") return this.pnpmPackage(name, versionHint);
    if (this.lock?.kind === "npm") return this.npmPackage(name, importer);
    if (this.lock?.kind === "yarn") return this.lockedDirect(name, importer);
    return null;
  }

  private pnpmPackage(name: string, version?: string): { integrity?: string; resolved?: string; dependencies?: Record<string, unknown> } | null {
    if (!this.lock || this.lock.kind !== "pnpm" || !version) return null;
    const packages = asRecord(this.lock.data.packages);
    const snapshots = asRecord(this.lock.data.snapshots);
    const base = pnpmBaseVersion(version);
    const find = (record: Record<string, unknown>): Record<string, unknown> | null => {
      const exact = record[`${name}@${version}`] ?? record[`${name}@${base}`];
      if (exact) return asRecord(exact);
      const prefix = `${name}@${base}`;
      const key = Object.keys(record).find((candidate) => candidate === prefix || candidate.startsWith(`${prefix}(`));
      return key ? asRecord(record[key]) : null;
    };
    const packageEntry = find(packages);
    const snapshot = find(snapshots);
    const resolution = asRecord(packageEntry?.resolution);
    return {
      integrity: typeof resolution.integrity === "string" ? resolution.integrity : undefined,
      resolved: typeof resolution.resolved === "string" ? resolution.resolved : undefined,
      dependencies: asRecord(snapshot?.dependencies),
    };
  }

  private npmPackage(name: string, importer: string): { version?: string; integrity?: string; resolved?: string; dependencies?: Record<string, unknown>; importer?: string } | null {
    if (!this.lock || this.lock.kind !== "npm") return null;
    const packages = asRecord(this.lock.data.packages);
    const directory = importer === "." ? this.root : path.resolve(this.root, importer);
    const candidates: string[] = [];
    let current = directory;
    while (current.startsWith(this.root)) {
      candidates.push(toPosix(path.relative(this.root, path.join(current, "node_modules", name))));
      if (current === this.root) break;
      current = path.dirname(current);
    }
    for (const candidate of candidates) {
      const entry = asRecord(packages[candidate]);
      if (Object.keys(entry).length === 0) continue;
      return {
        version: typeof entry.version === "string" ? entry.version : undefined,
        integrity: typeof entry.integrity === "string" ? entry.integrity : undefined,
        resolved: typeof entry.resolved === "string" ? entry.resolved : undefined,
        dependencies: asRecord(entry.dependencies),
        importer: candidate.includes("/node_modules/") ? candidate.slice(0, candidate.lastIndexOf("/node_modules/")) : ".",
      };
    }
    return null;
  }
}

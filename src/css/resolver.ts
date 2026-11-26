import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { CssAnalysisProject } from "./types.js";

export const PREPROCESSOR_RE = /\.(scss|sass|less|styl|stylus)$/i;
export const CSS_RE = /\.css$/i;

const GENERATED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "generated",
  "__generated__",
]);

/**
 * Imported build artifacts are not project sources. They are skipped by
 * default; callers can still analyze compiled output explicitly through
 * `extra_css_files`.
 */
export function isGeneratedCssFile(file: string, root?: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (/\.min\.css$/i.test(normalized)) return true;

  const relative = root ? path.relative(root, file).replace(/\\/g, "/") : normalized;
  const segments = (relative.startsWith("..") ? normalized : relative).split("/");
  return segments.some((segment) => GENERATED_SEGMENTS.has(segment.toLowerCase()));
}

export function isCssSpecifier(specifier: string): boolean {
  return CSS_RE.test(stripQuery(specifier));
}

export function isPreprocessorSpecifier(specifier: string): boolean {
  return PREPROCESSOR_RE.test(stripQuery(specifier));
}

function stripQuery(specifier: string): string {
  return specifier.replace(/[?#].*$/, "");
}

function canonicalFile(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    } catch {
      return path.resolve(file);
    }
  }
}

function existingFile(file: string): string | null {
  try {
    return fs.statSync(file).isFile() ? canonicalFile(file) : null;
  } catch {
    return null;
  }
}

function resolveBaseDir(project: CssAnalysisProject): string {
  const options = project.compilerOptions as { pathsBasePath?: string; baseUrl?: string };
  if (typeof options.pathsBasePath === "string" && options.pathsBasePath) {
    return path.resolve(options.pathsBasePath);
  }
  if (typeof options.baseUrl === "string" && options.baseUrl) {
    return path.resolve(options.baseUrl);
  }
  return path.dirname(project.tsconfigPath);
}

/**
 * Resolves a CSS import exactly the way the owning TypeScript project would
 * resolve a module: relative paths first, then `baseUrl`, then `paths`, then
 * package resolution. This avoids `path.resolve(dir, specifier)` false misses
 * for aliases such as `@/styles/Button.module.css`.
 */
export function resolveCssSpecifier(
  specifier: string,
  containingFile: string,
  project: CssAnalysisProject
): string | null {
  const clean = stripQuery(specifier);
  if (!clean) return null;

  if (path.isAbsolute(clean)) return existingFile(clean);

  if (clean.startsWith(".")) {
    return existingFile(path.resolve(path.dirname(containingFile), clean));
  }

  const baseDir = resolveBaseDir(project);
  const options = project.compilerOptions as {
    paths?: Record<string, readonly string[]>;
  };

  // TypeScript prefers the longest matching prefix in `paths`. Evaluate every
  // matching pattern and keep the most specific successful candidate.
  const candidates: Array<{ score: number; file: string }> = [];
  if (options.paths) {
    for (const [pattern, targets] of Object.entries(options.paths)) {
      const star = pattern.indexOf("*");
      if (star === -1) {
        if (pattern !== clean) continue;
        for (const target of targets) {
          const candidate = existingFile(path.resolve(baseDir, target));
          if (candidate) candidates.push({ score: pattern.length, file: candidate });
        }
        continue;
      }

      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!clean.startsWith(prefix) || !clean.endsWith(suffix)) continue;
      if (clean.length < prefix.length + suffix.length) continue;

      const matched = clean.slice(prefix.length, clean.length - suffix.length);
      for (const target of targets) {
        const replaced = target.replace("*", matched);
        const candidate = existingFile(path.resolve(baseDir, replaced));
        if (candidate) candidates.push({ score: prefix.length + suffix.length, file: candidate });
      }
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
    return candidates[0]!.file;
  }

  const baseUrlCandidate = existingFile(path.resolve(baseDir, clean));
  if (baseUrlCandidate) return baseUrlCandidate;

  try {
    const requireFromFile = createRequire(containingFile);
    const resolved = requireFromFile.resolve(clean);
    const file = existingFile(resolved);
    if (file) return file;
  } catch {
    // The package may be ESM-only or not expose a CSS subpath to require().
  }

  return null;
}

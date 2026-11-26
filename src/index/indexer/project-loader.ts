import path from "node:path";
import ts from "typescript";
import type { resolveProject } from "../../util/paths.js";
import {
  isExcluded,
  isSourceFile,
  resolveReferencedTsconfig,
  toPosix,
} from "../../util/paths.js";
import { canonicalPath } from "./symbol-utils.js";
import type { ParsedProject } from "./types.js";

export interface LoadedProjects {
  parsedProjects: ParsedProject[];
  activeProjects: ParsedProject[];
  fileList: string[];
  fileVersions: Map<string, number>;
  removedFiles: Set<string>;
}

export function loadProjects(
  root: string,
  config: ReturnType<typeof resolveProject>["config"],
  tsconfigPaths: string[],
  previousVersions: ReadonlyMap<string, number>
): LoadedProjects {
  const isIgnoredAbsolute = (file: string): boolean => {
    const absolute = path.resolve(file);
    if (absolute.includes(`${path.sep}node_modules${path.sep}`)) return true;
    const relative = toPosix(path.relative(root, absolute));
    if (relative.startsWith("..")) return false;
    return isExcluded(relative, config);
  };

  const parsed: ParsedProject[] = [];

    for (const requestedConfigPath of tsconfigPaths) {
      const configPath = canonicalPath(requestedConfigPath);
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      if (read.error) {
        throw new Error(
          `Failed to read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`
        );
      }
      const result = ts.parseJsonConfigFileContent(
        read.config,
        ts.sys,
        path.dirname(configPath),
        undefined,
        configPath
      );
      const errors = result.errors.filter((error) => error.category === ts.DiagnosticCategory.Error);
      if (errors.length > 0) {
        throw new Error(
          `Failed to parse ${configPath}: ${ts.flattenDiagnosticMessageText(errors[0]!.messageText, "\n")}`
        );
      }
      const fileNames = result.fileNames.map((file) => path.resolve(file));
      const options: ts.CompilerOptions = {
        ...result.options,
        skipLibCheck: true,
        // The language service never emits; avoiding declaration output prevents
        // composite projects from requiring prebuilt referenced projects.
        noEmit: result.options.composite ? false : result.options.noEmit,
      };
      if (options.jsx === undefined) options.jsx = ts.JsxEmit.ReactJSX;
      if (options.allowJs === undefined && fileNames.some((file) => /\.[cm]?jsx?$/.test(file))) {
        options.allowJs = true;
      }
      if (!options.moduleResolution) options.moduleResolution = ts.ModuleResolutionKind.Bundler;
      parsed.push({
        path: configPath,
        options,
        fileNames,
        programFiles: fileNames
          .filter((file) => isSourceFile(file) && !isIgnoredAbsolute(file))
          .map(canonicalPath)
          .sort(),
        ownedFiles: [],
        references: (result.projectReferences ?? [])
          .map((reference) =>
            resolveReferencedTsconfig(path.resolve(path.dirname(configPath), reference.path))
          )
          .filter((reference): reference is string => reference !== null)
          .map(canonicalPath),
      });
    }

    if (parsed.length === 0) throw new Error(`No TypeScript project could be loaded from ${root}`);

    // A file can be included by several configs (for example tsconfig.app and
    // tsconfig.lib). Assign it once, preferring the broadest applicable config
    // so tests and demos are not lost or checked under a library-only config.
    const candidates = parsed
      .filter((project) => project.fileNames.length > 0)
      .sort((a, b) => b.fileNames.length - a.fileNames.length || a.path.localeCompare(b.path));
    const files = new Set<string>();
    for (const project of candidates) {
      for (const file of project.fileNames) {
        if (!isSourceFile(file) || isIgnoredAbsolute(file)) continue;
        const absolute = canonicalPath(file);
        if (files.has(absolute)) continue;
        files.add(absolute);
        project.ownedFiles.push(absolute);
      }
      project.ownedFiles.sort();
    }
    const activeProjects = candidates.filter((project) => project.ownedFiles.length > 0);
    const fileList = [...files].sort();
    const fileVersions = new Map(previousVersions);
    for (const file of fileList) {
      if (!fileVersions.has(file)) fileVersions.set(file, 1);
    }

    // A changed tsconfig can remove files as well as add them.
    const allowed = new Set(fileList);
    const removedFiles = new Set<string>();
    for (const file of fileVersions.keys()) {
      if (!allowed.has(file)) {
        fileVersions.delete(file);
        removedFiles.add(file);
      }
    }

    return { parsedProjects: parsed, activeProjects, fileList, fileVersions, removedFiles };
  }

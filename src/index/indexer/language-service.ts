import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { canonicalPath } from "./symbol-utils.js";
import type { ParsedProject } from "./types.js";

export interface LanguageServiceOptions {
  root: string;
  fileVersions: ReadonlyMap<string, number>;
  scriptSnapshots: Map<string, { version: string; snapshot: ts.IScriptSnapshot }>;
  documentRegistry: ts.DocumentRegistry;
}

export function createLanguageService(
  project: ParsedProject,
  options: LanguageServiceOptions
): ts.LanguageService {
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => project.programFiles,
    getScriptVersion: (fileName) => {
      const absolute = path.resolve(fileName);
      return String(
        options.fileVersions.get(absolute) ??
          options.fileVersions.get(canonicalPath(absolute)) ??
          0
      );
    },
    getScriptSnapshot: (fileName) => {
      const absolute = path.resolve(fileName);
      const version = String(
        options.fileVersions.get(absolute) ??
          options.fileVersions.get(canonicalPath(absolute)) ??
          0
      );
      const cached = options.scriptSnapshots.get(absolute);
      if (cached && cached.version === version) return cached.snapshot;
      if (!fs.existsSync(absolute)) return undefined;
      const text = fs.readFileSync(absolute, "utf8");
      const snapshot = ts.ScriptSnapshot.fromString(text);
      options.scriptSnapshots.set(absolute, { version, snapshot });
      return snapshot;
    },
    getCurrentDirectory: () => options.root,
    getCompilationSettings: () => project.options,
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: (...args) => ts.sys.readDirectory(...args).sort(),
    directoryExists: ts.sys.directoryExists,
    getDirectories: (directory) => ts.sys.getDirectories(directory).sort(),
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  };
  return ts.createLanguageService(host, options.documentRegistry);
}

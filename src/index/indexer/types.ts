import type ts from "typescript";
import type { resolveProject } from "../../util/paths.js";
import type {
  DiagnosticWarning,
  EdgeRecord,
  FileImportEdge,
  FileRecord,
  ProjectCacheProvider,
  SymbolRecord,
} from "../types.js";

export interface IndexerOptions {
  tsconfig?: string;
  workspace?: boolean;
  /** Recompute diagnostics unless a matching persistent workspace cache exists. */
  fullDiagnostics?: boolean;
  /** Serve and persist the semantic graph even when production diagnostics exist. */
  allowErrors?: boolean;
  /** Process independent owning projects in worker threads during full builds. */
  parallel?: boolean;
  /** Optional SQLite-backed per-project output cache. */
  projectCache?: ProjectCacheProvider;
}

/** @internal */
export interface ParsedProject {
  path: string;
  options: ts.CompilerOptions;
  fileNames: string[];
  programFiles: string[];
  ownedFiles: string[];
  references: string[];
}

export interface PendingWrap {
  fromId: string;
  expression: ts.Expression;
  sourceFile: ts.SourceFile;
}

export interface DiagnosticCacheEntry {
  version: string;
  diagnostics: DiagnosticWarning[];
}

export interface SerializedProjectIndex {
  projectPath: string;
  symbols: Array<[string, SymbolRecord]>;
  edges: EdgeRecord[];
  fileImports: FileImportEdge[];
  files: Array<[string, FileRecord]>;
  warnings: DiagnosticWarning[];
  prodErrors: DiagnosticWarning[];
  modules: string[];
}

export interface ProjectWorkerTask {
  bootstrap: IndexerBootstrap;
  projects: Array<{ path: string }>;
  fullDiagnostics: boolean;
}

export interface IndexerBootstrap {
  root: string;
  projectId: string;
  tsconfigPath: string;
  tsconfigPaths: string[];
  workspace: boolean;
  config: ReturnType<typeof resolveProject>["config"];
  projects: ParsedProject[];
  packageEntrypoints: string[];
  fileList: string[];
  fileVersions: Array<[string, number]>;
}

export interface ProjectWorkerOutput {
  results?: SerializedProjectIndex[];
  error?: string;
}

export interface IndexAccumulator {
  symbols: Map<string, SymbolRecord>;
  edges: EdgeRecord[];
  fileImports: FileImportEdge[];
  files: Map<string, FileRecord>;
  warnings: DiagnosticWarning[];
  prodErrors: DiagnosticWarning[];
  modules: Set<string>;
  declarationIds: Map<string, string>;
  pendingWraps: PendingWrap[];
  seenFileImports: Set<string>;
  seenEdges: Set<string>;
  symbolBody: Map<string, boolean>;
}

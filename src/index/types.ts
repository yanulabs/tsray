/**
 * Shared domain model for the tsray index.
 *
 * Canonical symbol IDs are line-independent:
 *   sym:<repo-relative-file>:<Container>#<name>
 *   file:<repo-relative-file>
 * Container is present for class methods only.
 */

export type SymbolKind =
  | "component"
  | "hook"
  | "context"
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable";

export type EdgeKind =
  | "imports"
  | "re_exports"
  | "calls"
  | "renders"
  | "wraps"
  | "uses_hook"
  | "provides_context"
  | "consumes_context"
  | "implements"
  | "references";

export type StalenessState =
  | "synced"
  | "soft_stale"
  | "hard_stale"
  | "missing"
  | "not_eligible";

export type FrameworkDirective = "use client" | "use server" | null;

export interface SymbolRecord {
  id: string;
  name: string;
  kind: SymbolKind;
  module: string;
  file: string;
  line: number;
  endLine: number;
  loc: number;
  members: number;
  parentId: string | null;
  exported: boolean;
  defaultExport: boolean;
  isTest: boolean;
  isGenerated: boolean;
  isEntrypoint: boolean;
  directive: FrameworkDirective;
  complexity: number;
  propsType: string | null;
  signature: string;
  /** JSDoc summary text without comment delimiters. */
  doc: string;
  sigHash: string;
  selfHash: string;
  depHash: string;
  contentHash: string;
  eligible: boolean;
  sourcePreview: string;
}

export interface EdgeRecord {
  fromId: string;
  toId: string;
  kind: EdgeKind;
  file: string;
  line: number;
  /** Optional disambiguator such as the interface behind a dispatch edge. */
  via?: string;
}

export interface FileRecord {
  path: string;
  module: string;
  loc: number;
  prodLoc: number;
  testLoc: number;
  generated: boolean;
  isTest: boolean;
  isEntrypoint: boolean;
  directive: FrameworkDirective;
  exports: number;
  imports: number;
}

export interface FileImportEdge {
  fromFile: string;
  toFile: string;
  specifier: string;
  line: number;
  fromModule: string;
  toModule: string;
  typeOnly: boolean;
  isTest: boolean;
}

export interface DiagnosticWarning {
  file: string;
  line: number;
  code: number;
  message: string;
  isTest: boolean;
}

export interface ProjectIndexDetail {
  project: string;
  status: "cached" | "rebuilt" | "empty";
  files: number;
  diagnostics_cached: number;
  project_sig_hash: string | null;
}

export interface ProjectIndexMetrics {
  projects_total: number;
  projects_cached: number;
  projects_rebuilt: number;
  projects_empty: number;
  workers_spawned: number;
  diagnostics_cached: number;
}

export interface ProjectCacheEntry {
  cacheVersion: 2;
  projectPath: string;
  inputHash: string;
  projectSigHash: string;
  outputHash: string;
  symbols: SymbolRecord[];
  edges: EdgeRecord[];
  fileImports: FileImportEdge[];
  files: FileRecord[];
  warnings: DiagnosticWarning[];
  prodErrors: DiagnosticWarning[];
  modules: string[];
}

export interface ProjectCacheProvider {
  readProjects(projectPaths: string[]): Map<string, ProjectCacheEntry>;
  writeProjects(entries: ProjectCacheEntry[]): void;
}

export interface CachedSymbolSignature {
  id: string;
  kind: SymbolKind;
  propsType: string | null;
  signature: string;
}

export interface DiagnosticCacheFile {
  path: string;
  diagnostics: DiagnosticWarning[];
  symbols: CachedSymbolSignature[];
}

export interface DiagnosticCacheWrite {
  projectKey: string;
  epoch: string;
  files: DiagnosticCacheFile[];
}

export interface DiagnosticCacheSnapshot {
  diagnostics: Map<string, DiagnosticWarning[]>;
  symbols: Map<string, CachedSymbolSignature>;
}

export interface DiagnosticCacheProvider {
  readDiagnostics(projectKey: string, epoch: string): DiagnosticCacheSnapshot | null;
  writeDiagnostics(entries: DiagnosticCacheWrite[]): void;
}

export interface ProjectConfigInfo {
  path: string;
  fileCount: number;
  references: string[];
}

export interface IndexSnapshot {
  root: string;
  projectId: string;
  tsconfigPath: string;
  tsconfigPaths: string[];
  projectConfigs: ProjectConfigInfo[];
  typescriptVersion: string;
  indexedAt: string;
  durationMs: number;
  symbols: Map<string, SymbolRecord>;
  edges: EdgeRecord[];
  files: Map<string, FileRecord>;
  fileImports: FileImportEdge[];
  moduleCycles: string[][];
  warnings: DiagnosticWarning[];
  prodErrors: DiagnosticWarning[];
  filesCount: number;
  modules: string[];
  /** Files whose diagnostics were served from the persistent workspace cache. */
  diagnosticsCached?: number;
  projectMetrics?: ProjectIndexMetrics;
  projectDetails?: ProjectIndexDetail[];
  graphDigest?: string;
}

export interface CachedSummary {
  contentHash: string;
  promptVersion: string;
  symbolId: string;
  summary: Record<string, unknown>;
  updatedAt: number;
  lastAccessedAt: number;
}

export interface HotspotRecord {
  id: string;
  name: string;
  kind: SymbolKind;
  module: string;
  file: string;
  line: number;
  loc: number;
  complexity: number;
  fanIn: number;
  testReachable: boolean;
  riskScore: number;
}

export interface ImpactSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  module: string;
  file: string;
  line: number;
  isTest: boolean;
}

export interface ImpactAnalysis {
  target: SymbolRecord | null;
  risk: "low" | "medium" | "high" | "critical";
  directReferencesCount: number;
  directReferences: EdgeRecord[];
  impactedComponents: ImpactSymbol[];
  impactedHooks: ImpactSymbol[];
  impactedCallers: ImpactSymbol[];
  impactedFiles: string[];
  impactedModules: string[];
  impactedTestFiles: string[];
  transitiveCount: number;
  suggestedCommands: string[];
}

export interface ModuleEdgeSummary {
  from: string;
  to: string;
  imports: number;
  symbols: number;
  files: string[];
}

export interface ModuleSummary {
  name: string;
  files: number;
  symbols: number;
  components: number;
  hooks: number;
  exported: number;
  loc: number;
  prodLoc: number;
  testLoc: number;
  generatedFiles: number;
  entrypoints: number;
  fanIn: number;
  fanOut: number;
  inModules: string[];
  outModules: string[];
  testReachable: number;
}

export interface TsrayConfig {
  /** Extra entrypoint glob patterns merged with the framework defaults. */
  entrypoints: string[];
  /** Extra exclusion glob patterns merged with the built-in exclusions. */
  exclude: string[];
  /** Optional project name override. */
  projectId?: string;
  summaries: {
    promptVersion: string;
  };
  runner: {
    test?: string;
    typecheck?: string;
    lint?: string;
  };
}

export interface ResolvedProject {
  root: string;
  projectId: string;
  tsconfigPaths: string[];
  primaryTsconfigPath: string;
  workspace: boolean;
  config: TsrayConfig;
}

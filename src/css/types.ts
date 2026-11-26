import type ts from "typescript";

/**
 * Domain model for the optional CSS analysis layer.
 *
 * The TypeScript graph is the source of truth for project ownership and module
 * resolution. CSS analysis derives a separate, on-demand model: parsed style
 * rules, CSS Modules bindings, custom-property references, and diagnostics.
 * Nothing here mutates the TypeScript snapshot.
 */

export type CssDiagnosticCode =
  | "CSS_SYNTAX_OR_VALUE_ERROR"
  | "UNRESOLVED_CSS_IMPORT"
  | "UNDEFINED_CSS_VAR"
  | "CYCLIC_CSS_VAR"
  | "INERT_DECLARATION"
  | "DUPLICATE_PROPERTY"
  | "MISSING_CSS_MODULE_CLASS"
  | "UNUSED_CSS_MODULE_CLASS"
  | "POSSIBLY_UNUSED_GLOBAL_CLASS";

export type CssResolutionKind = "static" | "type-resolved" | "dynamic-unresolved";

export type CssSkippedReason =
  | "preprocessor"
  | "unsupported-syntax"
  | "generated"
  | "not-found";

export interface CssDiagnostic {
  severity: "error" | "warning";
  code: CssDiagnosticCode;
  /** Repo-relative path. */
  file: string;
  line: number;
  symbol: string;
  message: string;
}

export interface CssSkippedPreprocessor {
  /** Repo-relative TypeScript file. */
  tsFile: string;
  specifier: string;
  resolvedFile: string | null;
}

export interface CssSkippedFile {
  /** Repo-relative CSS file. */
  file: string;
  reason: CssSkippedReason;
  detail: string;
}

export interface CssSpecificity {
  id: number;
  class: number;
  type: number;
}

export interface CssClassBinding {
  name: string;
  isGlobal: boolean;
}

export interface CssDeclarationRecord {
  property: string;
  value: string;
  important: boolean;
  line: number;
}

export interface CssRuleRecord {
  id: number;
  /** Repo-relative path. */
  file: string;
  line: number;
  selector: string;
  isModule: boolean;
  specificity: CssSpecificity;
  layer: string | null;
  layerOrder: number | null;
  mediaQuery: string | null;
  conditions: string[];
  classes: CssClassBinding[];
  declarations: CssDeclarationRecord[];
  /** Global order of the file in the analyzed stylesheet list. */
  fileOrder: number;
  /** Byte offset of the rule inside the file, used for cascade source order. */
  sourceOrder: number;
}

export interface CssVariableRecord {
  name: string;
  ruleId: number;
  /** Repo-relative path. */
  file: string;
  line: number;
  selector: string;
  value: string;
  isDefinition: boolean;
  hasFallback: boolean;
  /** When this reference appears inside a custom-property definition. */
  inVarDefinition: string | null;
}

export interface CssBindingRecord {
  /** Repo-relative TypeScript file. */
  tsFile: string;
  line: number;
  componentName: string;
  /** Repo-relative CSS file, or null for global class tokens. */
  targetCssFile: string | null;
  /**
   * Concrete class name for static/type-resolved bindings. Dynamic bindings
   * use `*` for fully unknown names and `prefix*suffix` for partially known
   * template literals.
   */
  className: string;
  resolutionKind: CssResolutionKind;
}

export interface CssLayerRecord {
  name: string;
  order: number;
}

export interface CssAnalysisStats {
  cssFiles: number;
  rules: number;
  declarations: number;
  variables: number;
  bindings: number;
  layers: number;
}

export interface CssAnalysis {
  root: string;
  /** Repo-relative CSS paths in analysis order. */
  files: string[];
  /** Files that use Tailwind directives; plain rules and design tokens were analyzed. */
  tailwindFiles: string[];
  bindings: CssBindingRecord[];
  rules: CssRuleRecord[];
  variables: CssVariableRecord[];
  layers: CssLayerRecord[];
  skippedPreprocessors: CssSkippedPreprocessor[];
  skippedFiles: CssSkippedFile[];
  diagnostics: CssDiagnostic[];
  stats: CssAnalysisStats;
  indexedAt: string;
}

export interface CssAnalyzeOptions {
  root: string;
  projects: CssAnalysisProject[];
  extraCssFiles?: string[];
  includeGenerated?: boolean;
  auditGlobalClasses?: boolean;
}

export interface CssAnalysisProject {
  tsconfigPath: string;
  compilerOptions: ts.CompilerOptions;
  rootNames: string[];
  ownedFiles: string[];
}

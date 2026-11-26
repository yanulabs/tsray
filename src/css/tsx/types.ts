import type ts from "typescript";
import type {
  CssAnalysisProject,
  CssBindingRecord,
  CssSkippedPreprocessor,
} from "../types.js";

export interface CssTsxExtraction {
  bindings: CssBindingRecord[];
  cssFiles: Set<string>;
  skippedPreprocessors: CssSkippedPreprocessor[];
  unresolvedImports: Array<{ tsFile: string; specifier: string; line: number }>;
}

export interface ExtractContext {
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
  root: string;
  tsFile: string;
  project: CssAnalysisProject;
  moduleImports: Map<string, string>;
  bindings: CssBindingRecord[];
  /** Guards recursive resolution of local className variables. */
  resolvingVariables: Set<ts.Node>;
}

export interface TextSegment {
  kind: "text";
  text: string;
}

export interface ExpressionSegment {
  kind: "expression";
  expression: ts.Expression;
}

export type Segment = TextSegment | ExpressionSegment;

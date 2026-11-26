import fs from "node:fs";
import path from "node:path";
import * as csstree from "css-tree";
import { transform } from "lightningcss";
import { validateCssBindings } from "../bindings.js";
import { relativePosix } from "../paths.js";
import { CSS_RE, PREPROCESSOR_RE, isGeneratedCssFile } from "../resolver.js";
import type {
  CssBindingRecord,
  CssDiagnostic,
  CssLayerRecord,
  CssRuleRecord,
  CssSkippedFile,
  CssSkippedPreprocessor,
  CssVariableRecord,
} from "../types.js";
import { validateCssVariables } from "../variables.js";
import {
  IGNORED_LIGHTNING_WARNINGS,
  isTailwindStylesheet,
  preludeText,
  unresolvedImportsToDiagnostics,
  type FileState,
} from "./helpers.js";
import { createCssAnalysisState } from "./state.js";
import { CssRuleWalker } from "./walker.js";

export class CssAnalysisBuilder {
  readonly skippedFiles: CssSkippedFile[] = [];
  readonly files: string[] = [];
  readonly tailwindFiles: string[] = [];
  private readonly state = createCssAnalysisState();
  private readonly walker = new CssRuleWalker(this.state);
  private readonly analyzedFiles = new Set<string>();
  private readonly seenFiles = new Set<string>();
  private readonly skippedGenerated = new Set<string>();

  constructor(private readonly root: string) {}

  get rules(): CssRuleRecord[] {
    return this.state.rules;
  }

  get variables(): CssVariableRecord[] {
    return this.state.variables;
  }

  get layers(): CssLayerRecord[] {
    return this.state.layers;
  }

  get diagnostics(): CssDiagnostic[] {
    return this.state.diagnostics;
  }

  addFile(file: string, allowGenerated = false): void {
    const absolute = path.resolve(file);
    if (this.seenFiles.has(absolute)) return;
    this.seenFiles.add(absolute);

    const relativeFile = relativePosix(this.root, absolute);
    if (PREPROCESSOR_RE.test(absolute)) {
      this.skippedFiles.push({
        file: relativeFile,
        reason: "preprocessor",
        detail: "Preprocessors are not parsed by the static CSS analyzer; analyze compiled CSS instead.",
      });
      return;
    }
    if (!CSS_RE.test(absolute)) return;
    if (!allowGenerated && isGeneratedCssFile(absolute, this.root)) {
      if (!this.skippedGenerated.has(absolute)) {
        this.skippedGenerated.add(absolute);
        this.skippedFiles.push({
          file: relativeFile,
          reason: "generated",
          detail:
            "Compiled or generated CSS is skipped by default; pass it through extra_css_files to analyze it explicitly.",
        });
      }
      // Do not consume the seen slot: an explicit extra_css_files entry may
      // still request this compiled file later.
      this.seenFiles.delete(absolute);
      return;
    }

    let source: string;
    try {
      source = fs.readFileSync(absolute, "utf8");
    } catch (error) {
      this.skippedFiles.push({
        file: relativeFile,
        reason: "not-found",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    this.analyzedFiles.add(absolute);

    let ast: csstree.CssNode;
    try {
      ast = csstree.parse(source, {
        filename: absolute,
        positions: true,
        parseAtrulePrelude: true,
        parseRulePrelude: true,
        parseValue: false,
        parseCustomProperty: false,
      });
    } catch (error) {
      const value = error as { message?: string; line?: number };
      this.state.diagnostics.push({
        severity: "error",
        code: "CSS_SYNTAX_OR_VALUE_ERROR",
        file: relativeFile,
        line: value.line ?? 1,
        symbol: "stylesheet",
        message: value.message ?? "CSS AST parse failure",
      });
      this.skippedFiles.push({
        file: relativeFile,
        reason: "unsupported-syntax",
        detail: "css-tree could not parse this stylesheet.",
      });
      for (const dependency of this.collectImports(absolute, source)) {
        this.addFile(dependency, allowGenerated);
      }
      return;
    }

    if (ast.type !== "StyleSheet") {
      this.skippedFiles.push({
        file: relativeFile,
        reason: "unsupported-syntax",
        detail: "css-tree did not return a stylesheet node.",
      });
      return;
    }

    // Process @import dependencies before the importing stylesheet so global
    // layer statements keep document order.
    for (const dependency of this.importsFromAst(ast, absolute)) {
      this.addFile(dependency, allowGenerated);
    }

    const tailwind = isTailwindStylesheet(ast);
    if (tailwind) this.tailwindFiles.push(relativeFile);

    this.files.push(relativeFile);
    const isModule = /\.module\.css$/i.test(absolute);
    if (!tailwind) {
      // lightningcss does not know Tailwind at-rules. The plain CSS portions are
      // still parsed and validated by css-tree below.
      this.validateWithLightningCss(absolute, relativeFile, source, isModule);
    }

    const state: FileState = {
      absolute,
      relative: relativeFile,
      isModule,
      fileOrder: this.state.nextFileOrder++,
    };
    this.walker.walk(ast, state);
  }

  addBindings(bindings: CssBindingRecord[]): CssBindingRecord[] {
    this.state.diagnostics.push(
      ...validateCssBindings({
        root: this.root,
        bindings,
        rules: this.state.rules,
        analyzedFiles: this.analyzedFiles,
        composedUsage: this.state.composedUsage,
      })
    );
    return bindings;
  }

  addUnresolvedImports(imports: Array<{ tsFile: string; specifier: string; line: number }>): void {
    this.state.diagnostics.push(...unresolvedImportsToDiagnostics(imports));
  }

  addSkippedPreprocessors(entries: CssSkippedPreprocessor[]): void {
    for (const entry of entries) {
      this.skippedFiles.push({
        file: entry.resolvedFile ?? entry.specifier,
        reason: "preprocessor",
        detail: `Imported from ${entry.tsFile}; analyze the compiled CSS instead.`,
      });
    }
  }

  finish(): CssDiagnostic[] {
    this.state.diagnostics.push(
      ...validateCssVariables(this.state.variables, this.state.registeredProperties)
    );
    const analyzed = new Set(this.files);
    for (let index = this.skippedFiles.length - 1; index >= 0; index--) {
      const entry = this.skippedFiles[index]!;
      if (entry.reason === "generated" && analyzed.has(entry.file)) {
        this.skippedFiles.splice(index, 1);
      }
    }
    this.state.diagnostics.sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.code.localeCompare(b.code) ||
        a.symbol.localeCompare(b.symbol)
    );
    return this.state.diagnostics;
  }

  private validateWithLightningCss(
    file: string,
    relativeFile: string,
    source: string,
    isModule: boolean
  ): void {
    try {
      const result = transform({
        filename: file,
        code: Buffer.from(source),
        minify: false,
        errorRecovery: true,
        cssModules: isModule,
      });
      for (const warning of result.warnings) {
        if (IGNORED_LIGHTNING_WARNINGS.some((pattern) => pattern.test(warning.message))) continue;
        this.state.diagnostics.push({
          // Custom at-rules are commonly consumed by PostCSS plugins; surface
          // them without failing the whole analysis.
          severity: /^Unknown at rule:/i.test(warning.message) ? "warning" : "error",
          code: "CSS_SYNTAX_OR_VALUE_ERROR",
          file: relativeFile,
          line: warning.loc.line ?? 1,
          symbol: "stylesheet",
          message: warning.message,
        });
      }
    } catch (error) {
      const value = error as { message?: string; loc?: { line?: number } };
      this.state.diagnostics.push({
        severity: "error",
        code: "CSS_SYNTAX_OR_VALUE_ERROR",
        file: relativeFile,
        line: value.loc?.line ?? 1,
        symbol: "stylesheet",
        message: value.message ?? "Fatal CSS parse error",
      });
    }
  }

  private importsFromAst(ast: csstree.CssNode, file: string): string[] {
    if (ast.type !== "StyleSheet") return [];
    const result: string[] = [];
    for (const node of ast.children) {
      if (node.type !== "Atrule" || node.name.toLowerCase() !== "import" || !node.prelude) {
        continue;
      }
      const text = preludeText(node.prelude);
      const match = /^(?:url\(\s*)?["']([^"']+)["']/.exec(text);
      if (!match) continue;
      const specifier = match[1]!;
      const clean = specifier.replace(/[?#].*$/, "");
      if (!/\.css$/i.test(clean) || !clean.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), clean);
      if (fs.existsSync(resolved)) result.push(resolved);
    }
    return result;
  }

  private collectImports(file: string, source: string): string[] {
    let ast: csstree.CssNode;
    try {
      ast = csstree.parse(source, {
        positions: true,
        parseAtrulePrelude: true,
        parseRulePrelude: true,
        parseValue: false,
      });
    } catch {
      return [];
    }
    return this.importsFromAst(ast, file);
  }

}

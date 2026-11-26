import fs from "node:fs";
import path from "node:path";
import * as csstree from "css-tree";
import type { Atrule, CssNode, Declaration, Rule } from "css-tree";
import { transform } from "lightningcss";
import { validateCssBindings } from "../bindings.js";
import {
  duplicatePropertyDiagnostics,
  inertDeclarationDiagnostics,
  invalidValueDiagnostics,
} from "../declaration-diagnostics.js";
import { relativePosix } from "../paths.js";
import { CSS_RE, PREPROCESSOR_RE, isGeneratedCssFile } from "../resolver.js";
import {
  extractClasses,
  resolveNestedSelectors,
  specificityOfSelector,
  specificityOfSelectorText,
} from "../selectors.js";
import type {
  CssBindingRecord,
  CssClassBinding,
  CssDeclarationRecord,
  CssDiagnostic,
  CssLayerRecord,
  CssRuleRecord,
  CssSkippedFile,
  CssSkippedPreprocessor,
  CssSpecificity,
  CssVariableRecord,
} from "../types.js";
import { extractVarRefs, validateCssVariables } from "../variables.js";
import {
  IGNORED_LIGHTNING_WARNINGS,
  declarationValue,
  isKeyframes,
  isTailwindStylesheet,
  parseSelector,
  preludeText,
  selectorNodes,
  unresolvedImportsToDiagnostics,
  type FileState,
  type WalkContext,
} from "./helpers.js";

export class CssAnalysisBuilder {
  readonly rules: CssRuleRecord[] = [];
  readonly variables: CssVariableRecord[] = [];
  readonly layers: CssLayerRecord[] = [];
  readonly skippedFiles: CssSkippedFile[] = [];
  readonly diagnostics: CssDiagnostic[] = [];
  readonly files: string[] = [];
  readonly tailwindFiles: string[] = [];
  private readonly analyzedFiles = new Set<string>();
  private readonly seenFiles = new Set<string>();
  private readonly skippedGenerated = new Set<string>();
  private readonly composedUsage = new Map<string, Set<string>>();
  private readonly layerOrder = new Map<string, number>();
  private nextLayer = 1;
  private nextRuleId = 1;
  private nextFileOrder = 0;
  private anonymousLayer = 0;
  private readonly registeredProperties = new Set<string>();

  constructor(private readonly root: string) {}

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
      this.diagnostics.push({
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
      fileOrder: this.nextFileOrder++,
    };
    const context: WalkContext = {
      selectors: null,
      layer: null,
      media: null,
      conditions: [],
      ruleLine: 1,
      ruleSourceOrder: 0,
      lineOffset: 0,
      offsetOffset: 0,
    };
    this.walkContainer(ast.children.toArray(), context, state);
  }

  addBindings(bindings: CssBindingRecord[]): CssBindingRecord[] {
    this.diagnostics.push(
      ...validateCssBindings({
        root: this.root,
        bindings,
        rules: this.rules,
        analyzedFiles: this.analyzedFiles,
        composedUsage: this.composedUsage,
      })
    );
    return bindings;
  }

  addUnresolvedImports(imports: Array<{ tsFile: string; specifier: string; line: number }>): void {
    this.diagnostics.push(...unresolvedImportsToDiagnostics(imports));
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
    this.diagnostics.push(
      ...validateCssVariables(this.variables, this.registeredProperties)
    );
    const analyzed = new Set(this.files);
    for (let index = this.skippedFiles.length - 1; index >= 0; index--) {
      const entry = this.skippedFiles[index]!;
      if (entry.reason === "generated" && analyzed.has(entry.file)) {
        this.skippedFiles.splice(index, 1);
      }
    }
    this.diagnostics.sort(
      (a, b) =>
        a.file.localeCompare(b.file) ||
        a.line - b.line ||
        a.code.localeCompare(b.code) ||
        a.symbol.localeCompare(b.symbol)
    );
    return this.diagnostics;
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
        this.diagnostics.push({
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
      this.diagnostics.push({
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

  private registerLayer(name: string): string {
    const existing = this.layerOrder.get(name);
    if (existing !== undefined) return name;
    this.layerOrder.set(name, this.nextLayer++);
    this.layers.push({ name, order: this.layerOrder.get(name)! });
    return name;
  }

  private qualifiedLayer(parent: string | null, name: string): string {
    return parent ? `${parent}.${name}` : name;
  }

  private collectThemeVariables(
    node: Atrule,
    state: FileState,
    line: number,
    lineOffset: number
  ): void {
    if (!node.block) return;
    for (const child of node.block.children) {
      if (child.type !== "Declaration" || !child.property.startsWith("--")) continue;
      const declarationLine = (child.loc?.start.line ?? line) + lineOffset;
      const value = declarationValue(child);
      this.registeredProperties.add(child.property);
      this.variables.push({
        name: child.property,
        ruleId: 0,
        file: state.relative,
        line: declarationLine,
        selector: "@theme",
        value,
        isDefinition: true,
        hasFallback: false,
        inVarDefinition: null,
      });
      for (const ref of extractVarRefs(value)) {
        this.variables.push({
          name: ref.name,
          ruleId: 0,
          file: state.relative,
          line: declarationLine,
          selector: "@theme",
          value,
          isDefinition: false,
          hasFallback: ref.hasFallback,
          inVarDefinition: child.property,
        });
      }
    }
  }

  private walkContainer(
    children: readonly CssNode[],
    context: WalkContext,
    state: FileState
  ): void {
    const declarations = children.filter(
      (child): child is Declaration => child.type === "Declaration"
    );
    if (context.selectors && context.selectors.length > 0 && declarations.length > 0) {
      this.addRule(context.selectors, declarations, context, state);
    }

    for (const child of children) {
      if (child.type === "Rule") {
        this.walkRule(child, context, state);
      } else if (child.type === "Atrule") {
        this.walkAtrule(child, context, state);
      } else if (child.type === "Raw") {
        this.walkRaw(child, context, state);
      }
    }
  }

  private walkRule(node: Rule, context: WalkContext, state: FileState): void {
    const childSelectors = selectorNodes(node.prelude);
    if (childSelectors.length === 0) return;
    if (childSelectors.every((selector) => /^:(?:export|import)\b/i.test(selector))) {
      return;
    }

    const selectors = resolveNestedSelectors(context.selectors ?? [], childSelectors);
    const line = (node.loc?.start.line ?? 1) + context.lineOffset;
    const sourceOrder = (node.loc?.start.offset ?? 0) + context.offsetOffset;
    this.walkContainer(
      node.block.children.toArray(),
      {
        ...context,
        selectors,
        ruleLine: line,
        ruleSourceOrder: sourceOrder,
      },
      state
    );
  }

  private walkAtrule(node: Atrule, context: WalkContext, state: FileState): void {
    const name = node.name.toLowerCase();
    const line = (node.loc?.start.line ?? 1) + context.lineOffset;
    const sourceOrder = (node.loc?.start.offset ?? 0) + context.offsetOffset;
    const block = node.block;

    if (isKeyframes(name)) return;

    if (name === "theme") {
      this.collectThemeVariables(node, state, line, context.lineOffset);
      return;
    }
    if (
      name === "tailwind" ||
      name === "apply" ||
      name === "utility" ||
      name === "custom-variant" ||
      name === "variant" ||
      name === "source"
    ) {
      return;
    }

    if (name === "layer") {
      const names = preludeText(node.prelude)
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      if (!block) {
        for (const layerName of names) {
          this.registerLayer(this.qualifiedLayer(context.layer, layerName));
        }
        return;
      }

      this.anonymousLayer++;
      const localName =
        names[0] ??
        `#anonymous-${this.anonymousLayer}@${state.relative}:${line}`;
      const fullName = this.registerLayer(this.qualifiedLayer(context.layer, localName));
      this.walkContainer(
        block.children.toArray(),
        {
          ...context,
          layer: fullName,
          ruleLine: line,
          ruleSourceOrder: sourceOrder,
        },
        state
      );
      return;
    }

    if (name === "media") {
      const query = preludeText(node.prelude);
      if (!block) return;
      this.walkContainer(
        block.children.toArray(),
        {
          ...context,
          media: context.media ? `${context.media} and ${query}` : query,
          conditions: [...context.conditions, `@media ${query}`],
          ruleLine: line,
          ruleSourceOrder: sourceOrder,
        },
        state
      );
      return;
    }

    if (name === "supports" || name === "container" || name === "scope" || name === "starting-style") {
      if (!block) return;
      this.walkContainer(
        block.children.toArray(),
        {
          ...context,
          conditions: [...context.conditions, `@${name} ${preludeText(node.prelude)}`.trim()],
          ruleLine: line,
          ruleSourceOrder: sourceOrder,
        },
        state
      );
      return;
    }

    if (name === "property") {
      const propertyName = /--[a-zA-Z0-9_-]+/.exec(preludeText(node.prelude))?.[0];
      if (!propertyName) return;
      this.registeredProperties.add(propertyName);
      this.variables.push({
        name: propertyName,
        ruleId: 0,
        file: state.relative,
        line,
        selector: "@property",
        value: preludeText(node.prelude),
        isDefinition: true,
        hasFallback: false,
        inVarDefinition: null,
      });
      return;
    }

    if (name === "nest") {
      const childSelectors = selectorNodes(node.prelude);
      if (!block || childSelectors.length === 0) return;
      const selectors = resolveNestedSelectors(context.selectors ?? [], childSelectors);
      this.walkContainer(
        block.children.toArray(),
        { ...context, selectors, ruleLine: line, ruleSourceOrder: sourceOrder },
        state
      );
      return;
    }

    // CSS Modules ICSS blocks are not style rules.
    if (name === "value" || name === "import") return;

    if (!block) return;

    if (
      name === "font-face" ||
      name === "page" ||
      name === "counter-style" ||
      name === "font-feature-values" ||
      name === "font-palette-values" ||
      name === "view-transition"
    ) {
      return;
    }

    this.walkContainer(
      block.children.toArray(),
      {
        ...context,
        conditions: [...context.conditions, `@${name} ${preludeText(node.prelude)}`.trim()],
        ruleLine: line,
        ruleSourceOrder: sourceOrder,
      },
      state
    );
  }

  private walkRaw(raw: csstree.Raw, context: WalkContext, state: FileState): void {
    if (!raw.value.includes("{")) return;
    let ast: csstree.CssNode;
    try {
      ast = csstree.parse(raw.value, {
        positions: true,
        parseAtrulePrelude: true,
        parseRulePrelude: true,
        parseValue: false,
      });
    } catch {
      return;
    }
    if (ast.type !== "StyleSheet") return;
    this.walkContainer(ast.children.toArray(), {
      ...context,
      lineOffset: context.lineOffset + (raw.loc?.start.line ?? 1) - 1,
      offsetOffset: context.offsetOffset + (raw.loc?.start.offset ?? 0),
    }, state);
  }

  private addRule(
    selectors: string[],
    declarations: Declaration[],
    context: WalkContext,
    state: FileState
  ): void {
    const records: CssDeclarationRecord[] = declarations.map((declaration) => ({
      property: declaration.property,
      value: declarationValue(declaration),
      important: Boolean(declaration.important),
      line: (declaration.loc?.start.line ?? 1) + context.lineOffset,
    }));

    const firstSymbol = selectors[0] ?? "stylesheet";
    this.diagnostics.push(
      ...duplicatePropertyDiagnostics(records, state.relative, firstSymbol),
      ...inertDeclarationDiagnostics(records, state.relative, firstSymbol),
      ...invalidValueDiagnostics(records, state.relative, firstSymbol)
    );

    for (const selectorText of selectors) {
      const parsedSelector = parseSelector(selectorText);
      const specificity: CssSpecificity = parsedSelector
        ? specificityOfSelector(parsedSelector)
        : specificityOfSelectorText(selectorText);
      const classes: CssClassBinding[] = parsedSelector
        ? extractClasses(parsedSelector, state.isModule)
        : [];

      const rule: CssRuleRecord = {
        id: this.nextRuleId++,
        file: state.relative,
        line: context.ruleLine,
        selector: selectorText,
        isModule: state.isModule,
        specificity,
        layer: context.layer,
        layerOrder: context.layer ? this.layerOrder.get(context.layer) ?? null : null,
        mediaQuery: context.media,
        conditions: [...context.conditions],
        classes,
        declarations: records,
        fileOrder: state.fileOrder,
        sourceOrder: context.ruleSourceOrder,
      };
      this.rules.push(rule);

      for (const declaration of declarations) {
        const value = declarationValue(declaration);
        const line = (declaration.loc?.start.line ?? 1) + context.lineOffset;
        const property = declaration.property;
        if (property.toLowerCase() === "composes") {
          this.recordComposedClasses(state, value);
        }
        if (property.startsWith("--")) {
          this.variables.push({
            name: property,
            ruleId: rule.id,
            file: state.relative,
            line,
            selector: selectorText,
            value,
            isDefinition: true,
            hasFallback: false,
            inVarDefinition: null,
          });
          for (const ref of extractVarRefs(value)) {
            this.variables.push({
              name: ref.name,
              ruleId: rule.id,
              file: state.relative,
              line,
              selector: selectorText,
              value,
              isDefinition: false,
              hasFallback: ref.hasFallback,
              inVarDefinition: property,
            });
          }
        } else {
          for (const ref of extractVarRefs(value)) {
            this.variables.push({
              name: ref.name,
              ruleId: rule.id,
              file: state.relative,
              line,
              selector: selectorText,
              value,
              isDefinition: false,
              hasFallback: ref.hasFallback,
              inVarDefinition: null,
            });
          }
        }
      }
    }
  }

  private recordComposedClasses(state: FileState, value: string): void {
    const match = /^(.*?)(?:\s+from\s+(?:"([^"]+)"|'([^']+)'|(global)))?$/i.exec(
      value.trim()
    );
    if (!match) return;
    if (match[4]) return;

    const names = match[1]!
      .split(/\s+/)
      .map((name) => name.trim())
      .filter((name) => name && !/^global\(/i.test(name));
    if (names.length === 0) return;

    const from = match[2] ?? match[3];
    const target = from
      ? path.resolve(path.dirname(state.absolute), from)
      : state.absolute;
    if (!fs.existsSync(target)) return;

    const set = this.composedUsage.get(target) ?? new Set<string>();
    for (const name of names) set.add(name);
    this.composedUsage.set(target, set);
  }

}

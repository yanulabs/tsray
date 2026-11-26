import fs from "node:fs";
import path from "node:path";
import * as csstree from "css-tree";
import type { Atrule, CssNode, Declaration, Rule } from "css-tree";
import {
  duplicatePropertyDiagnostics,
  inertDeclarationDiagnostics,
  invalidValueDiagnostics,
} from "../declaration-diagnostics.js";
import {
  extractClasses,
  resolveNestedSelectors,
  specificityOfSelector,
  specificityOfSelectorText,
} from "../selectors.js";
import type {
  CssClassBinding,
  CssDeclarationRecord,
  CssRuleRecord,
  CssSpecificity,
} from "../types.js";
import { extractVarRefs } from "../variables.js";
import {
  declarationValue,
  isKeyframes,
  parseSelector,
  preludeText,
  selectorNodes,
  type FileState,
  type WalkContext,
} from "./helpers.js";
import type { CssAnalysisState } from "./state.js";

export class CssRuleWalker {
  constructor(private readonly state: CssAnalysisState) {}

  walk(ast: CssNode, state: FileState): void {
    if (ast.type !== "StyleSheet") return;
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

  private registerLayer(name: string): string {
    const existing = this.state.layerOrder.get(name);
    if (existing !== undefined) return name;
    this.state.layerOrder.set(name, this.state.nextLayer++);
    this.state.layers.push({ name, order: this.state.layerOrder.get(name)! });
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
      this.state.registeredProperties.add(child.property);
      this.state.variables.push({
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
        this.state.variables.push({
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

      this.state.anonymousLayer++;
      const localName =
        names[0] ??
        `#anonymous-${this.state.anonymousLayer}@${state.relative}:${line}`;
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
      this.state.registeredProperties.add(propertyName);
      this.state.variables.push({
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
    this.state.diagnostics.push(
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
        id: this.state.nextRuleId++,
        file: state.relative,
        line: context.ruleLine,
        selector: selectorText,
        isModule: state.isModule,
        specificity,
        layer: context.layer,
        layerOrder: context.layer ? this.state.layerOrder.get(context.layer) ?? null : null,
        mediaQuery: context.media,
        conditions: [...context.conditions],
        classes,
        declarations: records,
        fileOrder: state.fileOrder,
        sourceOrder: context.ruleSourceOrder,
      };
      this.state.rules.push(rule);

      for (const declaration of declarations) {
        const value = declarationValue(declaration);
        const line = (declaration.loc?.start.line ?? 1) + context.lineOffset;
        const property = declaration.property;
        if (property.toLowerCase() === "composes") {
          this.recordComposedClasses(state, value);
        }
        if (property.startsWith("--")) {
          this.state.variables.push({
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
            this.state.variables.push({
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
            this.state.variables.push({
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

    const set = this.state.composedUsage.get(target) ?? new Set<string>();
    for (const name of names) set.add(name);
    this.state.composedUsage.set(target, set);
  }

}

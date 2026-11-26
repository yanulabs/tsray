import * as csstree from "css-tree";
import type { Selector } from "css-tree";
import { classNamesMatch } from "./class-names.js";
import { compareSpecificity } from "./selectors.js";
import type { CssAnalysis, CssSpecificity } from "./types.js";

interface CascadeCandidate {
  important: boolean;
  layerOrder: number | null;
  specificity: CssSpecificity;
  fileOrder: number;
  sourceOrder: number;
  ruleId: number;
}

function compareCascade(a: CascadeCandidate, b: CascadeCandidate): number {
  if (a.important !== b.important) return a.important ? 1 : -1;

  const aLayered = a.layerOrder !== null;
  const bLayered = b.layerOrder !== null;
  if (a.important) {
    // Important declarations reverse layer order: earlier layers win, and
    // layered declarations beat unlayered declarations.
    if (aLayered !== bLayered) return aLayered ? 1 : -1;
    if (aLayered && bLayered && a.layerOrder !== b.layerOrder) {
      return b.layerOrder! - a.layerOrder!;
    }
  } else {
    // Normal declarations: later layers win, and unlayered declarations beat
    // every layered declaration.
    if (aLayered !== bLayered) return aLayered ? -1 : 1;
    if (aLayered && bLayered && a.layerOrder !== b.layerOrder) {
      return a.layerOrder! - b.layerOrder!;
    }
  }

  const specificity = compareSpecificity(a.specificity, b.specificity);
  if (specificity !== 0) return specificity;
  if (a.fileOrder !== b.fileOrder) return a.fileOrder - b.fileOrder;
  if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
  return a.ruleId - b.ruleId;
}

export interface CssCascadeEntry {
  winner: boolean;
  value: string;
  important: boolean;
  selector: string;
  specificity: [number, number, number];
  layer: string | null;
  media: string | null;
  conditions: string[];
  file: string;
  line: number;
  rule_id: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectorMatches(selector: string, query: string): boolean {
  if (selector === query) return true;
  if (!query) return false;
  const decoded = csstree.ident.decode(selector);
  if (decoded !== selector && selectorMatches(decoded, query)) return true;
  // Treat the query as a selector token so '.winner' does not also match
  // '.winner-important'. Trailing pseudo-classes and combinators are allowed.
  // Class, ID, attribute, and pseudo queries carry their own left delimiter,
  // so they also match compound selectors such as '#id.card'.
  const hasOwnDelimiter = /^[.#:[]/.test(query);
  const prefix = hasOwnDelimiter ? "" : "(^|[\\s>+~,(])";
  const pattern = new RegExp(
    `${prefix}${escapeRegExp(query)}(?=$|[:\\s>+~.#[\\],()])`
  );
  return pattern.test(selector);
}

function subjectOfSelector(selector: string): {
  text: string;
  hasPseudoElement: boolean;
} | null {
  let parsed: Selector;
  try {
    const node = csstree.parse(selector, { context: "selector" });
    if (node.type !== "Selector") return null;
    parsed = node;
  } catch {
    return null;
  }

  const nodes = parsed.children.toArray();
  let start = 0;
  for (let index = nodes.length - 1; index >= 0; index--) {
    if (nodes[index]!.type === "Combinator") {
      start = index + 1;
      break;
    }
  }
  const subject = nodes.slice(start);
  const text = subject.map((node) => csstree.generate(node)).join("").trim();
  return {
    // CSS selectors escape characters such as `:` and `[` that are legal in
    // Tailwind class names. Compare decoded identifiers to TypeScript strings.
    text: csstree.ident.decode(text),
    hasPseudoElement: subject.some((node) => node.type === "PseudoElementSelector"),
  };
}

/**
 * Cascade only applies to the selector's subject (the rightmost compound).
 * `.parent .card` styles the child, not `.parent`, so it must not participate
 * when resolving properties on `.card`.
 */
function subjectMatches(selector: string, query: string): boolean {
  const subject = subjectOfSelector(selector);
  if (!subject) return selectorMatches(selector, query);
  if (subject.hasPseudoElement && !query.includes("::")) return false;
  return selectorMatches(subject.text, query);
}

export function resolveCascade(
  analysis: CssAnalysis,
  selectorQuery: string,
  property?: string
): Record<string, CssCascadeEntry[]> {
  const byProperty = new Map<
    string,
    Array<{ entry: CssCascadeEntry; candidate: CascadeCandidate }>
  >();

  for (const rule of analysis.rules) {
    if (!subjectMatches(rule.selector, selectorQuery)) continue;
    for (const declaration of rule.declarations) {
      if (property && declaration.property !== property) continue;
      const entry: CssCascadeEntry = {
        winner: false,
        value: declaration.value,
        important: declaration.important,
        selector: rule.selector,
        specificity: [
          rule.specificity.id,
          rule.specificity.class,
          rule.specificity.type,
        ],
        layer: rule.layer,
        media: rule.mediaQuery,
        conditions: rule.conditions,
        file: rule.file,
        line: declaration.line,
        rule_id: rule.id,
      };
      const candidate: CascadeCandidate = {
        important: declaration.important,
        layerOrder: rule.layerOrder,
        specificity: rule.specificity,
        fileOrder: rule.fileOrder,
        sourceOrder: rule.sourceOrder,
        ruleId: rule.id,
      };
      const list = byProperty.get(declaration.property) ?? [];
      list.push({ entry, candidate });
      byProperty.set(declaration.property, list);
    }
  }

  const result: Record<string, CssCascadeEntry[]> = {};
  for (const propertyName of [...byProperty.keys()].sort()) {
    const list = byProperty.get(propertyName)!;
    list.sort((a, b) => compareCascade(a.candidate, b.candidate));
    const winner = list[list.length - 1]?.entry;
    if (winner) winner.winner = true;
    result[propertyName] = list.map((item) => item.entry);
  }
  return result;
}

export interface CssVariableImpact {
  name: string;
  rule_id: number;
  file: string;
  line: number;
  selector: string;
  value: string;
  has_fallback: boolean;
  in_var_definition: string | null;
}

export interface CssClassImpact {
  id: number;
  file: string;
  line: number;
  selector: string;
  specificity: [number, number, number];
  layer: string | null;
  media: string | null;
  is_module: boolean;
}

export interface CssComponentImpact {
  ts_file: string;
  line: number;
  component_name: string;
  target_css_file: string | null;
  resolution_kind: string;
}

export interface CssImpactResult {
  symbol: string;
  kind: "custom-property" | "class" | "id" | "unknown";
  definitions?: CssVariableImpact[];
  consumers?: CssVariableImpact[];
  rules?: CssClassImpact[];
  components?: CssComponentImpact[];
}

function toVariableImpact(
  analysis: CssAnalysis,
  name: string,
  definitions: boolean
): CssVariableImpact[] {
  return analysis.variables
    .filter((variable) => variable.name === name && variable.isDefinition === definitions)
    .map((variable) => ({
      name: variable.name,
      rule_id: variable.ruleId,
      file: variable.file,
      line: variable.line,
      selector: variable.selector,
      value: variable.value,
      has_fallback: variable.hasFallback,
      in_var_definition: variable.inVarDefinition,
    }));
}

function normalizeClass(name: string): string {
  return name.startsWith(".") ? name.slice(1) : name;
}

export function resolveCssImpact(analysis: CssAnalysis, symbol: string): CssImpactResult {
  if (symbol.startsWith("--")) {
    return {
      symbol,
      kind: "custom-property",
      definitions: toVariableImpact(analysis, symbol, true),
      consumers: toVariableImpact(analysis, symbol, false),
    };
  }

  if (symbol.startsWith("#")) {
    return {
      symbol,
      kind: "id",
      rules: analysis.rules
        .filter((rule) => selectorMatches(rule.selector, symbol))
        .map((rule) => ({
          id: rule.id,
          file: rule.file,
          line: rule.line,
          selector: rule.selector,
          specificity: [
            rule.specificity.id,
            rule.specificity.class,
            rule.specificity.type,
          ],
          layer: rule.layer,
          media: rule.mediaQuery,
          is_module: rule.isModule,
        })),
    };
  }

  const className = normalizeClass(symbol);
  const rules = analysis.rules
    .filter((rule) =>
      rule.classes.some((binding) => classNamesMatch(binding.name, className))
    )
    .map((rule) => ({
      id: rule.id,
      file: rule.file,
      line: rule.line,
      selector: rule.selector,
      specificity: [
        rule.specificity.id,
        rule.specificity.class,
        rule.specificity.type,
      ] as [number, number, number],
      layer: rule.layer,
      media: rule.mediaQuery,
      is_module: rule.isModule,
    }));

  const components = analysis.bindings
    .filter(
      (binding) =>
        binding.resolutionKind !== "dynamic-unresolved" &&
        classNamesMatch(binding.className, className)
    )
    .map((binding) => ({
      ts_file: binding.tsFile,
      line: binding.line,
      component_name: binding.componentName,
      target_css_file: binding.targetCssFile,
      resolution_kind: binding.resolutionKind,
    }));

  return {
    symbol,
    kind: rules.length > 0 || components.length > 0 ? "class" : "unknown",
    rules,
    components,
  };
}

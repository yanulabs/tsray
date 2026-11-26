import * as csstree from "css-tree";
import type { Atrule, CssNode, Declaration, Rule, Selector } from "css-tree";
import type { CssDiagnostic } from "../types.js";

export interface WalkContext {
  selectors: string[] | null;
  layer: string | null;
  media: string | null;
  conditions: string[];
  ruleLine: number;
  ruleSourceOrder: number;
  lineOffset: number;
  offsetOffset: number;
}

export interface FileState {
  absolute: string;
  relative: string;
  isModule: boolean;
  fileOrder: number;
}

export const TAILWIND_AT_RULES = new Set([
  "tailwind",
  "apply",
  "theme",
  "utility",
  "custom-variant",
  "variant",
  "source",
]);
export const IGNORED_LIGHTNING_WARNINGS = [
  /@value rule is deprecated/i,
  /'export' is not recognized as a valid pseudo-class/i,
  /'import' is not recognized as a valid pseudo-class/i,
  /Unknown at rule: @(?:custom-media|custom-selector|nest)\b/i,
  /The @nest rule is deprecated/i,
];

export function preludeText(prelude: Atrule["prelude"] | Rule["prelude"] | null): string {
  if (!prelude) return "";
  return csstree.generate(prelude).trim();
}

export function isKeyframes(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "keyframes" || lower.endsWith("-keyframes");
}

export function isTailwindStylesheet(ast: CssNode): boolean {
  let found = false;
  csstree.walk(ast, {
    enter(node: CssNode) {
      if (found) return csstree.walk.break;
      if (node.type !== "Atrule") return;
      const name = node.name.toLowerCase();
      if (TAILWIND_AT_RULES.has(name)) {
        found = true;
        return csstree.walk.break;
      }
      if (name === "import" && /tailwindcss/i.test(preludeText(node.prelude))) {
        found = true;
        return csstree.walk.break;
      }
    },
  });
  return found;
}

export function selectorNodes(prelude: Rule["prelude"] | Atrule["prelude"] | null): string[] {
  if (!prelude) return [];
  const text = preludeText(prelude);
  if (!text) return [];
  try {
    const list = csstree.parse(text, { context: "selectorList" });
    if (list.type !== "SelectorList") return [];
    const result: string[] = [];
    for (const child of list.children) {
      if (child.type === "Selector") result.push(csstree.generate(child).trim());
    }
    return result;
  } catch {
    return [];
  }
}

export function parseSelector(text: string): Selector | null {
  try {
    const parsed = csstree.parse(text, { context: "selector" });
    return parsed.type === "Selector" ? parsed : null;
  } catch {
    return null;
  }
}

export function declarationValue(declaration: Declaration): string {
  return csstree.generate(declaration.value).trim();
}

export function unresolvedImportsToDiagnostics(
  imports: Array<{ tsFile: string; specifier: string; line: number }>
): CssDiagnostic[] {
  return imports.map((entry) => ({
    severity: "warning",
    code: "UNRESOLVED_CSS_IMPORT",
    file: entry.tsFile,
    line: entry.line,
    symbol: entry.specifier,
    message: `CSS import '${entry.specifier}' could not be resolved from the owning TypeScript project.`,
  }));
}

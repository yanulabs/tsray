import * as csstree from "css-tree";
import type { CssNode } from "css-tree";
import type { CssDiagnostic, CssVariableRecord } from "./types.js";

export interface CssVariableReference {
  name: string;
  hasFallback: boolean;
}

function collectVarRefs(
  ast: CssNode,
  refs: CssVariableReference[],
  depth = 0
): void {
  csstree.walk(ast, {
    enter(node: CssNode) {
      if (node.type === "Function" && node.name.toLowerCase() === "var") {
        const children = node.children.toArray();
        const first = children[0];
        if (!first || first.type !== "Identifier" || !first.name.startsWith("--")) return;
        refs.push({
          name: first.name,
          hasFallback: children.some(
            (child: CssNode) => child.type === "Operator" && child.value === ","
          ),
        });
        return;
      }

      // css-tree keeps the fallback part of var() as Raw. Reparse it so nested
      // references such as var(--a, var(--b)) participate in cycle detection.
      if (node.type === "Raw" && depth < 5) {
        try {
          const nested = csstree.parse(node.value, {
            context: "value",
            parseCustomProperty: true,
          });
          collectVarRefs(nested, refs, depth + 1);
        } catch {
          // A fallback can be any token sequence; ignore unparseable fragments.
        }
      }
    },
  });
}

export function extractVarRefs(value: string): CssVariableReference[] {
  const refs: CssVariableReference[] = [];
  try {
    const ast = csstree.parse(value, { context: "value", parseCustomProperty: true });
    collectVarRefs(ast, refs);
  } catch {
    const sanitized = value
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const pattern = /var\(\s*(--[a-zA-Z0-9_-]+)\s*(,)?/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(sanitized)) !== null) {
      refs.push({ name: match[1]!, hasFallback: Boolean(match[2]) });
    }
  }
  return refs;
}

/**
 * Validates custom-property definitions and references across every analyzed
 * stylesheet. Cycles are reported once per strongly-connected name set.
 */
export function validateCssVariables(
  variables: readonly CssVariableRecord[],
  registeredProperties: ReadonlySet<string>
): CssDiagnostic[] {
  const diagnostics: CssDiagnostic[] = [];
  const definitions = new Set<string>(registeredProperties);
  const firstDefinition = new Map<string, CssVariableRecord>();

  for (const variable of variables) {
    if (!variable.isDefinition) continue;
    definitions.add(variable.name);
    if (!firstDefinition.has(variable.name)) {
      firstDefinition.set(variable.name, variable);
    }
  }

  const reportedUndefined = new Set<string>();
  for (const variable of variables) {
    if (variable.isDefinition || variable.hasFallback) continue;
    if (definitions.has(variable.name)) continue;
    const key = `${variable.name}|${variable.file}|${variable.line}`;
    if (reportedUndefined.has(key)) continue;
    reportedUndefined.add(key);
    diagnostics.push({
      severity: "error",
      code: "UNDEFINED_CSS_VAR",
      file: variable.file,
      line: variable.line,
      symbol: variable.name,
      message: `Custom property '${variable.name}' used in '${variable.selector}' has no definition and no fallback.`,
    });
  }

  const edges = new Map<string, string[]>();
  for (const variable of variables) {
    const source = variable.inVarDefinition;
    if (variable.isDefinition || !source) continue;
    const targets = edges.get(source) ?? [];
    if (!targets.includes(variable.name)) targets.push(variable.name);
    edges.set(source, targets);
  }

  const reportedCycles = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const visit = (name: string): void => {
    if (onStack.has(name)) {
      const start = stack.indexOf(name);
      const cycle = start >= 0 ? [...stack.slice(start), name] : [name];
      const key = [...new Set(cycle)].sort().join("|");
      if (!reportedCycles.has(key)) {
        reportedCycles.add(key);
        const origin = firstDefinition.get(name);
        if (origin) {
          diagnostics.push({
            severity: "error",
            code: "CYCLIC_CSS_VAR",
            file: origin.file,
            line: origin.line,
            symbol: name,
            message: `Circular dependency detected for custom property '${name}': ${cycle.join(" -> ")}.`,
          });
        }
      }
      return;
    }
    if (visited.has(name)) return;
    visited.add(name);
    onStack.add(name);
    stack.push(name);
    for (const next of edges.get(name) ?? []) visit(next);
    stack.pop();
    onStack.delete(name);
  };

  for (const name of edges.keys()) visit(name);
  return diagnostics;
}

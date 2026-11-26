import * as csstree from "css-tree";
import type { CssDeclarationRecord, CssDiagnostic } from "./types.js";

export function duplicatePropertyDiagnostics(
  declarations: readonly CssDeclarationRecord[],
  file: string,
  selector: string
): CssDiagnostic[] {
  const diagnostics: CssDiagnostic[] = [];
  const seen = new Map<string, string>();
  const reported = new Set<string>();

  for (const declaration of declarations) {
    if (declaration.property.startsWith("--")) continue;
    const previousValue = seen.get(declaration.property);
    if (
      previousValue !== undefined &&
      previousValue === declaration.value &&
      !reported.has(declaration.property)
    ) {
      reported.add(declaration.property);
      diagnostics.push({
        severity: "warning",
        code: "DUPLICATE_PROPERTY",
        file,
        line: declaration.line,
        symbol: selector,
        message: `Duplicate property '${declaration.property}' with the same value within the same rule block.`,
      });
    }
    seen.set(declaration.property, declaration.value);
  }
  return diagnostics;
}

export function inertDeclarationDiagnostics(
  declarations: readonly CssDeclarationRecord[],
  file: string,
  selector: string
): CssDiagnostic[] {
  const diagnostics: CssDiagnostic[] = [];
  const properties = new Map<string, string>();
  const lines = new Map<string, number>();
  for (const declaration of declarations) {
    properties.set(declaration.property, declaration.value.toLowerCase());
    lines.set(declaration.property, declaration.line);
  }

  const add = (property: string, message: string): void => {
    diagnostics.push({
      severity: "warning",
      code: "INERT_DECLARATION",
      file,
      line: lines.get(property) ?? 1,
      symbol: selector,
      message,
    });
  };

  const display = properties.get("display");
  const position = properties.get("position");

  if (display === "inline") {
    for (const property of [
      "width",
      "height",
      "min-width",
      "min-height",
      "margin-top",
      "margin-bottom",
    ]) {
      if (properties.has(property)) {
        add(property, `'${property}' has no effect on 'display: inline'.`);
      }
    }
  }

  if (
    display &&
    !["flex", "inline-flex", "grid", "inline-grid", "contents", "none"].includes(display)
  ) {
    for (const property of ["gap", "row-gap", "column-gap", "justify-content", "align-items"]) {
      if (properties.has(property)) {
        add(
          property,
          `'${property}' requires a flex or grid container (found 'display: ${display}').`
        );
      }
    }
  }

  if (position === "static") {
    for (const property of ["top", "right", "bottom", "left", "inset"]) {
      if (properties.has(property)) {
        add(property, `'${property}' is ignored when 'position: static'.`);
      }
    }
  }

  return diagnostics;
}

export function invalidValueDiagnostics(
  declarations: readonly CssDeclarationRecord[],
  file: string,
  selector: string
): CssDiagnostic[] {
  const diagnostics: CssDiagnostic[] = [];

  for (const declaration of declarations) {
    const property = declaration.property.toLowerCase();
    if (property.startsWith("--") || property.startsWith("-") || property.startsWith("_")) {
      continue;
    }
    const value = declaration.value;
    if (!value) continue;
    if (/\b(?:var|env|attr)\s*\(/i.test(value)) continue;

    let valueAst: csstree.CssNode;
    try {
      valueAst = csstree.parse(value, { context: "value" });
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "CSS_SYNTAX_OR_VALUE_ERROR",
        file,
        line: declaration.line,
        symbol: selector,
        message: `Invalid value for '${declaration.property}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }

    // css-tree's property grammar can lag newer functions and layout keywords.
    // Skip those values instead of emitting false positives; lightningcss still
    // validates the stylesheet's syntax and at-rules above.
    if (value.includes("(")) continue;
    if (property === "display" && /^(?:masonry|grid-lanes)$/i.test(value)) continue;

    try {
      const match = csstree.lexer.matchProperty(property, valueAst);
      if (!match.error || match.error.name === "SyntaxReferenceError") continue;
      const reason =
        match.error.message.split("\n")[0] ?? "value does not match the property grammar";
      diagnostics.push({
        severity: "error",
        code: "CSS_SYNTAX_OR_VALUE_ERROR",
        file,
        line: declaration.line,
        symbol: selector,
        message: `Invalid value for '${declaration.property}': ${reason}`,
      });
    } catch {
      // The lexer can reject newer syntax it does not know yet. Unknown
      // properties and unsupported value grammars are intentionally ignored.
    }
  }

  return diagnostics;
}

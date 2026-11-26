import type {
  CssBindingRecord,
  CssDiagnostic,
  CssRuleRecord,
} from "./types.js";

export interface GlobalClassAuditInput {
  rules: readonly CssRuleRecord[];
  bindings: readonly CssBindingRecord[];
}

function patternMatches(pattern: string, className: string): boolean {
  const firstStar = pattern.indexOf("*");
  if (firstStar === -1) return pattern === className;
  const lastStar = pattern.lastIndexOf("*");
  const prefix = pattern.slice(0, firstStar);
  const suffix = pattern.slice(lastStar + 1);
  return className.startsWith(prefix) && className.endsWith(suffix);
}

/**
 * Conservative dead-class audit for plain (non-module) CSS. It is opt-in
 * because classes can be applied by runtime code, external widgets, or plain
 * HTML. Dynamic template literals contribute `prefix*suffix` patterns; fully
 * dynamic class names are reported as an explicit caveat rather than silently
 * disabling the audit.
 */
export function validateGlobalClasses(
  input: GlobalClassAuditInput
): CssDiagnostic[] {
  const defined = new Map<string, { className: string; rule: CssRuleRecord }>();
  for (const rule of input.rules) {
    if (rule.isModule) continue;
    for (const classBinding of rule.classes) {
      const key = `${rule.file}:${classBinding.name}`;
      if (!defined.has(key)) {
        defined.set(key, { className: classBinding.name, rule });
      }
    }
  }

  const used = new Set<string>();
  const dynamicPatterns: string[] = [];
  let hasUnknownDynamic = false;
  for (const binding of input.bindings) {
    if (binding.targetCssFile) continue;
    if (binding.resolutionKind !== "dynamic-unresolved") {
      used.add(binding.className);
      continue;
    }
    if (binding.className === "*") {
      hasUnknownDynamic = true;
    } else {
      dynamicPatterns.push(binding.className);
    }
  }

  const diagnostics: CssDiagnostic[] = [];
  for (const { className, rule } of defined.values()) {
    if (used.has(className)) continue;
    if (dynamicPatterns.some((pattern) => patternMatches(pattern, className))) continue;
    diagnostics.push({
      severity: "warning",
      code: "POSSIBLY_UNUSED_GLOBAL_CLASS",
      file: rule.file,
      line: rule.line,
      symbol: `.${className}`,
      message: hasUnknownDynamic
        ? `Global class '.${className}' is not referenced by a statically resolved className; unresolved dynamic classes also exist, so verify before removing it.`
        : `Global class '.${className}' is not referenced by any statically resolved className.`,
    });
  }
  return diagnostics;
}

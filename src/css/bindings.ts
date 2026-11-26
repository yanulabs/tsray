import path from "node:path";
import { hasMatchingClass } from "./class-names.js";
import { relativePosix } from "./paths.js";
import type {
  CssBindingRecord,
  CssDiagnostic,
  CssRuleRecord,
} from "./types.js";

export interface CssBindingValidationInput {
  root: string;
  bindings: readonly CssBindingRecord[];
  rules: readonly CssRuleRecord[];
  analyzedFiles: ReadonlySet<string>;
  composedUsage: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Cross-checks TypeScript class usage against local CSS Module classes.
 * Dynamically unresolved usage suppresses unused-class warnings for that
 * module; `composes` declarations count as local usage as well.
 */
export function validateCssBindings(
  input: CssBindingValidationInput
): CssDiagnostic[] {
  const diagnostics: CssDiagnostic[] = [];
  const defined = new Map<string, Set<string>>();
  const used = new Map<string, Set<string>>();
  const dynamicFiles = new Set<string>();
  const firstRuleByClass = new Map<string, CssRuleRecord>();

  for (const rule of input.rules) {
    if (!rule.isModule) continue;
    const set = defined.get(rule.file) ?? new Set<string>();
    for (const classBinding of rule.classes) {
      if (classBinding.isGlobal) continue;
      set.add(classBinding.name);
      if (!firstRuleByClass.has(`${rule.file}:${classBinding.name}`)) {
        firstRuleByClass.set(`${rule.file}:${classBinding.name}`, rule);
      }
    }
    if (set.size > 0) defined.set(rule.file, set);
  }

  for (const binding of input.bindings) {
    if (!binding.targetCssFile) continue;
    const file = relativePosix(input.root, binding.targetCssFile);
    if (binding.resolutionKind === "dynamic-unresolved") {
      dynamicFiles.add(file);
      continue;
    }
    const set = used.get(file) ?? new Set<string>();
    set.add(binding.className);
    used.set(file, set);
  }

  for (const [absolute, classes] of input.composedUsage) {
    const file = relativePosix(input.root, absolute);
    const set = used.get(file) ?? new Set<string>();
    for (const className of classes) set.add(className);
    used.set(file, set);
  }

  for (const binding of input.bindings) {
    if (!binding.targetCssFile || binding.resolutionKind === "dynamic-unresolved") {
      continue;
    }
    if (!input.analyzedFiles.has(path.resolve(binding.targetCssFile))) continue;

    const file = relativePosix(input.root, binding.targetCssFile);
    const classes = defined.get(file);
    if (!classes || classes.size === 0) continue;
    if (hasMatchingClass(classes, binding.className)) continue;

    diagnostics.push({
      severity: "error",
      code: "MISSING_CSS_MODULE_CLASS",
      file: binding.tsFile,
      line: binding.line,
      symbol: binding.className,
      message: `Component '${binding.componentName}' references '${binding.className}', which does not exist in '${path.basename(file)}'.`,
    });
  }

  for (const [file, classes] of defined) {
    if (dynamicFiles.has(file)) continue;
    const referenced = used.get(file);
    for (const className of classes) {
      if (referenced && hasMatchingClass(referenced, className)) continue;
      const rule = firstRuleByClass.get(`${file}:${className}`);
      diagnostics.push({
        severity: "warning",
        code: "UNUSED_CSS_MODULE_CLASS",
        file,
        line: rule?.line ?? 1,
        symbol: `.${className}`,
        message: `CSS Module class '.${className}' is not referenced by any TypeScript component.`,
      });
    }
  }

  return diagnostics;
}

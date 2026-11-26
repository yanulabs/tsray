import ts from "typescript";
import type { ExtractContext } from "./types.js";

export const CLASS_NAME_HELPERS = new Set([
  "clsx",
  "classnames",
  "classNames",
  "cn",
  "cx",
  "twJoin",
  "twMerge",
]);

export const CLASS_NAME_TRANSFORMS = new Set([
  "trim",
  "trimStart",
  "trimEnd",
  "join",
  "concat",
  "filter",
  "toString",
  "valueOf",
]);

export function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function detectComponentName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
    node.name &&
    /^[A-Z]/.test(node.name.text)
  ) {
    return node.name.text;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    /^[A-Z]/.test(node.name.text) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) ||
      ts.isFunctionExpression(node.initializer) ||
      ts.isClassExpression(node.initializer) ||
      ts.isCallExpression(node.initializer))
  ) {
    return node.name.text;
  }
  return null;
}

export function pushGlobalTokens(
  raw: string,
  context: ExtractContext,
  line: number,
  componentName: string
): void {
  for (const token of raw.split(/\s+/)) {
    const className = token.trim();
    if (!className) continue;
    context.bindings.push({
      tsFile: context.tsFile,
      line,
      componentName,
      targetCssFile: null,
      className,
      resolutionKind: "static",
    });
  }
}

export function collectModuleTargets(
  expression: ts.Expression,
  moduleImports: Map<string, string>,
  targets: Set<string>
): void {
  const current = unwrap(expression);
  if (ts.isIdentifier(current)) {
    const target = moduleImports.get(current.text);
    if (target) targets.add(target);
    return;
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const base = unwrap(current.expression);
    if (ts.isIdentifier(base)) {
      const target = moduleImports.get(base.text);
      if (target) targets.add(target);
    }
  }
  ts.forEachChild(current, (child) => {
    if (ts.isExpression(child)) collectModuleTargets(child, moduleImports, targets);
  });
}

export function pushDynamicPattern(
  context: ExtractContext,
  line: number,
  componentName: string,
  pattern: string,
  expressions: readonly ts.Expression[]
): void {
  const normalized = pattern.replace(/\*+/g, "*");
  const targets = new Set<string>();
  for (const expression of expressions) {
    collectModuleTargets(expression, context.moduleImports, targets);
  }
  if (targets.size === 0) {
    context.bindings.push({
      tsFile: context.tsFile,
      line,
      componentName,
      targetCssFile: null,
      className: normalized,
      resolutionKind: "dynamic-unresolved",
    });
    return;
  }
  for (const target of targets) {
    context.bindings.push({
      tsFile: context.tsFile,
      line,
      componentName,
      targetCssFile: target,
      className: normalized,
      resolutionKind: "dynamic-unresolved",
    });
  }
}

export function pushDynamicBinding(
  context: ExtractContext,
  line: number,
  componentName: string,
  expression: ts.Expression | null,
  pattern = "*"
): void {
  pushDynamicPattern(
    context,
    line,
    componentName,
    pattern,
    expression ? [expression] : []
  );
}

export function collectStringLiteralsFromType(type: ts.Type): string[] {
  if (type.isStringLiteral()) return [type.value];
  if (type.isUnion()) {
    const values: string[] = [];
    for (const member of type.types) {
      if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
      if (!member.isStringLiteral()) return [];
      values.push(member.value);
    }
    return values;
  }
  return [];
}

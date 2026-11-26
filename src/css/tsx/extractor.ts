import ts from "typescript";
import type { CssResolutionKind } from "../types.js";
import type { ExtractContext, Segment, TextSegment, ExpressionSegment } from "./types.js";
import {
  CLASS_NAME_HELPERS,
  CLASS_NAME_TRANSFORMS,
  collectModuleTargets,
  collectStringLiteralsFromType,
  pushDynamicBinding,
  pushDynamicPattern,
  pushGlobalTokens,
  unwrap,
} from "./helpers.js";

function processSegments(
  segments: Segment[],
  context: ExtractContext,
  line: number,
  componentName: string
): void {
  type TokenPart = TextSegment | ExpressionSegment;
  let token: TokenPart[] = [];

  const flush = (): void => {
    if (token.length === 0) return;
    const expressions = token.filter(
      (part): part is ExpressionSegment => part.kind === "expression"
    );
    const text = token
      .filter((part): part is TextSegment => part.kind === "text")
      .map((part) => part.text)
      .join("");

    if (expressions.length === 1 && text.length === 0) {
      extractFromExpression(expressions[0]!.expression, context, line, componentName);
    } else if (expressions.length === 0) {
      pushGlobalTokens(text, context, line, componentName);
    } else if (expressions.length === 1) {
      const expression = expressions[0]!;
      const targets = new Set<string>();
      collectModuleTargets(expression.expression, context.moduleImports, targets);

      if (targets.size === 0) {
        const literals = collectStringLiteralsFromType(
          context.checker.getTypeAtLocation(unwrap(expression.expression))
        );
        if (literals.length > 0) {
          const index = token.indexOf(expression);
          const prefix = token
            .slice(0, index)
            .filter((part): part is TextSegment => part.kind === "text")
            .map((part) => part.text)
            .join("");
          const suffix = token
            .slice(index + 1)
            .filter((part): part is TextSegment => part.kind === "text")
            .map((part) => part.text)
            .join("");
          for (const literal of literals) {
            pushGlobalTokens(`${prefix}${literal}${suffix}`, context, line, componentName);
          }
          token = [];
          return;
        }
      }

      const pattern = token
        .map((part) => (part.kind === "text" ? part.text : "*"))
        .join("");
      pushDynamicBinding(
        context,
        line,
        componentName,
        expression.expression,
        pattern
      );
    } else {
      // Multiple expressions in one token; retain prefix/suffix information
      // when possible, but the middle of the class name remains unknown.
      const pattern = token
        .map((part) => (part.kind === "text" ? part.text : "*"))
        .join("");
      pushDynamicPattern(
        context,
        line,
        componentName,
        pattern,
        expressions.map((expression) => expression.expression)
      );
    }
    token = [];
  };

  for (const segment of segments) {
    if (segment.kind === "expression") {
      token.push(segment);
      continue;
    }
    for (const part of segment.text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        flush();
      } else {
        token.push({ kind: "text", text: part });
      }
    }
  }
  flush();
}

function templateSegments(expression: ts.TemplateExpression): Segment[] {
  const segments: Segment[] = [{ kind: "text", text: expression.head.text }];
  for (const span of expression.templateSpans) {
    segments.push({ kind: "expression", expression: span.expression });
    segments.push({ kind: "text", text: span.literal.text });
  }
  return segments;
}

function flattenConcatenation(expression: ts.Expression, segments: Segment[]): void {
  const current = unwrap(expression);
  if (
    ts.isBinaryExpression(current) &&
    current.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    flattenConcatenation(current.left, segments);
    flattenConcatenation(current.right, segments);
    return;
  }
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    const previous = segments[segments.length - 1];
    if (previous?.kind === "text") {
      previous.text += current.text;
    } else {
      segments.push({ kind: "text", text: current.text });
    }
    return;
  }
  segments.push({ kind: "expression", expression: current });
}

export function extractFromExpression(
  expression: ts.Expression,
  context: ExtractContext,
  line: number,
  componentName: string
): void {
  const expr = unwrap(expression);

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    pushGlobalTokens(expr.text, context, line, componentName);
    return;
  }

  if (ts.isTemplateExpression(expr)) {
    processSegments(templateSegments(expr), context, line, componentName);
    return;
  }

  if (
    ts.isBinaryExpression(expr) &&
    (expr.operatorToken.kind === ts.SyntaxKind.PlusToken ||
      expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    if (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      extractFromExpression(expr.right, context, line, componentName);
      return;
    }
    if (
      expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      extractFromExpression(expr.left, context, line, componentName);
      extractFromExpression(expr.right, context, line, componentName);
      return;
    }
    const segments: Segment[] = [];
    flattenConcatenation(expr, segments);
    processSegments(segments, context, line, componentName);
    return;
  }

  if (ts.isIdentifier(expr)) {
    // Passing the whole module object to a helper makes the concrete classes
    // unknowable, but the module is still in use.
    if (context.moduleImports.has(expr.text)) {
      pushDynamicBinding(context, line, componentName, expr);
      return;
    }

    // Common pattern: `const dayClass = cx('day', ...)` followed by
    // `className={dayClass}`. Resolve local variables that clearly produce a
    // className value. Object literals and functions are intentionally ignored
    // because their keys are not necessarily class names.
    const symbol = context.checker.getSymbolAtLocation(expr);
    for (const declaration of symbol?.declarations ?? []) {
      if (
        !ts.isVariableDeclaration(declaration) ||
        !declaration.initializer ||
        context.resolvingVariables.has(declaration)
      ) {
        continue;
      }
      const initializer = unwrap(declaration.initializer);
      if (
        ts.isObjectLiteralExpression(initializer) ||
        ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer) ||
        ts.isClassExpression(initializer) ||
        ts.isJsxElement(initializer) ||
        ts.isJsxSelfClosingElement(initializer) ||
        ts.isJsxFragment(initializer)
      ) {
        continue;
      }
      context.resolvingVariables.add(declaration);
      try {
        extractFromExpression(initializer, context, line, componentName);
      } finally {
        context.resolvingVariables.delete(declaration);
      }
    }
    return;
  }

  if (ts.isPropertyAccessExpression(expr)) {
    const base = unwrap(expr.expression);
    const target = ts.isIdentifier(base) ? context.moduleImports.get(base.text) : undefined;
    if (target) {
      context.bindings.push({
        tsFile: context.tsFile,
        line,
        componentName,
        targetCssFile: target,
        className: expr.name.text,
        resolutionKind: "static",
      });
      return;
    }

    // Enum-like objects and const maps often expose className constants:
    // `classList.add(Theme.DARK)`. Their type is a string-literal union.
    const literals = collectStringLiteralsFromType(
      context.checker.getTypeAtLocation(expr)
    );
    for (const literal of literals) {
      pushGlobalTokens(literal, context, line, componentName);
    }
    return;
  }

  if (ts.isElementAccessExpression(expr)) {
    const base = unwrap(expr.expression);
    const target = ts.isIdentifier(base) ? context.moduleImports.get(base.text) : undefined;
    if (!target || !expr.argumentExpression) return;

    const argument = unwrap(expr.argumentExpression);
    let kind: CssResolutionKind = "static";
    let literals: string[];
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
      literals = [argument.text];
    } else {
      literals = collectStringLiteralsFromType(context.checker.getTypeAtLocation(argument));
      kind = "type-resolved";
    }

    if (literals.length > 0) {
      for (const className of literals) {
        context.bindings.push({
          tsFile: context.tsFile,
          line,
          componentName,
          targetCssFile: target,
          className,
          resolutionKind: kind,
        });
      }
    } else {
      pushDynamicBinding(context, line, componentName, expr);
    }
    return;
  }

  if (ts.isCallExpression(expr)) {
    const callee = unwrap(expr.expression);
    const name = ts.isIdentifier(callee) ? callee.text : null;
    if (name && CLASS_NAME_HELPERS.has(name)) {
      for (const argument of expr.arguments) {
        extractFromExpression(argument, context, line, componentName);
      }
      return;
    }

    // Common transforms preserve the className value: `... .trim()`,
    // `array.filter(Boolean).join(" ")`, `value.toString()`.
    if (
      ts.isPropertyAccessExpression(callee) &&
      CLASS_NAME_TRANSFORMS.has(callee.name.text)
    ) {
      extractFromExpression(callee.expression, context, line, componentName);
      return;
    }

    // Unknown helpers may still consume module classes. Suppress unused-class
    // warnings for the target modules rather than guessing the final names.
    const targets = new Set<string>();
    for (const argument of expr.arguments) {
      collectModuleTargets(argument, context.moduleImports, targets);
    }
    for (const target of targets) {
      context.bindings.push({
        tsFile: context.tsFile,
        line,
        componentName,
        targetCssFile: target,
        className: "*",
        resolutionKind: "dynamic-unresolved",
      });
    }
    return;
  }

  if (ts.isArrayLiteralExpression(expr)) {
    for (const element of expr.elements) {
      if (ts.isSpreadElement(element)) {
        extractFromExpression(element.expression, context, line, componentName);
      } else if (!ts.isOmittedExpression(element)) {
        extractFromExpression(element, context, line, componentName);
      }
    }
    return;
  }

  if (ts.isConditionalExpression(expr)) {
    extractFromExpression(expr.whenTrue, context, line, componentName);
    extractFromExpression(expr.whenFalse, context, line, componentName);
    return;
  }

  if (ts.isObjectLiteralExpression(expr)) {
    for (const property of expr.properties) {
      if (ts.isPropertyAssignment(property)) {
        if (ts.isComputedPropertyName(property.name)) {
          extractFromExpression(property.name.expression, context, line, componentName);
        } else if (
          ts.isStringLiteral(property.name) ||
          ts.isIdentifier(property.name) ||
          ts.isNumericLiteral(property.name)
        ) {
          pushGlobalTokens(property.name.text, context, line, componentName);
        }
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        pushGlobalTokens(property.name.text, context, line, componentName);
        continue;
      }
      if (ts.isSpreadAssignment(property)) {
        extractFromExpression(property.expression, context, line, componentName);
      }
    }
  }
}

export function collectDomClassUsage(
  node: ts.CallExpression,
  context: ExtractContext,
  line: number,
  componentName: string
): void {
  const callee = unwrap(node.expression);
  if (!ts.isPropertyAccessExpression(callee)) return;

  const method = callee.name.text;
  if (
    ["add", "remove", "toggle", "replace"].includes(method) &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === "classList"
  ) {
    for (const argument of node.arguments) {
      extractFromExpression(argument, context, line, componentName);
    }
    return;
  }

  if (method === "setAttribute" && node.arguments.length >= 2) {
    const attribute = node.arguments[0];
    if (
      attribute &&
      (ts.isStringLiteral(attribute) || ts.isNoSubstitutionTemplateLiteral(attribute)) &&
      (attribute.text === "class" || attribute.text === "className")
    ) {
      const value = node.arguments[1]!;
      extractFromExpression(value, context, line, componentName);
    }
  }
}

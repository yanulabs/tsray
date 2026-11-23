import ts from "typescript";

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

export function getFileDirective(sourceFile: ts.SourceFile): "use client" | "use server" | null {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    if (statement.expression.text === "use client") return "use client";
    if (statement.expression.text === "use server") return "use server";
  }
  return null;
}

export function computeComplexity(node: ts.Node): number {
  let complexity = 1;

  const visit = (current: ts.Node): void => {
    if (
      ts.isIfStatement(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isCaseClause(current) ||
      ts.isCatchClause(current) ||
      ts.isConditionalExpression(current)
    ) {
      complexity++;
    } else if (ts.isBinaryExpression(current)) {
      const kind = current.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.QuestionQuestionToken ||
        kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
        kind === ts.SyntaxKind.BarBarEqualsToken ||
        kind === ts.SyntaxKind.QuestionQuestionEqualsToken
      ) {
        complexity++;
      }
    }
    ts.forEachChild(current, visit);
  };

  visit(node);
  return complexity;
}

export function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

export function extractDoc(node: ts.Node, sourceFile: ts.SourceFile): string {
  const raw = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile));
  const match = /\/\*\*([\s\S]*?)\*\//.exec(raw);
  if (!match) return "";
  return match[1]!
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();
}

export function isExportedNode(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
  if (ts.isVariableDeclaration(node) && node.parent && ts.isVariableDeclarationList(node.parent)) {
    const statement = node.parent.parent;
    if (statement && ts.canHaveModifiers(statement)) {
      return Boolean(
        ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      );
    }
  }
  return false;
}

export function isDefaultExportNode(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return true;
  if (ts.isVariableDeclaration(node) && node.parent && ts.isVariableDeclarationList(node.parent)) {
    const statement = node.parent.parent;
    return Boolean(
      statement &&
        ts.canHaveModifiers(statement) &&
        ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
    );
  }
  return false;
}

export function isGeneratedSource(sourceFile: ts.SourceFile): boolean {
  const header = sourceFile.text.slice(0, 600);
  if (/@generated|DO NOT EDIT|auto-generated|eslint-disable.*generated/i.test(header)) return true;
  return /(^|\/)(generated|__generated__)\//i.test(sourceFile.fileName);
}

export function pascalCase(value: string): string {
  const cleaned = value.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]+/g, " ").trim();
  if (!cleaned) return "DefaultExport";
  return cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n// ... truncated ...`;
}

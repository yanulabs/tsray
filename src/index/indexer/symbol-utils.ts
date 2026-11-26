import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { isSourceFile, toPosix } from "../../util/paths.js";
import { containsJsx, pascalCase } from "../../util/source.js";
import type { SymbolKind } from "../types.js";

export function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Resolves symlinked roots (notably /var -> /private/var on macOS) so the
 * LanguageService version map and watcher events refer to the same key.
 */
export function canonicalPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    } catch {
      return path.resolve(file);
    }
  }
}

export function classApiSignature(
  node: ts.ClassDeclaration | ts.ClassExpression,
  sourceFile: ts.SourceFile
): string {
  const parts: string[] = [];
  for (const heritage of node.heritageClauses ?? []) {
    parts.push(heritage.getText(sourceFile));
  }
  for (const member of node.members) {
    if (!isPublicMember(member)) continue;
    const modifiers = (ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined)
      ?.map((modifier) => modifier.getText(sourceFile))
      .filter((modifier) => modifier !== "async" && modifier !== "public");
    const prefix = modifiers && modifiers.length > 0 ? `${modifiers.join(" ")} ` : "";
    if (ts.isConstructorDeclaration(member)) {
      const parameters = member.parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
      parts.push(`constructor(${parameters})`);
      continue;
    }
    if (ts.isMethodDeclaration(member)) {
      const name = member.name.getText(sourceFile);
      const typeParameters = member.typeParameters
        ? `<${member.typeParameters.map((parameter) => parameter.getText(sourceFile)).join(", ")}>`
        : "";
      const parameters = member.parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
      const returns = member.type ? `: ${member.type.getText(sourceFile)}` : "";
      parts.push(`${prefix}${name}${typeParameters}(${parameters})${returns}`);
      continue;
    }
    if (ts.isPropertyDeclaration(member)) {
      const name = member.name.getText(sourceFile);
      const optional = member.questionToken ? "?" : "";
      const type = member.type ? `: ${member.type.getText(sourceFile)}` : "";
      parts.push(`${prefix}${name}${optional}${type}`);
      continue;
    }
    if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
      const parameters = member.parameters.map((parameter) => parameter.getText(sourceFile)).join(", ");
      const returns = member.type ? `: ${member.type.getText(sourceFile)}` : "";
      parts.push(`${prefix}get ${member.name.getText(sourceFile)}(${parameters})${returns}`);
      continue;
    }
    if (ts.isIndexSignatureDeclaration(member)) {
      parts.push(member.getText(sourceFile));
    }
  }
  return parts.join("; ");
}

export function requiredMemberNames(type: ts.Type): Set<string> {
  const names = new Set<string>();
  for (const property of type.getProperties()) {
    if ((property.flags & ts.SymbolFlags.Optional) === 0) names.add(property.name);
  }
  return names;
}

export function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  if (!node.importClause) return false;
  if (node.importClause.isTypeOnly) return true;
  if (node.importClause.name) return false;
  const bindings = node.importClause.namedBindings;
  return Boolean(
    bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((element) => element.isTypeOnly)
  );
}

export function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return false;
  return (
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

export function isPublicMember(node: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  if (
    modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword
    )
  ) {
    return false;
  }
  const name = (node as ts.NamedDeclaration).name;
  return !name || !ts.isPrivateIdentifier(name);
}

export function isNodeWithBody(node: ts.Node): boolean {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node)) &&
    Boolean(node.body)
  );
}

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

interface ClassifiedInitializer {
  kind: "memo" | "forwardRef" | "lazy" | "context" | "expression";
  inner: ts.Expression | null;
}

export function classifyInitializer(expression: ts.Expression, checker: ts.TypeChecker): ClassifiedInitializer {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current)) return { kind: "expression", inner: null };
  const calleeText = current.expression.getText();
  const name = resolvedSymbolName(checker, current.expression) ?? calleeText.split(".").pop() ?? calleeText;
  if (name === "lazy") {
    const argument = current.arguments[0] ?? null;
    return { kind: "lazy", inner: (argument && extractDynamicImport(argument)) ?? argument };
  }
  if (name === "memo" || name === "forwardRef") {
    return { kind: name, inner: current.arguments[0] ?? null };
  }
  if (name === "createContext") {
    return { kind: "context", inner: null };
  }
  return { kind: "expression", inner: null };
}

export function extractDynamicImport(expression: ts.Expression): ts.CallExpression | null {
  const current = unwrapExpression(expression);
  if (ts.isCallExpression(current)) {
    return current.expression.kind === ts.SyntaxKind.ImportKeyword ? current : null;
  }
  if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
    const body = current.body;
    if (!ts.isBlock(body)) return extractDynamicImport(body);
    for (const statement of body.statements) {
      if (ts.isReturnStatement(statement) && statement.expression) {
        return extractDynamicImport(statement.expression);
      }
    }
  }
  return null;
}

interface CallableClassification {
  kind: SymbolKind;
  propsType: string | null;
  signature: string;
}

export function classifyCallable(
  checker: ts.TypeChecker,
  node: ts.Node,
  name: string,
  isHocComponent: boolean,
  sourceFile: ts.SourceFile
): CallableClassification {
  const type = checker.getTypeAtLocation(node);
  const callSignatures = type.getCallSignatures();
  const signature = callSignatures[0]
    ? checker.signatureToString(callSignatures[0])
    : checker.typeToString(type);

  if (/^use[A-Z0-9]/.test(name)) {
    return { kind: "hook", propsType: null, signature };
  }

  const isPascalCase = /^[A-Z]/.test(name);
  const returnType = callSignatures[0]?.getReturnType();
  const returnText = returnType ? checker.typeToString(returnType) : "";
  const returnsJsx =
    /(^|[.\s|&])(ReactNode|ReactElement|ReactPortal|JSX\.Element|Element)(?=$|[.\s|&<])/.test(returnText) ||
    containsJsx(node) ||
    (ts.isCallExpression(node) &&
      /(memo|forwardRef|lazy)$/.test(node.expression.getText(sourceFile)));

  if (isHocComponent || (isPascalCase && returnsJsx)) {
    const firstParameter = callSignatures[0]?.getParameters()[0];
    const propsType = firstParameter
      ? checker.typeToString(checker.getTypeOfSymbolAtLocation(firstParameter, node))
      : null;
    return { kind: "component", propsType, signature };
  }

  return { kind: "function", propsType: null, signature };
}

export function classifyClass(
  checker: ts.TypeChecker,
  node: ts.ClassDeclaration | ts.ClassExpression,
  sourceFile: ts.SourceFile
): CallableClassification {
  const signature = checker.typeToString(checker.getTypeAtLocation(node));
  let propsType: string | null = null;
  let isReactComponent = false;

  for (const heritage of node.heritageClauses ?? []) {
    for (const type of heritage.types) {
      const baseText = type.expression.getText(sourceFile);
      if (/(^|\.)(Component|PureComponent)$/.test(baseText)) {
        isReactComponent = true;
        const argument = type.typeArguments?.[0];
        if (argument) propsType = argument.getText(sourceFile);
      }
    }
  }

  if (isReactComponent) {
    return { kind: "component", propsType, signature };
  }
  return { kind: "class", propsType: null, signature };
}

export function resolveSymbolTargetByIdentity(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>,
  declarationIds: Map<string, string>,
  root: string
): string | null {
  let current = symbol;
  if (current.flags & ts.SymbolFlags.Alias) {
    try {
      current = checker.getAliasedSymbol(current);
    } catch {
      return null;
    }
  }
  const declarations = current.getDeclarations() ?? [];
  for (const declaration of declarations) {
    const direct =
      declToId.get(declaration) ??
      declarationIds.get(declarationKey(declaration, root)) ??
      symbolIdForDeclaration(declaration, root);
    if (direct) return direct;
    if (declaration.parent) {
      const parent =
        declToId.get(declaration.parent) ??
        declarationIds.get(declarationKey(declaration.parent, root)) ??
        symbolIdForDeclaration(declaration.parent, root);
      if (parent) return parent;
    }
  }
  return null;
}

export function symbolIdForDeclaration(node: ts.Node, root: string): string | null {
  const sourceFile = node.getSourceFile();
  if (!sourceFile || sourceFile.isDeclarationFile) return null;
  const relative = toPosix(path.relative(root, sourceFile.fileName));
  if (relative.startsWith("..") || !isSourceFile(relative)) return null;
  const fallbackName = pascalCase(path.basename(relative));
  if (ts.isFunctionDeclaration(node)) {
    return `sym:${relative}#${node.name?.text ?? fallbackName}`;
  }
  if (ts.isClassDeclaration(node)) {
    return `sym:${relative}#${node.name?.text ?? fallbackName}`;
  }
  if (ts.isInterfaceDeclaration(node)) return `sym:${relative}#${node.name.text}`;
  if (ts.isTypeAliasDeclaration(node)) return `sym:${relative}#${node.name.text}`;
  if (ts.isEnumDeclaration(node)) return `sym:${relative}#${node.name.text}`;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return `sym:${relative}#${node.name.text}`;
  }
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
    const parent = node.parent;
    if (parent && ts.isClassDeclaration(parent)) {
      return `sym:${relative}:${parent.name?.text ?? fallbackName}#${node.name.text}`;
    }
  }
  if (ts.isExportAssignment(node) && !node.isExportEquals) {
    const expression = unwrapExpression(node.expression);
    if (
      ts.isArrowFunction(expression) ||
      ts.isFunctionExpression(expression) ||
      ts.isClassExpression(expression) ||
      ts.isCallExpression(expression)
    ) {
      return `sym:${relative}#${fallbackName}`;
    }
  }
  return null;
}

export function declarationKey(node: ts.Node, root: string): string {
  const sourceFile = node.getSourceFile();
  const relative = toPosix(path.relative(root, sourceFile.fileName));
  return `${relative}:${node.getStart(sourceFile)}:${node.end}:${node.kind}`;
}

export function resolvedSymbolName(checker: ts.TypeChecker, node: ts.Node): string | null {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      return symbol.getName();
    }
  }
  return symbol.getName();
}

export function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;

  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) {
    return false;
  }
  if (ts.isExportSpecifier(parent) || ts.isExportAssignment(parent)) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isModuleDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isJsxAttribute(parent)) return false;
  if (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) {
    return false;
  }
  if (ts.isLabeledStatement(parent)) return false;
  if (ts.isBreakOrContinueStatement(parent)) return false;
  if (ts.isMetaProperty(parent)) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  return true;
}

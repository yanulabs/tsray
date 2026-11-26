import path from "node:path";
import ts from "typescript";
import { pascalCase } from "../../util/source.js";
import { relativePosix } from "../paths.js";
import {
  isCssSpecifier,
  isPreprocessorSpecifier,
  resolveCssSpecifier,
} from "../resolver.js";
import type {
  CssAnalysisProject,
  CssBindingRecord,
  CssSkippedPreprocessor,
} from "../types.js";
import {
  collectDomClassUsage,
  detectComponentName,
  extractFromExpression,
  lineOf,
  pushGlobalTokens,
  unwrap,
} from "./expressions.js";
import type { CssTsxExtraction, ExtractContext } from "./types.js";

function findRequireCssImports(
  sourceFile: ts.SourceFile,
  context: ExtractContext,
  addCssFile: (absolute: string) => void
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const initializer = unwrap(node.initializer);
      if (ts.isCallExpression(initializer) && initializer.arguments.length === 1) {
        const callee = unwrap(initializer.expression);
        const isRequire = ts.isIdentifier(callee) && callee.text === "require";
        const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        const argument = initializer.arguments[0];
        if (
          (isRequire || isDynamicImport) &&
          argument &&
          (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
          isCssSpecifier(argument.text)
        ) {
          const resolved = resolveCssSpecifier(
            argument.text,
            sourceFile.fileName,
            context.project
          );
          if (resolved) {
            context.moduleImports.set(node.name.text, resolved);
            addCssFile(resolved);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function extractBindingsFromFile(
  sourceFile: ts.SourceFile,
  project: CssAnalysisProject,
  checker: ts.TypeChecker,
  root: string,
  cssFiles: Set<string>,
  skippedPreprocessors: CssSkippedPreprocessor[],
  unresolvedImports: Array<{ tsFile: string; specifier: string; line: number }>
): CssBindingRecord[] {
  const tsFile = path.resolve(sourceFile.fileName);
  const tsRelative = relativePosix(root, tsFile);
  const moduleImports = new Map<string, string>();
  const bindings: CssBindingRecord[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (isPreprocessorSpecifier(specifier)) {
      const resolved = resolveCssSpecifier(specifier, tsFile, project);
      skippedPreprocessors.push({
        tsFile: tsRelative,
        specifier,
        resolvedFile: resolved ? relativePosix(root, resolved) : null,
      });
      continue;
    }
    if (!isCssSpecifier(specifier)) continue;

    const resolved = resolveCssSpecifier(specifier, tsFile, project);
    if (!resolved) {
      unresolvedImports.push({
        tsFile: tsRelative,
        specifier,
        line: lineOf(sourceFile, statement),
      });
      continue;
    }
    cssFiles.add(resolved);

    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) moduleImports.set(clause.name.text, resolved);
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        moduleImports.set(clause.namedBindings.name.text, resolved);
      } else {
        for (const element of clause.namedBindings.elements) {
          moduleImports.set(element.name.text, resolved);
        }
      }
    }
  }

  const context: ExtractContext = {
    sourceFile,
    checker,
    root,
    tsFile: tsRelative,
    project,
    moduleImports,
    bindings,
    resolvingVariables: new Set<ts.Node>(),
  };

  findRequireCssImports(sourceFile, context, (file) => cssFiles.add(file));

  const defaultComponent = pascalCase(path.basename(tsFile));
  const visit = (node: ts.Node, currentComponent: string): void => {
    const nextComponent = detectComponentName(node) ?? currentComponent;

    if (ts.isCallExpression(node)) {
      collectDomClassUsage(node, context, lineOf(sourceFile, node), nextComponent);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "className"
    ) {
      extractFromExpression(
        node.right,
        context,
        lineOf(sourceFile, node),
        nextComponent
      );
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      const lower = name.toLowerCase();
      const isClassNameProp =
        lower === "class" ||
        lower === "classname" ||
        lower.endsWith("classname") ||
        lower.endsWith("class");
      const isClassNamesProp =
        lower === "classnames" || lower.endsWith("classnames");

      if ((isClassNameProp || isClassNamesProp) && node.initializer) {
        const line = lineOf(sourceFile, node);
        if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          const expression = node.initializer.expression;
          if (isClassNamesProp && ts.isObjectLiteralExpression(expression)) {
            for (const property of expression.properties) {
              if (ts.isPropertyAssignment(property)) {
                extractFromExpression(
                  property.initializer,
                  context,
                  line,
                  nextComponent
                );
              }
            }
          } else {
            extractFromExpression(expression, context, line, nextComponent);
          }
        } else if (
          ts.isStringLiteral(node.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(node.initializer)
        ) {
          pushGlobalTokens(node.initializer.text, context, line, nextComponent);
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, nextComponent));
  };
  visit(sourceFile, defaultComponent);

  return bindings;
}

interface ImportEdge {
  kind: "ts" | "css";
  file: string;
}

function resolveTsSpecifier(
  specifier: string,
  containingFile: string,
  project: CssAnalysisProject
): string | null {
  const resolved = ts.resolveModuleName(
    specifier,
    containingFile,
    project.compilerOptions,
    ts.sys
  ).resolvedModule;
  if (!resolved) return null;
  return path.resolve(resolved.resolvedFileName);
}

/**
 * Mirrors module evaluation order from the files that are not imported by any
 * other owned file. CSS cascade layers are global across stylesheets, so using
 * alphabetical file order would invert layers imported by an entry component.
 */
function orderedCssImports(
  program: ts.Program,
  project: CssAnalysisProject,
  owned: Set<string>
): string[] {
  const ordered: string[] = [];
  const seenCss = new Set<string>();
  const edges = new Map<string, ImportEdge[]>();
  const importedBy = new Set<string>();
  const ownedOrder = project.ownedFiles
    .map((file) => path.resolve(file))
    .filter((file) => owned.has(file));

  for (const file of ownedOrder) {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile || sourceFile.isDeclarationFile) continue;
    const fileEdges: ImportEdge[] = [];
    for (const statement of sourceFile.statements) {
      let specifier: string | undefined;
      if (
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        specifier = statement.moduleSpecifier.text;
      }
      if (!specifier) continue;

      if (isPreprocessorSpecifier(specifier)) continue;
      if (isCssSpecifier(specifier)) {
        const resolved = resolveCssSpecifier(specifier, sourceFile.fileName, project);
        if (resolved) fileEdges.push({ kind: "css", file: resolved });
        continue;
      }

      const resolved = resolveTsSpecifier(specifier, sourceFile.fileName, project);
      if (resolved && owned.has(resolved)) {
        fileEdges.push({ kind: "ts", file: resolved });
        importedBy.add(resolved);
      }
    }
    edges.set(file, fileEdges);
  }

  const roots = ownedOrder.filter((file) => !importedBy.has(file));
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const edge of edges.get(file) ?? []) {
      if (edge.kind === "css") {
        if (!seenCss.has(edge.file)) {
          seenCss.add(edge.file);
          ordered.push(edge.file);
        }
      } else {
        visit(edge.file);
      }
    }
  };

  for (const rootFile of roots.length > 0 ? roots : ownedOrder) visit(rootFile);
  for (const file of ownedOrder) visit(file);
  return ordered;
}

/**
 * Extracts CSS imports and className bindings from every owned TypeScript file.
 * Uses the project compiler options and a real TypeChecker so computed keys can
 * be resolved from string-literal unions.
 */
export function extractCssBindings(projects: readonly CssAnalysisProject[], root: string): CssTsxExtraction {
  const bindings: CssBindingRecord[] = [];
  const cssFiles = new Set<string>();
  const orderedCss = new Set<string>();
  const skippedPreprocessors: CssSkippedPreprocessor[] = [];
  const unresolvedImports: Array<{ tsFile: string; specifier: string; line: number }> = [];

  const seenFiles = new Set<string>();
  for (const project of projects) {
    const owned = new Set(project.ownedFiles.map((file) => path.resolve(file)));
    if (owned.size === 0) continue;

    const program = ts.createProgram({
      rootNames: project.rootNames,
      options: { ...project.compilerOptions, noEmit: true },
    });
    const checker = program.getTypeChecker();

    for (const sourceFile of program.getSourceFiles()) {
      const absolute = path.resolve(sourceFile.fileName);
      if (sourceFile.isDeclarationFile || !owned.has(absolute) || seenFiles.has(absolute)) {
        continue;
      }
      seenFiles.add(absolute);
      bindings.push(
        ...extractBindingsFromFile(
          sourceFile,
          project,
          checker,
          root,
          cssFiles,
          skippedPreprocessors,
          unresolvedImports
        )
      );
    }

    for (const file of orderedCssImports(program, project, owned)) {
      orderedCss.add(file);
    }
  }

  return {
    bindings,
    cssFiles: new Set([...orderedCss, ...cssFiles]),
    skippedPreprocessors,
    unresolvedImports,
  };
}

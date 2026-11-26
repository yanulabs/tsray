import path from "node:path";
import ts from "typescript";
import { TEST_FILE_RE } from "../../util/glob.js";
import {
  deriveModuleName,
  isExcluded,
  isSourceFile,
  toPosix,
} from "../../util/paths.js";
import type {
  EdgeKind,
  EdgeRecord,
  FileImportEdge,
  FileRecord,
  SymbolRecord,
} from "../types.js";
import type { resolveProject } from "../../util/paths.js";
import {
  isReferenceIdentifier,
  isTypeOnlyExport,
  isTypeOnlyImport,
  lineOf,
  resolvedSymbolName,
  unwrapExpression,
} from "./symbol-utils.js";
import type { ParsedProject, PendingWrap } from "./types.js";

export interface ProjectEdgeContext {
  root: string;
  config: ReturnType<typeof resolveProject>["config"];
  project: ParsedProject;
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFiles: ts.SourceFile[];
  files: Map<string, FileRecord>;
  fileImports: FileImportEdge[];
  symbols: Map<string, SymbolRecord>;
  edges: EdgeRecord[];
  seenEdges: Set<string>;
  seenFileImports: Set<string>;
  pendingWraps: PendingWrap[];
  declToId: Map<ts.Node, string>;
  relOf(sourceFile: ts.SourceFile): string;
  fileId(relative: string): string;
  resolveSymbolTarget(symbol: ts.Symbol, checker: ts.TypeChecker, declToId: Map<ts.Node, string>): string | null;
}

export function addImportAndWrapperEdges(context: ProjectEdgeContext): {
  addEdge: (fromId: string, toId: string, kind: EdgeKind, relative: string, line: number, via?: string) => void;
} {
    const moduleResolutionCache = ts.createModuleResolutionCache(
      context.root,
      (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
      context.project.options
    );
    const moduleResolutionHost: ts.ModuleResolutionHost = {
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      directoryExists: ts.sys.directoryExists,
      getDirectories: (directory) => ts.sys.getDirectories(directory).sort(),
      realpath: ts.sys.realpath,
    };
    const {
      project,
      program,
      checker,
      sourceFiles,
      files,
      fileImports,
      symbols,
      edges,
      seenEdges,
      seenFileImports,
      pendingWraps,
      declToId,
      relOf,
      fileId,
      resolveSymbolTarget,
    } = context;
    const root = context.root;
    const config = context.config;
    const resolveDeclarationTarget = (
      targetChecker: ts.TypeChecker,
      node: ts.Node,
      targetDeclToId: Map<ts.Node, string>
    ): string | null => {
      const symbol = targetChecker.getSymbolAtLocation(node);
      return symbol
        ? resolveSymbolTarget(symbol, targetChecker, targetDeclToId)
        : null;
    };
    // Add file import edges and symbol-level import/re-export edges.
    const addModuleResolution = (sourceFile: ts.SourceFile, specifier: string): string | null => {
      const resolved = ts.resolveModuleName(
        specifier,
        sourceFile.fileName,
        project.options,
        moduleResolutionHost,
        moduleResolutionCache
      ).resolvedModule;
      if (!resolved) return null;
      const absolute = path.resolve(resolved.resolvedFileName);
      const relative = toPosix(path.relative(root, absolute));
      if (relative.startsWith("..") || !isSourceFile(relative)) return null;
      if (isExcluded(relative, config)) return null;
      return relative;
    };

    const addFileImport = (
      sourceFile: ts.SourceFile,
      specifier: string,
      line: number,
      typeOnly: boolean
    ): string | null => {
      const fromFile = relOf(sourceFile);
      const toFile = addModuleResolution(sourceFile, specifier);
      if (!toFile || toFile === fromFile) return toFile;
      const key = `${fromFile}|${toFile}|${line}|${typeOnly ? "type" : "value"}`;
      if (seenFileImports.has(key)) return toFile;
      seenFileImports.add(key);
      fileImports.push({
        fromFile,
        toFile,
        specifier,
        line,
        fromModule: deriveModuleName(fromFile),
        toModule: deriveModuleName(toFile),
        typeOnly,
        isTest: TEST_FILE_RE.test(fromFile),
      });
      const record = files.get(fromFile);
      if (record) record.imports++;
      return toFile;
    };

    const addEdge = (
      fromId: string,
      toId: string,
      kind: EdgeKind,
      relative: string,
      line: number,
      via?: string
    ): void => {
      if (fromId === toId) return;
      if (!fromId.startsWith("file:") && !symbols.has(fromId)) return;
      const key = `${fromId}|${toId}|${kind}|${relative}:${line}|${via ?? ""}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push({ fromId, toId, kind, file: relative, line, ...(via ? { via } : {}) });
    };

    const resolveDynamicImport = (sourceFile: ts.SourceFile, call: ts.CallExpression): string | null => {
      if (call.arguments.length === 0) return null;
      const argument = call.arguments[0]!;
      if (!ts.isStringLiteralLike(argument)) return null;
      return addFileImport(sourceFile, argument.text, lineOf(sourceFile, call), false);
    };

    const resolveDefaultExportOfFile = (relative: string): string | null => {
      const absolute = path.resolve(context.root, relative);
      const sourceFile = program.getSourceFile(absolute);
      if (!sourceFile) return null;
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) return null;
      let exported: ts.Symbol[];
      try {
        exported = checker.getExportsOfModule(moduleSymbol);
      } catch {
        return null;
      }
      const preferred = exported.find((symbol) => symbol.name === "default") ?? exported[0];
      return preferred ? resolveSymbolTarget(preferred, checker, declToId) : null;
    };

    for (const sourceFile of sourceFiles) {
      const relative = relOf(sourceFile);
      const currentFileId = fileId(relative);

      for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement)) {
          const line = lineOf(sourceFile, statement);
          const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
          if (specifier) addFileImport(sourceFile, specifier, line, isTypeOnlyImport(statement));
          if (!statement.importClause) continue;
          const bindings: ts.Node[] = [];
          if (statement.importClause.name) bindings.push(statement.importClause.name);
          const namedBindings = statement.importClause.namedBindings;
          if (namedBindings) {
            if (ts.isNamedImports(namedBindings)) {
              for (const element of namedBindings.elements) bindings.push(element.name);
            } else {
              bindings.push(namedBindings.name);
            }
          }
          for (const binding of bindings) {
            const target = resolveDeclarationTarget(checker, binding, declToId);
            if (target) addEdge(currentFileId, target, "imports", relative, line);
          }
          continue;
        }

        if (ts.isExportDeclaration(statement)) {
          const line = lineOf(sourceFile, statement);
          const specifier =
            statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
              ? statement.moduleSpecifier.text
              : null;
          if (specifier) {
            addFileImport(sourceFile, specifier, line, isTypeOnlyExport(statement));
          }
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) {
              const symbol = checker.getSymbolAtLocation(element.name);
              const target = symbol ? resolveSymbolTarget(symbol, checker, declToId) : null;
              if (!target) continue;
              declToId.set(element, target);
              addEdge(currentFileId, target, "re_exports", relative, line);
            }
          } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
            // Namespace re-exports are represented by the file import edge.
          } else if (!statement.exportClause && specifier) {
            const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier!);
            if (moduleSymbol) {
              try {
                for (const exported of checker.getExportsOfModule(moduleSymbol)) {
                  const target = resolveSymbolTarget(exported, checker, declToId);
                  if (target) addEdge(currentFileId, target, "re_exports", relative, line);
                }
              } catch {
                // Ignore unresolvable export stars.
              }
            }
          }
          continue;
        }
      }

      const skipReferenceNodes = new Set<ts.Node>();
      const visit = (node: ts.Node, enclosingId: string): void => {
        const directId = declToId.get(node);
        const currentId = directId ?? enclosingId;
        const line = lineOf(sourceFile, node);

        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName;
          if (ts.isPropertyAccessExpression(tag)) {
            const last = tag.name.text;
            if (last === "Provider") {
              const contextId = resolveDeclarationTarget(checker, tag.expression, declToId);
              if (contextId) {
                addEdge(currentId, contextId, "provides_context", relative, line);
                skipReferenceNodes.add(tag.expression);
              }
            } else if (last === "Consumer") {
              const contextId = resolveDeclarationTarget(checker, tag.expression, declToId);
              if (contextId) {
                addEdge(currentId, contextId, "consumes_context", relative, line);
                skipReferenceNodes.add(tag.expression);
              }
            } else {
              const target = resolveDeclarationTarget(checker, tag, declToId);
              if (target) {
                const kind = symbols.get(target)?.kind === "context" ? "provides_context" : "renders";
                addEdge(currentId, target, kind, relative, line);
                skipReferenceNodes.add(tag);
              }
            }
          } else if (ts.isIdentifier(tag)) {
            const text = tag.text;
            if (/^[A-Z]/.test(text)) {
              const target = resolveDeclarationTarget(checker, tag, declToId);
              if (target) {
                const kind = symbols.get(target)?.kind === "context" ? "provides_context" : "renders";
                addEdge(currentId, target, kind, relative, line);
                skipReferenceNodes.add(tag);
              }
            }
          }
        }

        if (ts.isCallExpression(node)) {
          const calleeText = node.expression.getText(sourceFile);
          const calleeName = resolvedSymbolName(checker, node.expression) ?? calleeText.split(".").pop();
          if ((calleeName === "useContext" || calleeName === "use") && node.arguments.length > 0) {
            const contextId = resolveDeclarationTarget(checker, node.arguments[0]!, declToId);
            if (contextId) {
              addEdge(currentId, contextId, "consumes_context", relative, line);
              skipReferenceNodes.add(node.arguments[0]!);
            }
          }

          if (calleeName === "createElement" && node.arguments.length > 0) {
            const target = resolveDeclarationTarget(checker, node.arguments[0]!, declToId);
            if (target) {
              addEdge(currentId, target, "renders", relative, line);
              skipReferenceNodes.add(node.arguments[0]!);
            }
          }

          if (
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "createContext"
          ) {
            // The createContext symbol is external; the declaration symbol is indexed separately.
          }

          if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            resolveDynamicImport(sourceFile, node);
          } else {
            const target = resolveDeclarationTarget(checker, node.expression, declToId);
            if (target) {
              const targetKind = symbols.get(target)?.kind;
              const kind: EdgeKind = targetKind === "hook" ? "uses_hook" : "calls";
              addEdge(currentId, target, kind, relative, line);
            }
          }
          skipReferenceNodes.add(node.expression);
        }

        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
          for (const heritage of node.heritageClauses ?? []) {
            for (const type of heritage.types) {
              const target = resolveDeclarationTarget(checker, type.expression, declToId);
              if (target) {
                addEdge(currentId, target, "implements", relative, line, heritage.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends");
                skipReferenceNodes.add(type.expression);
              }
            }
          }
        }

        if (ts.isIdentifier(node) && !skipReferenceNodes.has(node) && isReferenceIdentifier(node)) {
          const target = resolveDeclarationTarget(checker, node, declToId);
          if (target) addEdge(currentId, target, "references", relative, line);
        }

        ts.forEachChild(node, (child) => visit(child, currentId));
      };
      visit(sourceFile, currentFileId);
    }

    // HOC wrapper edges (memo/forwardRef/fragment wrappers and React.lazy).
    for (const pending of pendingWraps) {
      const internal = unwrapExpression(pending.expression);
      const target = resolveDeclarationTarget(checker, internal, declToId);
      if (target) {
        addEdge(
          pending.fromId,
          target,
          "wraps",
          relOf(pending.sourceFile),
          lineOf(pending.sourceFile, pending.expression)
        );
        continue;
      }
      if (ts.isCallExpression(internal) && internal.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const file = resolveDynamicImport(pending.sourceFile, internal);
        if (file) {
          const targetFromFile = resolveDefaultExportOfFile(file);
          if (targetFromFile) {
            addEdge(
              pending.fromId,
              targetFromFile,
              "wraps",
              relOf(pending.sourceFile),
              lineOf(pending.sourceFile, pending.expression)
            );
          }
        }
      }
    }

  return { addEdge };
}

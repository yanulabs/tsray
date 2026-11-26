import path from "node:path";
import ts from "typescript";
import {
  computeDirectHashes,
  normalizeNodeText,
} from "../hasher.js";
import type {
  DiagnosticWarning,
  SymbolKind,
  SymbolRecord,
} from "../types.js";
import type { resolveProject } from "../../util/paths.js";
import {
  canonicalizeTypeText,
  deriveModuleName,
  isEntrypointFile,
  toPosix,
} from "../../util/paths.js";
import {
  computeComplexity,
  countLines,
  extractDoc,
  getFileDirective,
  isDefaultExportNode,
  isExportedNode,
  isGeneratedSource,
  pascalCase,
  truncate,
} from "../../util/source.js";
import { TEST_FILE_RE } from "../../util/glob.js";
import { addImportAndWrapperEdges } from "./project-edges.js";
import { addStructuralImplementationEdges } from "./project-structural.js";
import {
  classApiSignature,
  classifyCallable,
  classifyClass,
  classifyInitializer,
  declarationKey,
  isNodeWithBody,
  isPublicMember,
  resolveSymbolTargetByIdentity,
  unwrapExpression,
} from "./symbol-utils.js";
import type {
  DiagnosticCacheEntry,
  IndexAccumulator,
  ParsedProject,
} from "./types.js";

const MAX_RUNTIME_PREVIEW = 4000;

export interface ProjectIndexContext {
  root: string;
  config: ReturnType<typeof resolveProject>["config"];
  packageEntrypoints: string[];
  fileVersions: Map<string, number>;
  diagnosticsCache: Map<string, DiagnosticCacheEntry>;
}

export function indexProject(
  context: ProjectIndexContext,
  project: ParsedProject,
  program: ts.Program,
  checker: ts.TypeChecker,
  accumulator: IndexAccumulator,
  fullDiagnostics: boolean
): void {
    const {
      symbols,
      edges,
      fileImports,
      files,
      warnings,
      prodErrors,
      modules: moduleSet,
      declarationIds,
      pendingWraps,
      seenFileImports,
      seenEdges,
      symbolBody,
    } = accumulator;
    const ownedFiles = new Set(project.ownedFiles);
    const sourceFiles = project.ownedFiles
      .map((file) => program.getSourceFile(file))
      .filter(
        (sourceFile): sourceFile is ts.SourceFile =>
          Boolean(sourceFile) &&
          !sourceFile!.isDeclarationFile &&
          ownedFiles.has(path.resolve(sourceFile!.fileName))
      );
    const declToId = new Map<ts.Node, string>();

    const relOf = (sourceFile: ts.SourceFile): string =>
      toPosix(path.relative(context.root, sourceFile.fileName));
    const isTestFile = (sourceFile: ts.SourceFile): boolean => TEST_FILE_RE.test(relOf(sourceFile));
    const resolveSymbolTarget = (
      symbol: ts.Symbol,
      _checker: ts.TypeChecker,
      _declToId: Map<ts.Node, string>
    ): string | null =>
      resolveSymbolTargetByIdentity(symbol, checker, declToId, declarationIds, context.root);
    const resolveDeclarationTarget = (
      targetChecker: ts.TypeChecker,
      node: ts.Node,
      _declToId: Map<ts.Node, string>
    ): string | null => {
      const symbol = targetChecker.getSymbolAtLocation(node);
      return symbol ? resolveSymbolTarget(symbol, targetChecker, _declToId) : null;
    };

    // File records and diagnostics.
    for (const sourceFile of sourceFiles) {
      const relative = relOf(sourceFile);
      const moduleName = deriveModuleName(relative);
      const isTest = TEST_FILE_RE.test(relative);
      const generated = isGeneratedSource(sourceFile);
      const entrypoint = isEntrypointFile(relative, context.config, context.packageEntrypoints);
      const loc = countLines(sourceFile.text);
      moduleSet.add(moduleName);
      files.set(relative, {
        path: relative,
        module: moduleName,
        loc,
        prodLoc: isTest ? 0 : loc,
        testLoc: isTest ? loc : 0,
        generated,
        isTest,
        isEntrypoint: entrypoint,
        directive: getFileDirective(sourceFile),
        exports: 0,
        imports: 0,
      });
    }

    const projectFileSet = new Set(sourceFiles.map((sourceFile) => path.resolve(sourceFile.fileName)));
    const diagnosticsByFile = new Map<string, DiagnosticWarning[]>();
    const toWarning = (diagnostic: ts.Diagnostic, sourceFile: ts.SourceFile): DiagnosticWarning => {
      const relative = relOf(sourceFile);
      return {
        file: relative,
        line: sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1,
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        isTest: TEST_FILE_RE.test(relative),
      };
    };
    const recordFileDiagnostics = (sourceFile: ts.SourceFile, diagnostics: readonly ts.Diagnostic[]): void => {
      const absolute = path.resolve(sourceFile.fileName);
      const list = diagnosticsByFile.get(absolute) ?? [];
      for (const diagnostic of diagnostics) {
        if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
        if (project.references.length > 0 && [6305, 6307, 6310].includes(diagnostic.code)) continue;
        list.push(toWarning(diagnostic, sourceFile));
      }
      diagnosticsByFile.set(absolute, list);
    };

    for (const sourceFile of sourceFiles) {
      const absolute = path.resolve(sourceFile.fileName);
      const version = String(context.fileVersions.get(absolute) ?? 0);
      const cached = context.diagnosticsCache.get(absolute);
      if (!fullDiagnostics && cached?.version === version) {
        diagnosticsByFile.set(absolute, cached.diagnostics);
        continue;
      }
      const syntactic = program.getSyntacticDiagnostics(sourceFile);
      const semantic = program.getSemanticDiagnostics(sourceFile);
      recordFileDiagnostics(sourceFile, [...syntactic, ...semantic]);
      context.diagnosticsCache.set(absolute, {
        version,
        diagnostics: diagnosticsByFile.get(absolute) ?? [],
      });
    }

    for (const diagnostic of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
      // Project-reference build diagnostics are irrelevant to a language-service
      // index that never emits or requires prebuilt declaration outputs.
      if (project.references.length > 0 && [6305, 6310].includes(diagnostic.code)) continue;
      const file = diagnostic.file
        ? toPosix(path.relative(context.root, diagnostic.file.fileName))
        : toPosix(path.relative(context.root, project.path));
      prodErrors.push({
        file,
        line: diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
          : 1,
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        isTest: false,
      });
    }

    for (const sourceFile of sourceFiles) {
      const entries = diagnosticsByFile.get(path.resolve(sourceFile.fileName)) ?? [];
      for (const entry of entries) {
        if (entry.isTest) warnings.push(entry);
        else prodErrors.push(entry);
      }
    }
    const fileId = (relative: string): string => `file:${relative}`;

    const registerSymbol = (
      sourceFile: ts.SourceFile,
      node: ts.Node,
      name: string,
      kind: SymbolKind,
      container: string | null,
      exported: boolean,
      defaultExport: boolean,
      propsType: string | null,
      signature: string,
      members = 0,
      parentId: string | null = null,
      hashSignature = signature
    ): string => {
      const relative = relOf(sourceFile);
      const id = container
        ? `sym:${relative}:${container}#${name}`
        : `sym:${relative}#${name}`;
      const stableSignature = canonicalizeTypeText(signature, context.root);
      const stablePropsType = propsType === null ? null : canonicalizeTypeText(propsType, context.root);
      const stableHashSignature = canonicalizeTypeText(hashSignature, context.root);
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      const directive = getFileDirective(sourceFile);
      const normalized = normalizeNodeText(node, sourceFile);
      const { sigHash, selfHash } = computeDirectHashes(stableHashSignature, normalized, directive);
      const existing = symbols.get(id);
      const hasBody = isNodeWithBody(node);

      if (existing && !hasBody && symbolBody.get(id) === true) {
        declToId.set(node, id);
        declarationIds.set(declarationKey(node, context.root), id);
        if (exported) {
          existing.exported = true;
          if (files.get(relative)?.isEntrypoint) existing.isEntrypoint = true;
        }
        if (defaultExport) existing.defaultExport = true;
        return id;
      }

      const record: SymbolRecord = {
        id,
        name,
        kind,
        module: deriveModuleName(relative),
        file: relative,
        line: start.line + 1,
        endLine: end.line + 1,
        loc: end.line - start.line + 1,
        members,
        parentId,
        exported,
        defaultExport,
        isTest: isTestFile(sourceFile),
        isGenerated: isGeneratedSource(sourceFile),
        isEntrypoint:
          isEntrypointFile(relative, context.config, context.packageEntrypoints) && exported,
        directive,
        complexity: ["component", "hook", "function", "method"].includes(kind)
          ? computeComplexity(node)
          : 1,
        propsType: stablePropsType,
        signature: stableSignature,
        doc: extractDoc(node, sourceFile),
        sigHash,
        selfHash,
        depHash: "",
        contentHash: "",
        eligible: !isTestFile(sourceFile) && !isGeneratedSource(sourceFile),
        sourcePreview: truncate(
          sourceFile.text.slice(node.getStart(sourceFile), node.getEnd()),
          MAX_RUNTIME_PREVIEW
        ),
      };
      symbols.set(id, record);
      declToId.set(node, id);
      declarationIds.set(declarationKey(node, context.root), id);
      symbolBody.set(id, hasBody);
      return id;
    };

    // Symbol extraction.
    for (const sourceFile of sourceFiles) {
      const relative = relOf(sourceFile);
      const fileExported = (node: ts.Node): boolean => isExportedNode(node);
      const defaultExported = (node: ts.Node): boolean => isDefaultExportNode(node);

      for (const statement of sourceFile.statements) {
        if (ts.isFunctionDeclaration(statement)) {
          const name = statement.name?.text ?? pascalCase(path.basename(relative));
          const classification = classifyCallable(checker, statement, name, false, sourceFile);
          registerSymbol(
            sourceFile,
            statement,
            name,
            classification.kind,
            null,
            fileExported(statement),
            defaultExported(statement),
            classification.propsType,
            classification.signature
          );
          continue;
        }

        if (ts.isClassDeclaration(statement)) {
          const name = statement.name?.text ?? pascalCase(path.basename(relative));
          const classInfo = classifyClass(checker, statement, sourceFile);
          const classId = registerSymbol(
            sourceFile,
            statement,
            name,
            classInfo.kind,
            null,
            fileExported(statement),
            defaultExported(statement),
            classInfo.propsType,
            classInfo.signature,
            statement.members.length,
            null,
            classApiSignature(statement, sourceFile)
          );
          for (const member of statement.members) {
            if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
              const signature = ts.isConstructorDeclaration(member)
                ? "(constructor)"
                : checker.typeToString(checker.getTypeAtLocation(member));
              registerSymbol(
                sourceFile,
                member,
                member.name.text,
                "method",
                name,
                fileExported(statement) && isPublicMember(member),
                false,
                null,
                signature,
                0,
                classId
              );
            }
          }
          continue;
        }

        if (ts.isInterfaceDeclaration(statement)) {
          registerSymbol(
            sourceFile,
            statement,
            statement.name.text,
            "interface",
            null,
            fileExported(statement),
            false,
            null,
            checker.typeToString(checker.getTypeAtLocation(statement)),
            statement.members.length,
            null,
            normalizeNodeText(statement, sourceFile)
          );
          continue;
        }

        if (ts.isTypeAliasDeclaration(statement)) {
          registerSymbol(
            sourceFile,
            statement,
            statement.name.text,
            "type",
            null,
            fileExported(statement),
            false,
            null,
            checker.typeToString(checker.getTypeAtLocation(statement)),
            ts.isTypeLiteralNode(statement.type) ? statement.type.members.length : 0,
            null,
            normalizeNodeText(statement, sourceFile)
          );
          continue;
        }

        if (ts.isEnumDeclaration(statement)) {
          registerSymbol(
            sourceFile,
            statement,
            statement.name.text,
            "enum",
            null,
            fileExported(statement),
            false,
            null,
            checker.typeToString(checker.getTypeAtLocation(statement)),
            statement.members.length,
            null,
            normalizeNodeText(statement, sourceFile)
          );
          continue;
        }

        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
            const name = declaration.name.text;
            const initializer = unwrapExpression(declaration.initializer);
            const hoc = classifyInitializer(initializer, checker);

            if (hoc.kind === "context") {
              registerSymbol(
                sourceFile,
                declaration,
                name,
                "context",
                null,
                fileExported(declaration),
                false,
                null,
                checker.typeToString(checker.getTypeAtLocation(declaration))
              );
              continue;
            }

            if (
              hoc.kind === "memo" ||
              hoc.kind === "forwardRef" ||
              hoc.kind === "lazy" ||
              ts.isArrowFunction(initializer) ||
              ts.isFunctionExpression(initializer) ||
              ts.isClassExpression(initializer)
            ) {
              const isHoc = hoc.kind !== "expression";
              const callable = classifyCallable(checker, declaration, name, isHoc, sourceFile);
              const id = registerSymbol(
                sourceFile,
                declaration,
                name,
                callable.kind,
                null,
                fileExported(declaration),
                false,
                callable.propsType,
                callable.signature
              );
              if (hoc.inner) {
                pendingWraps.push({ fromId: id, expression: hoc.inner, sourceFile });
              }
              continue;
            }

            if (fileExported(declaration)) {
              registerSymbol(
                sourceFile,
                declaration,
                name,
                "variable",
                null,
                true,
                false,
                null,
                checker.typeToString(checker.getTypeAtLocation(declaration))
              );
            }
          }
        }
      }

      // Export specifiers and default assignments. These can refer to symbols
      // declared elsewhere in the file, so they run after declaration pass.
      for (const statement of sourceFile.statements) {
        if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
          const expression = unwrapExpression(statement.expression);
          const target = resolveDeclarationTarget(checker, expression, declToId);
          if (target) {
            declToId.set(statement, target);
            const record = symbols.get(target);
            if (record) {
              record.exported = true;
              record.defaultExport = true;
              if (files.get(record.file)?.isEntrypoint) record.isEntrypoint = true;
            }
            continue;
          }

          if (
            ts.isArrowFunction(expression) ||
            ts.isFunctionExpression(expression) ||
            ts.isClassExpression(expression) ||
            ts.isCallExpression(expression)
          ) {
            const name = pascalCase(path.basename(relative));
            const hoc = classifyInitializer(expression, checker);
            const callable = classifyCallable(
              checker,
              expression,
              name,
              hoc.kind === "memo" || hoc.kind === "forwardRef" || hoc.kind === "lazy",
              sourceFile
            );
            const id = registerSymbol(
              sourceFile,
              expression,
              name,
              callable.kind,
              null,
              true,
              true,
              callable.propsType,
              callable.signature
            );
            declToId.set(statement, id);
            if (hoc.inner) pendingWraps.push({ fromId: id, expression: hoc.inner, sourceFile });
          }
          continue;
        }

        if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
          if (ts.isNamedExports(statement.exportClause)) {
            for (const specifier of statement.exportClause.elements) {
              const local = checker.getExportSpecifierLocalTargetSymbol(specifier);
              if (!local) continue;
              const target = resolveSymbolTarget(local, checker, declToId);
              if (!target) continue;
              declToId.set(specifier, target);
              const record = symbols.get(target);
              if (!record) continue;
              record.exported = true;
              if (files.get(record.file)?.isEntrypoint) record.isEntrypoint = true;
              if (specifier.name.text === "default") {
                record.defaultExport = true;
              }
            }
          }
        }
      }
    }

    const { addEdge } = addImportAndWrapperEdges({
      root: context.root,
      config: context.config,
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
    });

    addStructuralImplementationEdges({
      checker,
      declToId,
      projectFileSet,
      symbols,
      addEdge,
    });
  }

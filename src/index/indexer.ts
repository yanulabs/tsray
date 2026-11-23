import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { computeDirectHashes, computeGraphHashes, findDirectedCycles, normalizeNodeText } from "./hasher.js";
import type {
  DiagnosticWarning,
  EdgeKind,
  EdgeRecord,
  FileImportEdge,
  FileRecord,
  IndexSnapshot,
  ProjectConfigInfo,
  SymbolKind,
  SymbolRecord,
} from "./types.js";
import {
  deriveModuleName,
  isEntrypointFile,
  isExcluded,
  isSourceFile,
  loadConfig,
  readPackageEntrypoints,
  resolveProject,
  toPosix,
} from "../util/paths.js";
import {
  containsJsx,
  computeComplexity,
  countLines,
  extractDoc,
  getFileDirective,
  isDefaultExportNode,
  isExportedNode,
  isGeneratedSource,
  pascalCase,
  truncate,
} from "../util/source.js";
import { TEST_FILE_RE } from "../util/glob.js";

export interface IndexerOptions {
  tsconfig?: string;
  workspace?: boolean;
  /** Recompute every file's diagnostics instead of using the incremental cache. */
  fullDiagnostics?: boolean;
}

interface ParsedProject {
  path: string;
  options: ts.CompilerOptions;
  fileNames: string[];
  references: string[];
}

interface PendingWrap {
  fromId: string;
  expression: ts.Expression;
  sourceFile: ts.SourceFile;
}

interface DiagnosticCacheEntry {
  version: string;
  diagnostics: DiagnosticWarning[];
}

const MAX_RUNTIME_PREVIEW = 4000;

export class TsReactIndexer {
  readonly root: string;
  readonly projectId: string;
  readonly tsconfigPath: string;
  readonly tsconfigPaths: string[];
  readonly workspace: boolean;
  config: ReturnType<typeof resolveProject>["config"];
  readonly typescriptVersion = ts.version;

  private parsedProjects: ParsedProject[] = [];
  private compilerOptions: ts.CompilerOptions = {};
  private moduleResolutionCache: ts.ModuleResolutionCache;
  private fileList: string[] = [];
  private readonly fileVersions = new Map<string, number>();
  private readonly scriptSnapshots = new Map<
    string,
    { version: string; snapshot: ts.IScriptSnapshot }
  >();
  private readonly dirtyFiles = new Set<string>();
  private readonly diagnosticsCache = new Map<string, DiagnosticCacheEntry>();
  private languageService: ts.LanguageService;
  private lastHealthySnapshot: IndexSnapshot | null = null;
  private lastSnapshot: IndexSnapshot | null = null;
  private packageEntrypoints: string[] = [];

  constructor(targetPath: string, options: IndexerOptions = {}) {
    const resolved = resolveProject(targetPath, options);
    this.root = resolved.root;
    this.projectId = resolved.projectId;
    this.tsconfigPath = resolved.primaryTsconfigPath;
    this.tsconfigPaths = resolved.tsconfigPaths;
    this.workspace = resolved.workspace;
    this.config = resolved.config;

    this.loadProjects();
    this.packageEntrypoints = this.collectPackageEntrypoints();
    this.moduleResolutionCache = ts.createModuleResolutionCache(
      this.root,
      (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
      this.compilerOptions
    );
    this.languageService = this.createLanguageService();
    if (options.fullDiagnostics) this.dirtyFiles.clear();
  }

  private loadProjects(): void {
    const parsed: ParsedProject[] = [];
    let primary: ParsedProject | null = null;

    for (const configPath of this.tsconfigPaths) {
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      if (read.error) {
        throw new Error(
          `Failed to read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`
        );
      }
      const result = ts.parseJsonConfigFileContent(
        read.config,
        ts.sys,
        path.dirname(configPath),
        undefined,
        configPath
      );
      const errors = result.errors.filter((error) => error.category === ts.DiagnosticCategory.Error);
      if (errors.length > 0) {
        throw new Error(
          `Failed to parse ${configPath}: ${ts.flattenDiagnosticMessageText(errors[0]!.messageText, "\n")}`
        );
      }
      const project: ParsedProject = {
        path: configPath,
        options: result.options,
        fileNames: result.fileNames.map((file) => path.resolve(file)),
        references: (result.projectReferences ?? []).map((reference) =>
          path.resolve(reference.path, "tsconfig.json")
        ),
      };
      parsed.push(project);
      if (configPath === this.tsconfigPath) primary = project;
    }

    primary ??= parsed[0] ?? null;
    if (!primary) throw new Error(`No TypeScript project could be loaded from ${this.root}`);
    this.parsedProjects = parsed;

    const primaryOptions = primary.options;
    const merged: ts.CompilerOptions = {
      ...primaryOptions,
      noEmit: true,
      skipLibCheck: true,
      baseUrl: this.root,
    };
    if (merged.jsx === undefined) merged.jsx = ts.JsxEmit.ReactJSX;
    if (merged.allowJs === undefined && this.hasJavaScriptSources(parsed)) merged.allowJs = true;
    if (!merged.moduleResolution) merged.moduleResolution = ts.ModuleResolutionKind.Bundler;

    // A single LanguageService has one baseUrl. Normalize every project's path
    // mappings to workspace-root-relative targets so workspace aliases such as
    // `@acme/ui` resolve identically in every package.
    const paths: ts.MapLike<string[]> = {};
    const projectsInOrder = [primary, ...parsed.filter((project) => project !== primary)];
    for (const project of projectsInOrder) {
      const projectPaths = project.options.paths;
      if (!projectPaths) continue;
      const base = project.options.baseUrl
        ? path.resolve(path.dirname(project.path), project.options.baseUrl)
        : path.dirname(project.path);
      for (const [pattern, targets] of Object.entries(projectPaths)) {
        if (paths[pattern]) continue;
        paths[pattern] = targets.map((target) => {
          const absolute = path.isAbsolute(target) ? target : path.resolve(base, target);
          const relative = toPosix(path.relative(this.root, absolute));
          return relative.startsWith("..") ? toPosix(absolute) : relative || ".";
        });
      }
    }
    if (Object.keys(paths).length > 0) merged.paths = paths;

    this.compilerOptions = merged;
    this.moduleResolutionCache = ts.createModuleResolutionCache(
      this.root,
      (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
      this.compilerOptions
    );

    const files = new Set<string>();
    for (const project of parsed) {
      for (const file of project.fileNames) {
        if (!isSourceFile(file)) continue;
        if (this.isIgnoredAbsolute(file)) continue;
        files.add(canonicalPath(file));
      }
    }
    this.fileList = [...files].sort();
    for (const file of this.fileList) {
      if (!this.fileVersions.has(file)) this.fileVersions.set(file, 1);
    }

    // A changed tsconfig can remove files as well as add them.
    const allowed = new Set(this.fileList);
    for (const file of [...this.fileVersions.keys()]) {
      if (!allowed.has(file)) {
        this.fileVersions.delete(file);
        this.scriptSnapshots.delete(file);
      }
    }
  }

  private hasJavaScriptSources(projects: ParsedProject[]): boolean {
    return projects.some((project) =>
      project.fileNames.some((file) => /\.[cm]?jsx?$/.test(file))
    );
  }

  private collectPackageEntrypoints(): string[] {
    const patterns = new Set(readPackageEntrypoints(this.root));
    const directories = new Set(this.parsedProjects.map((project) => path.dirname(project.path)));
    for (const directory of directories) {
      for (const pattern of readPackageEntrypoints(directory)) {
        const relative = toPosix(path.relative(this.root, path.join(directory, pattern)));
        if (!relative.startsWith("..")) patterns.add(relative);
      }
    }
    return [...patterns];
  }

  private isIgnoredAbsolute(file: string): boolean {
    const absolute = path.resolve(file);
    if (absolute.includes(`${path.sep}node_modules${path.sep}`)) return true;
    const relative = toPosix(path.relative(this.root, absolute));
    if (relative.startsWith("..")) return false; // symlinked source outside the root
    return isExcluded(relative, this.config);
  }

  private createLanguageService(): ts.LanguageService {
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => this.fileList,
      getScriptVersion: (fileName) => {
        const absolute = path.resolve(fileName);
        return String(this.fileVersions.get(absolute) ?? this.fileVersions.get(canonicalPath(absolute)) ?? 0);
      },
      getScriptSnapshot: (fileName) => {
        const absolute = path.resolve(fileName);
        const version = String(
          this.fileVersions.get(absolute) ?? this.fileVersions.get(canonicalPath(absolute)) ?? 0
        );
        const cached = this.scriptSnapshots.get(absolute);
        if (cached && cached.version === version) return cached.snapshot;
        if (!fs.existsSync(absolute)) return undefined;
        const text = fs.readFileSync(absolute, "utf8");
        const snapshot = ts.ScriptSnapshot.fromString(text);
        this.scriptSnapshots.set(absolute, { version, snapshot });
        return snapshot;
      },
      getCurrentDirectory: () => this.root,
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getNewLine: () => ts.sys.newLine,
    };
    return ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  getLastHealthySnapshot(): IndexSnapshot | null {
    return this.lastHealthySnapshot;
  }

  getLastSnapshot(): IndexSnapshot | null {
    return this.lastSnapshot;
  }

  getProjectConfigs(): ProjectConfigInfo[] {
    return this.parsedProjects.map((project) => ({
      path: toPosix(path.relative(this.root, project.path)),
      fileCount: project.fileNames.length,
      references: project.references.map((reference) => toPosix(path.relative(this.root, reference))),
    }));
  }

  notifyFilesChanged(changedFiles: string[], reloadConfig = false): void {
    if (reloadConfig) {
      this.config = loadConfig(this.root);
      this.loadProjects();
      this.packageEntrypoints = this.collectPackageEntrypoints();
      this.languageService.dispose();
      this.languageService = this.createLanguageService();
      this.diagnosticsCache.clear();
      for (const file of this.fileList) {
        this.fileVersions.set(file, (this.fileVersions.get(file) ?? 0) + 1);
        this.dirtyFiles.add(file);
      }
      return;
    }

    for (const changed of changedFiles) {
      const absolute = canonicalPath(changed);
      if (fs.existsSync(absolute) && isSourceFile(absolute)) {
        const relative = toPosix(path.relative(this.root, absolute));
        if (!relative.startsWith("..") && isExcluded(relative, this.config)) continue;
        this.fileVersions.set(absolute, (this.fileVersions.get(absolute) ?? 0) + 1);
        if (!this.fileList.includes(absolute)) {
          this.fileList.push(absolute);
          this.fileList.sort();
        }
        this.scriptSnapshots.delete(absolute);
        this.dirtyFiles.add(absolute);
        this.diagnosticsCache.delete(absolute);
      } else if (!fs.existsSync(absolute)) {
        this.fileVersions.delete(absolute);
        this.scriptSnapshots.delete(absolute);
        this.fileList = this.fileList.filter((file) => file !== absolute);
        this.dirtyFiles.add(absolute);
        this.diagnosticsCache.delete(absolute);
      }
    }

    // A newly added file can satisfy a module specifier that previously failed
    // to resolve, so drop the resolver cache for this invalidation batch.
    this.moduleResolutionCache.clear();

    // Type errors can surface in direct importers after a dependency changes.
    if (this.lastSnapshot) {
      for (const edge of this.lastSnapshot.fileImports) {
        const from = path.resolve(this.root, edge.fromFile);
        const to = path.resolve(this.root, edge.toFile);
        if (this.dirtyFiles.has(to) && !this.dirtyFiles.has(from)) {
          this.fileVersions.set(from, (this.fileVersions.get(from) ?? 0) + 1);
          this.scriptSnapshots.delete(from);
          this.dirtyFiles.add(from);
          this.diagnosticsCache.delete(from);
        }
      }
    }
  }

  buildIndex(options: IndexerOptions = {}): IndexSnapshot {
    const started = performance.now();
    const fullDiagnostics = options.fullDiagnostics ?? this.dirtyFiles.size === 0;
    const program = this.languageService.getProgram();
    if (!program) throw new Error("TypeScript LanguageService returned no program");

    const checker = program.getTypeChecker();
    const symbols = new Map<string, SymbolRecord>();
    const edges: EdgeRecord[] = [];
    const fileImports: FileImportEdge[] = [];
    const files = new Map<string, FileRecord>();
    const declToId = new Map<ts.Node, string>();
    const moduleSet = new Set<string>();
    const warnings: DiagnosticWarning[] = [];
    const prodErrors: DiagnosticWarning[] = [];
    const pendingWraps: PendingWrap[] = [];

    const sourceFiles = program.getSourceFiles().filter((sourceFile) => {
      if (sourceFile.isDeclarationFile) return false;
      const absolute = path.resolve(sourceFile.fileName);
      const relative = toPosix(path.relative(this.root, absolute));
      if (relative.startsWith("..")) return false;
      if (absolute.includes(`${path.sep}node_modules${path.sep}`)) return false;
      return !isExcluded(relative, this.config);
    });

    const relOf = (sourceFile: ts.SourceFile): string =>
      toPosix(path.relative(this.root, sourceFile.fileName));

    // File records and diagnostics.
    for (const sourceFile of sourceFiles) {
      const relative = relOf(sourceFile);
      const moduleName = deriveModuleName(relative);
      const isTest = TEST_FILE_RE.test(relative);
      const generated = isGeneratedSource(sourceFile);
      const entrypoint = isEntrypointFile(relative, this.config, this.packageEntrypoints);
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
        if (diagnostic.category === ts.DiagnosticCategory.Error) list.push(toWarning(diagnostic, sourceFile));
      }
      diagnosticsByFile.set(absolute, list);
    };

    if (fullDiagnostics) {
      for (const diagnostic of program.getSyntacticDiagnostics()) {
        if (diagnostic.category !== ts.DiagnosticCategory.Error || !diagnostic.file) continue;
        if (!projectFileSet.has(path.resolve(diagnostic.file.fileName))) continue;
        recordFileDiagnostics(diagnostic.file, [diagnostic]);
      }
      for (const diagnostic of program.getSemanticDiagnostics()) {
        if (diagnostic.category !== ts.DiagnosticCategory.Error || !diagnostic.file) continue;
        if (!projectFileSet.has(path.resolve(diagnostic.file.fileName))) continue;
        recordFileDiagnostics(diagnostic.file, [diagnostic]);
      }
    } else {
      for (const sourceFile of sourceFiles) {
        const absolute = path.resolve(sourceFile.fileName);
        const version = String(this.fileVersions.get(absolute) ?? 0);
        const cached = this.diagnosticsCache.get(absolute);
        if (cached?.version === version) {
          diagnosticsByFile.set(absolute, cached.diagnostics);
          continue;
        }
        const syntactic = program.getSyntacticDiagnostics(sourceFile);
        const semantic = program.getSemanticDiagnostics(sourceFile);
        recordFileDiagnostics(sourceFile, [...syntactic, ...semantic]);
        this.diagnosticsCache.set(absolute, {
          version,
          diagnostics: diagnosticsByFile.get(absolute) ?? [],
        });
      }
    }

    for (const diagnostic of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
      const file = diagnostic.file
        ? toPosix(path.relative(this.root, diagnostic.file.fileName))
        : toPosix(path.relative(this.root, this.tsconfigPath));
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
      const absolute = path.resolve(sourceFile.fileName);
      const version = String(this.fileVersions.get(absolute) ?? 0);
      const entries = diagnosticsByFile.get(absolute) ?? [];
      if (fullDiagnostics) {
        this.diagnosticsCache.set(absolute, { version, diagnostics: entries });
      }
      for (const entry of entries) {
        if (entry.isTest) warnings.push(entry);
        else prodErrors.push(entry);
      }
    }
    this.dirtyFiles.clear();

    const isTestFile = (sourceFile: ts.SourceFile): boolean => TEST_FILE_RE.test(relOf(sourceFile));

    const fileId = (relative: string): string => `file:${relative}`;
    const symbolBody = new Map<string, boolean>();

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
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      const directive = getFileDirective(sourceFile);
      const normalized = normalizeNodeText(node, sourceFile);
      const { sigHash, selfHash } = computeDirectHashes(hashSignature, normalized, directive);
      const existing = symbols.get(id);
      const hasBody = isNodeWithBody(node);

      if (existing && !hasBody && symbolBody.get(id) === true) {
        declToId.set(node, id);
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
          isEntrypointFile(relative, this.config, this.packageEntrypoints) && exported,
        directive,
        complexity: ["component", "hook", "function", "method"].includes(kind)
          ? computeComplexity(node)
          : 1,
        propsType,
        signature,
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

    // File export counts and module assignment.
    for (const symbol of symbols.values()) {
      const fileRecord = files.get(symbol.file);
      if (fileRecord && symbol.exported) fileRecord.exports++;
    }

    // Add file import edges and symbol-level import/re-export edges.
    const addModuleResolution = (sourceFile: ts.SourceFile, specifier: string): string | null => {
      const resolved = ts.resolveModuleName(
        specifier,
        sourceFile.fileName,
        this.compilerOptions,
        ts.sys,
        this.moduleResolutionCache
      ).resolvedModule;
      if (!resolved) return null;
      const absolute = path.resolve(resolved.resolvedFileName);
      const relative = toPosix(path.relative(this.root, absolute));
      if (relative.startsWith("..") || !isSourceFile(relative)) return null;
      if (isExcluded(relative, this.config)) return null;
      return relative;
    };

    const seenFileImports = new Set<string>();
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

    const seenEdges = new Set<string>();
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
      if (!symbols.has(toId)) return;
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
      const absolute = path.resolve(this.root, relative);
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

    // Structural implementations via TypeChecker assignability.
    const interfaceDecls: Array<{ id: string; type: ts.Type; node: ts.Node }> = [];
    const candidateDecls: Array<{ id: string; type: ts.Type; symbol: SymbolRecord }> = [];
    const seenStructuralIds = new Set<string>();
    for (const [node, id] of declToId) {
      if (seenStructuralIds.has(id)) continue;
      const symbol = symbols.get(id);
      if (!symbol || !node.getSourceFile() || node.getSourceFile().isDeclarationFile) continue;
      seenStructuralIds.add(id);
      if (symbol.kind === "interface") {
        const type = checker.getTypeAtLocation(node);
        // An interface with only optional/index members is assignable from
        // almost any object and produces meaningless structural edges.
        if (!hasRequiredMembers(type)) continue;
        interfaceDecls.push({ id, type, node });
      } else if (symbol.kind === "class" || symbol.kind === "type") {
        candidateDecls.push({ id, type: checker.getTypeAtLocation(node), symbol });
      }
    }

    if (interfaceDecls.length > 0 && candidateDecls.length > 0) {
      for (const iface of interfaceDecls) {
        for (const candidate of candidateDecls) {
          if (iface.id === candidate.id) continue;
          try {
            if (checker.isTypeAssignableTo(candidate.type, iface.type)) {
              addEdge(
                candidate.id,
                iface.id,
                "implements",
                candidate.symbol.file,
                candidate.symbol.line,
                "structural"
              );
            }
          } catch {
            // Generic or unresolved types can throw; skip them.
          }
        }
      }
    }

    // Drop weak `references` edges when a stronger semantic edge already
    // describes the same source, target, file, and line. Without this a hook
    // call would also count as a plain reference and inflate fan-in.
    const strongLocations = new Set(
      edges
        .filter((edge) => edge.kind !== "references")
        .map((edge) => `${edge.fromId}|${edge.toId}|${edge.file}:${edge.line}`)
    );
    const dedupedEdges = edges.filter(
      (edge) =>
        edge.kind !== "references" ||
        !strongLocations.has(`${edge.fromId}|${edge.toId}|${edge.file}:${edge.line}`)
    );
    edges.length = 0;
    edges.push(...dedupedEdges);

    // Semantic hash chain.
    computeGraphHashes(symbols, edges);

    // Module cycles from production file imports.
    const moduleEdges: Array<[string, string]> = [];
    for (const edge of fileImports) {
      if (edge.isTest) continue;
      // `import type` is erased at runtime and cannot create a runtime module
      // cycle. It still appears in the dependency graph for navigation.
      if (edge.typeOnly) continue;
      if (edge.fromModule !== edge.toModule) moduleEdges.push([edge.fromModule, edge.toModule]);
    }
    const moduleCycles = findDirectedCycles(moduleSet, moduleEdges);

    const snapshot: IndexSnapshot = {
      root: this.root,
      projectId: this.projectId,
      tsconfigPath: toPosix(path.relative(this.root, this.tsconfigPath)),
      tsconfigPaths: this.tsconfigPaths.map((config) => toPosix(path.relative(this.root, config))),
      projectConfigs: this.getProjectConfigs(),
      typescriptVersion: ts.version,
      indexedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      symbols,
      edges,
      files,
      fileImports,
      moduleCycles,
      warnings,
      prodErrors,
      filesCount: sourceFiles.length,
      modules: [...moduleSet].sort(),
    };

    this.lastSnapshot = snapshot;
    if (prodErrors.length === 0) this.lastHealthySnapshot = snapshot;
    return snapshot;
  }
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Resolves symlinked roots (notably /var -> /private/var on macOS) so the
 * LanguageService version map and watcher events refer to the same key.
 */
function canonicalPath(file: string): string {
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

function classApiSignature(
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

function hasRequiredMembers(type: ts.Type): boolean {
  const properties = type.getProperties();
  if (properties.length === 0) return false;
  return properties.some((property) => (property.flags & ts.SymbolFlags.Optional) === 0);
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
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

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return false;
  return (
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  );
}

function isPublicMember(node: ts.ClassElement): boolean {
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

function isNodeWithBody(node: ts.Node): boolean {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node)) &&
    Boolean(node.body)
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
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

function classifyInitializer(expression: ts.Expression, checker: ts.TypeChecker): ClassifiedInitializer {
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

function extractDynamicImport(expression: ts.Expression): ts.CallExpression | null {
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

function classifyCallable(
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

function classifyClass(
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

function resolveSymbolTarget(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  declToId: Map<ts.Node, string>
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
    const direct = declToId.get(declaration);
    if (direct) return direct;
    if (declaration.parent) {
      const parent = declToId.get(declaration.parent);
      if (parent) return parent;
    }
  }
  return null;
}

function resolveDeclarationTarget(
  checker: ts.TypeChecker,
  node: ts.Node,
  declToId: Map<ts.Node, string>
): string | null {
  const symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  return resolveSymbolTarget(symbol, checker, declToId);
}

function resolvedSymbolName(checker: ts.TypeChecker, node: ts.Node): string | null {
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

function isReferenceIdentifier(node: ts.Identifier): boolean {
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

import type { DatabaseSync } from "node:sqlite";
import { initWorkingSchema } from "./schema.js";
import type {
  CachedSymbolSignature,
  DiagnosticCacheProvider,
  DiagnosticCacheSnapshot,
  DiagnosticCacheWrite,
  DiagnosticWarning,
  IndexSnapshot,
  ProjectCacheEntry,
  ProjectCacheProvider,
} from "../../index/types.js";

export class WorkingStore implements ProjectCacheProvider, DiagnosticCacheProvider {
  constructor(private readonly workingDb: DatabaseSync) {
    initWorkingSchema(workingDb);
  }

  readProjects(projectPaths: string[]): Map<string, ProjectCacheEntry> {
    const result = new Map<string, ProjectCacheEntry>();
    const statement = this.workingDb.prepare(
      "SELECT project_path, input_hash, project_sig_hash, payload_json FROM project_cache WHERE project_path = ?"
    );
    for (const projectPath of projectPaths) {
      const row = statement.get(projectPath) as {
        project_path: string;
        input_hash: string;
        project_sig_hash: string;
        payload_json: string;
      } | undefined;
      if (!row) continue;
      try {
        const entry = JSON.parse(row.payload_json) as ProjectCacheEntry;
        if (
          entry.cacheVersion !== 5 ||
          entry.projectPath !== row.project_path ||
          entry.inputHash !== row.input_hash ||
          entry.projectSigHash !== row.project_sig_hash ||
          typeof entry.outputHash !== "string" ||
          !Array.isArray(entry.symbols) ||
          !Array.isArray(entry.edges) ||
          !Array.isArray(entry.fileImports) ||
          !Array.isArray(entry.files) ||
          !Array.isArray(entry.warnings) ||
          !Array.isArray(entry.prodErrors) ||
          !Array.isArray(entry.modules)
        ) {
          continue;
        }
        result.set(projectPath, entry);
      } catch {
        // Corrupt or old cache rows are treated as misses.
      }
    }
    return result;
  }

  writeProjects(entries: ProjectCacheEntry[]): void {
    if (entries.length === 0) return;
    const statement = this.workingDb.prepare(`
      INSERT OR REPLACE INTO project_cache (project_path, input_hash, project_sig_hash, payload_json)
      VALUES (?, ?, ?, ?)
    `);
    this.workingDb.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        statement.run(entry.projectPath, entry.inputHash, entry.projectSigHash, JSON.stringify(entry));
      }
      this.workingDb.exec("COMMIT");
    } catch (error) {
      try {
        this.workingDb.exec("ROLLBACK");
      } catch {
        // The transaction may already be closed by SQLite.
      }
      throw error;
    }
  }

  readDiagnostics(projectKey: string, epoch: string): DiagnosticCacheSnapshot | null {
    const row = this.workingDb
      .prepare("SELECT payload_json FROM diagnostic_cache WHERE project_key = ? AND epoch = ?")
      .get(projectKey, epoch) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      const files = JSON.parse(row.payload_json) as unknown;
      if (!Array.isArray(files)) return null;
      const diagnostics = new Map<string, DiagnosticWarning[]>();
      const symbols = new Map<string, CachedSymbolSignature>();
      for (const entry of files) {
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof entry.path !== "string" ||
          !Array.isArray(entry.diagnostics) ||
          !Array.isArray(entry.symbols)
        ) {
          return null;
        }
        const validDiagnostics = entry.diagnostics.every((item: unknown) => {
          if (!item || typeof item !== "object") return false;
          const value = item as Record<string, unknown>;
          return (
            typeof value.file === "string" &&
            typeof value.line === "number" &&
            typeof value.code === "number" &&
            typeof value.message === "string" &&
            typeof value.isTest === "boolean"
          );
        });
        const validSymbols = entry.symbols.every((item: unknown) => {
          if (!item || typeof item !== "object") return false;
          const value = item as Record<string, unknown>;
          return (
            typeof value.id === "string" &&
            typeof value.kind === "string" &&
            (value.propsType === null || typeof value.propsType === "string") &&
            typeof value.signature === "string"
          );
        });
        if (!validDiagnostics || !validSymbols) return null;
        diagnostics.set(entry.path, entry.diagnostics as DiagnosticWarning[]);
        for (const symbol of entry.symbols as CachedSymbolSignature[]) symbols.set(symbol.id, symbol);
      }
      return { diagnostics, symbols };
    } catch {
      return null;
    }
  }

  writeDiagnostics(entries: DiagnosticCacheWrite[]): void {
    if (entries.length === 0) return;
    const removeOld = this.workingDb.prepare(
      "DELETE FROM diagnostic_cache WHERE project_key = ? AND epoch <> ?"
    );
    const insert = this.workingDb.prepare(
      "INSERT OR REPLACE INTO diagnostic_cache (project_key, epoch, payload_json) VALUES (?, ?, ?)"
    );
    this.workingDb.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        removeOld.run(entry.projectKey, entry.epoch);
        insert.run(entry.projectKey, entry.epoch, JSON.stringify(entry.files));
      }
      this.workingDb.exec("COMMIT");
    } catch (error) {
      try {
        this.workingDb.exec("ROLLBACK");
      } catch {
        // The transaction may already be closed by SQLite.
      }
      throw error;
    }
  }

  syncWorking(snapshot: IndexSnapshot): void {
    if (snapshot.graphDigest) {
      const existing = this.workingDb
        .prepare("SELECT value FROM working_meta WHERE key = 'graph_digest'")
        .get() as { value: string } | undefined;
      if (existing?.value === snapshot.graphDigest) {
        const update = this.workingDb.prepare(
          "INSERT OR REPLACE INTO working_meta (key, value) VALUES (?, ?)"
        );
        this.workingDb.exec("BEGIN IMMEDIATE");
        try {
          update.run("indexed_at", snapshot.indexedAt);
          update.run("duration_ms", String(snapshot.durationMs));
          update.run("prod_errors", String(snapshot.prodErrors.length));
          update.run("warnings", String(snapshot.warnings.length));
          this.workingDb.exec("COMMIT");
        } catch (error) {
          try {
            this.workingDb.exec("ROLLBACK");
          } catch {
            // The transaction may already be closed by SQLite.
          }
          throw error;
        }
        return;
      }
    }
    const insertSymbol = this.workingDb.prepare(`
      INSERT INTO working_symbols (
        id, name, kind, module, file, line, end_line, loc, members, parent_id,
        exported, default_export, is_test, is_generated, is_entrypoint, directive,
        complexity, props_type, signature, doc, sig_hash, self_hash, dep_hash,
        content_hash, eligible
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const insertEdge = this.workingDb.prepare(`
      INSERT INTO working_edges (from_id, to_id, kind, file, line, via) VALUES (?,?,?,?,?,?)
    `);
    const insertFile = this.workingDb.prepare(`
      INSERT INTO working_files (
        path, module, loc, prod_loc, test_loc, generated, is_test, is_entrypoint,
        directive, exports, imports
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    const upsertMeta = this.workingDb.prepare(
      "INSERT OR REPLACE INTO working_meta (key, value) VALUES (?, ?)"
    );

    this.workingDb.exec("BEGIN IMMEDIATE");
    try {
      this.workingDb.exec("DELETE FROM working_symbols; DELETE FROM working_edges; DELETE FROM working_files;");
      for (const symbol of snapshot.symbols.values()) {
        insertSymbol.run(
          symbol.id,
          symbol.name,
          symbol.kind,
          symbol.module,
          symbol.file,
          symbol.line,
          symbol.endLine,
          symbol.loc,
          symbol.members,
          symbol.parentId,
          symbol.exported ? 1 : 0,
          symbol.defaultExport ? 1 : 0,
          symbol.isTest ? 1 : 0,
          symbol.isGenerated ? 1 : 0,
          symbol.isEntrypoint ? 1 : 0,
          symbol.directive,
          symbol.complexity,
          symbol.propsType,
          symbol.signature,
          symbol.doc,
          symbol.sigHash,
          symbol.selfHash,
          symbol.depHash,
          symbol.contentHash,
          symbol.eligible ? 1 : 0
        );
      }
      for (const edge of snapshot.edges) {
        insertEdge.run(edge.fromId, edge.toId, edge.kind, edge.file, edge.line, edge.via ?? null);
      }
      for (const file of snapshot.files.values()) {
        insertFile.run(
          file.path,
          file.module,
          file.loc,
          file.prodLoc,
          file.testLoc,
          file.generated ? 1 : 0,
          file.isTest ? 1 : 0,
          file.isEntrypoint ? 1 : 0,
          file.directive,
          file.exports,
          file.imports
        );
      }
      const meta: Record<string, string> = {
        canonical_root: snapshot.root,
        project_id: snapshot.projectId,
        tsconfig_path: snapshot.tsconfigPath,
        tsconfig_paths: JSON.stringify(snapshot.tsconfigPaths),
        typescript_version: snapshot.typescriptVersion,
        indexed_at: snapshot.indexedAt,
        duration_ms: String(snapshot.durationMs),
        files: String(snapshot.filesCount),
        symbols: String(snapshot.symbols.size),
        edges: String(snapshot.edges.length),
        modules: JSON.stringify(snapshot.modules),
        module_cycles: JSON.stringify(snapshot.moduleCycles),
        prod_errors: String(snapshot.prodErrors.length),
        warnings: String(snapshot.warnings.length),
        ...(snapshot.graphDigest ? { graph_digest: snapshot.graphDigest } : {}),
      };
      for (const [key, value] of Object.entries(meta)) upsertMeta.run(key, value);
      this.workingDb.exec("COMMIT");
    } catch (error) {
      try {
        this.workingDb.exec("ROLLBACK");
      } catch {
        // The transaction may already be closed by SQLite.
      }
      throw error;
    }
  }

  getStats(): {
    symbols: number;
    edges: number;
    files: number;
    indexed_at: string | null;
    canonical_root: string | null;
    project_id: string | null;
  } {
    const count = (table: string): number => {
      const row = this.workingDb
        .prepare(`SELECT COUNT(*) AS c FROM ${table}`)
        .get() as { c: number };
      return row.c;
    };
    const meta = (key: string): string | null => {
      const row = this.workingDb
        .prepare("SELECT value FROM working_meta WHERE key = ?")
        .get(key) as { value: string } | undefined;
      return row?.value ?? null;
    };
    return {
      symbols: count("working_symbols"),
      edges: count("working_edges"),
      files: count("working_files"),
      indexed_at: meta("indexed_at"),
      canonical_root: meta("canonical_root"),
      project_id: meta("project_id"),
    };
  }

  close(): void {
    this.workingDb.close();
  }
}

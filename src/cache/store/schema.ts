import type { DatabaseSync } from "node:sqlite";

export function configureDb(db: DatabaseSync, workingPath: string): void {
  db.exec("PRAGMA busy_timeout = 5000;");
  if (workingPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec("PRAGMA foreign_keys = ON;");
}

export function initWorkingSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS working_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS working_symbols (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        module TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        loc INTEGER NOT NULL,
        members INTEGER NOT NULL,
        parent_id TEXT,
        exported INTEGER NOT NULL,
        default_export INTEGER NOT NULL,
        is_test INTEGER NOT NULL,
        is_generated INTEGER NOT NULL,
        is_entrypoint INTEGER NOT NULL,
        directive TEXT,
        complexity INTEGER NOT NULL,
        props_type TEXT,
        signature TEXT NOT NULL,
        doc TEXT NOT NULL,
        sig_hash TEXT NOT NULL,
        self_hash TEXT NOT NULL,
        dep_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        eligible INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_working_symbols_module ON working_symbols(module);
      CREATE INDEX IF NOT EXISTS idx_working_symbols_file ON working_symbols(file);
      CREATE INDEX IF NOT EXISTS idx_working_symbols_content ON working_symbols(content_hash);
      CREATE TABLE IF NOT EXISTS working_edges (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        via TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from ON working_edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON working_edges(to_id);
      CREATE TABLE IF NOT EXISTS working_files (
        path TEXT PRIMARY KEY,
        module TEXT NOT NULL,
        loc INTEGER NOT NULL,
        prod_loc INTEGER NOT NULL,
        test_loc INTEGER NOT NULL,
        generated INTEGER NOT NULL,
        is_test INTEGER NOT NULL,
        is_entrypoint INTEGER NOT NULL,
        directive TEXT,
        exports INTEGER NOT NULL,
        imports INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diagnostic_cache (
        project_key TEXT NOT NULL,
        epoch TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (project_key, epoch)
      );
      CREATE TABLE IF NOT EXISTS project_cache (
        project_path TEXT PRIMARY KEY,
        input_hash TEXT NOT NULL,
        project_sig_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
  }

export function initSummarySchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS summary_cache (
        content_hash TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        self_hash TEXT NOT NULL,
        dep_hash TEXT NOT NULL,
        kind TEXT NOT NULL,
        model_id TEXT NOT NULL DEFAULT '',
        summary_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        PRIMARY KEY (content_hash, prompt_version)
      );
      CREATE INDEX IF NOT EXISTS idx_summary_self ON summary_cache(self_hash, prompt_version);
      CREATE INDEX IF NOT EXISTS idx_summary_lru ON summary_cache(last_accessed_at);
      CREATE TABLE IF NOT EXISTS symbol_history (
        symbol_id TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        last_content_hash TEXT NOT NULL,
        last_self_hash TEXT NOT NULL,
        last_dep_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (symbol_id, prompt_version)
      );
      CREATE TABLE IF NOT EXISTS summary_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

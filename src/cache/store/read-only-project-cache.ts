import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { ProjectCacheEntry, ProjectCacheProvider } from "../../index/types.js";

export class ReadOnlyProjectCacheStore implements ProjectCacheProvider {
  private readonly database: DatabaseSync | null;

  constructor(file: string) {
    try {
      this.database = fs.existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
      this.database?.exec("PRAGMA busy_timeout = 5000;");
    } catch {
      this.database = null;
    }
  }

  readProjects(projectPaths: string[]): Map<string, ProjectCacheEntry> {
    const result = new Map<string, ProjectCacheEntry>();
    if (!this.database) return result;
    try {
      const statement = this.database.prepare(
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
      }
    } catch {
      return new Map();
    }
    return result;
  }

  writeProjects(_entries: ProjectCacheEntry[]): void {
    // Diff seeding is deliberately read-only.
  }

  close(): void {
    this.database?.close();
  }
}

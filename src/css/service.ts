import { analyzeCss } from "./analyzer.js";
import type { CssAnalysis, CssAnalysisProject } from "./types.js";

/** Narrow contract needed by CSS analysis; keeps the service testable. */
export interface CssAnalysisSource {
  readonly root: string;
  readonly analysisRevision: number;
  getAnalysisProjects(): CssAnalysisProject[];
}

export interface CssAnalysisRequest {
  extraCssFiles?: readonly string[];
  includeGenerated?: boolean;
  auditGlobalClasses?: boolean;
}

/**
 * Per-server cache for the optional CSS model. The indexer revision changes on
 * every rebuild and on every watched file event, so edited CSS invalidates the
 * cache even when the TypeScript graph digest is unchanged.
 */
export class CssAnalysisService {
  private cached: { key: string; analysis: CssAnalysis } | null = null;

  constructor(private readonly source: CssAnalysisSource) {}

  analyze(request: CssAnalysisRequest = {}): CssAnalysis {
    const extras = [...(request.extraCssFiles ?? [])].sort();
    const includeGenerated = request.includeGenerated ?? false;
    const auditGlobalClasses = request.auditGlobalClasses ?? false;
    const key = [
      this.source.analysisRevision,
      includeGenerated ? "generated" : "source",
      auditGlobalClasses ? "audit" : "default",
      extras.join("\u0000"),
    ].join("|");
    if (this.cached?.key === key) return this.cached.analysis;

    const analysis = analyzeCss({
      root: this.source.root,
      projects: this.source.getAnalysisProjects(),
      extraCssFiles: extras,
      includeGenerated,
      auditGlobalClasses,
    });
    this.cached = { key, analysis };
    return analysis;
  }

  clear(): void {
    this.cached = null;
  }
}

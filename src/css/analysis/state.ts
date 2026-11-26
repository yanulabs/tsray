import type {
  CssDiagnostic,
  CssLayerRecord,
  CssRuleRecord,
  CssVariableRecord,
} from "../types.js";

export interface CssAnalysisState {
  rules: CssRuleRecord[];
  variables: CssVariableRecord[];
  layers: CssLayerRecord[];
  diagnostics: CssDiagnostic[];
  composedUsage: Map<string, Set<string>>;
  layerOrder: Map<string, number>;
  registeredProperties: Set<string>;
  nextLayer: number;
  nextRuleId: number;
  nextFileOrder: number;
  anonymousLayer: number;
}

export function createCssAnalysisState(): CssAnalysisState {
  return {
    rules: [],
    variables: [],
    layers: [],
    diagnostics: [],
    composedUsage: new Map(),
    layerOrder: new Map(),
    registeredProperties: new Set(),
    nextLayer: 1,
    nextRuleId: 1,
    nextFileOrder: 0,
    anonymousLayer: 0,
  };
}

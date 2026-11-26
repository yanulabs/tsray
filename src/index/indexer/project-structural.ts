import path from "node:path";
import type ts from "typescript";
import type { EdgeKind, SymbolRecord } from "../types.js";
import { requiredMemberNames } from "./symbol-utils.js";

export function addStructuralImplementationEdges(options: {
  checker: ts.TypeChecker;
  declToId: Map<ts.Node, string>;
  projectFileSet: Set<string>;
  symbols: Map<string, SymbolRecord>;
  addEdge(
    fromId: string,
    toId: string,
    kind: EdgeKind,
    relative: string,
    line: number,
    via?: string
  ): void;
}): void {
  const { checker, declToId, projectFileSet, symbols, addEdge } = options;
    // Structural implementations are checked only inside the owning project.
    // A required-property prefilter avoids the previous all-pairs type sweep.
    const interfaceDecls: Array<{ id: string; type: ts.Type; required: Set<string> }> = [];
    const candidateDecls: Array<{
      id: string;
      type: ts.Type;
      symbol: SymbolRecord;
      properties: Set<string>;
    }> = [];
    const seenStructuralIds = new Set<string>();
    for (const [node, id] of declToId) {
      if (seenStructuralIds.has(id)) continue;
      const sourceFile = node.getSourceFile();
      if (!sourceFile || sourceFile.isDeclarationFile || !projectFileSet.has(path.resolve(sourceFile.fileName))) {
        continue;
      }
      const symbol = symbols.get(id);
      if (!symbol) continue;
      seenStructuralIds.add(id);
      if (symbol.kind === "interface") {
        const type = checker.getTypeAtLocation(node);
        const required = requiredMemberNames(type);
        if (required.size === 0) continue;
        interfaceDecls.push({ id, type, required });
      } else if (symbol.kind === "class" || symbol.kind === "type") {
        const type = checker.getTypeAtLocation(node);
        candidateDecls.push({
          id,
          type,
          symbol,
          properties: new Set(type.getProperties().map((property) => property.name)),
        });
      }
    }

    for (const iface of interfaceDecls) {
      for (const candidate of candidateDecls) {
        if (iface.id === candidate.id) continue;
        if (![...iface.required].every((name) => candidate.properties.has(name))) continue;
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

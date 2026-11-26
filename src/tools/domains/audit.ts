import { z } from "zod";
import { getDeadCode, getHotspots } from "../../index/queries.js";
import { paginate } from "../response.js";
import { boolArg, numberArg, stringArg } from "../shared/args.js";
import type { ToolContext } from "../shared/context.js";
import { hotspotResult } from "../shared/projections.js";
import { jsonResult } from "../shared/results.js";
import { maxCharsOptional, offsetOptional } from "../shared/schema.js";

export function registerAuditTools(context: ToolContext): void {
  const { controller, register } = context;

  register(
    "get_dead_code",
    "Unreachable symbols after entrypoint, test, generated-file, and React framework exemptions.",
    {
      include_exported: z.boolean().default(false),
      module: z.string().optional(),
      kind: z.string().optional(),
      group_by: z.enum(["none", "module", "kind"]).default("none"),
      limit: z.number().int().min(1).max(1000).default(200),
      offset: offsetOptional,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleFilter = stringArg(args, "module");
      const kindFilter = stringArg(args, "kind");
      let symbols = getDeadCode(snapshot, boolArg(args, "include_exported", false));
      if (moduleFilter) {
        symbols = symbols.filter((symbol) => symbol.module === moduleFilter);
      }
      if (kindFilter) {
        symbols = symbols.filter((symbol) => symbol.kind === kindFilter);
      }
      const page = paginate(
        symbols,
        numberArg(args, "offset", 0),
        numberArg(args, "limit", 200)
      );
      const lean = page.items.map((symbol) => ({
        id: symbol.id,
        name: symbol.name,
        kind: symbol.kind,
        module: symbol.module,
        file: symbol.file,
        line: symbol.line,
        loc: symbol.loc,
        complexity: symbol.complexity,
        exported: symbol.exported,
      }));
      const pagination = {
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        next_offset: page.next_offset,
        truncated: page.truncated,
      };
      const groupBy = stringArg(args, "group_by") ?? "none";
      if (groupBy === "none") {
        return jsonResult(
          { ...pagination, symbols: lean },
          numberArg(args, "max_chars", 20_000)
        );
      }
      const groups: Record<string, unknown[]> = {};
      for (const symbol of lean) {
        const key = groupBy === "module" ? symbol.module : symbol.kind;
        (groups[key] ??= []).push(symbol);
      }
      return jsonResult({ ...pagination, groups }, numberArg(args, "max_chars", 20_000));
    }
  );

  register(
    "get_hotspots",
    "Rank components/hooks/functions/methods by complexity, fan-in, and test reachability.",
    {
      limit: z.number().int().min(1).max(500).default(25),
      module: z.string().optional(),
      untested_only: z.boolean().default(false),
      min_complexity: z.number().int().min(1).default(1),
      sort_by: z.enum(["risk", "complexity", "loc", "fan_in"]).default("risk"),
      offset: offsetOptional,
      max_chars: maxCharsOptional,
    },
    async (args) => {
      const snapshot = await controller.getSnapshot();
      const moduleFilter = stringArg(args, "module");
      const untestedOnly = boolArg(args, "untested_only", false);
      const minComplexity = numberArg(args, "min_complexity", 1);
      let hotspots = getHotspots(
        snapshot,
        Math.max(1, snapshot.symbols.size)
      ).filter(
        (hotspot) =>
          (!moduleFilter || hotspot.module === moduleFilter) &&
          (!untestedOnly || !hotspot.testReachable) &&
          hotspot.complexity >= minComplexity
      );
      const sortBy = stringArg(args, "sort_by") ?? "risk";
      hotspots = hotspots.sort((a, b) => {
        switch (sortBy) {
          case "complexity":
            return b.complexity - a.complexity;
          case "loc":
            return b.loc - a.loc;
          case "fan_in":
            return b.fanIn - a.fanIn;
          default:
            return b.riskScore - a.riskScore;
        }
      });
      const page = paginate(
        hotspots,
        numberArg(args, "offset", 0),
        numberArg(args, "limit", 25)
      );
      return jsonResult(
        {
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          next_offset: page.next_offset,
          truncated: page.truncated,
          hotspots: page.items.map(hotspotResult),
        },
        numberArg(args, "max_chars", 20_000)
      );
    }
  );
}

import { useMemo, useState } from "react";
import { indexReport } from "../lib/derive";
import { formatNumber, kindClasses, kindLabel, riskClasses } from "../lib/format";
import type { Report } from "../types/report";
import type { Selection } from "../types/ui";
import { Badge, Card, EmptyState } from "./ui";
import { FlameIcon, SearchIcon } from "./icons";

type SortKey = "risk" | "complexity" | "fanIn" | "loc";

export function HotspotsView({
  report,
  selection,
  onSelect,
}: {
  report: Report;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}): React.ReactElement {
  const index = useMemo(() => indexReport(report), [report]);
  const [query, setQuery] = useState("");
  const [untestedOnly, setUntestedOnly] = useState(false);
  const [minComplexity, setMinComplexity] = useState(1);
  const [sortBy, setSortBy] = useState<SortKey>("risk");

  const rows = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return report.hotspots
      .filter((hotspot) => (!untestedOnly || !hotspot.testReachable) && hotspot.complexity >= minComplexity)
      .filter(
        (hotspot) =>
          !lower ||
          hotspot.name.toLowerCase().includes(lower) ||
          hotspot.module.toLowerCase().includes(lower) ||
          hotspot.file.toLowerCase().includes(lower)
      )
      .sort((a, b) => {
        switch (sortBy) {
          case "complexity":
            return b.complexity - a.complexity;
          case "fanIn":
            return b.fanIn - a.fanIn;
          case "loc":
            return b.loc - a.loc;
          default:
            return b.riskScore - a.riskScore;
        }
      });
  }, [minComplexity, query, report.hotspots, sortBy, untestedOnly]);

  const maxRisk = Math.max(1, ...rows.map((row) => row.riskScore));
  const untested = report.hotspots.filter((hotspot) => !hotspot.testReachable).length;

  return (
    <div className="flex h-full flex-col gap-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <FlameIcon width={15} height={15} className="text-orange-500" />
            <h2 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Risk hotspots</h2>
            <Badge className="border-orange-200 bg-orange-50 text-orange-600 dark:border-orange-900 dark:bg-orange-950/50 dark:text-orange-300">
              {untested} untested
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
            Complexity × fan-in × missing test reachability. Lower risk is better.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="relative">
            <SearchIcon
              width={13}
              height={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter symbols"
              className="h-8 w-48 rounded-lg border border-zinc-300 bg-white pl-7 pr-2 text-xs text-zinc-700 outline-none placeholder:text-zinc-400 focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
            />
          </label>
          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as SortKey)}
            className="h-8 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-600 outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <option value="risk">Sort: risk</option>
            <option value="complexity">Sort: complexity</option>
            <option value="fanIn">Sort: fan-in</option>
            <option value="loc">Sort: LOC</option>
          </select>
          <select
            value={minComplexity}
            onChange={(event) => setMinComplexity(Number(event.target.value))}
            className="h-8 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-600 outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <option value={1}>Complexity ≥ 1</option>
            <option value={5}>Complexity ≥ 5</option>
            <option value={10}>Complexity ≥ 10</option>
            <option value={20}>Complexity ≥ 20</option>
          </select>
          <button
            type="button"
            onClick={() => setUntestedOnly(!untestedOnly)}
            className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
              untestedOnly
                ? "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                : "border-zinc-300 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            }`}
          >
            Untested only
          </button>
        </div>
      </div>

      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState
            title="No hotspots match the filters"
            hint="Relax the complexity threshold or clear the search query."
            icon={<FlameIcon width={28} height={28} />}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10 border-b border-zinc-200 bg-zinc-50/95 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/95">
                <tr className="text-[10px] uppercase tracking-[0.07em] text-zinc-400 dark:text-zinc-500">
                  <th className="w-10 px-3 py-2 font-semibold">#</th>
                  <th className="px-3 py-2 font-semibold">Symbol</th>
                  <th className="px-3 py-2 font-semibold">Kind</th>
                  <th className="px-3 py-2 font-semibold">Module</th>
                  <th className="px-3 py-2 font-semibold">File</th>
                  <th className="px-3 py-2 text-right font-semibold">LOC</th>
                  <th className="px-3 py-2 text-right font-semibold">Cplx</th>
                  <th className="px-3 py-2 text-right font-semibold">Fan-in</th>
                  <th className="px-3 py-2 text-center font-semibold">Tested</th>
                  <th className="w-36 px-3 py-2 font-semibold">Risk</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, position) => {
                  const symbol = index.symbolById.get(row.id);
                  const selected = selection?.type === "symbol" && selection.id === row.id;
                  return (
                    <tr
                      key={row.id}
                      onClick={() => onSelect({ type: "symbol", id: row.id })}
                      className={`cursor-pointer border-b border-zinc-100 transition-colors last:border-0 dark:border-zinc-800/60 ${
                        selected
                          ? "bg-indigo-50/70 dark:bg-indigo-950/30"
                          : "hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                      }`}
                    >
                      <td className="px-3 py-2 font-mono text-[10px] text-zinc-400">{position + 1}</td>
                      <td className="max-w-[220px] truncate px-3 py-2 font-medium text-zinc-800 dark:text-zinc-100">
                        {row.name}
                        {symbol?.dead ? (
                          <Badge className="ml-1.5 border-rose-200 bg-rose-50 text-rose-500 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300">
                            dead
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <Badge className={kindClasses(row.kind)}>{kindLabel(row.kind)}</Badge>
                      </td>
                      <td className="max-w-[140px] truncate px-3 py-2 text-zinc-500 dark:text-zinc-400">{row.module}</td>
                      <td
                        className="max-w-[240px] truncate px-3 py-2 font-mono text-[10.5px] text-zinc-400 dark:text-zinc-500"
                        title={`${row.file}:${row.line}`}
                      >
                        {row.file}:{row.line}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] text-zinc-500">{formatNumber(row.loc)}</td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] text-zinc-500">{row.complexity}</td>
                      <td className="px-3 py-2 text-right font-mono text-[11px] text-zinc-500">{row.fanIn}</td>
                      <td className="px-3 py-2 text-center">
                        <span
                          className={`inline-block h-1.5 w-1.5 rounded-full ${
                            row.testReachable ? "bg-emerald-500" : "bg-amber-500"
                          }`}
                          title={row.testReachable ? "Reachable from tests" : "Not reached by tests"}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-amber-400 to-rose-500"
                              style={{ width: `${Math.max(4, (row.riskScore / maxRisk) * 100)}%` }}
                            />
                          </div>
                          <span className={`w-10 text-right font-mono text-[10.5px] ${riskClasses(row.riskScore)}`}>
                            {row.riskScore}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

import { useMemo, useState } from "react";
import { moduleHealth, indexReport } from "../lib/derive";
import { formatNumber, formatPercent, syncClasses, syncLabel } from "../lib/format";
import type { Report } from "../types/report";
import type { Selection } from "../types/ui";
import { Badge, Card, EmptyState, ProgressBar } from "./ui";
import { AlertIcon, GridIcon } from "./icons";

type SortKey = "loc" | "symbols" | "fan_in" | "name";

export function ModulesView({
  report,
  selection,
  onSelect,
}: {
  report: Report;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}): React.ReactElement {
  const index = useMemo(() => indexReport(report), [report]);
  const [sortBy, setSortBy] = useState<SortKey>("loc");
  const [query, setQuery] = useState("");

  const modules = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return report.modules
      .filter((module) => !lower || module.name.toLowerCase().includes(lower))
      .sort((a, b) => {
        switch (sortBy) {
          case "symbols":
            return b.symbols - a.symbols;
          case "fan_in":
            return b.fan_in - a.fan_in;
          case "name":
            return a.name.localeCompare(b.name);
          default:
            return b.prod_loc - a.prod_loc;
        }
      });
  }, [query, report.modules, sortBy]);

  const totalSymbols = Math.max(1, report.modules.reduce((total, module) => total + module.symbols, 0));

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <GridIcon width={15} height={15} className="text-indigo-500" />
            <h2 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Logical modules</h2>
            <Badge className="border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              {report.modules.length}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
            Workspace packages and feature folders, grouped by src/&lt;area&gt;/&lt;name&gt;.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter modules"
            className="h-8 w-44 rounded-lg border border-zinc-300 bg-white px-2.5 text-xs text-zinc-700 outline-none placeholder:text-zinc-400 focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
          />
          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as SortKey)}
            className="h-8 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-600 outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <option value="loc">Sort: prod LOC</option>
            <option value="symbols">Sort: symbols</option>
            <option value="fan_in">Sort: fan-in</option>
            <option value="name">Sort: name</option>
          </select>
        </div>
      </div>

      {report.module_cycles.length > 0 ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <div className="flex items-center gap-2 font-medium">
            <AlertIcon width={13} height={13} />
            {report.module_cycles.length} module cycle{report.module_cycles.length === 1 ? "" : "s"} detected
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10.5px] opacity-80">
            {report.module_cycles.map((cycle) => (
              <span key={cycle.join(",")}>{cycle.join(" → ")} → {cycle[0]}</span>
            ))}
          </div>
        </div>
      ) : null}

      {modules.length === 0 ? (
        <EmptyState title="No modules match" icon={<GridIcon width={28} height={28} />} />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {modules.map((module) => {
            const health = moduleHealth(module);
            const selected = selection?.type === "module" && selection.id === module.id;
            const symbols = index.symbolsByModule.get(module.id) ?? [];
            const top = symbols
              .filter((symbol) => !symbol.is_test)
              .sort((a, b) => b.fan_in - a.fan_in)
              .slice(0, 3);
            return (
              <Card
                key={module.id}
                className={`cursor-pointer p-3.5 transition-all hover:-translate-y-0.5 hover:shadow-md ${
                  selected ? "ring-2 ring-indigo-400 dark:ring-indigo-600" : ""
                }`}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => onSelect({ type: "module", id: module.id })}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{module.name}</p>
                      <p className="mt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">
                        {module.files} files · {module.entrypoints} entrypoint{module.entrypoints === 1 ? "" : "s"}
                      </p>
                    </div>
                    <Badge
                      className={
                        health.tone === "danger"
                          ? "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300"
                          : health.tone === "warn"
                            ? "border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
                            : "border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300"
                      }
                    >
                      {health.label}
                    </Badge>
                  </div>

                  <div className="mt-3 grid grid-cols-4 gap-2">
                    <MiniStat label="Symbols" value={formatNumber(module.symbols)} />
                    <MiniStat label="Prod LOC" value={formatNumber(module.prod_loc)} />
                    <MiniStat label="Fan-in" value={String(module.fan_in)} />
                    <MiniStat label="Fan-out" value={String(module.fan_out)} />
                  </div>

                  <div className="mt-3">
                    <div className="mb-1 flex items-center justify-between text-[10px] text-zinc-400 dark:text-zinc-500">
                      <span>summary coverage</span>
                      <span>{formatPercent(module.synced_percent)}</span>
                    </div>
                    <ProgressBar
                      value={module.synced_percent}
                      tone={module.synced_percent >= 80 ? "emerald" : module.synced_percent > 0 ? "amber" : "indigo"}
                    />
                  </div>

                  <div className="mt-2.5 flex items-center gap-1.5">
                    <Badge className={syncClasses(module.sync_state)}>{syncLabel(module.sync_state)}</Badge>
                    <Badge className="border-sky-200 bg-sky-50 text-sky-600 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-300">
                      {module.components} comp
                    </Badge>
                    <Badge className="border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300">
                      {module.hooks} hook
                    </Badge>
                    <div className="ml-auto flex h-1.5 w-20 items-center overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-indigo-400"
                        style={{ width: `${(module.symbols / totalSymbols) * 100}%` }}
                      />
                    </div>
                  </div>

                  {top.length > 0 ? (
                    <div className="mt-3 space-y-1 border-t border-zinc-100 pt-2 dark:border-zinc-800/70">
                      {top.map((symbol) => (
                        <div key={symbol.id} className="flex items-center justify-between gap-2 text-[10.5px]">
                          <span className="truncate font-mono text-zinc-500 dark:text-zinc-400">{symbol.name}</span>
                          <span className="shrink-0 text-zinc-400 dark:text-zinc-600">{symbol.fan_in} in</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </button>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="rounded-lg bg-zinc-50 px-2 py-1.5 dark:bg-zinc-900/70">
      <p className="text-[9px] uppercase tracking-[0.06em] text-zinc-400 dark:text-zinc-500">{label}</p>
      <p className="font-mono text-[11.5px] font-medium text-zinc-700 dark:text-zinc-200">{value}</p>
    </div>
  );
}

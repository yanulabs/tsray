import { useEffect, useMemo, useState } from "react";
import { indexReport } from "../lib/derive";
import { kindClasses, kindLabel, syncClasses, syncLabel } from "../lib/format";
import { searchSymbols } from "../lib/fuzzy";
import type { Report } from "../types/report";
import type { Selection } from "../types/ui";
import { Badge, Card, EmptyState } from "./ui";
import { FileTreeIcon, SearchIcon } from "./icons";

const KIND_OPTIONS = [
  "all",
  "component",
  "hook",
  "context",
  "function",
  "method",
  "class",
  "interface",
  "type",
  "enum",
  "variable",
] as const;

export function ExplorerView({
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
  const [moduleFilter, setModuleFilter] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<(typeof KIND_OPTIONS)[number]>("all");
  const [hideTests, setHideTests] = useState(true);
  const [sortBy, setSortBy] = useState<"file" | "fan_in" | "name">("file");

  useEffect(() => {
    if (selection?.type === "module") setModuleFilter(selection.id);
  }, [selection]);

  useEffect(() => {
    if (moduleFilter && !index.moduleByName.has(moduleFilter)) setModuleFilter(null);
  }, [index.moduleByName, moduleFilter]);

  const rows = useMemo(() => {
    const base = query.trim() ? searchSymbols(report, query, 500).map((hit) => hit.symbol) : report.symbols;
    return base
      .filter((symbol) => !moduleFilter || symbol.module === moduleFilter)
      .filter((symbol) => kindFilter === "all" || symbol.kind === kindFilter)
      .filter((symbol) => !hideTests || !symbol.is_test)
      .sort((a, b) => {
        switch (sortBy) {
          case "fan_in":
            return b.fan_in - a.fan_in || a.name.localeCompare(b.name);
          case "name":
            return a.name.localeCompare(b.name);
          default:
            return a.file.localeCompare(b.file) || a.line - b.line;
        }
      });
  }, [hideTests, kindFilter, moduleFilter, query, report, sortBy]);

  const visible = rows.slice(0, 500);

  return (
    <div className="flex h-full min-h-0 gap-3 p-4 sm:p-5">
      <Card className="hidden w-56 shrink-0 flex-col overflow-hidden md:flex">
        <div className="border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500">Modules</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          <button
            type="button"
            onClick={() => setModuleFilter(null)}
            className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
              moduleFilter === null
                ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-200"
                : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-900"
            }`}
          >
            <span className="font-medium">All modules</span>
            <span className="font-mono text-[10px] text-zinc-400">{report.symbols.length}</span>
          </button>
          {report.modules.map((module) => (
            <button
              key={module.id}
              type="button"
              onClick={() => setModuleFilter(module.id)}
              className={`mt-0.5 flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                moduleFilter === module.id
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-200"
                  : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-900"
              }`}
            >
              <span className="truncate">{module.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-zinc-400">{module.symbols}</span>
            </button>
          ))}
        </div>
      </Card>

      <Card className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
          <label className="relative min-w-[160px] flex-1">
            <SearchIcon
              width={13}
              height={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, file, module, or canonical ID"
              className="h-8 w-full rounded-lg border border-zinc-300 bg-white pl-7 pr-2 text-xs text-zinc-700 outline-none placeholder:text-zinc-400 focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
            />
          </label>
          <select
            value={moduleFilter ?? ""}
            onChange={(event) => setModuleFilter(event.target.value || null)}
            className="h-8 max-w-40 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-600 outline-none md:hidden dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <option value="">All modules</option>
            {report.modules.map((module) => (
              <option key={module.id} value={module.id}>
                {module.id}
              </option>
            ))}
          </select>
          <select
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value as (typeof KIND_OPTIONS)[number])}
            className="h-8 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-600 outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            {KIND_OPTIONS.map((kind) => (
              <option key={kind} value={kind}>
                {kind === "all" ? "All kinds" : kindLabel(kind)}
              </option>
            ))}
          </select>
          <select
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as "file" | "fan_in" | "name")}
            className="h-8 rounded-lg border border-zinc-300 bg-white px-2 text-xs text-zinc-600 outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            <option value="file">Sort: file</option>
            <option value="fan_in">Sort: fan-in</option>
            <option value="name">Sort: name</option>
          </select>
          <button
            type="button"
            onClick={() => setHideTests(!hideTests)}
            className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
              hideTests
                ? "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                : "border-zinc-300 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            }`}
          >
            Hide tests
          </button>
        </div>

        <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-1.5 text-[10px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          <span>
            {rows.length} symbol{rows.length === 1 ? "" : "s"}
            {rows.length > visible.length ? ` · showing first ${visible.length}` : ""}
          </span>
          <span className="font-mono">{moduleFilter ?? "all modules"}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <EmptyState
              title="No symbols match"
              hint="Try a broader query or clear the kind and module filters."
              icon={<FileTreeIcon width={28} height={28} />}
            />
          ) : (
            visible.map((symbol) => {
              const selected = selection?.type === "symbol" && selection.id === symbol.id;
              return (
                <button
                  key={symbol.id}
                  type="button"
                  onClick={() => onSelect({ type: "symbol", id: symbol.id })}
                  className={`flex w-full items-center gap-2 border-b border-zinc-50 px-3 py-1.5 text-left transition-colors last:border-0 dark:border-zinc-900 ${
                    selected ? "bg-indigo-50/70 dark:bg-indigo-950/30" : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                  }`}
                >
                  <Badge className={`w-20 shrink-0 justify-center ${kindClasses(symbol.kind)}`}>
                    {kindLabel(symbol.kind)}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">{symbol.name}</span>
                      {symbol.dead ? (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" title="Dead code" />
                      ) : null}
                      {symbol.entrypoint ? (
                        <Badge className="border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-300">
                          entry
                        </Badge>
                      ) : null}
                      {symbol.is_generated ? (
                        <Badge className="border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500">
                          gen
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500" title={`${symbol.file}:${symbol.line}`}>
                      {symbol.file}:{symbol.line}
                    </p>
                  </div>
                  <div className="hidden shrink-0 items-center gap-2 text-[10px] text-zinc-400 sm:flex dark:text-zinc-500">
                    <span className="w-20 truncate text-right font-mono" title={symbol.module}>
                      {symbol.module}
                    </span>
                    <span className="w-8 text-right">{symbol.fan_in} in</span>
                    <Badge className={syncClasses(symbol.sync_state)}>{syncLabel(symbol.sync_state)}</Badge>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </Card>
    </div>
  );
}

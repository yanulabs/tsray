import { useMemo, useState } from "react";
import { kindClasses, kindLabel } from "../lib/format";
import type { Report } from "../types/report";
import type { Selection } from "../types/ui";
import { Badge, Card, EmptyState } from "./ui";
import { BracesIcon, SearchIcon } from "./icons";

export function ContractsView({
  report,
  selection,
  onSelect,
}: {
  report: Report;
  selection: Selection;
  onSelect: (selection: Selection) => void;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [hideEmpty, setHideEmpty] = useState(false);

  const interfaces = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return report.interfaces
      .filter((entry) => !hideEmpty || entry.implementations.length > 0)
      .filter(
        (entry) =>
          !lower ||
          entry.name.toLowerCase().includes(lower) ||
          entry.module.toLowerCase().includes(lower) ||
          entry.file.toLowerCase().includes(lower)
      )
      .sort((a, b) => b.implementations.length - a.implementations.length || a.name.localeCompare(b.name));
  }, [hideEmpty, query, report.interfaces]);

  const implemented = report.interfaces.filter((entry) => entry.implementations.length > 0).length;
  const implementationCount = report.interfaces.reduce((total, entry) => total + entry.implementations.length, 0);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4 sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <BracesIcon width={15} height={15} className="text-rose-500" />
            <h2 className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Interface contracts</h2>
            <Badge className="border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              {report.interfaces.length} interfaces
            </Badge>
            <Badge className="border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300">
              {implemented} implemented
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">
            TypeChecker.assignability matches ({implementationCount} edges). Structural matches can include object types.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="relative">
            <SearchIcon
              width={13}
              height={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter interfaces"
              className="h-8 w-48 rounded-lg border border-zinc-300 bg-white pl-7 pr-2 text-xs text-zinc-700 outline-none placeholder:text-zinc-400 focus:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
            />
          </label>
          <button
            type="button"
            onClick={() => setHideEmpty(!hideEmpty)}
            className={`h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
              hideEmpty
                ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300"
                : "border-zinc-300 bg-white text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            }`}
          >
            Implemented only
          </button>
        </div>
      </div>

      {interfaces.length === 0 ? (
        <EmptyState
          title="No interface contracts match"
          hint="Interfaces with structural implementations appear here after indexing."
          icon={<BracesIcon width={28} height={28} />}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {interfaces.map((entry) => {
            const selected = selection?.type === "symbol" && selection.id === entry.id;
            return (
              <Card key={entry.id} className={`p-3.5 ${selected ? "ring-2 ring-indigo-400 dark:ring-indigo-600" : ""}`}>
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => onSelect({ type: "symbol", id: entry.id })}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">{entry.name}</p>
                      <p className="font-mono text-[10.5px] text-zinc-400 dark:text-zinc-500">
                        {entry.file}:{entry.line} · {entry.module}
                      </p>
                    </div>
                    <Badge className="border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300">
                      {entry.members} member{entry.members === 1 ? "" : "s"}
                    </Badge>
                  </div>
                </button>

                <div className="mt-3 flex flex-wrap gap-1.5">
                  {entry.implementations.length === 0 ? (
                    <span className="text-[11px] text-zinc-400 dark:text-zinc-500">No implementations detected</span>
                  ) : (
                    entry.implementations.map((implementation) => (
                      <button
                        key={`${entry.id}-${implementation.id}`}
                        type="button"
                        onClick={() => onSelect({ type: "symbol", id: implementation.id })}
                        className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-transform hover:-translate-y-0.5 ${kindClasses(implementation.kind)}`}
                        title={`${implementation.file}:${implementation.line} · ${implementation.via}`}
                      >
                        {implementation.name}
                        <span className="ml-1 opacity-60">{kindLabel(implementation.kind)}</span>
                      </button>
                    ))
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

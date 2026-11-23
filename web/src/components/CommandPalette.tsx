import { useEffect, useMemo, useRef, useState } from "react";
import { searchModules, searchSymbols } from "../lib/fuzzy";
import { kindClasses, kindLabel } from "../lib/format";
import type { Report } from "../types/report";
import type { Selection } from "../types/ui";
import { Badge, Kbd } from "./ui";
import { ArrowRightIcon, GridIcon, SearchIcon } from "./icons";

interface PaletteItem {
  type: "symbol" | "module";
  id: string;
  title: string;
  subtitle: string;
  kind: string;
  score: number;
}

export function CommandPalette({
  open,
  onClose,
  report,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  report: Report;
  onSelect: (selection: Selection) => void;
}): React.ReactElement | null {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(timer);
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const symbols = searchSymbols(report, query, 60).map(({ symbol, score }) => ({
      type: "symbol" as const,
      id: symbol.id,
      title: symbol.name,
      subtitle: `${symbol.file}:${symbol.line} · ${symbol.module}`,
      kind: symbol.kind,
      score,
    }));
    const modules = searchModules(report, query, 20).map(({ module, score }) => ({
      type: "module" as const,
      id: module.id,
      title: module.name,
      subtitle: `${module.symbols} symbols · ${module.prod_loc} prod LOC · ${module.components} components`,
      kind: "module",
      score: score - 20,
    }));
    return [...symbols, ...modules].sort((a, b) => b.score - a.score).slice(0, 80);
  }, [query, report]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const choose = (item: PaletteItem): void => {
    onSelect(item.type === "module" ? { type: "module", id: item.id } : { type: "symbol", id: item.id });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-950/40 px-4 pt-[14vh] backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl shadow-zinc-950/20 dark:border-zinc-800 dark:bg-zinc-950"
        role="dialog"
        aria-modal="true"
        aria-label="Search symbols and modules"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((value) => Math.min(items.length - 1, value + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((value) => Math.max(0, value - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const item = items[active];
            if (item) choose(item);
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-zinc-100 px-3.5 py-3 dark:border-zinc-800">
          <SearchIcon width={15} height={15} className="text-zinc-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search symbols, files, modules, or canonical IDs…"
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
          />
          <Kbd>esc</Kbd>
        </div>

        <div className="max-h-[55vh] min-h-[120px] overflow-y-auto p-1.5">
          {items.length === 0 ? (
            <div className="flex h-28 items-center justify-center text-xs text-zinc-400">No matches found.</div>
          ) : (
            items.map((item, index) => (
              <button
                key={`${item.type}:${item.id}`}
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(item)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  index === active ? "bg-indigo-50 dark:bg-indigo-950/40" : "hover:bg-zinc-50 dark:hover:bg-zinc-900"
                }`}
              >
                {item.type === "module" ? (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500">
                    <GridIcon width={12} height={12} />
                  </span>
                ) : (
                  <Badge className={`w-24 shrink-0 justify-center ${kindClasses(item.kind)}`}>{kindLabel(item.kind)}</Badge>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-zinc-800 dark:text-zinc-100">{item.title}</span>
                  <span className="block truncate font-mono text-[10px] text-zinc-400 dark:text-zinc-500">{item.subtitle}</span>
                </span>
                <ArrowRightIcon
                  width={12}
                  height={12}
                  className={index === active ? "text-indigo-400" : "text-zinc-300 dark:text-zinc-700"}
                />
              </button>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-zinc-100 px-3.5 py-2 text-[10px] text-zinc-400 dark:border-zinc-800 dark:text-zinc-500">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> open
          </span>
          <span className="ml-auto">{items.length} results</span>
        </div>
      </div>
    </div>
  );
}

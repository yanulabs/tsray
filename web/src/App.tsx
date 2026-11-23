import { useCallback, useEffect, useMemo, useState } from "react";
import { CommandPalette } from "./components/CommandPalette";
import { ContractsView } from "./components/ContractsView";
import { ExplorerView } from "./components/ExplorerView";
import { GraphView } from "./components/GraphView";
import { HotspotsView } from "./components/HotspotsView";
import { Inspector } from "./components/Inspector";
import { MetricStrip } from "./components/MetricStrip";
import { ModulesView } from "./components/ModulesView";
import { Topbar } from "./components/Topbar";
import { AlertIcon, RefreshIcon } from "./components/icons";
import { fetchLiveReport, fetchSymbolDetail, readEmbeddedReport, type SymbolDetail } from "./lib/data";
import { indexReport } from "./lib/derive";
import type { Report, ViewMode } from "./types/report";
import type { LiveStatus, Selection, Theme } from "./types/ui";

const embedded = readEmbeddedReport();

function initialTheme(): Theme {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) return "dark";
  return "light";
}

export default function App(): React.ReactElement {
  const [report, setReport] = useState<Report | null>(embedded?.report ?? null);
  const [live] = useState<boolean>(embedded?.live ?? true);
  const [status, setStatus] = useState<LiveStatus>(embedded?.live ? "live" : "static");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("graph");
  const [selection, setSelection] = useState<Selection>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [detail, setDetail] = useState<SymbolDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const selectedSymbolId = selection?.type === "symbol" ? selection.id : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (!live) return;
    setStatus((current) => (current === "live" ? "refreshing" : current));
    try {
      const next = await fetchLiveReport();
      setReport(next);
      setStatus("live");
      setError(null);
    } catch (cause) {
      setStatus("offline");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [live]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      localStorage.setItem("tsray-theme", theme);
    } catch {
      // Theme persistence is best effort.
    }
  }, [theme]);

  useEffect(() => {
    if (!live) return;
    if (!report) void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    const onVisible = (): void => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, refresh, report]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keep the selection valid across live refreshes.
  useEffect(() => {
    if (!report || !selection) return;
    const index = indexReport(report);
    if (selection.type === "symbol" && !index.symbolById.has(selection.id)) setSelection(null);
    if (selection.type === "module" && !index.moduleByName.has(selection.id)) setSelection(null);
  }, [report, selection]);

  useEffect(() => {
    if (!live || !selectedSymbolId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setDetailLoading(true);
    fetchSymbolDetail(selectedSymbolId, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setDetail(next);
        setDetailLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setDetail(null);
        setDetailLoading(false);
      });
    return () => controller.abort();
  }, [live, report?.generated_at, selectedSymbolId]);

  const issueBanner = useMemo(() => {
    if (!report) return null;
    if (report.prod_errors.length > 0) {
      return (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="flex items-center gap-2">
            <AlertIcon width={12} height={12} />
            <span className="font-medium">
              {report.prod_errors.length} production TypeScript error{report.prod_errors.length === 1 ? "" : "s"}
            </span>
            <span className="truncate opacity-70">
              {report.prod_errors[0]?.file}:{report.prod_errors[0]?.line} · {report.prod_errors[0]?.message}
            </span>
          </div>
        </div>
      );
    }
    return null;
  }, [report]);

  if (!report) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-zinc-50 p-8 text-center dark:bg-zinc-950">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-900 text-sm font-bold text-white dark:bg-white dark:text-zinc-900">
          t.
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">No indexed report available yet.</p>
          <p className="mt-1 max-w-sm text-xs text-zinc-400">
            {error ?? "Start tsray serve or export a static HTML report with tsray export html."}
          </p>
        </div>
        {live ? (
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
          >
            <RefreshIcon width={12} height={12} /> Retry
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <Topbar
        report={report}
        view={view}
        onView={setView}
        onSearch={() => setPaletteOpen(true)}
        theme={theme}
        onTheme={setTheme}
        status={status}
        onRefresh={() => void refresh()}
      />
      <MetricStrip report={report} />
      {error ? (
        <div className="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-1.5 text-[11px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200">
          <AlertIcon width={12} height={12} />
          <span className="min-w-0 flex-1 truncate">Live refresh failed: {error}. Showing the last snapshot.</span>
          <button type="button" onClick={() => void refresh()} className="shrink-0 font-medium underline">
            retry
          </button>
        </div>
      ) : null}
      {issueBanner}

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-hidden">
          {view === "graph" ? (
            <GraphView report={report} selection={selection} onSelect={setSelection} />
          ) : view === "hotspots" ? (
            <HotspotsView report={report} selection={selection} onSelect={setSelection} />
          ) : view === "modules" ? (
            <ModulesView report={report} selection={selection} onSelect={setSelection} />
          ) : view === "contracts" ? (
            <ContractsView report={report} selection={selection} onSelect={setSelection} />
          ) : (
            <ExplorerView report={report} selection={selection} onSelect={setSelection} />
          )}
        </main>

        {selection ? (
          <>
            <div
              className="fixed inset-0 z-30 bg-zinc-950/30 backdrop-blur-sm md:hidden"
              onClick={() => setSelection(null)}
            />
            <div className="fixed inset-y-0 right-0 z-40 md:static md:z-auto">
              <Inspector
                report={report}
                selection={selection}
                onSelect={setSelection}
                onClose={() => setSelection(null)}
                live={live}
                detail={detail}
                detailLoading={detailLoading}
              />
            </div>
          </>
        ) : null}
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        report={report}
        onSelect={setSelection}
      />
    </div>
  );
}

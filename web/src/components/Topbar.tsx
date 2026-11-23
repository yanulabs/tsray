import { formatDuration, relativeTime } from "../lib/format";
import type { Report, ViewMode } from "../types/report";
import type { LiveStatus, Theme } from "../types/ui";
import { MoonIcon, RefreshIcon, SearchIcon, SunIcon } from "./icons";
import { Badge, Button, Kbd } from "./ui";

const VIEWS: Array<{ id: ViewMode; label: string }> = [
  { id: "graph", label: "Graph" },
  { id: "hotspots", label: "Hotspots" },
  { id: "modules", label: "Modules" },
  { id: "contracts", label: "Contracts" },
  { id: "explorer", label: "Explorer" },
];

export function Topbar({
  report,
  view,
  onView,
  onSearch,
  theme,
  onTheme,
  status,
  onRefresh,
}: {
  report: Report;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  onSearch: () => void;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  status: LiveStatus;
  onRefresh: () => void;
}): React.ReactElement {
  return (
    <header className="shrink-0 border-b border-zinc-200/80 bg-white/80 backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-950/80">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-[13px] font-bold text-white dark:bg-white dark:text-zinc-900">
            t<span className="text-indigo-400 dark:text-indigo-600">.</span>
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white dark:ring-zinc-950" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                {report.project}
              </h1>
              <Badge className="border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
                arch report
              </Badge>
            </div>
            <p className="truncate font-mono text-[10.5px] leading-4 text-zinc-400 dark:text-zinc-500" title={report.repo}>
              {report.repo}
            </p>
          </div>
        </div>

        <nav className="order-3 flex w-full items-center gap-1 overflow-x-auto rounded-xl bg-zinc-100/80 p-1 sm:order-none sm:ml-2 sm:w-auto dark:bg-zinc-900">
          {VIEWS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onView(item.id)}
              className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                view === item.id
                  ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-50"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <div className="mr-1 hidden text-right lg:block">
            <p className="text-[10px] uppercase tracking-[0.08em] text-zinc-400 dark:text-zinc-500">
              indexed {relativeTime(report.generated_at)}
            </p>
            <p className="text-[10px] text-zinc-400 dark:text-zinc-600">
              TS {report.typescript_version} · {formatDuration(report.duration_ms)}
            </p>
          </div>

          <StatusBadge status={status} />

          <Button onClick={onSearch} variant="outline" className="gap-2">
            <SearchIcon width={13} height={13} />
            <span className="hidden sm:inline">Search</span>
            <Kbd>⌘K</Kbd>
          </Button>

          {status !== "static" ? (
            <Button onClick={onRefresh} variant="outline" title="Refresh report">
              <RefreshIcon width={13} height={13} className={status === "refreshing" ? "animate-spin" : ""} />
            </Button>
          ) : null}

          <Button
            onClick={() => onTheme(theme === "dark" ? "light" : "dark")}
            variant="outline"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
          >
            {theme === "dark" ? <SunIcon width={13} height={13} /> : <MoonIcon width={13} height={13} />}
          </Button>
        </div>
      </div>
    </header>
  );
}

function StatusBadge({ status }: { status: LiveStatus }): React.ReactElement {
  if (status === "static") {
    return (
      <Badge className="border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        offline file
      </Badge>
    );
  }
  if (status === "offline") {
    return (
      <Badge className="border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300">
        disconnected
      </Badge>
    );
  }
  return (
    <Badge className="border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300">
      <span className={`h-1.5 w-1.5 rounded-full bg-emerald-500 ${status === "refreshing" ? "animate-pulse" : ""}`} />
      {status === "refreshing" ? "refreshing" : "live"}
    </Badge>
  );
}

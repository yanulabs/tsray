export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-US", {
    notation: Math.abs(value) >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPercent(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return "0%";
  return `${value.toFixed(digits)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function truncatePath(value: string, max = 54): string {
  if (value.length <= max) return value;
  const parts = value.split("/");
  if (parts.length <= 2) return `…${value.slice(-(max - 1))}`;
  const head = parts[0]!;
  const tail = parts.slice(-2).join("/");
  if (head.length + tail.length + 2 <= max) return `${head}/…/${tail}`;
  return `…/${tail}`;
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case "component":
      return "component";
    case "hook":
      return "hook";
    case "context":
      return "context";
    case "method":
      return "method";
    default:
      return kind;
  }
}

export function kindClasses(kind: string): string {
  switch (kind) {
    case "component":
      return "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-300";
    case "hook":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300";
    case "context":
      return "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-300";
    case "function":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300";
    case "interface":
    case "type":
      return "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300";
    case "class":
      return "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950/60 dark:text-orange-300";
    default:
      return "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300";
  }
}

export function syncClasses(state: string): string {
  switch (state) {
    case "synced":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300";
    case "soft_stale":
      return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300";
    case "hard_stale":
      return "border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-900 dark:bg-orange-950/60 dark:text-orange-300";
    case "missing":
      return "border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400";
    default:
      return "border-zinc-200 bg-transparent text-zinc-400 dark:border-zinc-800 dark:text-zinc-500";
  }
}

export function syncLabel(state: string): string {
  switch (state) {
    case "soft_stale":
      return "deps stale";
    case "hard_stale":
      return "stale";
    case "not_eligible":
      return "n/a";
    default:
      return state;
  }
}

export function riskClasses(score: number): string {
  if (score >= 30) return "text-rose-600 dark:text-rose-400";
  if (score >= 15) return "text-orange-600 dark:text-orange-400";
  if (score >= 6) return "text-amber-600 dark:text-amber-400";
  return "text-zinc-500 dark:text-zinc-400";
}

export function summaryIntent(summary: { intent?: string } | null): string | null {
  return summary?.intent?.trim() || null;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

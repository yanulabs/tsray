import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "./icons";

export function Badge({
  children,
  className = "",
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}): React.ReactElement {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${className}`}
    >
      {children}
    </span>
  );
}

export function IconButton({
  label,
  onClick,
  active = false,
  disabled = false,
  children,
  className = "",
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? "border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
          : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function Button({
  children,
  className = "",
  variant = "ghost",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: "ghost" | "solid" | "outline";
}): React.ReactElement {
  const styles =
    variant === "solid"
      ? "bg-indigo-600 text-white hover:bg-indigo-500 border-transparent"
      : variant === "outline"
        ? "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        : "border-transparent text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800";
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div
      className={`rounded-2xl border border-zinc-200/80 bg-white/90 shadow-sm shadow-zinc-950/[0.03] dark:border-zinc-800 dark:bg-zinc-950/70 ${className}`}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}): React.ReactElement {
  return (
    <div className="mb-2 flex items-end justify-between gap-3">
      <div>
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.08em] text-zinc-500 dark:text-zinc-400">
          {title}
        </h2>
        {hint ? <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-500">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function ProgressBar({
  value,
  className = "",
  tone = "indigo",
}: {
  value: number;
  className?: string;
  tone?: "indigo" | "emerald" | "amber" | "rose";
}): React.ReactElement {
  const color =
    tone === "emerald"
      ? "bg-emerald-500"
      : tone === "amber"
        ? "bg-amber-500"
        : tone === "rose"
          ? "bg-rose-500"
          : "bg-indigo-500";
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-zinc-200/80 dark:bg-zinc-800 ${className}`}>
      <div
        className={`h-full rounded-full ${color} transition-[width] duration-500`}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
}): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-300 px-6 py-14 text-center dark:border-zinc-700">
      {icon ? <div className="text-zinc-400 dark:text-zinc-500">{icon}</div> : null}
      <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{title}</p>
      {hint ? <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-500">{hint}</p> : null}
    </div>
  );
}

export function CopyButton({
  value,
  label = "Copy",
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={copied ? "Copied" : label}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 ${className}`}
    >
      {copied ? <CheckIcon width={12} height={12} /> : <CopyIcon width={12} height={12} />}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <kbd className="rounded border border-zinc-300 bg-zinc-50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
      {children}
    </kbd>
  );
}

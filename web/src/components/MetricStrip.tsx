import { metricCards } from "../lib/derive";
import type { Report } from "../types/report";

const toneClasses: Record<string, string> = {
  default: "text-zinc-900 dark:text-zinc-100",
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-rose-600 dark:text-rose-400",
};

export function MetricStrip({ report }: { report: Report }): React.ReactElement {
  const cards = metricCards(report);
  return (
    <section className="shrink-0 overflow-x-auto border-b border-zinc-200/70 bg-zinc-50/60 px-4 py-2 sm:px-6 dark:border-zinc-800/80 dark:bg-zinc-950/40">
      <div className="flex min-w-max gap-2">
        {cards.map((card) => (
          <div
            key={card.label}
            className="group min-w-[118px] rounded-xl border border-zinc-200/80 bg-white px-3 py-2 shadow-sm shadow-zinc-950/[0.02] transition-colors hover:border-indigo-200 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-indigo-900"
          >
            <p className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">
              {card.label}
            </p>
            <p className={`mt-0.5 text-lg font-semibold tabular-nums leading-6 ${toneClasses[card.tone]}`}>
              {card.value}
            </p>
            <p className="truncate text-[10px] text-zinc-400 dark:text-zinc-500" title={card.hint}>
              {card.hint}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

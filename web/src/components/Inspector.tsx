import { useMemo, useState } from "react";
import type { Report, Summary } from "../types/report";
import type { Selection } from "../types/ui";
import type { ReportIndex } from "../lib/derive";
import { edgeTone, indexReport, moduleHealth, relatedSymbols, topModuleSymbols } from "../lib/derive";
import {
  formatNumber,
  formatPercent,
  kindClasses,
  kindLabel,
  syncClasses,
  syncLabel,
  truncatePath,
} from "../lib/format";
import type { SymbolDetail } from "../lib/data";
import { Badge, CopyButton, Kbd, ProgressBar } from "./ui";
import {
  AlertIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BracesIcon,
  ChevronDownIcon,
  XIcon,
  ZapIcon,
} from "./icons";

export function Inspector({
  report,
  selection,
  onSelect,
  onClose,
  live,
  detail,
  detailLoading,
}: {
  report: Report;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
  live: boolean;
  detail: SymbolDetail | null;
  detailLoading: boolean;
}): React.ReactElement | null {
  const index = useMemo(() => indexReport(report), [report]);
  if (!selection) return null;

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-l border-zinc-200/80 bg-white/80 backdrop-blur-xl md:w-[390px] dark:border-zinc-800 dark:bg-zinc-950/85">
      <div className="flex shrink-0 items-center justify-between border-b border-zinc-100 px-3.5 py-2.5 dark:border-zinc-800">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">Inspector</p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          aria-label="Close inspector"
        >
          <XIcon width={14} height={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {selection.type === "module" ? (
          <ModuleInspector
            report={report}
            index={index}
            moduleId={selection.id}
            onSelect={onSelect}
          />
        ) : (
          <SymbolInspector
            index={index}
            symbolId={selection.id}
            onSelect={onSelect}
            live={live}
            detail={detail}
            detailLoading={detailLoading}
          />
        )}
      </div>
    </aside>
  );
}

function ModuleInspector({
  report,
  index,
  moduleId,
  onSelect,
}: {
  report: Report;
  index: ReportIndex;
  moduleId: string;
  onSelect: (selection: Selection) => void;
}): React.ReactElement {
  const module = index.moduleByName.get(moduleId);
  if (!module) {
    return <div className="p-4 text-xs text-zinc-500">Module `{moduleId}` is no longer indexed.</div>;
  }
  const health = moduleHealth(module);
  const hotspots = report.hotspots.filter((hotspot) => hotspot.module === module.id).slice(0, 8);
  const symbols = topModuleSymbols(index, module.id, 14);
  const cycles = report.module_cycles.filter((cycle) => cycle.includes(module.id));

  return (
    <div className="space-y-4 p-3.5">
      <Header
        eyebrow="module"
        title={module.name}
        badges={
          <>
            <Badge className={healthTone(health.tone)}>{health.label}</Badge>
            <Badge className={syncClasses(module.sync_state)}>{syncLabel(module.sync_state)}</Badge>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Symbols" value={formatNumber(module.symbols)} />
        <Stat label="Prod LOC" value={formatNumber(module.prod_loc)} />
        <Stat label="Components" value={String(module.components)} />
        <Stat label="Hooks" value={String(module.hooks)} />
        <Stat label="Fan-in" value={`${module.fan_in} modules`} />
        <Stat label="Fan-out" value={`${module.fan_out} modules`} />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] text-zinc-400 dark:text-zinc-500">
          <span>summary coverage</span>
          <span className="font-mono">{formatPercent(module.synced_percent)}</span>
        </div>
        <ProgressBar
          value={module.synced_percent}
          tone={module.synced_percent >= 80 ? "emerald" : module.synced_percent > 0 ? "amber" : "indigo"}
        />
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <MetricLine label="Files" value={String(module.files)} />
        <MetricLine label="Entrypoints" value={String(module.entrypoints)} />
        <MetricLine label="Test reachable" value={String(module.test_reachable)} />
        <MetricLine label="Generated files" value={String(module.generated_files)} />
      </div>

      {cycles.length > 0 ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-2.5 text-[11px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertIcon width={12} height={12} /> Part of {cycles.length} cycle{cycles.length === 1 ? "" : "s"}
          </p>
          {cycles.map((cycle) => (
            <p key={cycle.join(",")} className="mt-1 font-mono text-[10px] opacity-80">
              {cycle.join(" → ")} → {cycle[0]}
            </p>
          ))}
        </div>
      ) : null}

      {module.in_modules.length + module.out_modules.length > 0 ? (
        <Section title="Module edges">
          <div className="space-y-2">
            {module.in_modules.length > 0 ? (
              <div>
                <p className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.07em] text-zinc-400">
                  <ArrowLeftIcon width={10} height={10} /> incoming
                </p>
                <div className="flex flex-wrap gap-1">
                  {module.in_modules.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => onSelect({ type: "module", id: name })}
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 transition-colors hover:border-indigo-300 hover:text-indigo-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-indigo-800 dark:hover:text-indigo-300"
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {module.out_modules.length > 0 ? (
              <div>
                <p className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.07em] text-zinc-400">
                  <ArrowRightIcon width={10} height={10} /> outgoing
                </p>
                <div className="flex flex-wrap gap-1">
                  {module.out_modules.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => onSelect({ type: "module", id: name })}
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 transition-colors hover:border-indigo-300 hover:text-indigo-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:border-indigo-800 dark:hover:text-indigo-300"
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      {hotspots.length > 0 ? (
        <Section title="Hotspots">
          <div className="space-y-1">
            {hotspots.map((hotspot) => (
              <button
                key={hotspot.id}
                type="button"
                onClick={() => onSelect({ type: "symbol", id: hotspot.id })}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-1.5 py-1 text-left text-[11px] transition-colors hover:border-zinc-200 hover:bg-zinc-50 dark:hover:border-zinc-800 dark:hover:bg-zinc-900"
              >
                <span className="truncate font-medium text-zinc-700 dark:text-zinc-200">{hotspot.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-zinc-400">
                  c{hotspot.complexity} · f{hotspot.fanIn}
                </span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title="Top symbols">
        <div className="space-y-0.5">
          {symbols.map((symbol) => (
            <button
              key={symbol.id}
              type="button"
              onClick={() => onSelect({ type: "symbol", id: symbol.id })}
              className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${kindDot(symbol.kind)}`} />
              <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-700 dark:text-zinc-200">{symbol.name}</span>
              {symbol.dead ? <Badge className="border-rose-200 text-rose-500 dark:border-rose-900 dark:text-rose-300">dead</Badge> : null}
              <span className="shrink-0 font-mono text-[9.5px] text-zinc-400">{symbol.fan_in} in</span>
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

function SymbolInspector({
  index,
  symbolId,
  onSelect,
  live,
  detail,
  detailLoading,
}: {
  index: ReportIndex;
  symbolId: string;
  onSelect: (selection: Selection) => void;
  live: boolean;
  detail: SymbolDetail | null;
  detailLoading: boolean;
}): React.ReactElement {
  const symbol = index.symbolById.get(symbolId);
  const [showSource, setShowSource] = useState(true);
  if (!symbol) {
    return <div className="p-4 text-xs text-zinc-500">Symbol `{symbolId}` is no longer indexed.</div>;
  }

  const incoming = index.edgesByTo.get(symbol.id) ?? [];
  const outgoing = index.edgesByFrom.get(symbol.id) ?? [];
  const related = relatedSymbols(index, symbol.id, "both");
  const hashes = detail?.symbol.hashes;
  const sourceLines = detail?.source.split(/\r?\n/) ?? [];

  return (
    <div className="space-y-4 p-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className={kindClasses(symbol.kind)}>{kindLabel(symbol.kind)}</Badge>
        <Badge className={syncClasses(symbol.sync_state)}>{syncLabel(symbol.sync_state)}</Badge>
        {symbol.exported ? (
          <Badge className="border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300">
            exported
          </Badge>
        ) : null}
        {symbol.default_export ? (
          <Badge className="border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-300">
            default
          </Badge>
        ) : null}
        {symbol.entrypoint ? (
          <Badge className="border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-300">
            entrypoint
          </Badge>
        ) : null}
        {symbol.dead ? (
          <Badge className="border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300">
            dead
          </Badge>
        ) : null}
        {symbol.is_test ? (
          <Badge className="border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            test
          </Badge>
        ) : null}
        {symbol.is_generated ? (
          <Badge className="border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
            generated
          </Badge>
        ) : null}
      </div>

      <div>
        <h2 className="break-words text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{symbol.name}</h2>
        <button
          type="button"
          onClick={() => onSelect({ type: "module", id: symbol.module })}
          className="mt-0.5 font-mono text-[10px] text-indigo-500 transition-colors hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
        >
          {symbol.module}
        </button>
      </div>

      <FileRow file={symbol.file} line={symbol.line} endLine={symbol.end_line} />

      {symbol.directive ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 font-mono text-[10px] text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          &quot;{symbol.directive}&quot;
        </p>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        <Stat label="LOC" value={String(symbol.loc)} />
        <Stat label="Complexity" value={String(symbol.complexity)} />
        <Stat label="Fan-in" value={String(symbol.fan_in)} />
        <Stat label="Fan-out" value={String(symbol.fan_out)} />
        <Stat label="Members" value={String(symbol.members)} />
        <Stat label="Edges" value={String(incoming.length + outgoing.length)} />
      </div>

      {symbol.props_type ? (
        <Section title="Props">
          <code className="block overflow-x-auto rounded-lg bg-zinc-50 px-2 py-1.5 font-mono text-[10.5px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
            {symbol.props_type}
          </code>
        </Section>
      ) : null}

      {symbol.signature ? (
        <Section title="Signature">
          <code className="block overflow-x-auto rounded-lg bg-zinc-50 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
            {symbol.signature}
          </code>
        </Section>
      ) : null}

      {symbol.doc ? (
        <Section title="Documentation">
          <p className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-300">{symbol.doc}</p>
        </Section>
      ) : null}

      <SummaryBlock summary={symbol.summary} />

      {related.length > 0 ? (
        <Section title="Relationships">
          <div className="space-y-0.5">
            {related.slice(0, 24).map((other) => {
              const edge = [...incoming, ...outgoing].find(
                (candidate) => candidate.from === other.id || candidate.to === other.id
              );
              return (
                <button
                  key={other.id}
                  type="button"
                  onClick={() => onSelect({ type: "symbol", id: other.id })}
                  className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${kindDot(other.kind)}`} />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-700 dark:text-zinc-200">{other.name}</span>
                  {edge ? (
                    <span
                      className="shrink-0 rounded px-1 font-mono text-[9px]"
                      style={{ color: edgeTone(edge.kind), backgroundColor: `${edgeTone(edge.kind)}14` }}
                    >
                      {edge.kind}
                    </span>
                  ) : null}
                  <span className="shrink-0 font-mono text-[9px] text-zinc-400">
                    {incoming.some((candidate) => candidate.from === other.id) ? "in" : "out"}
                  </span>
                </button>
              );
            })}
            {related.length > 24 ? (
              <p className="px-1.5 pt-1 text-[10px] text-zinc-400">+{related.length - 24} more relationships</p>
            ) : null}
          </div>
        </Section>
      ) : null}

      {live ? (
        <Section
          title="Impact & source"
          action={
            <Badge className="border-indigo-200 bg-indigo-50 text-indigo-600 dark:border-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-300">
              live API
            </Badge>
          }
        >
          {detailLoading ? (
            <div className="animate-pulse space-y-1.5">
              <div className="h-3 w-2/3 rounded bg-zinc-100 dark:bg-zinc-800" />
              <div className="h-3 w-1/2 rounded bg-zinc-100 dark:bg-zinc-800" />
              <div className="h-20 rounded-lg bg-zinc-100 dark:bg-zinc-800" />
            </div>
          ) : detail ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
                <Badge
                  className={
                    detail.impact.risk === "critical"
                      ? "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300"
                      : detail.impact.risk === "high"
                        ? "border-orange-200 bg-orange-50 text-orange-600 dark:border-orange-900 dark:bg-orange-950/60 dark:text-orange-300"
                        : detail.impact.risk === "medium"
                          ? "border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
                          : "border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300"
                  }
                >
                  {detail.impact.risk} blast radius
                </Badge>
                <span className="text-zinc-500 dark:text-zinc-400">{detail.impact.transitiveCount} transitive</span>
                <span className="text-zinc-500 dark:text-zinc-400">
                  {detail.impact.impactedTestFiles.length} test file{detail.impact.impactedTestFiles.length === 1 ? "" : "s"}
                </span>
              </div>
              {detail.impact.suggestedCommands.length > 0 ? (
                <div className="space-y-1">
                  {detail.impact.suggestedCommands.map((command) => (
                    <div
                      key={command}
                      className="flex items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-[10px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
                    >
                      <span className="truncate">{command}</span>
                      <CopyButton value={command} label="" className="shrink-0" />
                    </div>
                  ))}
                </div>
              ) : null}

              <button
                type="button"
                onClick={() => setShowSource(!showSource)}
                className="flex w-full items-center justify-between rounded-lg border border-zinc-200 px-2 py-1 text-[10.5px] text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"
              >
                <span className="flex items-center gap-1.5">
                  <BracesIcon width={12} height={12} /> Source
                </span>
                <ChevronDownIcon
                  width={12}
                  height={12}
                  className={`transition-transform ${showSource ? "rotate-180" : ""}`}
                />
              </button>
              {showSource ? (
                <div className="relative max-h-72 overflow-auto rounded-lg border border-zinc-200 bg-zinc-950 dark:border-zinc-800">
                  <table className="w-full border-collapse font-mono text-[10px] leading-[1.45]">
                    <tbody>
                      {sourceLines.slice(0, 300).map((line, index) => (
                        <tr key={index}>
                          <td className="w-9 select-none border-r border-zinc-800/60 px-1.5 text-right align-top text-zinc-600">
                            {symbol.line + index}
                          </td>
                          <td className="whitespace-pre-wrap break-words px-2 text-zinc-300">{line || " "}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-[10.5px] text-zinc-400">Source detail unavailable. Is the live report server still running?</p>
          )}
        </Section>
      ) : (
        <Section title="Source">
          <p className="rounded-lg border border-dashed border-zinc-300 px-2 py-3 text-[10.5px] text-zinc-400 dark:border-zinc-700 dark:text-zinc-500">
            Static report: run <code className="font-mono">tsray serve</code> for source, references, and blast radius.
          </p>
        </Section>
      )}

      <Section title="Content hash">
        <div className="flex items-center gap-1">
          <code className="min-w-0 flex-1 truncate rounded bg-zinc-50 px-1.5 py-1 font-mono text-[9.5px] text-zinc-400 dark:bg-zinc-900 dark:text-zinc-500">
            {hashes?.content ?? symbol.content_hash}
          </code>
          <CopyButton value={hashes?.content ?? symbol.content_hash} label="" />
        </div>
        <div className="mt-1 flex items-center gap-1">
          <code className="min-w-0 flex-1 truncate rounded bg-zinc-50 px-1.5 py-1 font-mono text-[9px] text-zinc-400 dark:bg-zinc-900 dark:text-zinc-500">
            self {hashes?.self ?? symbol.self_hash}
          </code>
          <CopyButton value={hashes?.self ?? symbol.self_hash} label="" />
        </div>
        <p className="mt-1 flex items-center gap-1 text-[9.5px] text-zinc-400 dark:text-zinc-500">
          <Kbd>content</Kbd> changes with self or dependencies · <Kbd>self</Kbd> changes with the symbol body
        </p>
      </Section>
    </div>
  );
}

function Header({
  eyebrow,
  title,
  badges,
}: {
  eyebrow: string;
  title: string;
  badges: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <p className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">{eyebrow}</p>
      <h2 className="break-words text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h2>
      <div className="mt-1 flex flex-wrap gap-1">{badges}</div>
    </div>
  );
}

function FileRow({ file, line, endLine }: { file: string; line: number; endLine: number }): React.ReactElement {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
      <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-zinc-500 dark:text-zinc-400" title={`${file}:${line}-${endLine}`}>
        {truncatePath(file, 46)}:{line}
      </span>
      <CopyButton value={`${file}:${line}`} label="" />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="rounded-xl border border-zinc-200/80 bg-zinc-50/70 px-2 py-1.5 dark:border-zinc-800 dark:bg-zinc-900/50">
      <p className="text-[9px] uppercase tracking-[0.06em] text-zinc-400 dark:text-zinc-500">{label}</p>
      <p className="font-mono text-[12px] font-medium text-zinc-700 dark:text-zinc-200">{value}</p>
    </div>
  );
}

function MetricLine({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-400 dark:text-zinc-500">{label}</span>
      <span className="font-mono text-zinc-600 dark:text-zinc-300">{value}</span>
    </div>
  );
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-400 dark:text-zinc-500">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function SummaryBlock({ summary }: { summary: Summary | null }): React.ReactElement {
  if (!summary) {
    return (
      <Section title="Summary">
        <p className="rounded-lg border border-dashed border-zinc-300 px-2 py-2.5 text-[10.5px] text-zinc-400 dark:border-zinc-700 dark:text-zinc-500">
          No cached summary yet. Run <code className="font-mono">list_stale_summaries</code> and <code className="font-mono">get_summary_context</code> through MCP.
        </p>
      </Section>
    );
  }
  return (
    <Section
      title="Summary"
      action={
        <span className="flex items-center gap-1 text-[9px] text-zinc-400 dark:text-zinc-500">
          <ZapIcon width={10} height={10} /> cached
        </span>
      }
    >
      <div className="space-y-2 rounded-xl border border-zinc-200/80 bg-zinc-50/60 p-2.5 dark:border-zinc-800 dark:bg-zinc-900/40">
        {summary.intent ? (
          <p className="text-[11.5px] leading-relaxed text-zinc-700 dark:text-zinc-200">{summary.intent}</p>
        ) : null}
        {summary.side_effects && summary.side_effects.length > 0 ? (
          <div>
            <p className="mb-1 text-[9px] uppercase tracking-[0.06em] text-zinc-400 dark:text-zinc-500">side effects</p>
            <div className="flex flex-wrap gap-1">
              {summary.side_effects.map((effect) => (
                <Badge
                  key={effect}
                  className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300"
                >
                  {effect}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
        <SummaryList label="invariants" values={summary.invariants} />
        <SummaryList label="key invariants" values={summary.key_invariants} />
        <SummaryList label="boundaries" values={summary.boundaries} />
        {summary.concurrency ? (
          <p className="text-[10.5px] text-zinc-500 dark:text-zinc-400">
            <span className="uppercase tracking-[0.06em] text-zinc-400">concurrency:</span> {summary.concurrency}
          </p>
        ) : null}
      </div>
    </Section>
  );
}

function SummaryList({ label, values }: { label: string; values?: string[] }): React.ReactElement | null {
  if (!values || values.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-[9px] uppercase tracking-[0.06em] text-zinc-400 dark:text-zinc-500">{label}</p>
      <ul className="space-y-0.5">
        {values.map((value) => (
          <li key={value} className="flex gap-1.5 text-[10.5px] leading-relaxed text-zinc-600 dark:text-zinc-300">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-600" />
            {value}
          </li>
        ))}
      </ul>
    </div>
  );
}

function kindDot(kind: string): string {
  switch (kind) {
    case "component":
      return "bg-sky-500";
    case "hook":
      return "bg-amber-500";
    case "context":
      return "bg-violet-500";
    case "function":
      return "bg-emerald-500";
    case "interface":
    case "type":
      return "bg-rose-500";
    case "class":
      return "bg-orange-500";
    default:
      return "bg-zinc-400";
  }
}

function healthTone(tone: "good" | "warn" | "danger"): string {
  return tone === "danger"
    ? "border-rose-200 bg-rose-50 text-rose-600 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300"
    : tone === "warn"
      ? "border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300"
      : "border-emerald-200 bg-emerald-50 text-emerald-600 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300";
}

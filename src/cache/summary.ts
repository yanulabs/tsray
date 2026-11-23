import { z } from "zod";
import type { SymbolKind } from "../index/types.js";

export const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set([
  "component",
  "hook",
  "function",
  "method",
]);

export const SIDE_EFFECTS = [
  "none",
  "db_read",
  "db_write",
  "network_io",
  "fs_io",
  "exec",
  "env_read",
  "mutates_props",
  "mutates_module_state",
  "dom_mutation",
  "storage_io",
  "timer",
  "subscription",
  "throws",
  "renders_children",
  "uses_context",
] as const;

const intent = z.string().trim().min(1).max(400);
const invariant = z.string().trim().min(1).max(400);

const callableSummarySchema = z
  .object({
    intent,
    side_effects: z
      .array(z.enum(SIDE_EFFECTS))
      .min(1)
      .refine(
        (effects) => !effects.includes("none") || effects.length === 1,
        { message: "side_effects: 'none' must be the sole element" }
      ),
    invariants: z.array(invariant),
    concurrency: z.string().max(800).optional(),
  })
  .strict();

const architectureSummarySchema = z
  .object({
    intent,
    key_invariants: z.array(invariant),
    boundaries: z.array(invariant),
  })
  .strict();

export const SUMMARY_SCHEMA = {
  callable: {
    intent: "string (1-400 chars, required)",
    side_effects: `array of: ${SIDE_EFFECTS.join(" | ")} (required, non-empty)`,
    invariants: "array of strings (required, may be empty)",
    concurrency: "string (optional, max 800 chars)",
  },
  type: {
    intent: "string (1-400 chars, required)",
    key_invariants: "array of strings (required, may be empty)",
    boundaries: "array of strings (required, may be empty)",
  },
} as const;

export function isCallableKind(kind: SymbolKind): boolean {
  return CALLABLE_KINDS.has(kind);
}

export function validateSummary(
  kind: SymbolKind,
  summary: unknown
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const schema = isCallableKind(kind) ? callableSummarySchema : architectureSummarySchema;
  const parsed = schema.safeParse(summary);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) return { ok: false, error: "invalid summary" };
    const location = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `${location}${issue.message}` };
  }
  return { ok: true, value: parsed.data as Record<string, unknown> };
}

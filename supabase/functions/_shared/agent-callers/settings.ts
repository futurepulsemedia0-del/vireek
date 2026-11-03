// supabase/functions/_shared/agent-callers/settings.ts
// Pure: normalizes the per-business "AI agent callers" settings row. Anything missing/invalid falls back to the
// SAFE default (feature off, hold-for-approval, tight limits). Mirrored by src/lib/agentCallers.ts (UI).

export type ApprovalMode = "quote_only" | "hold_for_approval" | "auto_book";
export type FlatPriceMode = "exact" | "starting_at" | "range";

export interface AgentCallerSettings {
  /** Master switch. Off => AI callers are treated exactly like human callers. */
  enabled: boolean;
  approvalMode: ApprovalMode;
  maxHoldsPerDay: number;
  holdMinutes: number;
  /** How a FLAT price-book row is spoken to an agent. "range" widens by flatRangePercent (owner-set, never model-set). */
  flatPriceMode: FlatPriceMode;
  flatRangePercent: number;
  blockedZips: string[];
  /** Case-insensitive phrases the agent protocol will not discuss (routes to a human instead). */
  neverDiscuss: string[];
  allowSmsSummary: boolean;
  allowEmailSummary: boolean;
  maxQuotesPerCallerPerDay: number;
  maxDistinctServicesPerCallerPerDay: number;
  maxQuotesPerHourTenant: number;
  maxSummariesPerDay: number;
  /** Agent-protocol events (hashed caller key, channel destinations) are purged after this many days. */
  retentionDays: number;
}

export const DEFAULT_AGENT_CALLER_SETTINGS: AgentCallerSettings = {
  enabled: false,
  approvalMode: "hold_for_approval",
  maxHoldsPerDay: 5,
  holdMinutes: 60,
  flatPriceMode: "exact",
  flatRangePercent: 15,
  blockedZips: [],
  neverDiscuss: [],
  allowSmsSummary: true,
  allowEmailSummary: true,
  maxQuotesPerCallerPerDay: 6,
  maxDistinctServicesPerCallerPerDay: 5,
  maxQuotesPerHourTenant: 60,
  maxSummariesPerDay: 30,
  retentionDays: 90,
};

export const LIMITS = {
  maxHoldsPerDay: { min: 0, max: 50 },
  holdMinutes: { min: 15, max: 1440 },
  flatRangePercent: { min: 1, max: 50 },
  maxQuotesPerCallerPerDay: { min: 1, max: 50 },
  maxDistinctServicesPerCallerPerDay: { min: 1, max: 30 },
  maxQuotesPerHourTenant: { min: 5, max: 500 },
  maxSummariesPerDay: { min: 0, max: 200 },
  retentionDays: { min: 7, max: 365 },
  listItems: 50,
  phraseLength: 60,
} as const;

const int = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};
const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d);

export function normalizeZip(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{5})(?:-\d{4})?$/);
  return m ? m[1] : null;
}

function strList(v: unknown, map: (s: string) => string | null): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string") continue;
    const m = map(x);
    if (m) out.add(m);
    if (out.size >= LIMITS.listItems) break;
  }
  return [...out];
}

export function normalizeAgentCallerSettings(row: Record<string, unknown> | null | undefined): AgentCallerSettings {
  const d = DEFAULT_AGENT_CALLER_SETTINGS;
  const r = row ?? {};
  return {
    enabled: bool(r.enabled, d.enabled),
    approvalMode: oneOf(r.approval_mode, ["quote_only", "hold_for_approval", "auto_book"] as const, d.approvalMode),
    maxHoldsPerDay: int(r.max_holds_per_day, LIMITS.maxHoldsPerDay.min, LIMITS.maxHoldsPerDay.max, d.maxHoldsPerDay),
    holdMinutes: int(r.hold_minutes, LIMITS.holdMinutes.min, LIMITS.holdMinutes.max, d.holdMinutes),
    flatPriceMode: oneOf(r.flat_price_mode, ["exact", "starting_at", "range"] as const, d.flatPriceMode),
    flatRangePercent: int(r.flat_range_percent, LIMITS.flatRangePercent.min, LIMITS.flatRangePercent.max, d.flatRangePercent),
    blockedZips: strList(r.blocked_zips, normalizeZip),
    neverDiscuss: strList(r.never_discuss, (s) => {
      const t = s.trim().toLowerCase().slice(0, LIMITS.phraseLength);
      return t.length >= 2 ? t : null;
    }),
    allowSmsSummary: bool(r.allow_sms_summary, d.allowSmsSummary),
    allowEmailSummary: bool(r.allow_email_summary, d.allowEmailSummary),
    maxQuotesPerCallerPerDay: int(r.max_quotes_per_caller_per_day, LIMITS.maxQuotesPerCallerPerDay.min, LIMITS.maxQuotesPerCallerPerDay.max, d.maxQuotesPerCallerPerDay),
    maxDistinctServicesPerCallerPerDay: int(r.max_distinct_services_per_caller_per_day, LIMITS.maxDistinctServicesPerCallerPerDay.min, LIMITS.maxDistinctServicesPerCallerPerDay.max, d.maxDistinctServicesPerCallerPerDay),
    maxQuotesPerHourTenant: int(r.max_quotes_per_hour_tenant, LIMITS.maxQuotesPerHourTenant.min, LIMITS.maxQuotesPerHourTenant.max, d.maxQuotesPerHourTenant),
    maxSummariesPerDay: int(r.max_summaries_per_day, LIMITS.maxSummariesPerDay.min, LIMITS.maxSummariesPerDay.max, d.maxSummariesPerDay),
    retentionDays: int(r.retention_days, LIMITS.retentionDays.min, LIMITS.retentionDays.max, d.retentionDays),
  };
}

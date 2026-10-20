// supabase/functions/_shared/findings/engine.ts
//
// Pure, deterministic rules for Findings Packages (inspection + quote photo
// packages). No I/O, no clock reads (callers pass `now`). Shared by the
// findings-package-public edge function AND the dashboard / customer pages,
// and unit-tested in src/lib/findingsPackage.test.ts.
//
// Money is integer cents. Totals MUST match
//   - estimates.ts  optionTotals()
//   - SQL           quote_option_total_cents()
// (the test file pins the parity with optionTotals).

export type FindingSeverity = "urgent" | "recommended" | "monitor";
export type FindingDecision = "pending" | "approved" | "declined";
export type PackageStatus = "draft" | "sent" | "approved" | "partially_approved" | "declined";
export type ShareState = "draft" | "active" | "expired" | "disabled" | "answered";

export interface LineItemLike {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface OptionLike {
  id: string;
  tier: "good" | "better" | "best";
  name: string;
  line_items: LineItemLike[];
  recommended?: boolean;
}

export interface ItemLike {
  id: string;
  severity: FindingSeverity;
  options: OptionLike[];
  recommended_option_id: string | null;
  decision?: FindingDecision;
}

export interface PackageLike {
  status: PackageStatus;
  share_enabled: boolean;
  share_expires_at: string | null;
  tax_percent: number;
}

export interface DecisionInput {
  item_id: string;
  option_id: string | null;
}

export const MAX_FINDINGS = 30;
export const MAX_APPROVER_NAME = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export const SEVERITY_ORDER: Record<FindingSeverity, number> = { urgent: 0, recommended: 1, monitor: 2 };

export const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  urgent: "Urgent",
  recommended: "Recommended",
  monitor: "Keep an eye on it",
};

export function optionSubtotalCents(option: Pick<OptionLike, "line_items">): number {
  return (option.line_items ?? []).reduce(
    (sum, li) => sum + Math.max(0, Number(li.quantity) || 0) * Math.max(0, Number(li.unit_price_cents) || 0),
    0,
  );
}

export function optionTotalCents(option: Pick<OptionLike, "line_items">, taxPercent: number): number {
  const subtotal = optionSubtotalCents(option);
  return subtotal + Math.round((subtotal * (Number(taxPercent) || 0)) / 100);
}

/** A finding the customer can approve (monitor-only findings are informational). */
export function isDecisionable(item: Pick<ItemLike, "severity">): boolean {
  return item.severity !== "monitor";
}

/** Option pre-selected for the customer: the recommended one, else the middle/first option. */
export function defaultOptionId(item: Pick<ItemLike, "options" | "recommended_option_id">): string | null {
  if (!item.options.length) return null;
  const rec = item.options.find((o) => o.id === item.recommended_option_id) ?? item.options.find((o) => o.recommended);
  if (rec) return rec.id;
  return item.options[Math.min(1, item.options.length - 1)].id;
}

export function shareState(pkg: PackageLike, now: Date): ShareState {
  if (pkg.status === "draft") return "draft";
  if (!pkg.share_enabled) return "disabled";
  if (pkg.status !== "sent") return "answered";
  if (pkg.share_expires_at && new Date(pkg.share_expires_at).getTime() <= now.getTime()) return "expired";
  return "active";
}

/** Items in customer reading order: urgent first, then recommended, then monitor; stable inside a group. */
export function sortFindings<T extends { severity: FindingSeverity; sort_order?: number }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.item.severity] - SEVERITY_ORDER[b.item.severity] ||
        (a.item.sort_order ?? a.index) - (b.item.sort_order ?? b.index) ||
        a.index - b.index,
    )
    .map((x) => x.item);
}

/** Draft-time validation. Same rules as send_findings_package() in SQL. Empty array = ready to send. */
export function validateForSend(items: ItemLike[], taxPercent: number): string[] {
  const errors: string[] = [];
  if (items.length === 0) return ["Add at least one finding."];
  if (items.length > MAX_FINDINGS) errors.push(`A package holds at most ${MAX_FINDINGS} findings.`);

  let decisionable = 0;
  items.forEach((item, i) => {
    if (!isDecisionable(item)) return;
    decisionable += 1;
    const label = `Finding ${i + 1}`;
    if (item.options.length === 0) {
      errors.push(`${label} needs at least one priced option.`);
      return;
    }
    const seen = new Set<string>();
    for (const option of item.options) {
      if (seen.has(option.tier)) errors.push(`${label} has two "${option.tier}" options.`);
      seen.add(option.tier);
      if (optionTotalCents(option, taxPercent) <= 0) errors.push(`${label}: "${option.name || option.tier}" totals $0.`);
    }
  });
  if (decisionable === 0) errors.push("At least one finding must be approvable (not “keep an eye on it”).");
  return errors;
}

/** Sum of the options currently selected, ignoring declined findings. */
export function selectionTotals(
  items: ItemLike[],
  selection: Record<string, string | null>,
  taxPercent: number,
): { count: number; subtotalCents: number; taxCents: number; totalCents: number } {
  let subtotal = 0;
  let total = 0;
  let count = 0;
  for (const item of items) {
    if (!isDecisionable(item)) continue;
    const optionId = selection[item.id];
    const option = optionId ? item.options.find((o) => o.id === optionId) : undefined;
    if (!option) continue;
    subtotal += optionSubtotalCents(option);
    total += optionTotalCents(option, taxPercent);
    count += 1;
  }
  return { count, subtotalCents: subtotal, taxCents: total - subtotal, totalCents: total };
}

export type ParseResult =
  | { ok: true; decisions: DecisionInput[]; approverName: string | null }
  | { ok: false; error: string };

/** Defensive parse of the customer's response body (edge function + tests). */
export function parseResponseBody(body: unknown): ParseResult {
  if (!body || typeof body !== "object") return { ok: false, error: "INVALID_BODY" };
  const { decisions, approver_name: approverName } = body as { decisions?: unknown; approver_name?: unknown };
  if (!Array.isArray(decisions) || decisions.length === 0 || decisions.length > MAX_FINDINGS) {
    return { ok: false, error: "INVALID_DECISIONS" };
  }
  const out: DecisionInput[] = [];
  const seen = new Set<string>();
  for (const d of decisions) {
    if (!d || typeof d !== "object") return { ok: false, error: "INVALID_DECISIONS" };
    const { item_id: itemId, option_id: optionId } = d as { item_id?: unknown; option_id?: unknown };
    if (!isUuid(itemId) || seen.has(itemId)) return { ok: false, error: "INVALID_DECISIONS" };
    if (optionId !== null && (typeof optionId !== "string" || optionId.length === 0 || optionId.length > 80)) {
      return { ok: false, error: "INVALID_DECISIONS" };
    }
    seen.add(itemId);
    out.push({ item_id: itemId, option_id: optionId as string | null });
  }
  let name: string | null = null;
  if (approverName != null) {
    if (typeof approverName !== "string") return { ok: false, error: "INVALID_NAME" };
    const trimmed = approverName.trim().slice(0, MAX_APPROVER_NAME);
    name = trimmed.length ? trimmed : null;
  }
  return { ok: true, decisions: out, approverName: name };
}

export function packageStatusFromCounts(approved: number, declined: number): PackageStatus {
  if (approved === 0) return "declined";
  return declined === 0 ? "approved" : "partially_approved";
}

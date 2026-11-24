// Vendor review reminders: turns the rows claimed by vendor_review_claim_notifications() into one staff e-mail.
// Pure (no I/O). Every number and name comes from the register; nothing is estimated or invented.
// Used by supabase/functions/vendor-review-reminders.

export type ReminderKind = "initial_review" | "due_soon" | "overdue";
export type Criticality = "critical" | "high" | "medium" | "low";

export interface ClaimedReminder {
  reminder_id: string;
  vendor_key: string;
  vendor_name: string;
  criticality: Criticality;
  kind: ReminderKind;
  due_on: string | null;
  last_reviewed_on: string | null;
  is_subprocessor: boolean;
  renotified: boolean;
}

export interface VendorDigest {
  subject: string;
  html: string;
  text: string;
  counts: Record<ReminderKind, number>;
  listed: number;
  total: number;
}

const KINDS: readonly ReminderKind[] = ["initial_review", "due_soon", "overdue"];
const CRITICALITIES: readonly Criticality[] = ["critical", "high", "medium", "low"];
const KIND_RANK: Record<ReminderKind, number> = { overdue: 0, due_soon: 1, initial_review: 2 };
const CRIT_RANK: Record<Criticality, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const KIND_LABEL: Record<ReminderKind, string> = {
  overdue: "Overdue",
  due_soon: "Due soon",
  initial_review: "Never reviewed",
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_MAX_LINES = 40;

const isStr = (v: unknown): v is string => typeof v === "string";
const dateOrNull = (v: unknown): string | null => (isStr(v) && ISO_DATE.test(v) ? v : null);

/** Defensive parse of the RPC result: malformed rows are dropped, never trusted. */
export function parseClaimed(raw: unknown): ClaimedReminder[] {
  if (!Array.isArray(raw)) return [];
  const out: ClaimedReminder[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (!isStr(o.reminder_id) || !isStr(o.vendor_key) || !isStr(o.vendor_name)) continue;
    if (!KINDS.includes(o.kind as ReminderKind)) continue;
    if (!CRITICALITIES.includes(o.criticality as Criticality)) continue;
    out.push({
      reminder_id: o.reminder_id,
      vendor_key: o.vendor_key,
      vendor_name: o.vendor_name,
      criticality: o.criticality as Criticality,
      kind: o.kind as ReminderKind,
      due_on: dateOrNull(o.due_on),
      last_reviewed_on: dateOrNull(o.last_reviewed_on),
      is_subprocessor: o.is_subprocessor === true,
      renotified: o.renotified === true,
    });
  }
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function sortReminders(items: ClaimedReminder[]): ClaimedReminder[] {
  return [...items].sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      CRIT_RANK[a.criticality] - CRIT_RANK[b.criticality] ||
      (a.due_on ?? "").localeCompare(b.due_on ?? "") ||
      a.vendor_name.localeCompare(b.vendor_name),
  );
}

function line(r: ClaimedReminder): string {
  const when =
    r.kind === "initial_review"
      ? "no review recorded"
      : `due ${r.due_on ?? "unknown"}${r.last_reviewed_on ? `, last reviewed ${r.last_reviewed_on}` : ""}`;
  const flags = [r.criticality, r.is_subprocessor ? "published sub-processor" : null, r.renotified ? "repeat reminder" : null]
    .filter(Boolean)
    .join(", ");
  return `${r.vendor_name} (${r.vendor_key}) — ${when} [${flags}]`;
}

/** @returns null when there is nothing to send. */
export function buildDigest(items: ClaimedReminder[], opts: { maxLines?: number } = {}): VendorDigest | null {
  if (items.length === 0) return null;
  const max = Math.max(1, Math.floor(opts.maxLines ?? DEFAULT_MAX_LINES));
  const sorted = sortReminders(items);
  const counts: Record<ReminderKind, number> = { overdue: 0, due_soon: 0, initial_review: 0 };
  for (const r of sorted) counts[r.kind]++;

  const shown = sorted.slice(0, max);
  const hidden = sorted.length - shown.length;

  const parts = [
    counts.overdue ? `${counts.overdue} overdue` : null,
    counts.due_soon ? `${counts.due_soon} due soon` : null,
    counts.initial_review ? `${counts.initial_review} never reviewed` : null,
  ].filter(Boolean);
  const subject = `Vendor reviews: ${parts.join(", ")}`;

  const intro = "These vendors need a review recorded in the vendor review register (table public.vendor_reviews).";
  const how =
    "To record a review: set last_reviewed_on, last_review_outcome and at least one evidence link (https URL or docs/ path). The next due date and this reminder update automatically. Policy: docs/compliance/policies/vendor-management.md.";
  const footer = hidden > 0 ? `…and ${hidden} more. Query public.vendor_review_status_v for the full list.` : "";

  const textBlocks: string[] = [intro, ""];
  const htmlBlocks: string[] = [`<p>${escapeHtml(intro)}</p>`];
  for (const kind of ["overdue", "due_soon", "initial_review"] as const) {
    const group = shown.filter((r) => r.kind === kind);
    if (group.length === 0) continue;
    textBlocks.push(`${KIND_LABEL[kind]} (${counts[kind]})`, ...group.map((r) => `- ${line(r)}`), "");
    htmlBlocks.push(
      `<h3>${KIND_LABEL[kind]} (${counts[kind]})</h3><ul>${group.map((r) => `<li>${escapeHtml(line(r))}</li>`).join("")}</ul>`,
    );
  }
  if (footer) {
    textBlocks.push(footer, "");
    htmlBlocks.push(`<p>${escapeHtml(footer)}</p>`);
  }
  textBlocks.push(how);
  htmlBlocks.push(`<p>${escapeHtml(how)}</p>`);

  return { subject, html: htmlBlocks.join("\n"), text: textBlocks.join("\n"), counts, listed: shown.length, total: sorted.length };
}

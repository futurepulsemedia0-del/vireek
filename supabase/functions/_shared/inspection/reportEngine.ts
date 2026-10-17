// supabase/functions/_shared/inspection/reportEngine.ts
//
// Pure, deterministic helpers for Inspection Reports. No I/O and no clock
// reads (callers pass `now`), so it is unit-tested (src/lib/inspectionReports.test.ts)
// and shared by the inspection-reports / inspection-report-public edge
// functions AND the dashboard client (same convention as truth/engine.ts).
//
// Honesty rules: a report only ever contains what exists in the job's real
// records. Nothing is invented — an empty checklist stays empty and the
// suggested result is null when there is no evidence at all.

export type ReportStatus = "draft" | "published" | "signed" | "voided";
export type OverallResult = "pass" | "attention" | "fail";
export type PhotoSection = "before" | "after" | "evidence";
export type PhotoBucket = "job-room-photos" | "job-evidence-photos";

export interface ChecklistItem {
  label: string;
  done: boolean;
  completed_at: string | null;
}

export interface ReportPhoto {
  bucket: PhotoBucket;
  path: string;
  section: PhotoSection;
  caption: string;
  include: boolean;
}

export interface EvidenceSummary {
  verdict: "pass" | "needs_attention" | "fail";
  completeness: number | null;
  summary: string | null;
  safety_flag_count: number;
  checked_at: string;
}

export const MAX_PHOTOS = 30;
export const CAPTION_MAX = 200;
export const SUMMARY_MAX = 4000;
export const TITLE_MAX = 200;
export const DEFAULT_SHARE_DAYS = 30;
export const MAX_SHARE_DAYS = 90;

export function clip(input: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return String(input ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}

/** Storage paths must be relative object keys: no traversal, no absolute URLs. */
export function isSafeStoragePath(path: unknown): path is string {
  if (typeof path !== "string") return false;
  const p = path.trim();
  if (!p || p.length > 300) return false;
  if (p.startsWith("/") || p.includes("..") || p.includes("\\") || /^[a-z]+:/i.test(p)) return false;
  return true;
}

export function buildChecklistSnapshot(
  templates: { id: string; item_label: string; sort_order: number }[],
  completions: { template_item_id: string; completed_at: string }[],
): ChecklistItem[] {
  const doneAt = new Map(completions.map((c) => [c.template_item_id, c.completed_at]));
  return [...templates]
    .sort((a, b) => a.sort_order - b.sort_order || a.item_label.localeCompare(b.item_label))
    .map((t) => ({
      label: clip(t.item_label, 200),
      done: doneAt.has(t.id),
      completed_at: doneAt.get(t.id) ?? null,
    }));
}

export function collectPhotos(input: {
  before?: unknown;
  after?: unknown;
  evidence?: unknown;
  max?: number;
}): ReportPhoto[] {
  const max = input.max ?? MAX_PHOTOS;
  const out: ReportPhoto[] = [];
  const seen = new Set<string>();
  const add = (list: unknown, section: PhotoSection, bucket: PhotoBucket) => {
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (out.length >= max) return;
      if (!isSafeStoragePath(p)) continue;
      const key = `${bucket}/${p.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ bucket, path: p.trim(), section, caption: "", include: true });
    }
  };
  add(input.before, "before", "job-room-photos");
  add(input.after, "after", "job-room-photos");
  add(input.evidence, "evidence", "job-evidence-photos");
  return out;
}

export function checklistProgress(items: ChecklistItem[]): { done: number; total: number; percent: number } {
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** Suggested overall result; null when there is no checklist AND no evidence verdict. */
export function deriveOverallResult(items: ChecklistItem[], evidence: Pick<EvidenceSummary, "verdict"> | null): OverallResult | null {
  if (items.length === 0 && !evidence) return null;
  if (evidence?.verdict === "fail") return "fail";
  const incomplete = items.some((i) => !i.done);
  if (incomplete || evidence?.verdict === "needs_attention") return "attention";
  return "pass";
}

/** Applies staff edits (caption / include) onto the stored photos — unknown paths are ignored. */
export function mergePhotoEdits(existing: ReportPhoto[], edits: unknown): ReportPhoto[] {
  if (!Array.isArray(edits)) return existing;
  const byKey = new Map<string, { caption?: unknown; include?: unknown }>();
  for (const e of edits as { path?: unknown; caption?: unknown; include?: unknown }[]) {
    if (e && typeof e.path === "string") byKey.set(e.path, e);
  }
  return existing.map((p) => {
    const e = byKey.get(p.path);
    if (!e) return p;
    return {
      ...p,
      caption: e.caption === undefined ? p.caption : clip(e.caption, CAPTION_MAX),
      include: e.include === undefined ? p.include : e.include === true,
    };
  });
}

export function makeReportNumber(id: string, date: Date): string {
  const yy = String(date.getUTCFullYear()).slice(2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `IR-${yy}${mm}${dd}-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

export function clampShareDays(input: unknown): number {
  const n = Math.floor(Number(input));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SHARE_DAYS;
  return Math.min(n, MAX_SHARE_DAYS);
}

export type ShareState = "unpublished" | "active" | "disabled" | "expired" | "voided";

export function shareState(
  r: { status: ReportStatus; share_enabled: boolean; share_expires_at: string | null },
  now: Date,
): ShareState {
  if (r.status === "voided") return "voided";
  if (r.status === "draft") return "unpublished";
  if (!r.share_enabled) return "disabled";
  if (r.share_expires_at && new Date(r.share_expires_at).getTime() <= now.getTime()) return "expired";
  return "active";
}

/** The PDF on file no longer matches the report content (edited after generating). */
export function isPdfStale(updatedAt: string, pdfGeneratedAt: string | null): boolean {
  if (!pdfGeneratedAt) return false;
  return new Date(updatedAt).getTime() - new Date(pdfGeneratedAt).getTime() > 2000;
}

export const RESULT_LABEL: Record<OverallResult, string> = {
  pass: "Pass",
  attention: "Needs attention",
  fail: "Fail",
};

export const STATUS_LABEL: Record<ReportStatus, string> = {
  draft: "Draft",
  published: "Shared",
  signed: "Signed",
  voided: "Voided",
};

/** Same rule as the dashboard nav: owner, or can_view_all_jobs (custom roles override). */
export function canManageInspectionReports(input: {
  role: string | null | undefined;
  teamPermissions?: Record<string, unknown> | null;
  customRolePermissions?: Record<string, unknown> | null;
}): boolean {
  if (input.role === "owner") return true;
  const perms = { ...(input.teamPermissions ?? {}), ...(input.customRolePermissions ?? {}) };
  return perms.can_view_all_jobs === true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

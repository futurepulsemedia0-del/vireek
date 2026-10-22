// Enterprise Trust Pack — security-portal content: sub-processor change notices and
// pentest summaries.
//
// ISOMORPHIC pure logic (dashboard, public portal, edge functions). It deliberately does
// NOT import src/lib/subprocessors.ts (that file pulls in lucide icons); it works on the
// structural `ProcessorLike` shape instead, so the existing sub-processor list stays the
// single source of truth and is simply passed in.

export interface ProcessorLike {
  name: string;
  purpose: string;
  location: string;
  dataTypes: string;
}

export type NoticeChangeType = 'add' | 'replace' | 'remove' | 'change';
export const NOTICE_CHANGE_TYPES: readonly NoticeChangeType[] = ['add', 'replace', 'remove', 'change'];

export const DAY_MS = 86_400_000;
/** Customers get this long to object before a non-emergency change takes effect. */
export const MIN_OBJECTION_WINDOW_DAYS = 30;

export interface SubprocessorNotice {
  id: string;
  processor_name: string;
  change_type: NoticeChangeType;
  replaces_name: string | null;
  purpose: string;
  location: string;
  data_types: string;
  summary: string;
  posted_at: string;
  effective_at: string;
  emergency: boolean;
  withdrawn_at: string | null;
}

export type NoticePhase = 'objection_open' | 'effective' | 'withdrawn';

export function noticePhase(n: Pick<SubprocessorNotice, 'effective_at' | 'withdrawn_at'>, nowMs: number): NoticePhase {
  if (n.withdrawn_at) return 'withdrawn';
  return Date.parse(n.effective_at) > nowMs ? 'objection_open' : 'effective';
}

export function daysUntil(iso: string, nowMs: number): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / DAY_MS));
}

export interface NoticeInput {
  processor_name: string;
  change_type: string;
  replaces_name?: string;
  purpose: string;
  location: string;
  data_types: string;
  summary: string;
  effective_at: string; // ISO
  emergency: boolean;
}

export type FieldErrors<K extends string = string> = Partial<Record<K, string>>;

const len = (s: string, min: number, max: number) => s.trim().length >= min && s.trim().length <= max;

export function validateNoticeInput(input: NoticeInput, nowMs: number): FieldErrors<keyof NoticeInput> {
  const e: FieldErrors<keyof NoticeInput> = {};
  if (!len(input.processor_name, 2, 120)) e.processor_name = 'Enter the processor name (2–120 characters).';
  if (!(NOTICE_CHANGE_TYPES as readonly string[]).includes(input.change_type)) e.change_type = 'Choose a change type.';
  if (input.change_type === 'replace' && !len(input.replaces_name ?? '', 2, 120)) e.replaces_name = 'Name the processor being replaced.';
  if (!len(input.purpose, 5, 300)) e.purpose = 'Describe the purpose (5–300 characters).';
  if (!len(input.location, 2, 120)) e.location = 'Enter where the processor operates.';
  if (!len(input.data_types, 3, 300)) e.data_types = 'List the data types involved.';
  if (!len(input.summary, 10, 1000)) e.summary = 'Summarise the change (10–1000 characters).';
  const eff = Date.parse(input.effective_at);
  if (!Number.isFinite(eff)) e.effective_at = 'Choose an effective date.';
  else if (!input.emergency && eff < nowMs + MIN_OBJECTION_WINDOW_DAYS * DAY_MS) {
    e.effective_at = `Allow at least ${MIN_OBJECTION_WINDOW_DAYS} days for objections, or mark this as an emergency change.`;
  }
  return e;
}

/**
 * Compares two snapshots of the sub-processor list and returns draft notices for anything
 * that changed. Run it against the previous published list when updating subprocessors.ts.
 */
export interface DraftNotice {
  processor_name: string;
  change_type: 'add' | 'remove' | 'change';
  detail: string;
}

export function diffProcessors(previous: ProcessorLike[], next: ProcessorLike[]): DraftNotice[] {
  const prev = new Map(previous.map((p) => [p.name, p]));
  const nxt = new Map(next.map((p) => [p.name, p]));
  const out: DraftNotice[] = [];
  for (const [name, p] of nxt) {
    const old = prev.get(name);
    if (!old) {
      out.push({ processor_name: name, change_type: 'add', detail: `${p.purpose} — ${p.location}` });
      continue;
    }
    const changes: string[] = [];
    if (old.location !== p.location) changes.push(`location ${old.location} → ${p.location}`);
    if (old.purpose !== p.purpose) changes.push('purpose changed');
    if (old.dataTypes !== p.dataTypes) changes.push('data types changed');
    if (changes.length) out.push({ processor_name: name, change_type: 'change', detail: changes.join('; ') });
  }
  for (const [name, p] of prev) {
    if (!nxt.has(name)) out.push({ processor_name: name, change_type: 'remove', detail: p.purpose });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Email rendering (used by subprocessor-notice-dispatch)
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const CHANGE_LABEL: Record<NoticeChangeType, string> = {
  add: 'New sub-processor',
  replace: 'Sub-processor replacement',
  remove: 'Sub-processor removed',
  change: 'Sub-processor change',
};
export const changeLabel = (t: string): string => CHANGE_LABEL[t as NoticeChangeType] ?? 'Sub-processor change';

export function renderNoticeEmail(
  n: SubprocessorNotice,
  opts: { siteUrl: string; unsubscribeUrl: string | null },
): { subject: string; html: string; text: string } {
  const effective = new Date(n.effective_at).toISOString().slice(0, 10);
  const portal = `${opts.siteUrl.replace(/\/+$/, '')}/trust/security#subprocessor-notices`;
  const subject = `${changeLabel(n.change_type)}: ${n.processor_name} (effective ${effective})`;
  const lines: [string, string][] = [
    ['Processor', n.change_type === 'replace' && n.replaces_name ? `${n.processor_name} (replaces ${n.replaces_name})` : n.processor_name],
    ['Purpose', n.purpose],
    ['Location', n.location],
    ['Data involved', n.data_types],
    ['Effective', effective + (n.emergency ? ' (emergency change)' : '')],
  ];
  const text = [
    subject, '', n.summary, '',
    ...lines.map(([k, v]) => `${k}: ${v}`),
    '', `Review or object on reasonable data-protection grounds: ${portal}`,
    ...(opts.unsubscribeUrl ? ['', `Unsubscribe: ${opts.unsubscribeUrl}`] : []),
  ].join('\n');
  const rows = lines.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#667085">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`).join('');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#101828">
<h2 style="margin:0 0 12px">${escapeHtml(subject)}</h2>
<p style="line-height:1.5">${escapeHtml(n.summary)}</p>
<table style="font-size:14px;border-collapse:collapse">${rows}</table>
<p style="margin-top:20px"><a href="${escapeHtml(portal)}">Review this change or submit an objection</a></p>
${opts.unsubscribeUrl ? `<p style="font-size:12px;color:#667085"><a href="${escapeHtml(opts.unsubscribeUrl)}">Unsubscribe</a> from sub-processor notices.</p>` : ''}
</div>`;
  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Pentest summaries
// ---------------------------------------------------------------------------

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];
export type SeverityCounts = Record<Severity, number>;

export interface PentestSummary {
  id: string;
  title: string;
  tester: string;
  performed_on: string; // YYYY-MM-DD
  scope: string;
  methodology: string;
  summary: string;
  found: SeverityCounts;
  remediated: SeverityCounts;
  published_at: string | null;
  report_available_on_request: boolean;
}

export const emptyCounts = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

export function normalizeCounts(raw: unknown): SeverityCounts {
  const out = emptyCounts();
  if (raw && typeof raw === 'object') {
    for (const s of SEVERITIES) {
      const v = (raw as Record<string, unknown>)[s];
      out[s] = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
    }
  }
  return out;
}

export const totalFindings = (c: SeverityCounts): number => SEVERITIES.reduce((s, k) => s + c[k], 0);

/** Share of critical+high findings that are fixed (null when there were none). */
export function criticalRemediationRate(found: SeverityCounts, remediated: SeverityCounts): number | null {
  const f = found.critical + found.high;
  if (f === 0) return null;
  const r = Math.min(remediated.critical, found.critical) + Math.min(remediated.high, found.high);
  return Math.round((r / f) * 100);
}

export function openFindings(found: SeverityCounts, remediated: SeverityCounts): SeverityCounts {
  const out = emptyCounts();
  for (const s of SEVERITIES) out[s] = Math.max(0, found[s] - remediated[s]);
  return out;
}

export interface PentestInput {
  title: string;
  tester: string;
  performed_on: string;
  scope: string;
  methodology: string;
  summary: string;
  found: SeverityCounts;
  remediated: SeverityCounts;
}

export function validatePentestInput(i: PentestInput, nowMs: number): FieldErrors<keyof PentestInput> {
  const e: FieldErrors<keyof PentestInput> = {};
  if (!len(i.title, 3, 160)) e.title = 'Enter a title (3–160 characters).';
  if (!len(i.tester, 2, 160)) e.tester = 'Name the testing firm or team.';
  const d = Date.parse(i.performed_on);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.performed_on) || !Number.isFinite(d)) e.performed_on = 'Use the YYYY-MM-DD format.';
  else if (d > nowMs) e.performed_on = 'The test date cannot be in the future.';
  if (!len(i.scope, 5, 600)) e.scope = 'Describe what was in scope.';
  if (!len(i.methodology, 5, 600)) e.methodology = 'Describe the methodology.';
  if (!len(i.summary, 20, 2000)) e.summary = 'Write a summary (20–2000 characters).';
  for (const s of SEVERITIES) {
    if (i.remediated[s] > i.found[s]) { e.remediated = `Remediated ${s} findings cannot exceed those found.`; break; }
  }
  return e;
}

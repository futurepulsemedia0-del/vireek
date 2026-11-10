/**
 * Pest Ops — customer treatment reports + pre-visit notices (pure text builders).
 *
 * PII minimisation: reports use the customer's first name only and omit the street address; the
 * technician appears by first name. The applicator licence number is shown only when the business
 * opts in (some regions expect it on the customer copy — confirm with counsel).
 * All interpolated values are HTML-escaped in the html output.
 */

import { utcToZonedParts, zonedToUtcISO } from '@/lib/recurringJobs';
import type { NoticeChannel, NoticeKind } from './notifier';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function firstName(full: string | null | undefined): string {
  const t = (full ?? '').trim().split(/\s+/)[0] ?? '';
  return t.slice(0, 40);
}

export interface ReportProduct {
  name: string;
  registrationNumber: string | null;
  amount: number;
  unit: string;
  targetPests: string[];
  area: string | null;
  /** Instant after which the area may be re-entered; null = none stated on the label record. */
  reentryUntilUtc: string | null;
}

export interface TreatmentReportInput {
  businessName: string;
  timeZone: string;
  customerName: string | null;
  technicianName: string | null;
  /** Shown only when the business opted in. */
  applicatorLicense?: string | null;
  performedAtUtc: string;
  visitType: string;
  /** 0 none … 5 severe */
  activityLevel: number | null;
  findings?: string | null;
  recommendations?: string | null;
  products: ReportProduct[];
  nextVisitDate?: string | null;
  guaranteeUntil?: string | null;
}

export interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
}

const ACTIVITY_LABELS = ['None seen', 'Very low', 'Low', 'Moderate', 'High', 'Severe'];

export function activityLabel(level: number | null): string {
  if (level === null || !Number.isInteger(level) || level < 0 || level > 5) return 'Not recorded';
  return ACTIVITY_LABELS[level];
}

function formatInstant(utcIso: string, timeZone: string): string {
  const d = new Date(utcIso);
  return new Intl.DateTimeFormat('en-US', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

function formatAmount(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

export function buildTreatmentReport(i: TreatmentReportInput): RenderedMessage {
  const when = formatInstant(i.performedAtUtc, i.timeZone);
  const hello = firstName(i.customerName) ? `Hi ${firstName(i.customerName)},` : 'Hello,';
  const lines: string[] = [hello, '', `Here is the summary of your ${i.visitType.toLowerCase()} pest service on ${when}.`, ''];
  lines.push(`Technician: ${firstName(i.technicianName) || 'Our technician'}`);
  if (i.applicatorLicense) lines.push(`Applicator licence: ${i.applicatorLicense}`);
  lines.push(`Pest activity: ${activityLabel(i.activityLevel)}`);
  if (i.products.length === 0) {
    lines.push('', 'No products were applied on this visit.');
  } else {
    lines.push('', 'Products applied:');
    for (const p of i.products) {
      const reg = p.registrationNumber ? ` (Reg. ${p.registrationNumber})` : '';
      const targets = p.targetPests.length ? ` for ${p.targetPests.join(', ')}` : '';
      const area = p.area ? ` — ${p.area}` : '';
      lines.push(`• ${p.name}${reg}: ${formatAmount(p.amount)} ${p.unit}${targets}${area}`);
      if (p.reentryUntilUtc) lines.push(`  Please keep people and pets out of treated areas until ${formatInstant(p.reentryUntilUtc, i.timeZone)}.`);
    }
  }
  if (i.findings?.trim()) lines.push('', `Findings: ${i.findings.trim()}`);
  if (i.recommendations?.trim()) lines.push('', `What you can do: ${i.recommendations.trim()}`);
  if (i.nextVisitDate) lines.push('', `Next scheduled visit: ${i.nextVisitDate}`);
  if (i.guaranteeUntil) lines.push(`Re-service guarantee runs through ${i.guaranteeUntil}. Call us if activity continues.`);
  lines.push('', `— ${i.businessName}`);

  const text = lines.join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5">${lines
    .map((l) => (l === '' ? '<br/>' : `<p style="margin:0">${escapeHtml(l)}</p>`))
    .join('')}</div>`;
  return { subject: `Your pest service summary — ${i.businessName}`, text, html };
}

/* ------------------------------------------------------------------ */
/* Pre-visit notices                                                    */
/* ------------------------------------------------------------------ */

const PREP_TIPS: Record<string, string> = {
  Ants: 'Wipe counters and sweep floors; leave trails of ants undisturbed so we can trace them.',
  Cockroaches: 'Clear cabinets under sinks and move food into sealed containers.',
  Rodents: 'Keep pet food and bird seed stored in sealed containers.',
  Termites: 'Make sure we can reach the foundation and any crawlspace access.',
  'Bed bugs': 'Strip beds and bag linens for washing on high heat before we arrive.',
  Mosquitoes: 'Empty standing water in pots, buckets and toys.',
  Spiders: 'Clear clutter and boxes stored against exterior walls.',
  'Wasps / bees': 'Keep children and pets away from the nest area.',
  'Fleas / ticks': 'Wash pet bedding and vacuum floors beforehand.',
};

export interface PreVisitNoticeInput {
  businessName: string;
  customerName: string | null;
  technicianName?: string | null;
  visitStartUtc: string;
  timeZone: string;
  /** Length of the arrival window in hours (default 2). */
  windowHours?: number;
  targetPests?: string[];
  channel: NoticeChannel;
  /** Contact line for rescheduling, e.g. a phone number. */
  contact?: string | null;
}

export function buildPreVisitNotice(i: PreVisitNoticeInput): RenderedMessage {
  const windowHours = i.windowHours ?? 2;
  const start = formatInstant(i.visitStartUtc, i.timeZone);
  const endUtc = new Date(new Date(i.visitStartUtc).getTime() + windowHours * 3_600_000).toISOString();
  const endTime = new Intl.DateTimeFormat('en-US', { timeZone: i.timeZone, timeStyle: 'short' }).format(new Date(endUtc));
  const hello = firstName(i.customerName) ? `Hi ${firstName(i.customerName)},` : 'Hello,';
  const who = firstName(i.technicianName) ? `${firstName(i.technicianName)} from ${i.businessName}` : i.businessName;
  const lines = [hello, '', `${who} will visit for your pest service on ${start} (arrival window ends about ${endTime}).`];
  const tips = [...new Set(i.targetPests ?? [])].map((p) => PREP_TIPS[p]).filter((t): t is string => Boolean(t));
  if (tips.length) {
    lines.push('', 'To help the treatment work:');
    for (const t of tips) lines.push(`• ${t}`);
  }
  lines.push('', 'Please let us know about pets, children or anyone with health sensitivities at home.');
  if (i.contact) lines.push(`Need to reschedule? Contact us: ${i.contact}`);
  lines.push('', `— ${i.businessName}`);
  const text = lines.join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5">${lines.map((l) => (l === '' ? '<br/>' : `<p style="margin:0">${escapeHtml(l)}</p>`)).join('')}</div>`;
  return { subject: `Pest service visit — ${start}`, text, html };
}

/**
 * When to send a pre-visit notice: `leadHours` before the visit, but never during local quiet hours
 * (before 08:00 or from 20:00). A candidate in quiet hours moves back to 19:00 local of the previous
 * allowed evening. DST-safe (wall-clock arithmetic in the tenant's zone).
 */
export function noticeSendAt(visitStartUtc: string, leadHours: number, timeZone: string): string {
  const candidateMs = new Date(visitStartUtc).getTime() - Math.max(leadHours, 0) * 3_600_000;
  const candidate = new Date(candidateMs).toISOString();
  const { date, time } = utcToZonedParts(candidate, timeZone);
  const hour = Number(time.slice(0, 2));
  if (hour >= 8 && hour < 20) return candidate;
  if (hour >= 20) return zonedToUtcISO(date, '19:00', timeZone);
  const [y, m, d] = date.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  const prevISO = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
  return zonedToUtcISO(prevISO, '19:00', timeZone);
}

export function noticeIdempotencyKey(kind: NoticeKind, jobId: string, channel: NoticeChannel): string {
  return `notice:${kind}:${jobId}:${channel}`;
}

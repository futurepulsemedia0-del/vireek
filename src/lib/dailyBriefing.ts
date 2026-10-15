/**
 * Daily Briefing — pure domain logic (no network, no React, no Deno APIs).
 *
 * Shared by three consumers, which is why the relative import below carries a `.ts`
 * extension (Deno requires it; Vite/tsc allow it via `allowImportingTsExtensions`):
 *   - supabase/functions/daily-briefing  (7am composition + delivery)
 *   - the dashboard card / settings UI   (src/components/DailyBriefingCard.tsx)
 *   - vitest                             (src/lib/dailyBriefing.test.ts)
 *
 * Reuses `changesSinceYesterday` for the "yesterday's results" section — same
 * snapshot, same significance thresholds, same "null = hidden, never a fake zero" rule.
 *
 * Every data source is nullable: a source that failed to load simply drops its
 * section instead of producing a misleading "all clear".
 */
import {
  buildChangeRows,
  invoiceTotalCents,
  type ChangeSnapshot,
  type RawInvoice,
} from './changesSinceYesterday.ts';

// ---------- vocabulary ----------

export type BriefingRole = 'owner' | 'admin' | 'member' | 'technician';
export type SectionKey =
  'yesterday' | 'schedule' | 'emergencies' | 'unpaid' | 'expiring' | 'actions';
export type Tone = 'good' | 'bad' | 'warn' | 'neutral';
export type Severity = 'calm' | 'attention' | 'urgent';

export const SECTION_ORDER: readonly SectionKey[] = [
  'yesterday',
  'schedule',
  'emergencies',
  'unpaid',
  'expiring',
  'actions',
];

export const SECTION_TITLES: Record<SectionKey, string> = {
  yesterday: "Yesterday's results",
  schedule: "Today's schedule",
  emergencies: 'Emergencies',
  unpaid: 'Unpaid balances',
  expiring: 'Expiring soon',
  actions: 'Recommended actions',
};

/** What each role sees by default. Billing-gated content is removed separately (see canViewBilling). */
const ROLE_SECTIONS: Record<BriefingRole, readonly SectionKey[]> = {
  owner: SECTION_ORDER,
  admin: SECTION_ORDER,
  member: ['yesterday', 'schedule', 'emergencies', 'expiring', 'actions'],
  technician: ['schedule', 'emergencies'],
};

export const THRESHOLDS = {
  jobConflictMinutes: 90, // same technician, two jobs closer than this = conflict
  capacityRiskRatio: 1, // booked / capacity at or above this = overbooked
  quoteExpiryDays: 3,
  contractExpiryDays: 30,
  maxItemsPerSection: 4,
  maxActions: 3,
  catchUpHours: 2, // late-run window after the preferred hour (cron hiccups) — never later
} as const;

export const DEFAULT_TIMEZONE = 'America/New_York';
export const ROUTES = {
  jobs: '/dashboard/jobs',
  calls: '/dashboard/calls',
  dispatch: '/dashboard/dispatch',
  invoicing: '/dashboard/invoicing',
  quotes: '/dashboard/quotes',
  contracts: '/dashboard/contracts',
  insights: '/dashboard/insights',
} as const;

// ---------- inputs ----------

export interface BriefingJob {
  id: string;
  customer_name: string;
  service_type: string | null;
  scheduled_datetime: string | null;
  job_status: string;
  assigned_technician_id: string | null;
}
export interface BriefingEmergencyCall {
  id: string;
  caller_name: string | null;
  call_datetime: string;
  /** true when a job already exists for this call. */
  has_job: boolean;
}
export type BriefingInvoice = Pick<RawInvoice, 'status' | 'line_items' | 'tax_percent'> & {
  customer_name: string;
  due_date: string | null; // YYYY-MM-DD
};
export interface ExpiringItem {
  kind: 'quote' | 'contract';
  label: string;
  /** YYYY-MM-DD */
  date: string;
  amountCents?: number | null;
}
export interface BriefingInsight {
  title: string;
  description?: string | null;
  recommended_action: string | null;
  priority: number;
}

export interface BriefingInputs {
  now: number;
  timezone: string;
  /** From `computeSnapshot` in changesSinceYesterday. */
  snapshot: ChangeSnapshot | null;
  /** Calls created in the last 24h (all), for the yesterday absolutes. Optional. */
  jobsToday: BriefingJob[] | null;
  dailyCapacity: number | null;
  emergencyCalls: BriefingEmergencyCall[] | null;
  /** Issued, unpaid invoices (status sent/viewed). */
  unpaidInvoices: BriefingInvoice[] | null;
  expiring: ExpiringItem[] | null;
  insights: BriefingInsight[] | null;
}

export interface BriefingRecipient {
  role: BriefingRole;
  name: string | null;
  canViewBilling: boolean;
  /** team_members.id, null for the account owner. Used to scope a technician's own jobs. */
  teamMemberId: string | null;
  /** User-selected sections; always intersected with what the role may see. */
  sections?: SectionKey[] | null;
}

// ---------- output ----------

export interface BriefingItem {
  text: string;
  tone: Tone;
  href?: string;
  tag?: 'AI' | 'Rule';
}
export interface BriefingSection {
  key: SectionKey;
  title: string;
  /** Empty = nothing to report (rendered as "all clear"). */
  items: BriefingItem[];
}
export interface Briefing {
  version: 1;
  date: string;
  role: BriefingRole;
  recipientName: string | null;
  headline: string;
  severity: Severity;
  sections: BriefingSection[];
}

// ---------- time (timezone-correct, no dependencies) ----------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function resolveTimezone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function partsFormatter(tz: string): Intl.DateTimeFormat {
  const key = resolveTimezone(tz);
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: key,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(key, f);
  }
  return f;
}

export function localParts(now: number, tz: string) {
  const o: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(now))) {
    if (p.type !== 'literal') o[p.type] = Number(p.value);
  }
  const date = `${String(o.year).padStart(4, '0')}-${String(o.month).padStart(2, '0')}-${String(o.day).padStart(2, '0')}`;
  return { date, hour: o.hour % 24, year: o.year, month: o.month, day: o.day };
}

/** Offset (ms) of `tz` from UTC at instant `t`. */
function tzOffsetMs(t: number, tz: string): number {
  const p = localParts(t, tz);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    new Date(t).getUTCMinutes(),
    new Date(t).getUTCSeconds(),
  );
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** UTC instants [start, end) of the local calendar day containing `now` in `tz` (DST-safe). */
export function localDayBoundsUtc(
  now: number,
  tz: string,
): { start: number; end: number; date: string } {
  const { year, month, day, date } = localParts(now, tz);
  const at = (d: number) => {
    const guess = Date.UTC(year, month - 1, d);
    const first = guess - tzOffsetMs(guess, tz);
    return guess - tzOffsetMs(first, tz); // second pass fixes DST-transition days
  };
  return { start: at(day), end: at(day + 1), date };
}

function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimezone(tz),
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Whole days from `fromDate` to `toDate` (both YYYY-MM-DD). */
export function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// ---------- preferences & scheduling ----------

export interface BriefingPrefs {
  enabled: boolean;
  sendHour: number;
  timezone: string;
  channels: { push: boolean; email: boolean; inApp: boolean };
  /** null = role defaults. */
  sections: SectionKey[] | null;
  lastSentOn: string | null;
}

export const DEFAULT_PREFS: BriefingPrefs = {
  enabled: true,
  sendHour: 7,
  timezone: DEFAULT_TIMEZONE,
  channels: { push: true, email: true, inApp: true },
  sections: null,
  lastSentOn: null,
};

/** Normalises untrusted input (form values, DB rows). Never throws. */
export function sanitizePrefs(input: Partial<BriefingPrefs> | null | undefined): BriefingPrefs {
  const p = input ?? {};
  const hour = Number(p.sendHour);
  const valid = new Set<string>(SECTION_ORDER);
  const sections = Array.isArray(p.sections)
    ? p.sections.filter((s): s is SectionKey => valid.has(s))
    : null;
  return {
    enabled: p.enabled ?? DEFAULT_PREFS.enabled,
    sendHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_PREFS.sendHour,
    timezone:
      typeof p.timezone === 'string' && p.timezone
        ? resolveTimezone(p.timezone)
        : DEFAULT_PREFS.timezone,
    channels: { ...DEFAULT_PREFS.channels, ...(p.channels ?? {}) },
    sections: sections && sections.length > 0 ? sections : null,
    lastSentOn: p.lastSentOn ?? null,
  };
}

/**
 * True when this recipient's briefing should be produced on this hourly cron tick:
 * enabled, local time is inside [sendHour, sendHour + catch-up), and not already sent today.
 * The window never crosses local midnight, so `lastSentOn` (a local date) stays unambiguous.
 */
export function isDue(prefs: BriefingPrefs, now: number): boolean {
  if (!prefs.enabled) return false;
  const { date, hour } = localParts(now, prefs.timezone);
  if (prefs.lastSentOn === date) return false;
  const end = Math.min(24, prefs.sendHour + THRESHOLDS.catchUpHours);
  return hour >= prefs.sendHour && hour < end;
}

/** Sections the person may see: role defaults, minus billing content when they lack billing access. */
export function allowedSections(role: BriefingRole, canViewBilling: boolean): SectionKey[] {
  return ROLE_SECTIONS[role].filter((s) => canViewBilling || s !== 'unpaid');
}

export function effectiveSections(
  role: BriefingRole,
  canViewBilling: boolean,
  selected?: SectionKey[] | null,
): SectionKey[] {
  const allowed = allowedSections(role, canViewBilling);
  if (!selected || selected.length === 0) return allowed;
  const picked = allowed.filter((s) => selected.includes(s));
  return picked.length > 0 ? picked : allowed; // a stale selection can never produce an empty briefing
}

/** Owners/admins always see billing; others need the explicit permission. */
export function canSeeBilling(
  role: BriefingRole,
  permissions?: { can_view_billing?: boolean } | null,
): boolean {
  return role === 'owner' || role === 'admin' || permissions?.can_view_billing === true;
}

// ---------- section builders ----------

const INACTIVE = new Set(['completed', 'cancelled', 'no_show']);
const BILLING_WORDS =
  /\b(invoice|invoices|invoicing|revenue|payment|payments|billing|cash|pricing|price|profit|margin)\b|\$/i;

function yesterdaySection(i: BriefingInputs, canBilling: boolean): BriefingSection | null {
  const s = i.snapshot;
  if (!s) return null;
  const items: BriefingItem[] = [];
  const summary: string[] = [];
  if (s.revenueCents && canBilling) summary.push(`${usd(s.revenueCents.current)} collected`);
  if (s.calls) summary.push(plural(s.calls.current, 'call'));
  if (s.jobs) summary.push(`${plural(s.jobs.current, 'new job')}`);
  if (summary.length > 0) items.push({ text: summary.join(' · '), tone: 'neutral' });

  for (const row of buildChangeRows(s)) {
    if (!canBilling && (row.key === 'revenue' || row.key === 'ar')) continue;
    items.push({
      text: `${row.label} ${row.display}`,
      tone: row.tone === 'good' ? 'good' : row.tone === 'bad' ? 'bad' : 'neutral',
    });
  }
  return {
    key: 'yesterday',
    title: SECTION_TITLES.yesterday,
    items: items.slice(0, THRESHOLDS.maxItemsPerSection + 2),
  };
}

export interface ScheduleRisk {
  kind: 'unassigned' | 'conflict' | 'overbooked';
  text: string;
  severity: 'medium' | 'high';
}

export function scheduleRisks(
  jobs: BriefingJob[],
  dailyCapacity: number | null,
  tz: string,
): ScheduleRisk[] {
  const active = jobs.filter((j) => !INACTIVE.has(j.job_status));
  const risks: ScheduleRisk[] = [];

  const unassigned = active.filter((j) => !j.assigned_technician_id);
  if (unassigned.length > 0) {
    const first = [...unassigned].sort(
      (a, b) => Date.parse(a.scheduled_datetime ?? '') - Date.parse(b.scheduled_datetime ?? ''),
    )[0];
    const when = first.scheduled_datetime
      ? ` — earliest at ${fmtTime(first.scheduled_datetime, tz)}`
      : '';
    risks.push({
      kind: 'unassigned',
      text: `${plural(unassigned.length, 'job')} with no technician assigned${when}`,
      severity: 'high',
    });
  }

  const byTech = new Map<string, BriefingJob[]>();
  for (const j of active) {
    if (!j.assigned_technician_id || !j.scheduled_datetime) continue;
    byTech.set(j.assigned_technician_id, [...(byTech.get(j.assigned_technician_id) ?? []), j]);
  }
  let conflicts = 0;
  for (const list of byTech.values()) {
    const times = list.map((j) => Date.parse(j.scheduled_datetime as string)).sort((a, b) => a - b);
    for (let k = 1; k < times.length; k++) {
      if (times[k] - times[k - 1] < THRESHOLDS.jobConflictMinutes * 60_000) conflicts++;
    }
  }
  if (conflicts > 0) {
    risks.push({
      kind: 'conflict',
      text: `${plural(conflicts, 'possible double-booking')} (same technician, jobs under ${THRESHOLDS.jobConflictMinutes} min apart)`,
      severity: 'high',
    });
  }

  if (
    dailyCapacity &&
    dailyCapacity > 0 &&
    active.length / dailyCapacity >= THRESHOLDS.capacityRiskRatio
  ) {
    risks.push({
      kind: 'overbooked',
      text: `Fully booked: ${active.length} jobs vs. capacity of ${dailyCapacity}`,
      severity: 'medium',
    });
  }
  return risks;
}

function scheduleSection(i: BriefingInputs, who: BriefingRecipient): BriefingSection | null {
  if (!i.jobsToday) return null;
  const mine =
    who.role === 'technician'
      ? i.jobsToday.filter((j) => j.assigned_technician_id === who.teamMemberId)
      : i.jobsToday;
  const active = mine.filter((j) => !INACTIVE.has(j.job_status));
  if (active.length === 0) return { key: 'schedule', title: SECTION_TITLES.schedule, items: [] };

  const sorted = [...active].sort(
    (a, b) => Date.parse(a.scheduled_datetime ?? '') - Date.parse(b.scheduled_datetime ?? ''),
  );
  const first = sorted[0];
  const lead = first.scheduled_datetime
    ? `, first at ${fmtTime(first.scheduled_datetime, i.timezone)}`
    : '';
  const items: BriefingItem[] = [
    { text: `${plural(active.length, 'job')} today${lead}`, tone: 'neutral', href: ROUTES.jobs },
  ];

  if (who.role !== 'technician') {
    for (const r of scheduleRisks(mine, i.dailyCapacity, i.timezone)) {
      items.push({
        text: r.text,
        tone: r.severity === 'high' ? 'bad' : 'warn',
        href: ROUTES.dispatch,
      });
    }
  }
  return {
    key: 'schedule',
    title: SECTION_TITLES.schedule,
    items: items.slice(0, THRESHOLDS.maxItemsPerSection + 1),
  };
}

function emergenciesSection(i: BriefingInputs): BriefingSection | null {
  if (!i.emergencyCalls) return null;
  const open = i.emergencyCalls.filter((c) => !c.has_job);
  const handled = i.emergencyCalls.length - open.length;
  const items: BriefingItem[] = open.slice(0, THRESHOLDS.maxItemsPerSection).map((c) => ({
    text: `Emergency call${c.caller_name ? ` from ${c.caller_name}` : ''} at ${fmtTime(c.call_datetime, i.timezone)} — no job created yet`,
    tone: 'bad' as const,
    href: ROUTES.calls,
  }));
  if (open.length > THRESHOLDS.maxItemsPerSection) {
    items.push({
      text: `+${open.length - THRESHOLDS.maxItemsPerSection} more unhandled`,
      tone: 'bad',
      href: ROUTES.calls,
    });
  }
  if (handled > 0)
    items.push({ text: `${plural(handled, 'emergency call')} handled`, tone: 'good' });
  return { key: 'emergencies', title: SECTION_TITLES.emergencies, items };
}

export interface UnpaidSummary {
  count: number;
  totalCents: number;
  overdueCount: number;
  overdueCents: number;
  oldest: { customer: string; daysLate: number; cents: number } | null;
}

export function summarizeUnpaid(invoices: BriefingInvoice[], today: string): UnpaidSummary {
  let totalCents = 0;
  let overdueCents = 0;
  let overdueCount = 0;
  let count = 0;
  let oldest: UnpaidSummary['oldest'] = null;
  for (const inv of invoices) {
    if (inv.status === 'paid' || inv.status === 'void' || inv.status === 'draft') continue;
    const cents = invoiceTotalCents(inv);
    count++;
    totalCents += cents;
    if (inv.due_date && inv.due_date < today) {
      overdueCount++;
      overdueCents += cents;
      const daysLate = daysBetween(inv.due_date, today);
      if (!oldest || daysLate > oldest.daysLate)
        oldest = { customer: inv.customer_name, daysLate, cents };
    }
  }
  return { count, totalCents, overdueCount, overdueCents, oldest };
}

function unpaidSection(i: BriefingInputs, today: string): BriefingSection | null {
  if (!i.unpaidInvoices) return null;
  const u = summarizeUnpaid(i.unpaidInvoices, today);
  if (u.count === 0 || u.totalCents === 0)
    return { key: 'unpaid', title: SECTION_TITLES.unpaid, items: [] };
  const items: BriefingItem[] = [
    {
      text: `${usd(u.totalCents)} outstanding across ${plural(u.count, 'invoice')}`,
      tone: 'neutral',
      href: ROUTES.invoicing,
    },
  ];
  if (u.overdueCount > 0 && u.oldest) {
    items.push({
      text: `${usd(u.overdueCents)} overdue (${u.overdueCount}) — oldest: ${u.oldest.customer}, ${plural(u.oldest.daysLate, 'day')} late`,
      tone: 'bad',
      href: ROUTES.invoicing,
    });
  }
  return { key: 'unpaid', title: SECTION_TITLES.unpaid, items };
}

function expiringSection(i: BriefingInputs, today: string): BriefingSection | null {
  if (!i.expiring) return null;
  const rows = i.expiring
    .map((e) => ({ ...e, days: daysBetween(today, e.date) }))
    .filter(
      (e) =>
        e.days >= 0 &&
        e.days <= (e.kind === 'quote' ? THRESHOLDS.quoteExpiryDays : THRESHOLDS.contractExpiryDays),
    )
    .sort((a, b) => a.days - b.days);
  const when = (d: number) => (d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`);
  const items: BriefingItem[] = rows.slice(0, THRESHOLDS.maxItemsPerSection).map((e) => ({
    text: `${e.kind === 'quote' ? 'Quote' : 'Contract'} ${e.label} expires ${when(e.days)}${e.amountCents ? ` (${usd(e.amountCents)})` : ''}`,
    tone: e.days <= 1 ? ('bad' as const) : ('warn' as const),
    href: e.kind === 'quote' ? ROUTES.quotes : ROUTES.contracts,
  }));
  if (rows.length > THRESHOLDS.maxItemsPerSection) {
    items.push({
      text: `+${rows.length - THRESHOLDS.maxItemsPerSection} more expiring`,
      tone: 'warn',
    });
  }
  return { key: 'expiring', title: SECTION_TITLES.expiring, items };
}

/**
 * Up to 3 actions. Order: hard facts that need action NOW (unhandled emergencies) → AI insights
 * by priority → remaining rule-based fillers. Rule actions guarantee the card is never empty
 * when something is genuinely wrong, even if the AI layer is down.
 */
function buildActions(i: BriefingInputs, canBilling: boolean, today: string): BriefingItem[] {
  const out: BriefingItem[] = [];
  const seen = new Set<string>();
  const add = (item: BriefingItem) => {
    const key = item.text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (!key || seen.has(key) || out.length >= THRESHOLDS.maxActions) return;
    seen.add(key);
    out.push(item);
  };

  const openEmergencies = (i.emergencyCalls ?? []).filter((c) => !c.has_job);
  if (openEmergencies.length > 0) {
    add({
      text: `Dispatch ${plural(openEmergencies.length, 'unhandled emergency call')} now`,
      tone: 'bad',
      href: ROUTES.calls,
      tag: 'Rule',
    });
  }

  const ai = (i.insights ?? [])
    .filter(
      (x) => typeof x.recommended_action === 'string' && x.recommended_action.trim().length > 0,
    )
    .filter((x) => canBilling || !BILLING_WORDS.test(`${x.title} ${x.recommended_action}`))
    .sort((a, b) => b.priority - a.priority);
  for (const x of ai)
    add({
      text: (x.recommended_action as string).trim().slice(0, 240),
      tone: 'neutral',
      href: ROUTES.insights,
      tag: 'AI',
    });

  const jobs = i.jobsToday ?? [];
  const risks = i.jobsToday ? scheduleRisks(jobs, i.dailyCapacity, i.timezone) : [];
  const unassigned = risks.find((r) => r.kind === 'unassigned');
  if (unassigned)
    add({
      text: 'Assign technicians to today’s unassigned jobs',
      tone: 'warn',
      href: ROUTES.dispatch,
      tag: 'Rule',
    });
  if (canBilling && i.unpaidInvoices) {
    const u = summarizeUnpaid(i.unpaidInvoices, today);
    if (u.overdueCount > 0)
      add({
        text: `Send payment reminders for ${usd(u.overdueCents)} overdue`,
        tone: 'warn',
        href: ROUTES.invoicing,
        tag: 'Rule',
      });
  }
  const quote = (i.expiring ?? []).find(
    (e) => e.kind === 'quote' && daysBetween(today, e.date) >= 0 && daysBetween(today, e.date) <= 1,
  );
  if (quote)
    add({
      text: `Follow up on the quote ${quote.label} before it expires`,
      tone: 'warn',
      href: ROUTES.quotes,
      tag: 'Rule',
    });
  return out;
}

// ---------- compose ----------

function headlineFor(
  sections: BriefingSection[],
  i: BriefingInputs,
  today: string,
  canBilling: boolean,
): { headline: string; severity: Severity } {
  const get = (k: SectionKey) => sections.find((s) => s.key === k);
  const bits: string[] = [];
  let severity: Severity = 'calm';
  const bump = (s: Severity) => {
    if (s === 'urgent' || (s === 'attention' && severity === 'calm')) severity = s;
  };

  const open = (i.emergencyCalls ?? []).filter((c) => !c.has_job).length;
  if (open > 0) {
    bits.push(plural(open, 'unhandled emergency', 'unhandled emergencies'));
    bump('urgent');
  }
  const risks =
    get('schedule')?.items.filter((x) => x.tone === 'bad' || x.tone === 'warn').length ?? 0;
  if (risks > 0) {
    bits.push(plural(risks, 'schedule risk'));
    bump(get('schedule')?.items.some((x) => x.tone === 'bad') ? 'urgent' : 'attention');
  }
  if (canBilling && get('unpaid') && i.unpaidInvoices) {
    const u = summarizeUnpaid(i.unpaidInvoices, today);
    if (u.overdueCount > 0) {
      bits.push(`${usd(u.overdueCents)} overdue`);
      bump('attention');
    }
  }
  const exp = get('expiring')?.items.length ?? 0;
  if (exp > 0) {
    bits.push(`${exp} expiring`);
    bump('attention');
  }
  return {
    headline: bits.length > 0 ? bits.join(' · ') : 'All clear — a steady start to the day',
    severity,
  };
}

export function composeBriefing(inputs: BriefingInputs, who: BriefingRecipient): Briefing {
  const canBilling = who.canViewBilling;
  const { date: today } = localParts(inputs.now, inputs.timezone);
  const wanted = effectiveSections(who.role, canBilling, who.sections);

  const builders: Record<SectionKey, () => BriefingSection | null> = {
    yesterday: () => yesterdaySection(inputs, canBilling),
    schedule: () => scheduleSection(inputs, who),
    emergencies: () => emergenciesSection(inputs),
    unpaid: () => (canBilling ? unpaidSection(inputs, today) : null),
    expiring: () => expiringSection(inputs, today),
    actions: () => ({
      key: 'actions',
      title: SECTION_TITLES.actions,
      items: buildActions(inputs, canBilling, today),
    }),
  };

  const sections = SECTION_ORDER.filter((k) => wanted.includes(k))
    .map((k) => builders[k]())
    .filter((s): s is BriefingSection => s !== null);

  const { headline, severity } = headlineFor(sections, inputs, today, canBilling);
  return {
    version: 1,
    date: today,
    role: who.role,
    recipientName: who.name,
    headline,
    severity,
    sections,
  };
}

// ---------- rendering ----------

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const greeting = (b: Briefing) =>
  b.recipientName ? `Good morning, ${b.recipientName.split(' ')[0]}` : 'Good morning';

export function toPushPayload(b: Briefing): {
  title: string;
  body: string;
  url: string;
  tag: string;
} {
  const top = b.sections.find((s) => s.key === 'actions')?.items[0]?.text;
  const body = [b.headline, top ? `Top action: ${top}` : null].filter(Boolean).join('. ');
  return {
    title:
      b.severity === 'urgent'
        ? 'Vireek briefing — needs attention'
        : 'Your Vireek morning briefing',
    body: body.length > 178 ? `${body.slice(0, 177)}…` : body,
    url: '/dashboard',
    tag: 'daily-briefing',
  };
}

export function toPlainText(b: Briefing): string {
  const lines = [`${greeting(b)} — ${b.headline}`, ''];
  const clear: string[] = [];
  for (const s of b.sections) {
    if (s.items.length === 0) {
      clear.push(s.title);
      continue;
    }
    lines.push(s.title.toUpperCase());
    for (const it of s.items) lines.push(`• ${it.text}${it.tag === 'AI' ? ' (AI)' : ''}`);
    lines.push('');
  }
  if (clear.length > 0) lines.push(`All clear: ${clear.join(', ')}`);
  return lines.join('\n').trim();
}

const TONE_COLOR: Record<Tone, string> = {
  good: '#15803d',
  bad: '#b91c1c',
  warn: '#b45309',
  neutral: '#111827',
};

export function toEmail(
  b: Briefing,
  opts: { companyName?: string | null; dashboardUrl: string },
): { subject: string; html: string; text: string } {
  const clear = b.sections.filter((s) => s.items.length === 0).map((s) => s.title);
  const blocks = b.sections
    .filter((s) => s.items.length > 0)
    .map((s) => {
      const lis = s.items
        .map((it) => {
          const label =
            esc(it.text) +
            (it.tag === 'AI' ? ' <span style="font-size:11px;color:#6b7280">AI</span>' : '');
          const inner = it.href
            ? `<a href="${esc(opts.dashboardUrl + it.href)}" style="color:inherit;text-decoration:none">${label}</a>`
            : label;
          return `<li style="margin:6px 0;color:${TONE_COLOR[it.tone]}">${inner}</li>`;
        })
        .join('');
      return `<h3 style="margin:22px 0 4px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#6b7280">${esc(s.title)}</h3><ul style="margin:0;padding-left:18px;font-size:15px;line-height:1.5">${lis}</ul>`;
    })
    .join('');
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">` +
    `<p style="margin:0;font-size:13px;color:#6b7280">${esc(opts.companyName ?? 'Vireek')} · ${esc(b.date)}</p>` +
    `<h1 style="margin:6px 0 0;font-size:22px">${esc(greeting(b))}</h1>` +
    `<p style="margin:6px 0 0;font-size:16px;color:${b.severity === 'urgent' ? '#b91c1c' : '#111827'}">${esc(b.headline)}</p>` +
    blocks +
    (clear.length > 0
      ? `<p style="margin:22px 0 0;font-size:13px;color:#6b7280">All clear: ${esc(clear.join(', '))}</p>`
      : '') +
    `<p style="margin:28px 0 0"><a href="${esc(opts.dashboardUrl)}/dashboard" style="display:inline-block;background:#111827;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-size:14px">Open dashboard</a></p>` +
    `<p style="margin:20px 0 0;font-size:12px;color:#9ca3af">Change delivery time, channels and sections in Settings → Daily briefing.</p></div>`;
  return { subject: `Daily briefing · ${b.headline}`.slice(0, 120), html, text: toPlainText(b) };
}

/**
 * Operating Cadence Engine — pure domain logic (no network, no React).
 * Single tested implementation for: week math, target status, trends,
 * issue ranking, agenda generation, meeting timer, 90-day review, seat tree.
 */

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export type MetricKey =
  | 'calls_answered'
  | 'booked_rate'
  | 'revenue'
  | 'margin'
  | 'dso'
  | 'csat'
  | 'utilization';

export type MetricUnit = 'count' | 'percent' | 'cents' | 'days' | 'rating';
export type Direction = 'higher' | 'lower';

export interface MetricDef {
  key: MetricKey;
  label: string;
  unit: MetricUnit;
  defaultDirection: Direction;
  /** Needs can_view_billing (masked server-side too). */
  financial: boolean;
  hint: string;
}

export const METRICS: MetricDef[] = [
  { key: 'calls_answered', label: 'Calls answered', unit: 'count', defaultDirection: 'higher', financial: false, hint: 'Calls that were not missed or sent to voicemail.' },
  { key: 'booked_rate', label: 'Booked rate', unit: 'percent', defaultDirection: 'higher', financial: false, hint: 'Booked ÷ (booked + not booked) calls.' },
  { key: 'revenue', label: 'Revenue', unit: 'cents', defaultDirection: 'higher', financial: true, hint: 'Invoices paid during the week.' },
  { key: 'margin', label: 'Margin', unit: 'percent', defaultDirection: 'higher', financial: true, hint: 'Ledger revenue minus expenses, as % of revenue.' },
  { key: 'dso', label: 'DSO', unit: 'days', defaultDirection: 'lower', financial: true, hint: 'Days sales outstanding (AR ÷ 90-day billings × 90).' },
  { key: 'csat', label: 'CSAT', unit: 'rating', defaultDirection: 'higher', financial: false, hint: 'Average rating (1–5) from completed review requests.' },
  { key: 'utilization', label: 'Technician utilization', unit: 'percent', defaultDirection: 'higher', financial: false, hint: 'Assigned jobs ÷ weekly dispatch capacity.' },
];

export const METRIC_BY_KEY: Record<MetricKey, MetricDef> = Object.fromEntries(
  METRICS.map((m) => [m.key, m]),
) as Record<MetricKey, MetricDef>;

export const isMetricKey = (k: string): k is MetricKey => k in METRIC_BY_KEY;

export interface MetricValue {
  metric_key: MetricKey;
  value: number | null;
  detail: Record<string, unknown>;
  hidden: boolean;
}

export interface Target {
  metric_key: MetricKey;
  target_value: number;
  direction: Direction;
}

export type Status = 'green' | 'red' | 'none';

export function metricStatus(value: number | null, target: Target | null | undefined): Status {
  if (value === null || !Number.isFinite(value) || !target) return 'none';
  return target.direction === 'higher' ? (value >= target.target_value ? 'green' : 'red') : value <= target.target_value ? 'green' : 'red';
}

export function formatMetric(key: MetricKey, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  switch (METRIC_BY_KEY[key].unit) {
    case 'cents':
      return (value / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    case 'percent':
      return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
    case 'days':
      return `${Math.round(value)} d`;
    case 'rating':
      return value.toFixed(2);
    default:
      return Math.round(value).toLocaleString('en-US');
  }
}

/** Target input is typed in display units (dollars for cents metrics). */
export const targetToStored = (key: MetricKey, input: number): number =>
  METRIC_BY_KEY[key].unit === 'cents' ? Math.round(input * 100) : input;
export const targetToDisplay = (key: MetricKey, stored: number): number =>
  METRIC_BY_KEY[key].unit === 'cents' ? stored / 100 : stored;

export function validateTarget(key: MetricKey, raw: string): string | null {
  const t = raw.trim();
  if (!t) return 'Enter a number.';
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return 'Must be a number ≥ 0.';
  const unit = METRIC_BY_KEY[key].unit;
  if (unit === 'percent' && n > 100) return 'Percent cannot exceed 100.';
  if (unit === 'rating' && (n < 1 || n > 5)) return 'Rating must be between 1 and 5.';
  if (n > 1_000_000_000) return 'Too large.';
  return null;
}

export interface ScorecardRow {
  def: MetricDef;
  value: number | null;
  previous: number | null;
  /** Change vs previous week; null when either side is missing. */
  delta: number | null;
  target: Target | null;
  status: Status;
  hidden: boolean;
  detail: Record<string, unknown>;
  /** Consecutive red weeks ending now (current week counts). */
  redStreak: number;
}

export function buildScorecard(args: {
  current: MetricValue[];
  previous: Record<string, number | null>;
  targets: Target[];
  history?: Record<string, (number | null)[]>;
  visibleKeys?: MetricKey[];
}): ScorecardRow[] {
  const cur = new Map(args.current.map((m) => [m.metric_key, m]));
  const tgt = new Map(args.targets.map((t) => [t.metric_key, t]));
  return METRICS.filter((d) => !args.visibleKeys || args.visibleKeys.includes(d.key)).map((def) => {
    const c = cur.get(def.key);
    const value = c?.value ?? null;
    const target = tgt.get(def.key) ?? null;
    const previous = args.previous[def.key] ?? null;
    const status = metricStatus(value, target);
    let redStreak = status === 'red' ? 1 : 0;
    if (status === 'red' && args.history?.[def.key]) {
      const past = [...args.history[def.key]].reverse(); // newest completed week first
      for (const v of past) {
        if (metricStatus(v, target) === 'red') redStreak += 1;
        else break;
      }
    }
    return {
      def,
      value,
      previous,
      delta: value !== null && previous !== null ? value - previous : null,
      target,
      status,
      hidden: c?.hidden ?? false,
      detail: c?.detail ?? {},
      redStreak,
    };
  });
}

// ---------------------------------------------------------------------------
// Week math (ISO dates, Monday-start, timezone-aware "today")
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');

export function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
const parseIso = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
/** True only for real calendar dates (rejects 2026-13-45 and 2026-02-30). */
export const isValidIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && isoDate(parseIso(s)) === s;

export function addDays(iso: string, n: number): string {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

/** The calendar date "now" has in a time zone (falls back to UTC on a bad zone). */
export function todayIn(tz: string, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${g('year')}-${g('month')}-${g('day')}`;
  } catch {
    return isoDate(now);
  }
}

export function mondayOf(iso: string): string {
  const dow = (parseIso(iso).getUTCDay() + 6) % 7; // Mon=0
  return addDays(iso, -dow);
}

export const currentWeekStart = (tz: string, now: Date = new Date()) => mondayOf(todayIn(tz, now));
export const previousWeekStart = (weekStart: string) => addDays(weekStart, -7);

/** `count` completed Monday dates before `weekStart`, oldest first. */
export function pastWeeks(weekStart: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addDays(weekStart, -7 * (count - i)));
}

export function describeWeek(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const f = (s: string) => parseIso(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${f(weekStart)} – ${f(end)}`;
}

// ---------------------------------------------------------------------------
// Trend history
// ---------------------------------------------------------------------------
export interface SnapshotRow {
  week_start: string;
  metric_key: MetricKey;
  value: number | null;
}

/** Aligned series (null = no snapshot / no data) for the given weeks. */
export function trendSeries(snaps: SnapshotRow[], key: MetricKey, weeks: string[]): (number | null)[] {
  const m = new Map<string, number | null>();
  for (const s of snaps) if (s.metric_key === key) m.set(s.week_start, s.value);
  return weeks.map((w) => m.get(w) ?? null);
}

export function previousValues(snaps: SnapshotRow[], prevWeek: string): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const s of snaps) if (s.week_start === prevWeek) out[s.metric_key] = s.value;
  return out;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------
export type IssueStatus = 'open' | 'discussing' | 'solved' | 'dropped';
export type IssueSource = 'manual' | 'alert' | 'kpi_miss' | 'comment' | 'next_best_action';

export interface Issue {
  id: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  source_type: IssueSource;
  source_ref: string | null;
  metric_key: MetricKey | null;
  impact_cents: number | null;
  needs_decision: boolean;
  owner_user_id: string | null;
  owner_name: string | null;
  resolution: string | null;
  solved_at: string | null;
  created_at: string;
  created_by?: string | null;
}

export const isLive = (i: Pick<Issue, 'status'>) => i.status === 'open' || i.status === 'discussing';

/** Live issues ranked by dollar impact (unknown last), decisions first on ties, then oldest. */
export function rankIssues<T extends Pick<Issue, 'status' | 'impact_cents' | 'needs_decision' | 'created_at'>>(issues: T[]): T[] {
  return issues
    .filter(isLive)
    .sort((a, b) => {
      const ai = a.impact_cents ?? -1;
      const bi = b.impact_cents ?? -1;
      if (ai !== bi) return bi - ai;
      if (a.needs_decision !== b.needs_decision) return a.needs_decision ? -1 : 1;
      return a.created_at.localeCompare(b.created_at);
    });
}

/** Parses "$4,200", "$1.2k", "12,500", "$3M" -> cents. Anything else -> null. */
export function parseAmountLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = label.replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*([kKmM])?/);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  if (m[2]) n *= m[2].toLowerCase() === 'k' ? 1_000 : 1_000_000;
  const cents = Math.round(n * 100);
  return cents <= 100_000_000_000 ? cents : null;
}

/** Revenue / DSO shortfall in cents for an auto-filled KPI-miss issue (else null). */
export function estimateMissImpactCents(row: Pick<ScorecardRow, 'def' | 'value' | 'target'>): number | null {
  if (row.value === null || !row.target) return null;
  if (row.def.key === 'revenue' && row.target.direction === 'higher' && row.value < row.target.target_value) {
    return Math.round(row.target.target_value - row.value);
  }
  return null;
}

export const kpiMissSourceRef = (key: MetricKey, weekStart: string) => `${key}:${weekStart}`;

export interface IssueDraft {
  title: string;
  description: string;
  impact: string; // dollars, free text
  needsDecision: boolean;
  ownerUserId: string;
}
export type IssueErrors = Partial<Record<'title' | 'description' | 'impact', string>>;

export function validateIssue(d: IssueDraft): IssueErrors {
  const e: IssueErrors = {};
  if (!d.title.trim()) e.title = 'Give the issue a title.';
  else if (d.title.trim().length > 200) e.title = 'Keep it under 200 characters.';
  if (d.description.length > 4000) e.description = 'Keep it under 4,000 characters.';
  if (d.impact.trim()) {
    const n = Number(d.impact.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) e.impact = 'Enter a dollar amount ≥ 0.';
  }
  return e;
}
export const impactToCents = (raw: string): number | null => {
  const t = raw.replace(/[$,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

// ---------------------------------------------------------------------------
// Priorities
// ---------------------------------------------------------------------------
export type PriorityStatus = 'on_track' | 'off_track' | 'done';
export interface Priority {
  id: string;
  title: string;
  description: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  due_date: string;
  status: PriorityStatus;
  progress_pct: number;
  goal_id: string | null;
  completed_at: string | null;
}

/** Quarter start (Jan/Apr/Jul/Oct 1) containing an ISO date. */
export function quarterStart(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
}
export function quarterEnd(iso: string): string {
  const [y, m] = quarterStart(iso).split('-').map(Number);
  const nm = m + 3;
  return addDays(nm > 12 ? `${y + 1}-01-01` : `${y}-${pad(nm)}-01`, -1);
}
export const quarterLabel = (iso: string) => `Q${Math.floor((Number(iso.split('-')[1]) - 1) / 3) + 1} ${iso.slice(0, 4)}`;

export const isOverdue = (p: Pick<Priority, 'status' | 'due_date'>, today: string) => p.status !== 'done' && p.due_date < today;

/** Off-track/overdue first, then soonest due, done last. */
export function sortPriorities<T extends Pick<Priority, 'status' | 'due_date'>>(list: T[], today: string): T[] {
  const rank = (p: T) => (p.status === 'done' ? 3 : isOverdue(p, today) || p.status === 'off_track' ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.due_date.localeCompare(b.due_date));
}

export interface PriorityDraft {
  title: string;
  description: string;
  ownerUserId: string;
  dueDate: string;
  goalId: string;
}
export type PriorityErrors = Partial<Record<'title' | 'description' | 'dueDate', string>>;

export function validatePriority(d: PriorityDraft): PriorityErrors {
  const e: PriorityErrors = {};
  if (!d.title.trim()) e.title = 'Give the priority a title.';
  else if (d.title.trim().length > 200) e.title = 'Keep it under 200 characters.';
  if (d.description.length > 4000) e.description = 'Keep it under 4,000 characters.';
  if (!isValidIsoDate(d.dueDate)) e.dueDate = 'Pick a due date.';
  return e;
}

// ---------------------------------------------------------------------------
// Accountability chart
// ---------------------------------------------------------------------------
export interface Seat {
  id: string;
  parent_id: string | null;
  title: string;
  holder_user_id: string | null;
  holder_name: string | null;
  responsibilities: string[];
  metric_keys: MetricKey[];
  sort_order: number;
}
export interface SeatNode extends Seat {
  children: SeatNode[];
  depth: number;
}

/** Roots first; an orphan whose parent is missing is promoted to a root. */
export function buildSeatTree(seats: Seat[]): SeatNode[] {
  const ids = new Set(seats.map((s) => s.id));
  const byParent = new Map<string | null, Seat[]>();
  for (const s of seats) {
    const p = s.parent_id && ids.has(s.parent_id) && s.parent_id !== s.id ? s.parent_id : null;
    byParent.set(p, [...(byParent.get(p) ?? []), s]);
  }
  const seen = new Set<string>();
  const walk = (p: string | null, depth: number): SeatNode[] =>
    (byParent.get(p) ?? [])
      .sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title))
      .filter((s) => !seen.has(s.id) && (seen.add(s.id), true))
      .map((s) => ({ ...s, depth, children: walk(s.id, depth + 1) }));
  return walk(null, 0);
}

/** True when making `parentId` the parent of `seatId` would create a loop. */
export function wouldCreateCycle(seats: Seat[], seatId: string, parentId: string | null): boolean {
  if (!parentId) return false;
  if (parentId === seatId) return true;
  const byId = new Map(seats.map((s) => [s.id, s]));
  let cur: string | null = parentId;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    if (cur === seatId) return true;
    guard.add(cur);
    cur = byId.get(cur)?.parent_id ?? null;
  }
  return false;
}

/** Metrics nobody owns, plus seats without a holder (gaps worth fixing). */
export function chartGaps(seats: Seat[]): { unownedMetrics: MetricKey[]; vacantSeats: string[] } {
  const owned = new Set(seats.flatMap((s) => s.metric_keys));
  return {
    unownedMetrics: METRICS.map((m) => m.key).filter((k) => !owned.has(k)),
    vacantSeats: seats.filter((s) => !s.holder_user_id && !s.holder_name).map((s) => s.title),
  };
}

// ---------------------------------------------------------------------------
// Agenda + timer
// ---------------------------------------------------------------------------
export type SegmentKey = 'scorecard' | 'priorities' | 'issues' | 'decisions';

export interface AgendaItem {
  id: string;
  title: string;
  detail: string;
  tone: 'danger' | 'neutral' | 'success';
}
export interface AgendaSegment {
  key: SegmentKey;
  title: string;
  minutes: number;
  items: AgendaItem[];
}

export const DEFAULT_MINUTES: Record<SegmentKey, number> = { scorecard: 10, priorities: 10, issues: 30, decisions: 10 };
const TOP_ISSUES = 5;

export function buildAgenda(args: {
  scorecard: ScorecardRow[];
  priorities: Priority[];
  issues: Issue[];
  today: string;
  minutes?: Partial<Record<SegmentKey, number>>;
}): AgendaSegment[] {
  const mins = { ...DEFAULT_MINUTES, ...args.minutes };
  const visible = args.scorecard.filter((r) => !r.hidden);

  const reds = visible.filter((r) => r.status === 'red');
  const scorecardItems: AgendaItem[] = [
    ...reds.map((r) => ({
      id: `m:${r.def.key}`,
      title: `${r.def.label} is off target`,
      detail: `${formatMetric(r.def.key, r.value)} vs target ${formatMetric(r.def.key, r.target?.target_value ?? null)}${r.redStreak > 1 ? ` · ${r.redStreak} weeks in a row` : ''}`,
      tone: 'danger' as const,
    })),
    ...visible
      .filter((r) => r.status === 'green')
      .map((r) => ({ id: `m:${r.def.key}`, title: r.def.label, detail: `${formatMetric(r.def.key, r.value)} — on target`, tone: 'success' as const })),
  ];
  const noTarget = visible.filter((r) => r.status === 'none' && r.value !== null);
  if (noTarget.length) {
    scorecardItems.push({ id: 'm:no-target', title: `${noTarget.length} metric${noTarget.length > 1 ? 's' : ''} without a target`, detail: noTarget.map((r) => r.def.label).join(', '), tone: 'neutral' });
  }

  const open = sortPriorities(args.priorities.filter((p) => p.status !== 'done'), args.today);
  const priorityItems: AgendaItem[] = open.map((p) => ({
    id: `p:${p.id}`,
    title: p.title,
    detail: `${p.owner_name ?? 'Unassigned'} · due ${p.due_date} · ${p.progress_pct}%${isOverdue(p, args.today) ? ' · overdue' : p.status === 'off_track' ? ' · off track' : ''}`,
    tone: isOverdue(p, args.today) || p.status === 'off_track' ? ('danger' as const) : ('neutral' as const),
  }));

  const ranked = rankIssues(args.issues);
  const issueItems: AgendaItem[] = ranked.slice(0, TOP_ISSUES).map((i) => ({
    id: `i:${i.id}`,
    title: i.title,
    detail: i.impact_cents !== null ? `${(i.impact_cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} impact` : 'Impact not estimated',
    tone: i.impact_cents !== null && i.impact_cents > 0 ? ('danger' as const) : ('neutral' as const),
  }));
  const decisionItems: AgendaItem[] = ranked
    .filter((i) => i.needs_decision)
    .map((i) => ({ id: `d:${i.id}`, title: i.title, detail: i.owner_name ? `Owner: ${i.owner_name}` : 'No owner yet', tone: 'neutral' as const }));

  return [
    { key: 'scorecard', title: 'Scorecard review', minutes: mins.scorecard, items: scorecardItems },
    { key: 'priorities', title: 'Priority check', minutes: mins.priorities, items: priorityItems },
    { key: 'issues', title: 'Top issues by dollar impact', minutes: mins.issues, items: issueItems },
    { key: 'decisions', title: 'Decisions needed', minutes: mins.decisions, items: decisionItems },
  ];
}

export interface TimerState {
  segmentStartedAt: string | null;
  elapsedMs: number[]; // finished segments (index-aligned)
  current: number;
}

/** Remaining ms for the current segment (negative = overrun). */
export function segmentRemainingMs(minutes: number, startedAt: string | null, now: number): number {
  const spent = startedAt ? Math.max(0, now - new Date(startedAt).getTime()) : 0;
  return minutes * 60_000 - spent;
}

export function formatClock(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const total = Math.floor(Math.abs(ms) / 1000);
  return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** Finishes the current segment and moves on; returns the new timer state. */
export function advanceSegment(t: TimerState, total: number, now: number): TimerState {
  const spent = t.segmentStartedAt ? Math.max(0, now - new Date(t.segmentStartedAt).getTime()) : 0;
  const elapsed = [...t.elapsedMs];
  elapsed[t.current] = (elapsed[t.current] ?? 0) + spent;
  const next = Math.min(t.current + 1, total);
  return { current: next, elapsedMs: elapsed, segmentStartedAt: next < total ? new Date(now).toISOString() : null };
}

export const totalMeetingMinutes = (segs: AgendaSegment[]) => segs.reduce((s, x) => s + x.minutes, 0);

// ---------------------------------------------------------------------------
// Action items
// ---------------------------------------------------------------------------
export interface ActionDraft {
  title: string;
  ownerUserId: string;
  dueDate: string;
}
export type ActionErrors = Partial<Record<'title' | 'dueDate', string>>;

export function validateAction(d: ActionDraft, today: string): ActionErrors {
  const e: ActionErrors = {};
  if (!d.title.trim()) e.title = 'Describe the action.';
  else if (d.title.trim().length > 200) e.title = 'Keep it under 200 characters.';
  if (d.dueDate && (!isValidIsoDate(d.dueDate) || d.dueDate < today)) e.dueDate = 'Pick today or a future date.';
  return e;
}

// ---------------------------------------------------------------------------
// 90-day review
// ---------------------------------------------------------------------------
export interface MetricReview {
  key: MetricKey;
  weeksWithData: number;
  weeksGreen: number;
  greenPct: number | null;
  average: number | null;
  first: number | null;
  last: number | null;
  trend: 'up' | 'down' | 'flat' | 'unknown';
  /** True when the trend is moving the right way for this metric's direction. */
  improving: boolean | null;
}

export function reviewMetric(key: MetricKey, series: (number | null)[], target: Target | null): MetricReview {
  const vals = series.filter((v): v is number => v !== null && Number.isFinite(v));
  const green = target ? vals.filter((v) => metricStatus(v, target) === 'green').length : 0;
  const half = Math.floor(vals.length / 2);
  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const early = avg(vals.slice(0, half || 1));
  const late = avg(vals.slice(half));
  let trend: MetricReview['trend'] = 'unknown';
  if (vals.length >= 4 && early !== null && late !== null) {
    const base = Math.abs(early) || 1;
    const ch = (late - early) / base;
    trend = Math.abs(ch) < 0.03 ? 'flat' : ch > 0 ? 'up' : 'down';
  }
  const dir = target?.direction ?? METRIC_BY_KEY[key].defaultDirection;
  return {
    key,
    weeksWithData: vals.length,
    weeksGreen: green,
    greenPct: target && vals.length ? Math.round((green / vals.length) * 100) : null,
    average: avg(vals),
    first: vals[0] ?? null,
    last: vals.length ? vals[vals.length - 1] : null,
    trend,
    improving: trend === 'unknown' ? null : trend === 'flat' ? true : (trend === 'up') === (dir === 'higher'),
  };
}

export interface QuarterReview {
  metrics: MetricReview[];
  priorities: { total: number; done: number; offTrack: number; overdue: number; completionPct: number | null };
  issues: { created: number; solved: number; stillLive: number; avgDaysToSolve: number | null };
  meetings: { held: number; actionItems: number };
}

const DAY = 86_400_000;

export function buildQuarterReview(args: {
  weeks: string[];
  snapshots: SnapshotRow[];
  targets: Target[];
  priorities: Priority[];
  issues: Issue[];
  meetingsHeld: number;
  actionItems: number;
  today: string;
  sinceIso: string;
}): QuarterReview {
  const tgt = new Map(args.targets.map((t) => [t.metric_key, t]));
  const visibleKeys = new Set(args.snapshots.map((s) => s.metric_key));
  const metrics = METRICS.filter((m) => visibleKeys.has(m.key)).map((m) =>
    reviewMetric(m.key, trendSeries(args.snapshots, m.key, args.weeks), tgt.get(m.key) ?? null),
  );
  const pri = args.priorities;
  const done = pri.filter((p) => p.status === 'done').length;
  const created = args.issues.filter((i) => i.created_at.slice(0, 10) >= args.sinceIso);
  const solved = args.issues.filter((i) => i.status === 'solved' && i.solved_at && i.solved_at.slice(0, 10) >= args.sinceIso);
  const days = solved.map((i) => (new Date(i.solved_at as string).getTime() - new Date(i.created_at).getTime()) / DAY);
  return {
    metrics,
    priorities: {
      total: pri.length,
      done,
      offTrack: pri.filter((p) => p.status === 'off_track').length,
      overdue: pri.filter((p) => isOverdue(p, args.today)).length,
      completionPct: pri.length ? Math.round((done / pri.length) * 100) : null,
    },
    issues: {
      created: created.length,
      solved: solved.length,
      stillLive: args.issues.filter(isLive).length,
      avgDaysToSolve: days.length ? Math.round((days.reduce((s, v) => s + v, 0) / days.length) * 10) / 10 : null,
    },
    meetings: { held: args.meetingsHeld, actionItems: args.actionItems },
  };
}

// ---------------------------------------------------------------------------
// Roles (UI views; the database enforces the same rules)
// ---------------------------------------------------------------------------
export type CadenceRole = 'owner' | 'manager' | 'member';

export function cadenceRole(a: { isOwner: boolean; canViewAllJobs: boolean }): CadenceRole {
  return a.isOwner ? 'owner' : a.canViewAllJobs ? 'manager' : 'member';
}

export type TabKey = 'scorecard' | 'priorities' | 'issues' | 'chart' | 'meeting' | 'review';

export const TABS: { key: TabKey; label: string; roles: CadenceRole[] }[] = [
  { key: 'scorecard', label: 'Scorecard', roles: ['owner', 'manager', 'member'] },
  { key: 'priorities', label: 'Priorities', roles: ['owner', 'manager', 'member'] },
  { key: 'issues', label: 'Issues', roles: ['owner', 'manager', 'member'] },
  { key: 'chart', label: 'Accountability', roles: ['owner', 'manager', 'member'] },
  { key: 'meeting', label: 'Meeting', roles: ['owner', 'manager'] },
  { key: 'review', label: '90-day review', roles: ['owner', 'manager'] },
];

export const tabsFor = (role: CadenceRole) => TABS.filter((t) => t.roles.includes(role));

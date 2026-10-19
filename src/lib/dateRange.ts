/**
 * Shared date-range + period-comparison engine for Overview, Analytics,
 * Profitability and Marketing.
 *
 * Pure functions only (no React, no Supabase) so every rule below is unit
 * tested in dateRange.test.ts. All dates are LOCAL calendar days — a range
 * is "Oct 1 00:00:00.000 → Oct 11 23:59:59.999" in the viewer's timezone —
 * and all day arithmetic goes through calendar math (never `+ 86400000`),
 * so DST transitions can't shift a boundary by an hour.
 */

// ============================================================
// TYPES & CONSTANTS
// ============================================================

export type RangePreset = 'today' | '7d' | '30d' | '90d' | 'mtd' | 'qtd' | 'custom';

export const RANGE_PRESETS: readonly RangePreset[] = [
  'today',
  '7d',
  '30d',
  '90d',
  'mtd',
  'qtd',
  'custom',
];

export const PRESET_LABELS: Record<RangePreset, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  mtd: 'Month to date',
  qtd: 'Quarter to date',
  custom: 'Custom range',
};

/** Longest custom range we accept (keeps charts and queries bounded). */
export const MAX_CUSTOM_DAYS = 366;

/** Above this many days, time series switch from daily to weekly buckets. */
export const MAX_DAILY_POINTS = 92;

/** What is stored in the URL. */
export interface RangeSelection {
  preset: RangePreset;
  /** YYYY-MM-DD, only for preset === 'custom' */
  from: string | null;
  /** YYYY-MM-DD, only for preset === 'custom' */
  to: string | null;
  compare: boolean;
}

export interface ResolvedRange {
  preset: RangePreset;
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
  days: number;
  prevDays: number;
  label: string;
  prevLabel: string;
  compare: boolean;
}

export type Polarity = 'higherIsBetter' | 'lowerIsBetter' | 'neutral';
export type DeltaKind = 'percent' | 'points';
export type DeltaDirection = 'up' | 'down' | 'flat' | 'new' | 'none';
export type DeltaSentiment = 'good' | 'bad' | 'neutral';

export interface Delta {
  kind: DeltaKind;
  direction: DeltaDirection;
  /** Percent change (kind 'percent') or percentage-point change (kind 'points'). null for 'new' / 'none'. */
  value: number | null;
  sentiment: DeltaSentiment;
  current: number | null;
  previous: number | null;
}

// ============================================================
// LOCAL-DAY HELPERS
// ============================================================

const pad = (n: number) => String(n).padStart(2, '0');

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/** Calendar-day arithmetic (DST-safe). Returns local midnight. */
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 0, 0, 0, 0);
}

/** Whole calendar days from a to b (b - a), ignoring time of day and DST. */
export function diffDays(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86_400_000);
}

/** Inclusive number of calendar days in [start, end]. */
export function countDays(start: Date, end: Date): number {
  return diffDays(start, end) + 1;
}

/** Local YYYY-MM-DD (NOT toISOString, which is UTC and can be off by one day). */
export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Strict YYYY-MM-DD → local midnight, or null if malformed / not a real date (e.g. 2026-02-30). */
export function parseISODate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d, 0, 0, 0, 0);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

/** True when `value` (ISO timestamp) falls inside [start, end]. Null / invalid → false. */
export function inRange(value: string | null | undefined, start: Date, end: Date): boolean {
  if (!value) return false;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return false;
  return t >= start.getTime() && t <= end.getTime();
}

// ============================================================
// LABELS
// ============================================================

export function formatRangeLabel(start: Date, end: Date, now: Date = new Date()): string {
  const withYear =
    start.getFullYear() !== end.getFullYear() || end.getFullYear() !== now.getFullYear();
  const opts: Intl.DateTimeFormatOptions = withYear
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' };
  const fmt = new Intl.DateTimeFormat('en-US', opts);
  if (diffDays(start, end) === 0) return fmt.format(start);
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

// ============================================================
// VALIDATION (custom range)
// ============================================================

export type CustomRangeCheck =
  { ok: true; from: string; to: string } | { ok: false; error: string };

export function validateCustomRange(
  from: string | null | undefined,
  to: string | null | undefined,
  now: Date = new Date(),
): CustomRangeCheck {
  const a = parseISODate(from);
  const b = parseISODate(to);
  if (!a || !b) return { ok: false, error: 'Choose both a start and an end date.' };
  const today = startOfDay(now);
  if (a.getTime() > today.getTime())
    return { ok: false, error: 'The start date cannot be in the future.' };
  if (a.getTime() > b.getTime())
    return { ok: false, error: 'The start date must be on or before the end date.' };
  const clampedTo = b.getTime() > today.getTime() ? today : b;
  if (countDays(a, clampedTo) > MAX_CUSTOM_DAYS) {
    return { ok: false, error: `Ranges can span at most ${MAX_CUSTOM_DAYS} days.` };
  }
  return { ok: true, from: toISODate(a), to: toISODate(clampedTo) };
}

// ============================================================
// URL  <->  SELECTION
// ============================================================

const isPreset = (v: string | null): v is RangePreset =>
  !!v && (RANGE_PRESETS as readonly string[]).includes(v);

/**
 * Reads ?range=&from=&to=&compare= . Anything invalid silently falls back to
 * the page default, so a hand-edited or stale link never breaks the page.
 * Compare defaults to ON; `compare=0` turns it off.
 */
export function parseRangeParams(
  params: URLSearchParams,
  defaultPreset: RangePreset,
  now: Date = new Date(),
): RangeSelection {
  const compare = params.get('compare') !== '0';
  const raw = params.get('range');
  const preset = isPreset(raw) ? raw : defaultPreset;

  if (preset === 'custom') {
    const check = validateCustomRange(params.get('from'), params.get('to'), now);
    if (check.ok) return { preset: 'custom', from: check.from, to: check.to, compare };
    return {
      preset: defaultPreset === 'custom' ? '30d' : defaultPreset,
      from: null,
      to: null,
      compare,
    };
  }
  return { preset, from: null, to: null, compare };
}

/**
 * Writes the selection into a COPY of `base`, preserving every unrelated
 * param (?tab=, ?job=, …). Defaults are omitted so the common case keeps a
 * clean URL.
 */
export function serializeRangeParams(
  selection: RangeSelection,
  base: URLSearchParams,
  defaultPreset: RangePreset,
): URLSearchParams {
  const next = new URLSearchParams(base);
  ['range', 'from', 'to', 'compare'].forEach((k) => next.delete(k));
  if (selection.preset === 'custom' && selection.from && selection.to) {
    next.set('range', 'custom');
    next.set('from', selection.from);
    next.set('to', selection.to);
  } else if (selection.preset !== defaultPreset && selection.preset !== 'custom') {
    next.set('range', selection.preset);
  }
  if (!selection.compare) next.set('compare', '0');
  return next;
}

// ============================================================
// RESOLUTION  (selection → concrete windows)
// ============================================================

function build(
  preset: RangePreset,
  start: Date,
  end: Date,
  prevStart: Date,
  prevEnd: Date,
  compare: boolean,
  now: Date,
): ResolvedRange {
  return {
    preset,
    start,
    end,
    prevStart,
    prevEnd,
    days: countDays(start, end),
    prevDays: countDays(prevStart, prevEnd),
    label: formatRangeLabel(start, end, now),
    prevLabel: formatRangeLabel(prevStart, prevEnd, now),
    compare,
  };
}

/** Rolling window of `days` days ending today, vs the immediately preceding window of equal length. */
function rolling(preset: RangePreset, days: number, compare: boolean, now: Date): ResolvedRange {
  const today = startOfDay(now);
  const start = addDays(today, -(days - 1));
  const prevStart = addDays(start, -days);
  return build(
    preset,
    start,
    endOfDay(today),
    prevStart,
    endOfDay(addDays(start, -1)),
    compare,
    now,
  );
}

/**
 * Month/quarter to date compare against the SAME ELAPSED DAYS of the previous
 * month/quarter (e.g. Oct 1–11 vs Sep 1–11), clamped to that period's length —
 * comparing 11 days to a full month would make every delta look terrible.
 */
function periodToDate(preset: 'mtd' | 'qtd', compare: boolean, now: Date): ResolvedRange {
  const today = startOfDay(now);
  const span = preset === 'mtd' ? 1 : 3;
  const startMonth = preset === 'mtd' ? today.getMonth() : Math.floor(today.getMonth() / 3) * 3;
  const start = new Date(today.getFullYear(), startMonth, 1);
  const prevStart = new Date(today.getFullYear(), startMonth - span, 1);
  const prevLength = diffDays(prevStart, start);
  const elapsed = countDays(start, today);
  const prevEnd = endOfDay(addDays(prevStart, Math.min(elapsed, prevLength) - 1));
  return build(preset, start, endOfDay(today), prevStart, prevEnd, compare, now);
}

export function resolveRange(
  selection: RangeSelection,
  defaultPreset: RangePreset = '30d',
  now: Date = new Date(),
): ResolvedRange {
  const { compare } = selection;
  switch (selection.preset) {
    case 'today': {
      const today = startOfDay(now);
      const yesterday = addDays(today, -1);
      return build('today', today, endOfDay(today), yesterday, endOfDay(yesterday), compare, now);
    }
    case '7d':
      return rolling('7d', 7, compare, now);
    case '30d':
      return rolling('30d', 30, compare, now);
    case '90d':
      return rolling('90d', 90, compare, now);
    case 'mtd':
      return periodToDate('mtd', compare, now);
    case 'qtd':
      return periodToDate('qtd', compare, now);
    case 'custom': {
      const check = validateCustomRange(selection.from, selection.to, now);
      if (check.ok) {
        const start = parseISODate(check.from) as Date;
        const end = parseISODate(check.to) as Date;
        const days = countDays(start, end);
        const prevStart = addDays(start, -days);
        return build(
          'custom',
          start,
          endOfDay(end),
          prevStart,
          endOfDay(addDays(start, -1)),
          compare,
          now,
        );
      }
      return resolveRange(
        {
          preset: defaultPreset === 'custom' ? '30d' : defaultPreset,
          from: null,
          to: null,
          compare,
        },
        defaultPreset,
        now,
      );
    }
  }
}

// ============================================================
// DELTAS
// ============================================================

const round1 = (n: number) => Math.round(n * 10) / 10;

function sentimentFor(sign: 1 | -1 | 0, polarity: Polarity): DeltaSentiment {
  if (sign === 0 || polarity === 'neutral') return 'neutral';
  const rising = sign > 0;
  return (rising && polarity === 'higherIsBetter') || (!rising && polarity === 'lowerIsBetter')
    ? 'good'
    : 'bad';
}

/**
 * Compare a value with its previous-period value.
 *  - kind 'percent' (counts, money): relative change. Previous 0 → "new", never Infinity/NaN.
 *  - kind 'points'  (rates already in %): absolute percentage-point change.
 *  - null/undefined/NaN on either side → 'none' (rendered as "no prior data").
 * `polarity` decides whether an increase is good (revenue), bad (cost, missed-call rate) or neutral.
 */
export function computeDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
  opts: { polarity?: Polarity; kind?: DeltaKind } = {},
): Delta {
  const { polarity = 'higherIsBetter', kind = 'percent' } = opts;
  const none: Delta = {
    kind,
    direction: 'none',
    value: null,
    sentiment: 'neutral',
    current: current ?? null,
    previous: previous ?? null,
  };
  if (
    current == null ||
    previous == null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous)
  )
    return none;

  const sign: 1 | -1 | 0 = current > previous ? 1 : current < previous ? -1 : 0;

  if (kind === 'points') {
    const diff = round1(current - previous);
    if (Math.abs(diff) < 0.05) return { ...none, direction: 'flat', value: 0 };
    return {
      ...none,
      direction: diff > 0 ? 'up' : 'down',
      value: diff,
      sentiment: sentimentFor(sign, polarity),
    };
  }

  if (previous === 0) {
    if (current === 0) return { ...none, direction: 'flat', value: 0 };
    return { ...none, direction: 'new', value: null, sentiment: sentimentFor(sign, polarity) };
  }

  const pct = round1(((current - previous) / Math.abs(previous)) * 100);
  if (Math.abs(pct) < 0.05) return { ...none, direction: 'flat', value: 0 };
  return {
    ...none,
    direction: pct > 0 ? 'up' : 'down',
    value: pct,
    sentiment: sentimentFor(sign, polarity),
  };
}

export function formatDelta(delta: Delta): string {
  switch (delta.direction) {
    case 'none':
      return '—';
    case 'new':
      return 'New';
    case 'flat':
      return delta.kind === 'points' ? '0 pts' : '0%';
    default: {
      const v = delta.value ?? 0;
      const sign = v > 0 ? '+' : '−';
      const abs = Math.abs(v);
      if (delta.kind === 'points') return `${sign}${abs.toFixed(1)} pts`;
      return abs >= 1000 ? `${sign}999%+` : `${sign}${abs.toFixed(1)}%`;
    }
  }
}

/** Screen-reader sentence, e.g. "Up 12.5% versus Sep 11 – Oct 10". */
export function describeDelta(delta: Delta, versus = 'the previous period'): string {
  switch (delta.direction) {
    case 'none':
      return `No data for ${versus}`;
    case 'new':
      return `New — there was no activity in ${versus}`;
    case 'flat':
      return `Unchanged versus ${versus}`;
    default: {
      const abs = Math.abs(delta.value ?? 0);
      const unit = delta.kind === 'points' ? ' percentage points' : '%';
      const shown = delta.kind === 'percent' && abs >= 1000 ? 'more than 999' : abs.toFixed(1);
      return `${delta.direction === 'up' ? 'Up' : 'Down'} ${shown}${unit} versus ${versus}`;
    }
  }
}

// ============================================================
// TIME-SERIES BUCKETING
// ============================================================

export interface SeriesPoint {
  /** ISO timestamp of the bucket's first day (local midnight). */
  date: string;
  count: number;
}

/**
 * Counts items per day across [start, end] (zero-filled). Ranges longer than
 * MAX_DAILY_POINTS days are grouped into 7-day buckets so charts stay readable.
 */
export function bucketCounts<T>(
  items: readonly T[],
  getDate: (item: T) => string | null | undefined,
  start: Date,
  end: Date,
): { points: SeriesPoint[]; bucketDays: number } {
  const days = countDays(start, end);
  const bucketDays = days > MAX_DAILY_POINTS ? 7 : 1;
  const buckets = Math.ceil(days / bucketDays);
  const counts = new Array<number>(buckets).fill(0);
  const startMs = start.getTime();
  const endMs = end.getTime();

  for (const item of items) {
    const raw = getDate(item);
    if (!raw) continue;
    const t = Date.parse(raw);
    if (Number.isNaN(t) || t < startMs || t > endMs) continue;
    const idx = Math.floor(diffDays(start, new Date(t)) / bucketDays);
    if (idx >= 0 && idx < buckets) counts[idx] += 1;
  }

  return {
    points: counts.map((count, i) => ({
      date: addDays(start, i * bucketDays).toISOString(),
      count,
    })),
    bucketDays,
  };
}

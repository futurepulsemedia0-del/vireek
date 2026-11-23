// PMF ("how disappointed would you be") - pure helpers shared by the staff page and the tests.
// Method, thresholds and limits: docs/analytics/pmf.md. The server (migration 20290307000100_pmf_survey.sql)
// owns eligibility; the numbers below that mirror it are marked and covered by a test.

export const PMF_ANSWERS = ['very_disappointed', 'somewhat_disappointed', 'not_disappointed', 'no_longer_use'] as const;
export type PmfAnswer = (typeof PMF_ANSWERS)[number];
export const isPmfAnswer = (v: unknown): v is PmfAnswer => typeof v === 'string' && (PMF_ANSWERS as readonly string[]).includes(v);

/** Mirrors _pmf_due(): minimum account age (days) and calls+jobs in the last 30 days. */
export const PMF_MIN_ACCOUNT_AGE_DAYS = 30;
export const PMF_MIN_USAGE_30D = 10;
/** Widely used rule of thumb (Sean Ellis): >= 40% "very disappointed". A heuristic, not a guarantee. */
export const PMF_BENCHMARK_PCT = 40;
/** Below this many responses a percentage is too noisy to act on. */
export const PMF_MIN_RELIABLE_N = 40;
/** Mirrors the server: groups smaller than this are merged into "small_groups". */
export const PMF_MIN_GROUP = 5;
export const PMF_SMALL_GROUPS = 'small_groups';

export const PMF_DIMENSIONS = ['all', 'plan', 'role', 'trade', 'team_size', 'tenure_bucket', 'usage_bucket'] as const;
export type PmfDimension = (typeof PMF_DIMENSIONS)[number];
export const RETENTION_DIMENSIONS = ['all', 'plan', 'trade', 'team_size'] as const;
export type RetentionDimension = (typeof RETENTION_DIMENSIONS)[number];

export interface PmfSegmentRow {
  segment: string;
  n: number;
  very: number;
  somewhat: number;
  notDisappointed: number;
  noLongerUse: number;
  pctVery: number;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const str = (v: unknown, fallback = 'unknown'): string => (typeof v === 'string' && v ? v : fallback);

export function parsePmfSummary(raw: unknown): PmfSegmentRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = obj(r);
    const n = int(o.n);
    const very = int(o.very);
    return {
      segment: str(o.segment),
      n,
      very,
      somewhat: int(o.somewhat),
      notDisappointed: int(o.not_disappointed),
      noLongerUse: int(o.no_longer_use),
      pctVery: n > 0 ? Math.round((1000 * very) / n) / 10 : 0,
    };
  });
}

export type PmfVerdict = 'too_few' | 'below_benchmark' | 'at_or_above_benchmark';

/** "no_longer_use" counts in the denominator (they are respondents who are not "very disappointed"). */
export function pmfVerdict(row: Pick<PmfSegmentRow, 'n' | 'pctVery'>): PmfVerdict {
  if (row.n < PMF_MIN_RELIABLE_N) return 'too_few';
  return row.pctVery >= PMF_BENCHMARK_PCT ? 'at_or_above_benchmark' : 'below_benchmark';
}

export function overallPmf(rows: readonly PmfSegmentRow[]): { n: number; very: number; pctVery: number } {
  const n = rows.reduce((a, r) => a + r.n, 0);
  const very = rows.reduce((a, r) => a + r.very, 0);
  return { n, very, pctVery: n > 0 ? Math.round((1000 * very) / n) / 10 : 0 };
}

export interface RetentionRow {
  segment: string;
  weekOffset: number;
  cohortAccounts: number;
  activeAccounts: number;
  retentionPct: number;
}

export function parseRetention(raw: unknown): RetentionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = obj(r);
    const cohortAccounts = int(o.cohort_accounts);
    const activeAccounts = Math.min(int(o.active_accounts), cohortAccounts);
    return {
      segment: str(o.segment),
      weekOffset: int(o.week_offset),
      cohortAccounts,
      activeAccounts,
      retentionPct: cohortAccounts > 0 ? Math.round((1000 * activeAccounts) / cohortAccounts) / 10 : 0,
    };
  });
}

export interface RetentionMatrix {
  segments: string[];
  offsets: number[];
  /** null = no cohort has reached this week yet. */
  cell: (segment: string, offset: number) => RetentionRow | null;
}

/** Segments keep server order except "small_groups", which is always last. */
export function retentionMatrix(rows: readonly RetentionRow[], maxOffset = 12): RetentionMatrix {
  const seen: string[] = [];
  const byKey = new Map<string, RetentionRow>();
  for (const r of rows) {
    if (r.weekOffset > maxOffset) continue;
    if (!seen.includes(r.segment)) seen.push(r.segment);
    byKey.set(`${r.segment}|${r.weekOffset}`, r);
  }
  const segments = [...seen.filter((s) => s !== PMF_SMALL_GROUPS), ...seen.filter((s) => s === PMF_SMALL_GROUPS)];
  const offsets = Array.from(new Set(rows.filter((r) => r.weekOffset <= maxOffset).map((r) => r.weekOffset))).sort((a, b) => a - b);
  return { segments, offsets, cell: (s, o) => byKey.get(`${s}|${o}`) ?? null };
}

import { supabase } from '@/lib/supabase';
import { computeDelta, type Delta, type Polarity } from '@/lib/dateRange';

/** Period counts shown on the Marketing overview. */
export interface MarketingPeriodCounts {
  leads: number;
  touches: number;
  enrollments: number;
  conversions: number;
  referralCodes: number;
  referralConversions: number;
}

export interface MarketingKpi {
  key: keyof MarketingPeriodCounts;
  label: string;
  hint: string;
  value: number;
  /** null when comparison is switched off */
  delta: Delta | null;
}

const KPI_DEFS: {
  key: keyof MarketingPeriodCounts;
  label: string;
  hint: string;
  polarity: Polarity;
}[] = [
  {
    key: 'leads',
    label: 'New leads',
    hint: 'Leads created in this period',
    polarity: 'higherIsBetter',
  },
  {
    key: 'touches',
    label: 'Tracked visits',
    hint: 'Attribution touches recorded',
    polarity: 'higherIsBetter',
  },
  {
    key: 'enrollments',
    label: 'Campaign enrollments',
    hint: 'People entering a campaign',
    polarity: 'higherIsBetter',
  },
  {
    key: 'conversions',
    label: 'Campaign conversions',
    hint: 'Enrollments that hit the goal',
    polarity: 'higherIsBetter',
  },
  {
    key: 'referralCodes',
    label: 'Referral codes issued',
    hint: 'New codes created',
    polarity: 'higherIsBetter',
  },
  {
    key: 'referralConversions',
    label: 'Referral conversions',
    hint: 'Referred customers won',
    polarity: 'higherIsBetter',
  },
];

/** Pure: turns two sets of counts into KPI rows with delta badges. */
export function buildMarketingKpis(
  current: MarketingPeriodCounts,
  previous: MarketingPeriodCounts | null,
  compare: boolean,
): MarketingKpi[] {
  return KPI_DEFS.map(({ key, label, hint, polarity }) => ({
    key,
    label,
    hint,
    value: current[key],
    delta: compare && previous ? computeDelta(current[key], previous[key], { polarity }) : null,
  }));
}

/**
 * Exact server-side counts (head-only requests, no rows transferred), so the
 * numbers stay correct past PostgREST's 1,000-row default page size.
 * RLS already scopes every table to the account.
 */
async function countInWindow(
  table: string,
  column: string,
  start: Date,
  end: Date,
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .gte(column, start.toISOString())
    .lte(column, end.toISOString());
  if (error) throw error;
  return count ?? 0;
}

export async function fetchMarketingCounts(start: Date, end: Date): Promise<MarketingPeriodCounts> {
  const [leads, touches, enrollments, conversions, referralCodes, referralConversions] =
    await Promise.all([
      countInWindow('leads', 'created_at', start, end),
      countInWindow('marketing_attribution_touches', 'occurred_at', start, end),
      countInWindow('marketing_campaign_enrollments', 'enrolled_at', start, end),
      countInWindow('marketing_campaign_enrollments', 'converted_at', start, end),
      countInWindow('referral_codes', 'created_at', start, end),
      countInWindow('referral_conversions', 'converted_at', start, end),
    ]);
  return { leads, touches, enrollments, conversions, referralCodes, referralConversions };
}

import { DEFAULT_CLAIM_RATE, simulateBackfill, simulateHolds, type Candidate, type HoldReplayResult, type SimResult } from '../../../supabase/functions/_shared/capacity-guard/engine';
import type { GuardSettings } from './api';

export interface ReplayJob { service_type: string | null; created_at: string; scheduled_datetime: string | null; job_status: string; invoice_amount: number | null }
export interface ReplayInput { jobs: ReplayJob[]; technicians: number; maxJobsPerDay: number; settings: Pick<GuardSettings, 'hold_share_pct' | 'trade_rules' | 'backfill_max_offers_per_customer_24h' | 'backfill_max_offers_per_customer_7d' | 'backfill_offer_ttl_minutes' | 'backfill_batch_size'>; waitlistSize: number; dayKeyOf: (ms: number) => string }
export interface ReplayOutput { holds: HoldReplayResult; backfill: SimResult; cancellations: number }

const matches = (service: string | null, trade: string) => { const s = (service ?? '').toLowerCase(), t = trade.trim().toLowerCase(); return !!t && (s.includes(t) || s.includes(t.replace(/_/g, ' '))); };

/** "What would have happened last week" — always SIMULATED; uses real jobs of the replayed week. */
export function replayLastWeek(i: ReplayInput): ReplayOutput {
  const trades = i.settings.trade_rules;
  const days = new Map<string, { booked: number; arrivals: Map<string, { n: number; cents: number }> }>();
  const day = (k: string) => { const d = days.get(k) ?? { booked: 0, arrivals: new Map() }; days.set(k, d); return d; };
  let cancellations = 0;
  for (const j of i.jobs) {
    if (j.scheduled_datetime && j.job_status !== 'cancelled' && j.job_status !== 'no_show') day(i.dayKeyOf(Date.parse(j.scheduled_datetime))).booked += 1;
    if (j.job_status === 'cancelled' || j.job_status === 'no_show') cancellations += 1;
    for (const r of trades) if (matches(j.service_type, r.trade)) {
      const a = day(i.dayKeyOf(Date.parse(j.created_at))).arrivals;
      const cur = a.get(r.trade) ?? { n: 0, cents: 0 };
      a.set(r.trade, { n: cur.n + 1, cents: cur.cents + Math.round((j.invoice_amount ?? 0) * 100) });
    }
  }
  const capacity = Math.max(0, i.technicians * i.maxJobsPerDay);
  const rows = [...days.entries()].flatMap(([dayKey, d]) => trades.map((r) => {
    const a = d.arrivals.get(r.trade) ?? { n: 0, cents: 0 };
    return { dayKey, trade: r.trade, freeUnits: Math.max(0, capacity - d.booked), highValueArrivals: a.n, avgValueCents: a.n ? Math.round(a.cents / a.n) : 0 };
  }));
  const share = (t: string) => i.settings.trade_rules.find((r) => r.trade === t)?.hold_share_pct ?? i.settings.hold_share_pct;
  const holds = simulateHolds(rows, share);
  const pool: Candidate[] = Array.from({ length: i.waitlistSize }, (_, n) => ({
    type: 'waitlist', ref: `w${n}`, customerId: null, name: 'w', phoneNorm: `+1000${n}`, estValueCents: 0, distanceKm: null, ageDays: 0,
    marketingOptIn: false, prefsAllowSms: true, prefsAllowMarketing: false, prefsAllowReminders: true, sentLast24h: 0, sentLast7d: 0,
  }));
  const backfill = simulateBackfill(Array.from({ length: cancellations }, (_, n) => ({ id: `g${n}`, valueCents: 0, leadMinutes: 180, pool })), {
    caps: { max24h: i.settings.backfill_max_offers_per_customer_24h, max7d: i.settings.backfill_max_offers_per_customer_7d },
    ttlMinutes: i.settings.backfill_offer_ttl_minutes, batchSize: i.settings.backfill_batch_size, claimRate: DEFAULT_CLAIM_RATE, seed: 1,
  });
  return { holds, backfill, cancellations };
}

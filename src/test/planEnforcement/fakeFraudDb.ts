// src/test/planEnforcement/fakeFraudDb.ts
//
// In-memory stand-in for the Supabase client that guardOutbound() talks to. The ledger rule is NOT re-implemented
// here: fraud_reserve delegates to the production tryReserve() from planLimits.ts (which the SQL function mirrors),
// so a bug in the real caps arithmetic shows up in the tests. Everything else is a thin recorder.

import type { FraudDb } from '../../../supabase/functions/_shared/fraud/guard';
import { tryReserve, type LedgerState } from '../../../supabase/functions/_shared/fraud/planLimits';

export interface FakeContext {
  enforce: boolean;
  kill_outbound_calls: boolean;
  kill_sms: boolean;
  kill_international: boolean;
  status: 'active' | 'throttled' | 'suspended';
  status_reason: string | null;
  outbound_unlocked: boolean;
  international_unlocked: boolean;
  voice_clone_unlocked: boolean;
  allowed_countries: string[];
  plan: string;
  account_age_days: number;
}

export const BASE_CONTEXT: FakeContext = {
  enforce: true,
  kill_outbound_calls: false,
  kill_sms: false,
  kill_international: false,
  status: 'active',
  status_reason: null,
  outbound_unlocked: true,
  international_unlocked: false,
  voice_clone_unlocked: true,
  allowed_countries: [],
  plan: 'professional',
  account_age_days: 365, // past the new-account ramp, so caps equal PLAN_LIMITS exactly
};

export interface MarketingChecks {
  consent_mode: 'off' | 'log' | 'enforce';
  has_consent: boolean;
  approval_required: boolean;
  campaign_status: 'none' | 'pending' | 'approved' | 'rejected';
}

export interface FakeDbOptions {
  /** Partial context merged over BASE_CONTEXT. null = the fraud store is unreachable. */
  context?: Partial<FakeContext> | null;
  /** Counters already consumed in today's bucket and over the account's life. */
  ledger?: Partial<LedgerState>;
  /** Day bucket key the guard will use (UTC date of the request `now`). */
  dayKey?: string;
  /** Emergency hand-offs already placed today (own bucket). */
  handoffCalls?: number;
  /** fraud_reserve throws / errors. */
  reserveFails?: boolean;
  marketing?: Partial<MarketingChecks> | null;
  /** What fraud_inbound_allowance returns (default: paid / allowed). */
  inboundAllowance?: unknown;
  /** fraud_inbound_allowance returns an error. */
  inboundAllowanceFails?: boolean;
}

export interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

export interface FakeFraudDb extends FraudDb {
  rpcCalls: RpcCall[];
  inserts: Array<{ table: string; row: Record<string, unknown> }>;
  reserveCalls(): RpcCall[];
}

export const DEFAULT_DAY_KEY = '2026-11-11';

export function makeFakeFraudDb(opts: FakeDbOptions = {}): FakeFraudDb {
  const dayKey = opts.dayKey ?? DEFAULT_DAY_KEY;
  const ctx: FakeContext | null = opts.context === null ? null : { ...BASE_CONTEXT, ...(opts.context ?? {}) };
  const buckets = new Map<string, { dayCalls: number; daySms: number; dayCostCents: number }>();
  buckets.set(dayKey, { dayCalls: opts.ledger?.dayCalls ?? 0, daySms: opts.ledger?.daySms ?? 0, dayCostCents: opts.ledger?.dayCostCents ?? 0 });
  buckets.set(`handoff:${dayKey}`, { dayCalls: opts.handoffCalls ?? 0, daySms: 0, dayCostCents: 0 });
  let lifeCostCents = opts.ledger?.lifeCostCents ?? 0;

  const rpcCalls: RpcCall[] = [];
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

  const marketing: MarketingChecks | null =
    opts.marketing === null ? null : { consent_mode: 'off', has_consent: true, approval_required: false, campaign_status: 'approved', ...(opts.marketing ?? {}) };

  return {
    rpcCalls,
    inserts,
    reserveCalls: () => rpcCalls.filter((c) => c.fn === 'fraud_reserve'),
    async rpc(fn, args = {}) {
      rpcCalls.push({ fn, args });
      switch (fn) {
        case 'fraud_guard_context':
          return ctx ? { data: ctx, error: null } : { data: null, error: { message: 'fraud store unreachable' } };
        case 'fraud_reserve': {
          if (opts.reserveFails) return { data: null, error: { message: 'ledger unavailable' } };
          const day = String(args.p_day);
          const bucket = buckets.get(day) ?? { dayCalls: 0, daySms: 0, dayCostCents: 0 };
          const verdict = tryReserve(
            { ...bucket, lifeCostCents },
            { calls: Number(args.p_calls), sms: Number(args.p_sms), costCents: Number(args.p_cost) },
            {
              dailyOutboundCalls: Number(args.p_cap_calls),
              dailySms: Number(args.p_cap_sms),
              dailyCostCents: Number(args.p_cap_day_cost),
              lifetimeCostCents: args.p_cap_life_cost === null ? null : Number(args.p_cap_life_cost),
              maxCallSeconds: 0,
            },
          );
          if (!verdict.ok) return { data: verdict.reason, error: null };
          buckets.set(day, { dayCalls: verdict.state.dayCalls, daySms: verdict.state.daySms, dayCostCents: verdict.state.dayCostCents });
          lifeCostCents = verdict.state.lifeCostCents;
          return { data: null, error: null };
        }
        case 'fraud_inbound_allowance':
          if (opts.inboundAllowanceFails) return { data: null, error: { message: 'unavailable' } };
          return { data: opts.inboundAllowance ?? { allowed: true, free: false }, error: null };
        case 'fraud_marketing_checks':
          return marketing ? { data: marketing, error: null } : { data: null, error: { message: 'unavailable' } };
        default:
          return { data: null, error: null };
      }
    },
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

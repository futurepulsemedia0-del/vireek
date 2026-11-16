// src/test/planEnforcement/matrix.ts
//
// The plan x limit enforcement matrix. Every cell is produced by running the REAL enforcement code (guardOutbound,
// exhaustedResponse, planAllowsWhiteLabel, minutesForPlan, ...) against in-memory fixtures, plus static source
// checks for the parts that only exist as SQL or inside an edge-function handler. Expected values come from the
// single sources of truth: pricing.ts, planCatalog.ts, planLimits.ts and the entitlement modules.
//
// A cell is "enforced: yes" only when (a) the enforcement logic behaves correctly at the boundary AND (b) it is
// actually reachable from production code. Logic that is correct but never called is reported as "no" with its gap.

import { planAllowsWhiteLabel } from '../../../supabase/functions/_shared/branding/brand';
import { FREE_MINUTES_INCLUDED, minutesForPlan } from '../../../supabase/functions/_shared/billing/planCatalog';
import { createEntitlementChecker } from '../../../supabase/functions/_shared/entitlements/requireEntitlement';
import { EMERGENCY_HANDOFF_DAILY_CEILING, guardOutbound, type GuardRequest, type GuardResult } from '../../../supabase/functions/_shared/fraud/guard';
import { evaluateInbound, exhaustedResponse, parseAllowance } from '../../../supabase/functions/_shared/fraud/inbound';
import {
  FREE_MINUTES, PLAN_LIMITS, VOICE_CLONE_CENTS, callReservationCents, normalizePlan, smsReservationCents, type PlanId,
} from '../../../supabase/functions/_shared/fraud/planLimits';
import { decideSend, DEFAULT_QUIET_HOURS } from '../../../supabase/functions/_shared/messaging/quietHoursCore';
import { isEntitled as clientIsEntitled } from '../../lib/entitlements';
import { COMPARE_VALUES, PRICING_PLANS, parseOverageRate } from '../../lib/pricing';
import { evaluateGaps, parsePlanArray, stripSqlComments, WEBHOOK_OVERWRITES_MINUTES, subscriptionUpdatedBlock, type GapState } from './gaps';
import { KNOWN_GAPS, SENDER_REGISTRY, type GapId, type SenderChannel } from './registry';
import { REPO_ROOT, codeMatches, functionFileReferencesGuard, readSource } from './scan';
import { makeFakeFraudDb, type FakeDbOptions, type FakeFraudDb } from './fakeFraudDb';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const USER = '00000000-0000-4000-8000-000000000001';
export const NOW = new Date('2026-11-11T15:00:00Z');
export const DOMESTIC = '+12125551234';
export const INTERNATIONAL_UK = '+442079460958';

export const GUARD_PLANS: readonly PlanId[] = ['free', 'starter', 'professional', 'business', 'enterprise'];
export const MATRIX_PLANS = ['free', 'trial', 'starter', 'professional', 'business', 'enterprise'] as const;
export type MatrixPlan = (typeof MATRIX_PLANS)[number];

/** A Stripe-trialing account is guarded as an unknown plan, i.e. "free" (see GAP-T1). */
export function guardPlanOf(plan: MatrixPlan): PlanId {
  return normalizePlan(plan);
}

export function request(over: Partial<GuardRequest> = {}): GuardRequest {
  return { userId: USER, kind: 'call', to: DOMESTIC, purpose: 'service', source: 'plan-enforcement-matrix', now: NOW, ...over };
}

export async function runGuard(opts: FakeDbOptions, over: Partial<GuardRequest> = {}): Promise<{ result: GuardResult; db: FakeFraudDb }> {
  const db = makeFakeFraudDb(opts);
  return { result: await guardOutbound(db, request(over)), db };
}

// ---------------------------------------------------------------------------
// Observations (one per limit). The tests assert on these; the matrix judges them.
// ---------------------------------------------------------------------------

export interface PairObservation {
  cap: number;
  atBoundary: GuardResult;
  overBoundary: GuardResult;
}

/** cap-1 already used: the next request must pass and the one after it must be refused. */
export async function observeCount(plan: PlanId, kind: 'call' | 'sms'): Promise<PairObservation> {
  const cap = kind === 'call' ? PLAN_LIMITS[plan].dailyOutboundCalls : PLAN_LIMITS[plan].dailySms;
  const db = makeFakeFraudDb({ context: { plan }, ledger: kind === 'call' ? { dayCalls: cap - 1 } : { daySms: cap - 1 } });
  const atBoundary = await guardOutbound(db, request({ kind }));
  const overBoundary = await guardOutbound(db, request({ kind }));
  return { cap, atBoundary, overBoundary };
}

export interface SpendObservation {
  capCents: number;
  reservationCents: number;
  atBoundary: GuardResult;
  overBoundary: GuardResult;
}

export async function observeDailySpend(plan: PlanId): Promise<SpendObservation> {
  const capCents = PLAN_LIMITS[plan].dailyCostCents;
  const reservationCents = callReservationCents('domestic', PLAN_LIMITS[plan].maxCallSeconds);
  const at = await runGuard({ context: { plan }, ledger: { dayCostCents: capCents - reservationCents } });
  const over = await runGuard({ context: { plan }, ledger: { dayCostCents: capCents - reservationCents + 1 } });
  return { capCents, reservationCents, atBoundary: at.result, overBoundary: over.result };
}

export interface LifetimeObservation {
  capCents: number | null;
  atBoundary: GuardResult;
  overBoundary: GuardResult;
}

export async function observeLifetimeSpend(plan: PlanId): Promise<LifetimeObservation> {
  const capCents = PLAN_LIMITS[plan].lifetimeCostCents;
  const reservationCents = callReservationCents('domestic', PLAN_LIMITS[plan].maxCallSeconds);
  if (capCents === null) {
    // paid plans: an enormous lifetime total must never block
    const r = await runGuard({ context: { plan }, ledger: { lifeCostCents: 1_000_000_000 } });
    return { capCents, atBoundary: r.result, overBoundary: r.result };
  }
  const at = await runGuard({ context: { plan }, ledger: { lifeCostCents: capCents - reservationCents } });
  const over = await runGuard({ context: { plan }, ledger: { lifeCostCents: capCents - reservationCents + 1 } });
  return { capCents, atBoundary: at.result, overBoundary: over.result };
}

export async function observeCallLength(plan: PlanId): Promise<GuardResult> {
  return (await runGuard({ context: { plan } })).result;
}

export async function observeVerification(plan: PlanId): Promise<{ service: GuardResult; marketing: GuardResult }> {
  const service = await runGuard({ context: { plan, outbound_unlocked: false } }, { purpose: 'service' });
  const marketing = await runGuard({ context: { plan, outbound_unlocked: false } }, { purpose: 'marketing' });
  return { service: service.result, marketing: marketing.result };
}

export async function observeVoiceClone(plan: PlanId): Promise<GuardResult> {
  return (await runGuard({ context: { plan } }, { kind: 'clone', to: undefined, purpose: 'service' })).result;
}

export interface InboundObservation {
  freeWithForwarding: unknown;
  freeWithoutForwarding: unknown;
  freeWithForwardingStoreDown: unknown;
  paidAllowance: ReturnType<typeof parseAllowance>;
  garbageAllowance: ReturnType<typeof parseAllowance>;
}

export async function observeInbound(): Promise<InboundObservation> {
  const forwarding = DOMESTIC;
  return {
    freeWithForwarding: await exhaustedResponse(makeFakeFraudDb({ context: { plan: 'free' } }), USER, forwarding),
    freeWithoutForwarding: await exhaustedResponse(makeFakeFraudDb({ context: { plan: 'free' } }), USER, null),
    freeWithForwardingStoreDown: await exhaustedResponse(makeFakeFraudDb({ context: null }), USER, forwarding),
    paidAllowance: parseAllowance({ allowed: true, free: false }),
    garbageAllowance: parseAllowance('not-an-object'),
  };
}


export interface InboundModes {
  enforce: Awaited<ReturnType<typeof evaluateInbound>>;
  shadow: Awaited<ReturnType<typeof evaluateInbound>>;
  contextDown: Awaited<ReturnType<typeof evaluateInbound>>;
  allowanceDown: Awaited<ReturnType<typeof evaluateInbound>>;
  withinAllowance: Awaited<ReturnType<typeof evaluateInbound>>;
}

const EXHAUSTED = { allowed: false, free: true, used: FREE_MINUTES, included: FREE_MINUTES, mode: 'monthly' } as const;

/** Free minutes used up, under every enforcement state the inbound stop can be in. */
export async function observeInboundModes(): Promise<InboundModes> {
  return {
    enforce: await evaluateInbound(makeFakeFraudDb({ context: { plan: 'free', enforce: true }, inboundAllowance: EXHAUSTED }), USER),
    shadow: await evaluateInbound(makeFakeFraudDb({ context: { plan: 'free', enforce: false }, inboundAllowance: EXHAUSTED }), USER),
    contextDown: await evaluateInbound(makeFakeFraudDb({ context: null, inboundAllowance: EXHAUSTED }), USER),
    allowanceDown: await evaluateInbound(makeFakeFraudDb({ context: { plan: 'free' }, inboundAllowanceFails: true }), USER),
    withinAllowance: await evaluateInbound(makeFakeFraudDb({ context: { plan: 'free' }, inboundAllowance: { allowed: true, free: true, used: 1, included: FREE_MINUTES } }), USER),
  };
}

// ---------------------------------------------------------------------------
// Emergency lane
// ---------------------------------------------------------------------------

export interface EmergencyScenario {
  name: string;
  opts: FakeDbOptions;
  /** A non-emergency request in the same state must be refused with this code (proves the scenario actually bites). */
  control?: string;
}

const HUGE = 1_000_000_000;

export const EMERGENCY_SCENARIOS: readonly EmergencyScenario[] = [
  { name: 'all kill switches on', opts: { context: { kill_outbound_calls: true, kill_sms: true, kill_international: true } }, control: 'KILL_SWITCH' },
  { name: 'account suspended', opts: { context: { status: 'suspended' } }, control: 'ORG_SUSPENDED' },
  { name: 'account throttled', opts: { context: { status: 'throttled' } } },
  { name: 'business not verified', opts: { context: { outbound_unlocked: false } }, control: 'VERIFICATION_REQUIRED' },
  { name: 'daily and lifetime caps exhausted', opts: { ledger: { dayCalls: HUGE, daySms: HUGE, dayCostCents: HUGE, lifeCostCents: HUGE } } },
  { name: 'shadow mode (enforce = false)', opts: { context: { enforce: false } } },
  { name: 'brand-new account (ramp 10%)', opts: { context: { account_age_days: 0 } } },
  { name: 'fraud store unreachable', opts: { context: null }, control: 'GUARD_UNAVAILABLE' },
  { name: 'spend ledger unavailable', opts: { reserveFails: true }, control: 'GUARD_UNAVAILABLE' },
];

export interface EmergencyRow {
  plan: PlanId;
  scenario: string;
  kind: 'call' | 'sms';
  target: string;
  ok: boolean;
  emergency: boolean;
  code?: string;
}

/** Hand-off / dispatch to a domestic number and to 911, for every plan, scenario and channel. */
export async function runEmergencyScenarios(): Promise<EmergencyRow[]> {
  const rows: EmergencyRow[] = [];
  for (const plan of GUARD_PLANS) {
    for (const sc of EMERGENCY_SCENARIOS) {
      for (const kind of ['call', 'sms'] as const) {
        for (const target of [DOMESTIC, '911']) {
          const opts: FakeDbOptions = { ...sc.opts, context: sc.opts.context === null ? null : { plan, ...(sc.opts.context ?? {}) } };
          const { result } = await runGuard(opts, { kind, to: target, purpose: 'emergency' });
          rows.push({ plan, scenario: sc.name, kind, target, ok: result.ok, emergency: result.ok ? result.emergency : false, code: result.ok ? undefined : result.code });
        }
      }
    }
  }
  return rows;
}

export async function controlCode(plan: PlanId, sc: EmergencyScenario): Promise<string | null> {
  if (!sc.control) return null;
  const opts: FakeDbOptions = { ...sc.opts, context: sc.opts.context === null ? null : { plan, ...(sc.opts.context ?? {}) } };
  const { result } = await runGuard(opts, { kind: 'call', to: DOMESTIC, purpose: 'service' });
  return result.ok ? 'ALLOWED' : result.code;
}

export async function observeEmergencyBoundaries(): Promise<{ ceilingOk: GuardResult; ceilingHit: GuardResult; internationalLocked: GuardResult }> {
  const ok = await runGuard({ handoffCalls: EMERGENCY_HANDOFF_DAILY_CEILING - 1 }, { purpose: 'emergency' });
  const hit = await runGuard({ handoffCalls: EMERGENCY_HANDOFF_DAILY_CEILING }, { purpose: 'emergency' });
  const intl = await runGuard({}, { purpose: 'emergency', to: INTERNATIONAL_UK });
  return { ceilingOk: ok.result, ceilingHit: hit.result, internationalLocked: intl.result };
}

/** Quiet hours at 03:00 New York time. */
export function observeQuietHoursEmergency(): { defaultSms: boolean; defaultCall: boolean; overrideOffSms: boolean; marketingBlocked: boolean } {
  const at3am = new Date('2026-11-11T08:00:00Z');
  const tz = { timezone: 'America/New_York', source: 'business' as const };
  const decide = (purpose: 'emergency' | 'marketing', channel: 'sms' | 'call', allowEmergencyOverride: boolean) =>
    decideSend({ channel, purpose, settings: { ...DEFAULT_QUIET_HOURS, allowEmergencyOverride }, tz, now: at3am }).allowed;
  return {
    defaultSms: decide('emergency', 'sms', true),
    defaultCall: decide('emergency', 'call', true),
    overrideOffSms: decide('emergency', 'sms', false),
    marketingBlocked: !decide('marketing', 'sms', true),
  };
}

// ---------------------------------------------------------------------------
// Entitlement layer (module entitlements, default deny)
// ---------------------------------------------------------------------------

export async function observeEntitlementDefaultDeny(): Promise<Record<string, boolean>> {
  const tenant = '11111111-1111-4111-8111-111111111111';
  const mk = (rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>) => createEntitlementChecker({ rpc });
  const out: Record<string, boolean> = {};
  out.invalidTenantDenied = (await mk(async () => ({ data: true, error: null })).isEntitled('not-a-uuid', 'pay')) === false;
  out.invalidModuleDenied = (await mk(async () => ({ data: true, error: null })).isEntitled(tenant, 'Bad Module!')) === false;
  out.rpcErrorDenied = (await mk(async () => ({ data: null, error: { message: 'down' } })).isEntitled(tenant, 'pay')) === false;
  out.nonBooleanDenied = (await mk(async () => ({ data: 'yes', error: null })).isEntitled(tenant, 'pay')) === false;
  out.rpcThrowDenied = (await mk(async () => { throw new Error('network'); }).isEntitled(tenant, 'pay')) === false;
  out.grantedAllowed = (await mk(async () => ({ data: true, error: null })).isEntitled(tenant, 'pay')) === true;
  out.clientNoRowDenied = clientIsEntitled(undefined, Date.now()) === false;
  out.clientOffDenied = clientIsEntitled({ module_id: 'pay', state: 'off', source: 'manual', expires_at: null, active: true }, Date.now()) === false;
  out.clientExpiredDenied = clientIsEntitled({ module_id: 'pay', state: 'trial', source: 'manual', expires_at: new Date(Date.now() - 1000).toISOString(), active: true }, Date.now()) === false;
  return out;
}

// ---------------------------------------------------------------------------
// Pricing-derived expectations
// ---------------------------------------------------------------------------

export const unlimited = 'unlimited';

function planCopy(id: string) {
  const p = PRICING_PLANS.find((x) => x.id === id);
  if (!p) throw new Error(`pricing.ts has no plan ${id}`);
  return p;
}

export function parseCount(text: string, noun: RegExp): number | typeof unlimited | null {
  if (/unlimited/i.test(text)) return unlimited;
  const m = new RegExp(`(\\d[\\d,]*)\\s*${noun.source}`, 'i').exec(text);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export const expectedMinutes = (id: string) => parseCount(planCopy(id).minutes, /min/);
export const expectedSeats = (id: string) => parseCount(planCopy(id).seats, /seat/);
export const expectedLocations = (id: string) => parseCount(planCopy(id).locations, /location/);

/** A plan's feature bullets with "Everything in X" expanded, so inherited promises are included. */
export function featuresOf(id: string): string[] {
  const out: string[] = [];
  for (const f of planCopy(id).features) {
    const m = /^Everything in (\w+)/.exec(f);
    const inherited = m ? PRICING_PLANS.find((p) => p.name === m[1]) : undefined;
    if (inherited) out.push(...featuresOf(inherited.id));
    else out.push(f);
  }
  return out;
}

export function expectedRetention(id: string): string {
  let result = 'not specified';
  for (const f of featuresOf(id)) {
    const d = /(\d+)-day call transcript history/i.exec(f);
    if (d) result = `${d[1]} days`;
    else if (/unlimited history/i.test(f)) result = unlimited;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matrix model
// ---------------------------------------------------------------------------

export type Status = 'yes' | 'no' | 'n/a' | 'conflict';
export type Evidence = 'executed' | 'static' | 'none';

export const LIMITS = [
  { id: 'includedMinutes', label: 'Included minutes (catalog value, incl. bonus)' },
  { id: 'grandfatherMinutes', label: 'Grandfathered minutes_included kept' },
  { id: 'freeMinutesStop', label: 'Minutes hard stop / paid never blocked' },
  { id: 'overage', label: 'Overage policy (rate billed)' },
  { id: 'seats', label: 'Seats' },
  { id: 'locations', label: 'Locations' },
  { id: 'phoneNumbers', label: 'Phone numbers' },
  { id: 'concurrentCalls', label: 'Concurrent calls' },
  { id: 'smsMonthly', label: 'SMS per month' },
  { id: 'retentionDays', label: 'Transcript retention days' },
  { id: 'callLength', label: 'Max call length' },
  { id: 'dailyCalls', label: 'Daily outbound calls' },
  { id: 'dailySms', label: 'Daily SMS' },
  { id: 'dailySpend', label: 'Daily spend cap' },
  { id: 'lifetimeSpend', label: 'Lifetime spend cap' },
  { id: 'verification', label: 'Outbound needs verification' },
  { id: 'voiceClone', label: 'Voice clone' },
  { id: 'feat:dispatch', label: 'Feature: emergency detection & dispatch' },
  { id: 'feat:crm', label: 'Feature: CRM integrations' },
  { id: 'feat:recording', label: 'Feature: call recording' },
  { id: 'feat:analytics', label: 'Feature: advanced analytics' },
  { id: 'feat:api', label: 'Feature: API access' },
  { id: 'feat:whiteLabel', label: 'Feature: white label / custom domain' },
  { id: 'feat:siem', label: 'Feature: SIEM streaming' },
] as const;
export type LimitId = (typeof LIMITS)[number]['id'];

export interface Cell {
  plan: MatrixPlan;
  limit: LimitId;
  expected: string;
  actual: string;
  status: Status;
  evidence: Evidence;
  gap: GapId | null;
  note: string;
}

const fmt = (v: unknown): string => (v === null || v === undefined ? 'not defined' : typeof v === 'number' ? String(v) : String(v));

function unguardedFor(channels: readonly SenderChannel[]): string[] {
  return SENDER_REGISTRY.filter((s) => channels.includes(s.channel) && !functionFileReferencesGuard(s.file)).map((s) => s.file);
}

export interface MatrixContext {
  gaps: Map<GapId, GapState>;
  observed: {
    count: Record<'call' | 'sms', Record<PlanId, PairObservation>>;
    spend: Record<PlanId, SpendObservation>;
    lifetime: Record<PlanId, LifetimeObservation>;
    length: Record<PlanId, GuardResult>;
    verification: Record<PlanId, { service: GuardResult; marketing: GuardResult }>;
    clone: Record<PlanId, GuardResult>;
    inbound: InboundObservation;
  };
  consentClonePlans: string[] | null;
  siemPlans: string[] | null;
}

function byPlan<T>(fn: (p: PlanId) => Promise<T>): Promise<Record<PlanId, T>> {
  return Promise.all(GUARD_PLANS.map(async (p) => [p, await fn(p)] as const)).then((e) => Object.fromEntries(e) as Record<PlanId, T>);
}

export async function buildContext(): Promise<MatrixContext> {
  return {
    gaps: evaluateGaps(),
    observed: {
      count: { call: await byPlan((p) => observeCount(p, 'call')), sms: await byPlan((p) => observeCount(p, 'sms')) },
      spend: await byPlan(observeDailySpend),
      lifetime: await byPlan(observeLifetimeSpend),
      length: await byPlan(observeCallLength),
      verification: await byPlan(observeVerification),
      clone: await byPlan(observeVoiceClone),
      inbound: await observeInbound(),
    },
    consentClonePlans: parsePlanArray('supabase/functions/voice-consent/index.ts', 'CLONE_PLANS'),
    siemPlans: parsePlanArray('supabase/functions/_shared/siem/engine.ts', 'SIEM_PLANS'),
  };
}

const denied = (r: GuardResult, code: string, status?: number) => !r.ok && r.code === code && (status === undefined || r.httpStatus === status);

/** All 144 cells (6 plans x 24 rows). */
export function buildMatrix(cx: MatrixContext): Cell[] {
  const cells: Cell[] = [];
  const gapOpen = (id: GapId) => Boolean(cx.gaps.get(id)?.open);
  const catalogOnly = (l: LimitId) => ['includedMinutes', 'grandfatherMinutes', 'overage', 'seats', 'locations', 'retentionDays'].includes(l) || l.startsWith('feat:');

  const push = (plan: MatrixPlan, limit: LimitId, c: Omit<Cell, 'plan' | 'limit'>) => cells.push({ plan, limit, ...c });

  for (const plan of MATRIX_PLANS) {
    const gp = guardPlanOf(plan);
    const trialNote = plan === 'trial' ? ' Stripe trial: guarded as FREE (GAP-T1).' : '';
    const na = (limit: LimitId, note: string, expected = '-') => push(plan, limit, { expected, actual: '-', status: 'n/a', evidence: 'none', gap: null, note });

    const catalogId = plan === 'trial' ? null : plan;
    if (plan === 'trial' && catalogOnly('includedMinutes')) {
      for (const l of LIMITS.map((x) => x.id).filter((x) => catalogOnly(x))) {
        na(l, 'A Stripe trial carries the purchased plan\'s catalog values; nothing separate to enforce.');
      }
    }

    // ---- 1. included minutes -------------------------------------------------------------------------------
    if (catalogId) {
      const exp = expectedMinutes(catalogId);
      const act = catalogId === 'enterprise' ? (minutesForPlan('enterprise') === null ? unlimited : String(minutesForPlan('enterprise'))) : minutesForPlan(catalogId);
      const synced = exp === act && FREE_MINUTES === FREE_MINUTES_INCLUDED
        && codeMatches('supabase/functions/stripe-webhook/index.ts', /minutes_included\s*:[^,\n}]*minutesForPlan\(/)
        && codeMatches('supabase/functions/manage-subscription-plan/index.ts', /minutes_included\s*:\s*minutesForPlan\(/);
      push(plan, 'includedMinutes', {
        expected: fmt(exp), actual: fmt(act), status: synced ? 'yes' : 'conflict', evidence: 'static', gap: null,
        note: 'pricing.ts = planCatalog.ts = planLimits.FREE_MINUTES; written to profiles.minutes_included by stripe-webhook and manage-subscription-plan. No bonus-minutes concept exists in code: included minutes are the catalog value.',
      });
    }

    // ---- 2. grandfathered minutes --------------------------------------------------------------------------
    if (catalogId) {
      if (catalogId === 'free' || catalogId === 'enterprise') {
        na('grandfatherMinutes', catalogId === 'free' ? 'Free has no stored legacy allowance.' : 'Enterprise is unlimited / negotiated.');
      } else {
        const open = gapOpen('GAP-G1');
        push(plan, 'grandfatherMinutes', {
          expected: 'stored minutes_included survives plan sync', actual: open ? 'overwritten by customer.subscription.updated' : 'preserved', status: open ? 'no' : 'yes',
          evidence: 'static', gap: open ? 'GAP-G1' : null,
          note: open ? 'Inbound allowance and usage alerts read the STORED profiles.minutes_included, but the webhook resets it from the catalog on every subscription update.' : 'minutesToWriteOnSync() leaves minutes_included untouched unless the plan changes; inbound allowance and usage alerts read the stored value.',
        });
      }
    }

    // ---- 3. minutes hard stop ------------------------------------------------------------------------------
    {
      const ib = cx.observed.inbound;
      const forwardingOk = typeof ib.freeWithForwarding === 'object' && ib.freeWithForwarding !== null && 'destination' in ib.freeWithForwarding;
      const noForwardingMsg = typeof ib.freeWithoutForwarding === 'object' && ib.freeWithoutForwarding !== null && 'error' in ib.freeWithoutForwarding;
      const storeDownOk = typeof ib.freeWithForwardingStoreDown === 'object' && ib.freeWithForwardingStoreDown !== null && 'destination' in ib.freeWithForwardingStoreDown;
      const paidNeverBlocked = ib.paidAllowance.allowed === true && /IF\s+v_paid\s+THEN\s+RETURN\s+jsonb_build_object\('allowed',\s*true/.test(stripSqlComments(readSource('supabase/migrations/20280403000000_fraud_phase2.sql')));
      if (plan === 'free' || plan === 'trial') {
        if (plan === 'trial') {
          push(plan, 'freeMinutesStop', { expected: 'never blocked (has a subscription)', actual: paidNeverBlocked ? 'allowed' : 'blocked', status: paidNeverBlocked ? 'yes' : 'no', evidence: 'static', gap: null, note: 'fraud_inbound_allowance treats any account with stripe_subscription_id as paid.' });
        } else {
          const logic = forwardingOk && noForwardingMsg && storeDownOk;
          const open = gapOpen('GAP-I1');
          push(plan, 'freeMinutesStop', {
            expected: `stop at ${FREE_MINUTES} min; forward to owner or play message`, actual: logic ? (open ? 'logic correct, never called' : 'enforced') : 'logic wrong',
            status: logic && !open ? 'yes' : 'no', evidence: 'executed', gap: open ? 'GAP-I1' : null,
            note: 'exhaustedResponse() forwards via the emergency lane or plays a message and fails open; the count itself is SQL fraud_inbound_allowance().',
          });
        }
      } else {
        push(plan, 'freeMinutesStop', { expected: 'never blocked (overage billed)', actual: paidNeverBlocked ? 'allowed' : 'blocked', status: paidNeverBlocked ? 'yes' : 'no', evidence: 'static', gap: null, note: 'Paid accounts are never stopped on inbound minutes; see the overage row.' });
      }
    }

    // ---- 4. overage ------------------------------------------------------------------------------------------
    if (catalogId) {
      const rate = parseOverageRate(planCopy(catalogId).overage);
      if (rate === null) na('overage', catalogId === 'free' ? 'Free is hard-stopped instead of billed.' : 'Enterprise: SLA-backed, no metering.');
      else {
        const open = gapOpen('GAP-O1');
        push(plan, 'overage', { expected: `$${rate.toFixed(2)}/min over ${expectedMinutes(catalogId)}`, actual: open ? 'display-only' : 'metered', status: open ? 'no' : 'yes', evidence: 'static', gap: open ? 'GAP-O1' : null, note: 'No code in supabase/functions meters or invoices standard-plan overage (results-plan-bill does so for the results plan only).' });
      }
    }

    // ---- 5/6. seats, locations ------------------------------------------------------------------------------
    if (catalogId) {
      for (const [limit, exp, gap] of [['seats', expectedSeats(catalogId), 'GAP-S1'], ['locations', expectedLocations(catalogId), 'GAP-L1']] as const) {
        if (exp === unlimited) na(limit, 'Unlimited on this plan.', unlimited);
        else {
          const open = gapOpen(gap);
          push(plan, limit, { expected: fmt(exp), actual: open ? 'not enforced' : 'enforced', status: open ? 'no' : 'yes', evidence: 'static', gap: open ? gap : null, note: 'Marketing copy in pricing.ts only; no server-side check found.' });
        }
      }
    }

    // ---- 7. phone numbers -----------------------------------------------------------------------------------
    {
      const open = gapOpen('GAP-N1');
      push(plan, 'phoneNumbers', { expected: fmt(PLAN_LIMITS[gp].maxNumbers), actual: open ? 'PLAN_LIMITS.maxNumbers is never read' : 'enforced', status: open ? 'no' : 'yes', evidence: 'static', gap: open ? 'GAP-N1' : null, note: trialNote.trim() });
    }
    // ---- 8/9. concurrency, monthly SMS ------------------------------------------------------------------------
    push(plan, 'concurrentCalls', { expected: 'not defined', actual: gapOpen('GAP-C1') ? 'no limit exists' : 'enforced', status: gapOpen('GAP-C1') ? 'no' : 'yes', evidence: 'static', gap: gapOpen('GAP-C1') ? 'GAP-C1' : null, note: 'Neither pricing nor code defines a value.' });
    push(plan, 'smsMonthly', { expected: 'not defined', actual: gapOpen('GAP-M1') ? 'no limit exists' : 'enforced', status: gapOpen('GAP-M1') ? 'no' : 'yes', evidence: 'static', gap: gapOpen('GAP-M1') ? 'GAP-M1' : null, note: 'Only a daily SMS cap exists.' });

    // ---- 10. retention ---------------------------------------------------------------------------------------
    if (catalogId) {
      const open = gapOpen('GAP-R1');
      push(plan, 'retentionDays', { expected: expectedRetention(catalogId), actual: open ? 'per-tenant policy rows, not the plan' : 'plan-driven', status: open ? 'no' : 'yes', evidence: 'static', gap: open ? 'GAP-R1' : null, note: 'Derived from the plan bullets in pricing.ts (inherited bullets included).' });
    }

    // ---- 11-16. guard-derived limits ---------------------------------------------------------------------------
    const guardCell = (limit: LimitId, expected: string, logicOk: boolean, actual: string, channels: readonly SenderChannel[], note = '') => {
      const unguarded = unguardedFor(channels);
      const wired = unguarded.length === 0;
      push(plan, limit, {
        expected, actual: logicOk ? (wired ? actual : `${actual}; guard not called by ${unguarded.length} sender(s)`) : `WRONG: ${actual}`,
        status: logicOk && wired ? 'yes' : 'no', evidence: 'executed', gap: logicOk && !wired ? 'GAP-W1' : null, note: `${note}${trialNote}`.trim(),
      });
    };
    {
      const L = PLAN_LIMITS[gp];
      const c = cx.observed.count.call[gp];
      guardCell('callLength', `${L.maxCallSeconds} s`, cx.observed.length[gp].ok && (cx.observed.length[gp] as Extract<GuardResult, { ok: true }>).maxCallSeconds === L.maxCallSeconds, `guard returns maxCallSeconds ${L.maxCallSeconds}`, ['call']);
      guardCell('dailyCalls', `${L.dailyOutboundCalls}/day`, c.atBoundary.ok && denied(c.overBoundary, 'DAILY_CALLS', 429), `call ${c.cap} allowed, ${c.cap + 1} refused 429`, ['call']);
      const s = cx.observed.count.sms[gp];
      guardCell('dailySms', `${L.dailySms}/day`, s.atBoundary.ok && denied(s.overBoundary, 'DAILY_SMS', 429), `sms ${s.cap} allowed, ${s.cap + 1} refused 429`, ['sms']);
      const sp = cx.observed.spend[gp];
      guardCell('dailySpend', `${L.dailyCostCents} cents/day`, sp.atBoundary.ok && denied(sp.overBoundary, 'DAILY_COST', 429), `at cap allowed, 1 cent over refused 429`, ['call', 'sms']);
      const lt = cx.observed.lifetime[gp];
      if (lt.capCents === null) {
        push(plan, 'lifetimeSpend', { expected: 'none (paid)', actual: lt.atBoundary.ok ? 'never blocked' : 'WRONG: blocked', status: lt.atBoundary.ok ? 'n/a' : 'no', evidence: 'executed', gap: null, note: `By design paid plans have no lifetime cap.${trialNote}` });
      } else {
        guardCell('lifetimeSpend', `${lt.capCents} cents lifetime`, lt.atBoundary.ok && denied(lt.overBoundary, 'LIFETIME_COST', 429), 'at cap allowed, 1 cent over refused 429', ['call', 'sms']);
      }
      const v = cx.observed.verification[gp];
      guardCell('verification', 'unverified -> blocked', denied(v.service, 'VERIFICATION_REQUIRED', 403) && denied(v.marketing, 'VERIFICATION_REQUIRED', 403), 'unverified service + marketing refused 403', ['call', 'sms']);
    }

    // ---- 17. voice clone ---------------------------------------------------------------------------------------
    {
      const sot = PLAN_LIMITS[gp].allowVoiceClone;
      const guardLogic = sot ? cx.observed.clone[gp].ok : denied(cx.observed.clone[gp], 'PLAN_NOT_ALLOWED', 403);
      const consentAllows = cx.consentClonePlans?.includes(gp) ?? false;
      const wiredGuard = unguardedFor(['clone']).length === 0;
      const agree = consentAllows === sot;
      let status: Status = 'yes';
      let gap: GapId | null = null;
      if (!guardLogic) status = 'no';
      else if (!agree) { status = 'conflict'; gap = 'GAP-V1'; }
      push(plan, 'voiceClone', {
        expected: sot ? 'allowed' : 'blocked (PLAN_NOT_ALLOWED)', actual: `guard ${sot ? 'allows' : 'blocks'}; voice-consent ${consentAllows ? 'allows' : 'blocks'}${wiredGuard ? '' : '; guard not called by clone-voice'}`,
        status, evidence: 'executed', gap, note: `${agree ? 'The consent step is the wired plan gate (static).' : 'planLimits and voice-consent disagree.'}${trialNote}`.trim(),
      });
    }

    // ---- 18-22. plan-gated features (COMPARE_VALUES) ---------------------------------------------------------------
    if (catalogId) {
      const open = gapOpen('GAP-F1');
      const featureRow = (limit: LimitId, key: keyof typeof COMPARE_VALUES) => {
        const v = COMPARE_VALUES[key]?.[catalogId];
        const label = v === true ? 'included' : v === false || v === undefined ? 'not included' : String(v);
        const top = key === 'crm' ? v === 'Unlimited + API' : key === 'analytics' ? v === 'Advanced' : v === true;
        if (top) na(limit, 'Included at full level; nothing to restrict.', label);
        else push(plan, limit, { expected: label, actual: open ? 'no server-side plan check' : 'enforced', status: open ? 'no' : 'yes', evidence: 'static', gap: open ? 'GAP-F1' : null, note: key === 'dispatch' ? 'The emergency hand-off lane stays open on every plan by design; the gated part needs a product decision.' : '' });
      };
      featureRow('feat:dispatch', 'dispatch');
      featureRow('feat:crm', 'crm');
      featureRow('feat:recording', 'recording');
      featureRow('feat:analytics', 'analytics');
      featureRow('feat:api', 'api');

      // ---- 23. white label (real gate) ----------------------------------------------------------------------------
      // Parsed from source: importing src/lib/whiteLabel.ts would pull in the browser Supabase client.
      const wlExpected = (parsePlanArray('src/lib/whiteLabel.ts', 'WHITE_LABEL_PLANS') ?? []).includes(catalogId);
      const wlServer = planAllowsWhiteLabel(catalogId);
      const wlDomain = (parsePlanArray('supabase/functions/verify-custom-domain/index.ts', 'WHITE_LABEL_PLANS') ?? []).includes(catalogId);
      push(plan, 'feat:whiteLabel', { expected: wlExpected ? 'allowed' : 'blocked', actual: `brand.ts ${wlServer ? 'allows' : 'blocks'}; verify-custom-domain ${wlDomain ? 'allows' : 'blocks'}`, status: wlServer === wlExpected && wlDomain === wlExpected ? 'yes' : 'conflict', evidence: 'executed', gap: null, note: 'Server list = client list (src/lib/whiteLabel.ts) = custom-domain gate.' });

      // ---- 24. SIEM (real gate) -------------------------------------------------------------------------------------
      const siemAllows = cx.siemPlans?.includes(catalogId) ?? false;
      const siemWired = codeMatches('supabase/functions/siem-stream/index.ts', /SIEM_PLANS\.includes\(/);
      push(plan, 'feat:siem', { expected: siemAllows ? 'allowed' : 'blocked', actual: siemWired ? `siem-stream ${siemAllows ? 'allows' : 'blocks'}` : 'siem-stream does not check the plan', status: siemWired ? 'yes' : 'no', evidence: 'static', gap: null, note: catalogId === 'business' ? 'Pricing lists audit logs under Enterprise only; confirm intent (PLAN-ENF-014).' : '' });
    }
  }
  return cells.sort((a, b) => LIMITS.findIndex((l) => l.id === a.limit) - LIMITS.findIndex((l) => l.id === b.limit) || MATRIX_PLANS.indexOf(a.plan) - MATRIX_PLANS.indexOf(b.plan));
}

// ---------------------------------------------------------------------------
// Cross-plan controls (emergency lane, shadow mode, entitlement layer)
// ---------------------------------------------------------------------------

export interface CrossRow {
  control: string;
  status: Status;
  evidence: Evidence;
  gap: GapId | null;
  detail: string;
}

export async function buildCrossRows(cx: MatrixContext): Promise<CrossRow[]> {
  const emergency = await runEmergencyScenarios();
  const failures = emergency.filter((r) => !r.ok || !r.emergency);
  const q = observeQuietHoursEmergency();
  const ent = await observeEntitlementDefaultDeny();
  const entOk = Object.values(ent).every(Boolean);
  const shadowPlans = await Promise.all(GUARD_PLANS.map(async (plan) => {
    const cap = PLAN_LIMITS[plan].dailyOutboundCalls;
    const r = await runGuard({ context: { plan, enforce: false }, ledger: { dayCalls: cap } });
    return r.result.ok && r.result.shadowDenied === 'DAILY_CALLS';
  }));
  const gapOpen = (id: GapId) => Boolean(cx.gaps.get(id)?.open);
  const im = await observeInboundModes();
  const inboundModesOk = !im.enforce.allowed && !im.enforce.shadowDenied && im.shadow.allowed && im.shadow.shadowDenied && im.contextDown.allowed && im.allowanceDown.allowed && im.withinAllowance.allowed && !im.withinAllowance.shadowDenied;
  return [
    { control: 'Emergency hand-off / dispatch (call + SMS, domestic and 911) never blocked, every plan, every scenario', status: failures.length === 0 ? 'yes' : 'no', evidence: 'executed', gap: null, detail: `${emergency.length} guard calls, ${failures.length} blocked. Own runaway ceiling ${EMERGENCY_HANDOFF_DAILY_CEILING}/day per account; international targets still go through the destination policy.` },
    { control: 'Emergency messages through quiet hours', status: q.defaultSms && q.defaultCall && q.marketingBlocked ? (q.overrideOffSms ? 'yes' : 'no') : 'no', evidence: 'executed', gap: q.overrideOffSms ? null : 'GAP-E4', detail: q.overrideOffSms ? 'Emergency always bypasses the quiet window.' : 'Bypasses by default, but allowEmergencyOverride=false defers them.' },
    { control: 'Emergency SMS through sendCompliantSms (A2P / DNC / future guard)', status: gapOpen('GAP-E3') ? 'no' : 'yes', evidence: 'static', gap: gapOpen('GAP-E3') ? 'GAP-E3' : null, detail: 'Emergency paths use the raw deliver.ts sender today, which is why they are not blocked.' },
    { control: 'Shadow mode (enforce = false) on outbound: would-deny is logged, traffic allowed', status: shadowPlans.every(Boolean) ? 'yes' : 'no', evidence: 'executed', gap: null, detail: 'Verified per plan with the daily-call cap exhausted. Reachable only once senders call the guard (GAP-W1).' },
    { control: 'Shadow mode on inbound (free-minute stop): enforce stops, log-only allows, errors fail open', status: inboundModesOk ? (gapOpen('GAP-I1') ? 'no' : 'yes') : 'no', evidence: 'executed', gap: gapOpen('GAP-I1') ? 'GAP-I1' : null, detail: 'evaluateInbound() follows fraud_settings.enforce; an unreadable allowance or context allows the call.' },
    { control: 'Module entitlements default to deny (edge + client)', status: entOk ? 'yes' : 'no', evidence: 'executed', gap: null, detail: 'Invalid ids, RPC errors, non-boolean answers, expired trials and missing rows all deny.' },
    { control: 'Plan -> module entitlement sync', status: gapOpen('GAP-E1') ? 'no' : 'yes', evidence: 'static', gap: gapOpen('GAP-E1') ? 'GAP-E1' : null, detail: 'Entitlements are granted manually by staff; two parallel entitlement systems exist.' },
  ];
}

// Re-exports used by the tests.
export { KNOWN_GAPS, REPO_ROOT, VOICE_CLONE_CENTS, smsReservationCents, callReservationCents, subscriptionUpdatedBlock, WEBHOOK_OVERWRITES_MINUTES };

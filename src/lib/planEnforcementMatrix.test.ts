// @vitest-environment node
//
// Plan enforcement matrix. One row per plan x every limit and plan-gated feature; expected values come from the
// single sources of truth (pricing.ts, planCatalog.ts, planLimits.ts, entitlements, whiteLabel) and the REAL
// enforcement functions are run against in-memory fixtures. See src/test/planEnforcement/ for the helpers and
// docs/plan-enforcement-matrix.md for the generated human-readable result.
//
// Regenerate the doc:  UPDATE_PLAN_MATRIX=1 npx vitest run src/lib/planEnforcementMatrix.test.ts

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { FREE_MINUTES_INCLUDED, minutesForPlan, minutesToWriteOnSync } from '../../supabase/functions/_shared/billing/planCatalog';
import { EMERGENCY_HANDOFF_DAILY_CEILING } from '../../supabase/functions/_shared/fraud/guard';
import { FREE_MINUTES, PLAN_LIMITS, VOICE_CLONE_CENTS, callReservationCents, effectiveCaps, normalizePlan, type PlanId } from '../../supabase/functions/_shared/fraud/planLimits';
import { PRICING_PLANS, parseOverageRate } from './pricing';
import { evaluateGaps, stripSqlComments, subscriptionUpdatedBlock, WEBHOOK_OVERWRITES_MINUTES } from '../test/planEnforcement/gaps';
import {
  DOMESTIC, EMERGENCY_SCENARIOS, type EmergencyScenario, GUARD_PLANS, INTERNATIONAL_UK, LIMITS, MATRIX_PLANS, NOW, USER,
  buildContext, buildCrossRows, buildMatrix, controlCode, observeInboundModes, expectedLocations, expectedMinutes, expectedRetention, expectedSeats,
  observeCallLength, observeCount, observeDailySpend, observeEmergencyBoundaries, observeEntitlementDefaultDeny, observeInbound,
  observeLifetimeSpend, observeQuietHoursEmergency, observeVerification, observeVoiceClone, request, runEmergencyScenarios, runGuard,
  type MatrixContext,
} from '../test/planEnforcement/matrix';
import { KNOWN_GAPS } from '../test/planEnforcement/registry';
import { renderMatrixMarkdown } from '../test/planEnforcement/render';
import { REPO_ROOT, readSource, stripComments } from '../test/planEnforcement/scan';

let cx: MatrixContext;
beforeAll(async () => {
  cx = await buildContext();
});

// ---------------------------------------------------------------------------------------------------------------
describe('sources of truth agree', () => {
  it('every pricing plan has fraud limits and a catalog entry', () => {
    for (const p of PRICING_PLANS) {
      expect(Object.keys(PLAN_LIMITS), p.id).toContain(p.id);
    }
    expect(Object.keys(PLAN_LIMITS).sort()).toEqual(['business', 'enterprise', 'free', 'professional', 'starter']);
  });

  it.each(PRICING_PLANS.map((p) => p.id as string))('%s: included minutes in pricing.ts equal planCatalog.minutesForPlan', (id: string) => {
    const expected = expectedMinutes(id);
    const actual = minutesForPlan(id);
    expect(actual === null ? 'unlimited' : actual).toBe(expected);
  });

  it('free minutes agree between planLimits and planCatalog', () => {
    expect(FREE_MINUTES).toBe(FREE_MINUTES_INCLUDED);
  });

  it('paid plans advertise an overage rate, free and enterprise do not', () => {
    for (const p of PRICING_PLANS) {
      const rate = parseOverageRate(p.overage);
      if (p.id === 'free' || p.id === 'enterprise') expect(rate, p.id).toBeNull();
      else expect(rate, p.id).toBeGreaterThan(0);
    }
  });

  it('unknown and trial plan ids fall back to the most restrictive plan', () => {
    for (const bad of ['trial', 'legacy-gold', '', null, undefined]) {
      expect(normalizePlan(bad), String(bad)).toBe('free');
    }
    expect(normalizePlan('professional')).toBe('professional');
  });

  it('prototype keys are not plans (a plan id of "constructor" must fall back to free, not crash the guard)', async () => {
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(normalizePlan(key), key).toBe('free');
      const { result } = await runGuard({ context: { plan: key } });
      expect(result.ok, key).toBe(true); // evaluated as free, never a TypeError
    }
  });

  it('caps never decrease as the plan gets bigger', () => {
    const keys = ['dailyOutboundCalls', 'dailySms', 'dailyCostCents', 'maxCallSeconds', 'maxNumbers'] as const;
    for (const k of keys) {
      const series = GUARD_PLANS.map((p) => PLAN_LIMITS[p][k]);
      expect([...series].sort((a, b) => a - b), k).toEqual(series);
    }
  });

  it('plan limits are parsed from the pricing copy for seats, locations and retention', () => {
    expect(expectedSeats('free')).toBe(1);
    expect(expectedSeats('enterprise')).toBe('unlimited');
    expect(expectedLocations('business')).toBe(3);
    expect(expectedRetention('starter')).toBe('7 days');
    expect(expectedRetention('professional')).toBe('unlimited');
    expect(expectedRetention('business')).toBe('unlimited'); // inherited from Professional
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe.each(GUARD_PLANS)('%s: guardOutbound enforces every plan limit (real function, fake ledger)', (plan: PlanId) => {
  const L = PLAN_LIMITS[plan];

  it('daily outbound calls: cap allowed, cap+1 refused with 429 DAILY_CALLS', async () => {
    const o = await observeCount(plan, 'call');
    expect(o.cap).toBe(L.dailyOutboundCalls);
    expect(o.atBoundary.ok).toBe(true);
    expect(o.overBoundary).toMatchObject({ ok: false, code: 'DAILY_CALLS', httpStatus: 429 });
  });

  it('daily SMS: cap allowed, cap+1 refused with 429 DAILY_SMS', async () => {
    const o = await observeCount(plan, 'sms');
    expect(o.cap).toBe(L.dailySms);
    expect(o.atBoundary.ok).toBe(true);
    expect(o.overBoundary).toMatchObject({ ok: false, code: 'DAILY_SMS', httpStatus: 429 });
  });

  it('daily spend: exactly at the cap allowed, one cent over refused DAILY_COST', async () => {
    const o = await observeDailySpend(plan);
    expect(o.capCents).toBe(L.dailyCostCents);
    expect(o.reservationCents).toBe(callReservationCents('domestic', L.maxCallSeconds));
    expect(o.atBoundary.ok).toBe(true);
    expect(o.overBoundary).toMatchObject({ ok: false, code: 'DAILY_COST', httpStatus: 429 });
  });

  it(L.lifetimeCostCents === null ? 'lifetime spend: paid plans are never lifetime-capped' : 'lifetime spend: free is capped', async () => {
    const o = await observeLifetimeSpend(plan);
    expect(o.capCents).toBe(L.lifetimeCostCents);
    expect(o.atBoundary.ok).toBe(true);
    if (L.lifetimeCostCents !== null) expect(o.overBoundary).toMatchObject({ ok: false, code: 'LIFETIME_COST', httpStatus: 429 });
  });

  it('call length: the guard hands the sender the plan maxCallSeconds', async () => {
    const r = await observeCallLength(plan);
    expect(r.ok && r.maxCallSeconds).toBe(L.maxCallSeconds);
    expect(r.ok && r.reservedCents).toBe(callReservationCents('domestic', L.maxCallSeconds));
  });

  it('unverified accounts cannot place customer outbound (service and marketing) on any plan', async () => {
    const v = await observeVerification(plan);
    expect(v.service).toMatchObject({ ok: false, code: 'VERIFICATION_REQUIRED', httpStatus: 403 });
    expect(v.marketing).toMatchObject({ ok: false, code: 'VERIFICATION_REQUIRED', httpStatus: 403 });
  });

  it(L.allowVoiceClone ? 'voice clone allowed (and reserves its cost)' : 'voice clone refused PLAN_NOT_ALLOWED', async () => {
    const r = await observeVoiceClone(plan);
    if (L.allowVoiceClone) expect(r).toMatchObject({ ok: true, reservedCents: VOICE_CLONE_CENTS });
    else expect(r).toMatchObject({ ok: false, code: 'PLAN_NOT_ALLOWED', httpStatus: 403 });
  });

  it('domestic destination allowed, international locked until verification, premium numbers refused', async () => {
    expect((await runGuard({ context: { plan } })).result.ok).toBe(true);
    expect((await runGuard({ context: { plan } }, { to: INTERNATIONAL_UK })).result).toMatchObject({ ok: false, code: 'INTERNATIONAL_LOCKED' });
    expect((await runGuard({ context: { plan } }, { to: '+19005551234' })).result).toMatchObject({ ok: false });
    expect((await runGuard({ context: { plan } }, { to: '+1212555123;ww9' })).result).toMatchObject({ ok: false, code: 'INVALID_NUMBER' });
  });

  it('kill switches stop calls and SMS (service purpose)', async () => {
    expect((await runGuard({ context: { plan, kill_outbound_calls: true } })).result).toMatchObject({ ok: false, code: 'KILL_SWITCH' });
    expect((await runGuard({ context: { plan, kill_sms: true } }, { kind: 'sms' })).result).toMatchObject({ ok: false, code: 'KILL_SWITCH' });
    expect((await runGuard({ context: { plan, status: 'suspended' } })).result).toMatchObject({ ok: false, code: 'ORG_SUSPENDED' });
  });

  it('fails closed when the fraud store or the spend ledger is unreachable', async () => {
    expect((await runGuard({ context: null })).result).toMatchObject({ ok: false, code: 'GUARD_UNAVAILABLE' });
    expect((await runGuard({ context: { plan }, reserveFails: true })).result).toMatchObject({ ok: false, code: 'GUARD_UNAVAILABLE' });
  });

  it('brand-new accounts get the ramped caps from effectiveCaps()', async () => {
    const { db } = await runGuard({ context: { plan, account_age_days: 0 } });
    const caps = effectiveCaps(plan, 0);
    const reserve = db.reserveCalls()[0]?.args;
    expect(reserve?.p_cap_calls).toBe(caps.dailyOutboundCalls);
    expect(reserve?.p_cap_sms).toBe(caps.dailySms);
    expect(caps.dailyOutboundCalls).toBeLessThanOrEqual(L.dailyOutboundCalls);
  });

  it('the guard passes the plan caps to the ledger unchanged for an established account', async () => {
    const { db } = await runGuard({ context: { plan } });
    expect(db.reserveCalls()[0]?.args).toMatchObject({ p_cap_calls: L.dailyOutboundCalls, p_cap_sms: L.dailySms, p_cap_day_cost: L.dailyCostCents, p_cap_life_cost: L.lifetimeCostCents });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('inbound free-minute stop (fraud/inbound.ts)', () => {
  it('forwards to the owner through the emergency lane, or plays a message, and fails open when the store is down', async () => {
    const o = await observeInbound();
    expect(o.freeWithForwarding).toMatchObject({ destination: expect.anything() });
    expect(o.freeWithoutForwarding).toMatchObject({ error: expect.any(String) });
    expect(o.freeWithForwardingStoreDown).toMatchObject({ destination: expect.anything() });
  });

  it('allowance parsing: paid is allowed; garbage fails open', async () => {
    const o = await observeInbound();
    expect(o.paidAllowance.allowed).toBe(true);
    expect(o.garbageAllowance.allowed).toBe(true);
  });

  it('SQL: the count is minutes_used vs the STORED minutes_included; accounts with a subscription are never blocked', () => {
    const sql = stripSqlComments(readSource('supabase/migrations/20280403000000_fraud_phase2.sql'));
    expect(sql).toMatch(/p\.minutes_included/);
    expect(sql).toMatch(/IF\s+v_paid\s+THEN\s+RETURN\s+jsonb_build_object\('allowed',\s*true/);
    expect(sql).toMatch(/'allowed',\s*v_used\s*<\s*v_included/);
  });

  it('wired: vapi-webhook assistant-request calls evaluateInbound() and answers with exhaustedResponse() (GAP-I1 closed)', () => {
    const code = stripComments(readSource('supabase/functions/vapi-webhook/index.ts'));
    const handler = code.slice(code.indexOf('async function handleAssistantRequest'));
    expect(handler).toMatch(/evaluateInbound\(admin, tenant\.userId\)/);
    expect(handler).toMatch(/exhaustedResponse\(admin, tenant\.userId, forwardTarget\)/);
    // the stop must come before the AI is attached: before the ladder lookup and caller-context building
    expect(handler.indexOf('evaluateInbound(')).toBeLessThan(handler.indexOf('effectiveLevel('));
    expect(cx.gaps.get('GAP-I1')?.open).toBe(false);
  });

  it('evaluateInbound: enforce stops, shadow logs only, every infrastructure error fails open', async () => {
    const m = await observeInboundModes();
    expect(m.enforce).toMatchObject({ allowed: false, shadowDenied: false });
    expect(m.shadow).toMatchObject({ allowed: true, shadowDenied: true });
    expect(m.contextDown).toMatchObject({ allowed: true, shadowDenied: true }); // unknown enforce => log-only
    expect(m.allowanceDown).toMatchObject({ allowed: true, shadowDenied: false });
    expect(m.withinAllowance).toMatchObject({ allowed: true, shadowDenied: false });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('grandfathering', () => {
  it('inbound allowance and usage alerts read the STORED profiles.minutes_included, so a legacy Starter value is honoured', () => {
    const sql = stripSqlComments(readSource('supabase/migrations/20280403000000_fraud_phase2.sql'));
    expect(sql).not.toMatch(/minutesForPlan|catalog/i);
    expect(readSource('supabase/functions/check-cost-guardrails/index.ts')).toMatch(/minutes_included/);
  });

  it('manage-subscription-plan only rewrites minutes_included on an explicit plan change', () => {
    const src = readSource('supabase/functions/manage-subscription-plan/index.ts');
    const hits = [...src.matchAll(/minutes_included:\s*minutesForPlan\(/g)];
    expect(hits.length).toBeGreaterThan(0);
  });

  it('minutesToWriteOnSync: a legacy allowance survives every sync for the SAME plan; a plan change takes the catalog value', () => {
    expect(minutesToWriteOnSync('starter', 'starter')).toBeUndefined(); // old Starter keeps its stored minutes
    expect(minutesToWriteOnSync('professional', 'professional')).toBeUndefined();
    expect(minutesToWriteOnSync('starter', 'professional')).toBe(minutesForPlan('professional'));
    expect(minutesToWriteOnSync('professional', 'starter')).toBe(minutesForPlan('starter'));
    expect(minutesToWriteOnSync(null, 'starter')).toBe(minutesForPlan('starter')); // no recorded plan yet
    expect(minutesToWriteOnSync(undefined, 'business')).toBe(minutesForPlan('business'));
    expect(minutesToWriteOnSync('business', 'enterprise')).toBeUndefined(); // enterprise has no catalog minutes: never overwrite with null
  });

  it('stripe-webhook customer.subscription.updated uses minutesToWriteOnSync and no longer resets minutes (GAP-G1 closed)', () => {
    const block = subscriptionUpdatedBlock();
    expect(block, 'case "customer.subscription.updated" not found in stripe-webhook').not.toBe('');
    expect(block).toMatch(/minutesToWriteOnSync\(/);
    expect(WEBHOOK_OVERWRITES_MINUTES.test(block)).toBe(false);
    expect(block).toMatch(/\.select\("plan"\)/); // reads the current plan first
    expect(cx.gaps.get('GAP-G1')?.open).toBe(false);
  });

  it('plan caps are code constants: changing PLAN_LIMITS affects every account of that plan (no per-account snapshot exists)', () => {
    expect(readSource('supabase/migrations/20280402000000_fraud_abuse_prevention.sql')).not.toMatch(/plan_limits_snapshot/i);
  });

  it.todo('GAP-S1: an account already over the NEW seat limit is not locked out but cannot add another seat (no seat enforcement exists to test)');
  it.todo('GAP-L1: an account already over the NEW location limit is not locked out but cannot add another location (no location enforcement exists to test)');
});

// ---------------------------------------------------------------------------------------------------------------
describe('shadow vs enforce', () => {
  it.each(GUARD_PLANS)('%s outbound: enforce=true refuses, enforce=false allows, logs a shadow event and reserves nothing', async (plan: PlanId) => {
    const cap = PLAN_LIMITS[plan].dailyOutboundCalls;
    const enforced = await runGuard({ context: { plan, enforce: true }, ledger: { dayCalls: cap } });
    expect(enforced.result).toMatchObject({ ok: false, code: 'DAILY_CALLS' });

    const shadow = await runGuard({ context: { plan, enforce: false }, ledger: { dayCalls: cap } });
    expect(shadow.result).toMatchObject({ ok: true, shadowDenied: 'DAILY_CALLS', reservedCents: 0 });
    const ev = shadow.db.inserts.find((i) => i.table === 'fraud_events');
    expect(ev?.row.detail).toMatchObject({ shadow: true });
  });

  it('shadow mode never allows an unroutable or malformed destination to be dialled blindly (denial is still reported)', async () => {
    const r = await runGuard({ context: { enforce: false } }, { to: '+1212555123,,9' });
    expect(r.result.ok && r.result.shadowDenied).toBe('INVALID_NUMBER');
  });

  it('inbound: fraud_settings.enforce=false is log-only, enforce=true stops, errors fail open', async () => {
    const m = await observeInboundModes();
    expect(m.shadow).toMatchObject({ allowed: true, shadowDenied: true });
    expect(m.enforce).toMatchObject({ allowed: false });
    expect(m.allowanceDown.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('emergency calls and emergency / dispatch messages are never blocked', () => {
  it('guardOutbound: every plan x scenario x channel x target (domestic + 911) is allowed and marked emergency', async () => {
    const rows = await runEmergencyScenarios();
    expect(rows.length).toBe(GUARD_PLANS.length * EMERGENCY_SCENARIOS.length * 2 * 2);
    const blocked = rows.filter((r) => !r.ok || !r.emergency);
    expect(blocked, JSON.stringify(blocked.slice(0, 5))).toEqual([]);
  });

  it.each(EMERGENCY_SCENARIOS.filter((s) => s.control))('control: a non-emergency call IS refused in "$name" (proves the scenario bites)', async (sc: EmergencyScenario) => {
    for (const plan of GUARD_PLANS) expect(await controlCode(plan, sc), plan).toBe(sc.control);
  });

  it('emergency traffic does not consume the customer spend ledger', async () => {
    const { db } = await runGuard({}, { purpose: 'emergency' });
    for (const c of db.reserveCalls()) expect(c.args).toMatchObject({ p_cost: 0 });
  });

  it('documented boundaries: own runaway ceiling, and international targets still obey the destination policy', async () => {
    const b = await observeEmergencyBoundaries();
    expect(b.ceilingOk.ok).toBe(true);
    expect(b.ceilingHit).toMatchObject({ ok: false, code: 'DAILY_CALLS' }); // ceiling = EMERGENCY_HANDOFF_DAILY_CEILING
    expect(EMERGENCY_HANDOFF_DAILY_CEILING).toBe(200);
    expect(b.internationalLocked).toMatchObject({ ok: false, code: 'INTERNATIONAL_LOCKED' });
  });

  it('quiet hours: emergency passes at 03:00 local, marketing does not', () => {
    const q = observeQuietHoursEmergency();
    expect(q.defaultSms).toBe(true);
    expect(q.defaultCall).toBe(true);
    expect(q.marketingBlocked).toBe(true);
  });

  it('KNOWN GAP GAP-E4: allowEmergencyOverride=false defers an emergency message', () => {
    const q = observeQuietHoursEmergency();
    expect(cx.gaps.get('GAP-E4')?.open).toBe(!q.overrideOffSms);
    expect(q.overrideOffSms, 'if this passes the gap is closed: update registry.ts and regenerate the matrix').toBe(false);
  });

  it('KNOWN GAP GAP-E3: sendCompliantSms has no emergency lane (emergency paths use deliver.ts)', () => {
    expect(cx.gaps.get('GAP-E3')?.open).toBe(true);
    expect(readSource('supabase/functions/escalate-emergency/index.ts')).toMatch(/notify\/deliver/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('entitlement layer defaults to deny', () => {
  it('edge checker and client evaluation deny on every malformed, failed, expired or missing input', async () => {
    const o = await observeEntitlementDefaultDeny();
    for (const [name, ok] of Object.entries(o)) expect(ok, name).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('matrix integrity', () => {
  it('has exactly one cell per plan x row', () => {
    const cells = buildMatrix(cx);
    expect(cells.length).toBe(MATRIX_PLANS.length * LIMITS.length);
    const seen = new Set(cells.map((c) => `${c.plan}|${c.limit}`));
    expect(seen.size).toBe(cells.length);
  });

  it('every cell is yes, n/a, or an explicit "no" tied to a ticketed, still-open gap (never an unexplained or failing cell)', () => {
    for (const c of buildMatrix(cx)) {
      const where = `${c.plan} / ${c.limit}: ${c.actual}`;
      expect(c.actual.startsWith('WRONG'), where).toBe(false);
      if (c.status === 'no' || c.status === 'conflict') {
        expect(c.gap, `${where} has no gap id`).not.toBeNull();
        expect(KNOWN_GAPS[c.gap!], where).toBeDefined();
        expect(cx.gaps.get(c.gap!)?.open, `${where}: gap is closed, regenerate the matrix`).toBe(true);
      }
    }
  });

  it('every KNOWN_GAPS entry has a ticket id, an effect and a fix, and its evidence is still current', () => {
    const states = evaluateGaps();
    for (const g of Object.values(KNOWN_GAPS)) {
      expect(g.ticket, g.id).toMatch(/^PLAN-ENF-\d{3}$/);
      expect(g.effect.length, g.id).toBeGreaterThan(30);
      expect(g.fix.length, g.id).toBeGreaterThan(20);
      expect(states.has(g.id), `${g.id} has no detector`).toBe(true);
    }
  });

  it('cross-plan controls: nothing fails outright', async () => {
    for (const r of await buildCrossRows(cx)) {
      if (r.status === 'no') expect(r.gap, r.control).not.toBeNull();
    }
  });

  it('request fixtures use a fixed clock and a plain domestic number', () => {
    expect(request().now).toBe(NOW);
    expect(request().to).toBe(DOMESTIC);
    expect(USER).toMatch(/^[0-9a-f-]{36}$/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('docs/plan-enforcement-matrix.md', () => {
  const docPath = join(REPO_ROOT, 'docs/plan-enforcement-matrix.md');

  it('is generated from the same cells the tests assert (drift check; UPDATE_PLAN_MATRIX=1 rewrites it)', async () => {
    const md = renderMatrixMarkdown(buildMatrix(cx), await buildCrossRows(cx), cx);
    if (process.env.UPDATE_PLAN_MATRIX === '1') {
      writeFileSync(docPath, md, 'utf8');
      return;
    }
    expect(existsSync(docPath), 'docs/plan-enforcement-matrix.md is missing: run UPDATE_PLAN_MATRIX=1 npx vitest run src/lib/planEnforcementMatrix.test.ts').toBe(true);
    const onDisk = readFileSync(docPath, 'utf8').replace(/\r\n/g, '\n');
    expect(onDisk === md, 'docs/plan-enforcement-matrix.md is out of date: run UPDATE_PLAN_MATRIX=1 npx vitest run src/lib/planEnforcementMatrix.test.ts and commit it').toBe(true);
  });

  it('shows no "yes" for a cell the tests mark as a gap', async () => {
    const md = renderMatrixMarkdown(buildMatrix(cx), await buildCrossRows(cx), cx);
    expect(md).toMatch(/no \(GAP-W1\)/);
    expect(md).not.toMatch(/WRONG/);
  });
});

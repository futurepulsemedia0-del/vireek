import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALL_STATES, TERMINAL_STATES, TRANSITIONS, allowedEvents, canHomeownerDispute, computeReleaseDueAt,
  isFundsReserved, isTerminal, isValidPartialAmount, nextState,
} from './paymentProtection';
import type { ActorKind, HoldEvent, HoldState } from './paymentProtection';

const ACTORS: ActorKind[] = ['contractor', 'homeowner', 'system', 'staff'];

describe('transition table', () => {
  it('has exactly the allowed transitions (every valid one lands in the expected state)', () => {
    const cases: Array<[HoldState, HoldEvent, ActorKind, HoldState]> = [
      ['draft', 'send_request', 'contractor', 'awaiting_authorization'],
      ['draft', 'cancel', 'contractor', 'voided'],
      ['awaiting_authorization', 'authorized', 'homeowner', 'held'],
      ['awaiting_authorization', 'authorized', 'system', 'held'],
      ['awaiting_authorization', 'authorization_failed', 'system', 'failed'],
      ['awaiting_authorization', 'cancel', 'contractor', 'voided'],
      ['awaiting_authorization', 'expire', 'system', 'expired'],
      ['held', 'claim_completion', 'contractor', 'completion_claimed'],
      ['held', 'request_void', 'contractor', 'voiding'],
      ['held', 'open_dispute', 'homeowner', 'disputed'],
      ['held', 'expire', 'system', 'expired'],
      ['completion_claimed', 'homeowner_confirm', 'homeowner', 'capturing'],
      ['completion_claimed', 'auto_release', 'system', 'capturing'],
      ['completion_claimed', 'open_dispute', 'homeowner', 'disputed'],
      ['completion_claimed', 'request_void', 'contractor', 'voiding'],
      ['completion_claimed', 'expire', 'system', 'expired'],
      ['disputed', 'resolve_release', 'staff', 'capturing'],
      ['disputed', 'resolve_void', 'staff', 'voiding'],
      ['disputed', 'expire', 'system', 'expired'],
      ['capturing', 'capture_succeeded', 'system', 'released'],
      ['capturing', 'capture_failed', 'system', 'needs_review'],
      ['voiding', 'void_succeeded', 'system', 'voided'],
      ['voiding', 'void_failed', 'system', 'needs_review'],
      ['needs_review', 'resolve_capture', 'staff', 'capturing'],
      ['needs_review', 'resolve_void', 'staff', 'voiding'],
      ['needs_review', 'resolve_expired', 'staff', 'expired'],
    ];
    expect(cases).toHaveLength(TRANSITIONS.length);
    for (const [from, event, actor, to] of cases) expect(nextState(from, event, actor)).toBe(to);
  });

  it('rejects every transition that is not in the table', () => {
    const events = new Set<HoldEvent>(TRANSITIONS.map((t) => t.event));
    let rejected = 0;
    for (const s of ALL_STATES) for (const e of events) for (const a of ACTORS) {
      if (!TRANSITIONS.some((t) => t.from === s && t.event === e && t.actor === a)) {
        expect(nextState(s, e, a)).toBeNull();
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(500);
  });

  it('terminal states have no outgoing transitions', () => {
    for (const s of TERMINAL_STATES) {
      expect(isTerminal(s)).toBe(true);
      for (const a of ACTORS) expect(allowedEvents(s, a)).toEqual([]);
    }
  });

  it('every non-terminal state can reach a terminal state', () => {
    for (const s of ALL_STATES.filter((x) => !isTerminal(x))) {
      const seen = new Set<HoldState>([s]);
      const queue: HoldState[] = [s];
      let reachesTerminal = false;
      while (queue.length) {
        const cur = queue.shift() as HoldState;
        if (isTerminal(cur)) { reachesTerminal = true; break; }
        for (const t of TRANSITIONS.filter((x) => x.from === cur)) if (!seen.has(t.to)) { seen.add(t.to); queue.push(t.to); }
      }
      expect(reachesTerminal).toBe(true);
    }
  });

  it('the contractor can never release funds to themselves', () => {
    const toCapturing = TRANSITIONS.filter((t) => t.to === 'capturing').map((t) => t.actor);
    expect(toCapturing.includes('contractor')).toBe(false);
  });

  it('the homeowner can dispute only before capture starts', () => {
    expect(canHomeownerDispute('held')).toBe(true);
    expect(canHomeownerDispute('completion_claimed')).toBe(true);
    for (const s of ['capturing', 'released', 'voided', 'expired', 'draft'] as HoldState[]) expect(canHomeownerDispute(s)).toBe(false);
  });

  it('the homeowner cannot unilaterally void a hold', () => {
    for (const s of ALL_STATES) expect(nextState(s, 'request_void', 'homeowner')).toBeNull();
  });

  it('flags states where money is reserved', () => {
    expect(isFundsReserved('held')).toBe(true);
    expect(isFundsReserved('draft')).toBe(false);
    expect(isFundsReserved('released')).toBe(false);
  });
});

describe('computeReleaseDueAt', () => {
  const now = new Date('2030-01-01T00:00:00Z');
  it('uses the policy window when the card hold allows it', () => {
    expect(computeReleaseDueAt(now, 48, new Date('2030-01-07T00:00:00Z'), 24)?.toISOString()).toBe('2030-01-03T00:00:00.000Z');
  });
  it('clips to the card hold minus the margin', () => {
    expect(computeReleaseDueAt(now, 120, new Date('2030-01-04T00:00:00Z'), 24)?.toISOString()).toBe('2030-01-03T00:00:00.000Z');
  });
  it('returns null when the window is too short', () => {
    expect(computeReleaseDueAt(now, 48, new Date('2030-01-01T12:00:00Z'), 24)).toBeNull();
  });
  it('works without a known capture_before', () => {
    expect(computeReleaseDueAt(now, 2, null, 24)?.toISOString()).toBe('2030-01-01T02:00:00.000Z');
  });
});

describe('isValidPartialAmount', () => {
  it('needs both sides to keep at least one cent', () => {
    expect(isValidPartialAmount(1, 10000)).toBe(true);
    expect(isValidPartialAmount(9999, 10000)).toBe(true);
    expect(isValidPartialAmount(0, 10000)).toBe(false);
    expect(isValidPartialAmount(10000, 10000)).toBe(false);
    expect(isValidPartialAmount(12.5, 10000)).toBe(false);
  });
});

describe('SQL seed parity', () => {
  it('the TS table equals the migration seed row for row', () => {
    const sql = readFileSync(resolve(__dirname, '../../supabase/migrations/20290312000100_homeowner_payment_protection.sql'), 'utf8');
    const block = sql.slice(sql.indexOf('INSERT INTO public.payment_protection_transitions'), sql.indexOf('ON CONFLICT (from_state, event, actor_kind)'));
    const rows = [...block.matchAll(/\('([a-z_]+)', '([a-z_]+)', '([a-z_]+)', '([a-z]+)'\)/g)].map((m) => `${m[1]}|${m[2]}|${m[3]}|${m[4]}`).sort();
    const ts = TRANSITIONS.map((t) => `${t.from}|${t.event}|${t.to}|${t.actor}`).sort();
    expect(rows).toEqual(ts);
  });
});

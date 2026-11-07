import { describe, expect, it } from 'vitest';
import {
  RESULTS_PLAN_DEFAULTS,
  qualifyJob,
  type ContactFacts,
  type JobFacts,
  type PriorJob,
  type ReasonCode,
  type RulesConfig,
} from '../../../supabase/functions/_shared/results-plan/qualification';
import { UNIT_COST_DEFAULTS, directCostPerVerifiedJob, marginAtPrice, priceFloorCents } from '../../../supabase/functions/_shared/results-plan/unitEconomics';

const T0 = '2026-03-01T10:00:00.000Z';
const iso = (base: string, addHours: number) => new Date(Date.parse(base) + addHours * 3_600_000).toISOString();

const job = (o: Partial<JobFacts> = {}): JobFacts => ({
  id: 'job-1',
  customerKey: 'cust-1',
  addressKey: 'addr-1',
  createdAt: T0,
  source: 'sarah',
  status: 'completed',
  confirmedAt: iso(T0, 1),
  completedAt: iso(T0, 48),
  paidAt: null,
  cancelledAt: null,
  ...o,
});
const contact = (o: Partial<ContactFacts> = {}): ContactFacts => ({ handledBySarah: true, channel: 'call', isSpam: false, isWrongNumber: false, ...o });
const prior = (o: Partial<PriorJob> = {}): PriorJob => ({ id: 'p-1', customerKey: 'cust-1', addressKey: 'addr-1', createdAt: iso(T0, -24 * 5), status: 'scheduled', ...o });

describe('qualifyJob — happy path', () => {
  it('bills a completed Sarah-booked job', () => {
    const r = qualifyJob(job(), contact(), []);
    expect(r.billable).toBe(true);
    expect(r.level).toBe('completed');
    expect(r.billableAt).toBe(iso(T0, 48));
  });
});

describe('qualifyJob — first contact channels', () => {
  for (const channel of ['call', 'sms', 'chat'] as const) {
    it(`accepts ${channel}`, () => expect(qualifyJob(job(), contact({ channel }), []).billable).toBe(true));
  }
  it('rejects when not handled by Sarah', () => expect(qualifyJob(job(), contact({ handledBySarah: false }), []).reasons).toContain('not_first_contact_by_sarah'));
  it('rejects when channel unknown', () => expect(qualifyJob(job(), contact({ channel: null }), []).billable).toBe(false));
});

describe('qualifyJob — exclusions', () => {
  const cases: Array<[string, Partial<JobFacts>, Partial<ContactFacts>, ReasonCode]> = [
    ['owner-created', { source: 'owner' }, {}, 'owner_created'],
    ['crm import', { source: 'crm_import' }, {}, 'owner_created'],
    ['internal test', { source: 'test' }, {}, 'internal_test'],
    ['spam', {}, { isSpam: true }, 'spam'],
    ['wrong number', {}, { isWrongNumber: true }, 'wrong_number'],
  ];
  for (const [name, j, c, reason] of cases) {
    it(`never bills ${name}`, () => {
      const r = qualifyJob(job(j), contact(c), []);
      expect(r.billable).toBe(false);
      expect(r.qualified).toBe(false);
      expect(r.reasons).toContain(reason);
    });
  }
  it('unknown source is billable only if Sarah handled it', () => expect(qualifyJob(job({ source: 'unknown' }), contact(), []).billable).toBe(true));
});

describe('qualifyJob — duplicates (hours matrix)', () => {
  for (const hrs of [0, 1, 6, 12, 23, 24]) {
    it(`earlier job ${hrs}h before is a duplicate`, () => {
      const r = qualifyJob(job(), contact(), [prior({ createdAt: iso(T0, -hrs), status: 'completed' })]);
      expect(r.reasons).toContain('duplicate');
      expect(r.billable).toBe(false);
    });
  }
  for (const hrs of [25, 48, 100]) {
    it(`completed job ${hrs}h before is NOT a duplicate`, () => {
      const r = qualifyJob(job(), contact(), [prior({ createdAt: iso(T0, -hrs), status: 'completed' })]);
      expect(r.billable).toBe(true);
    });
  }
  it('cancelled earlier job is not a duplicate', () => expect(qualifyJob(job(), contact(), [prior({ createdAt: iso(T0, -2), status: 'cancelled' })]).billable).toBe(true));
  it('a LATER job does not make this one a duplicate', () => expect(qualifyJob(job(), contact(), [prior({ createdAt: iso(T0, 5), status: 'scheduled' })]).billable).toBe(true));
  it('same id is ignored', () => expect(qualifyJob(job(), contact(), [prior({ id: 'job-1', createdAt: iso(T0, -1) })]).billable).toBe(true));
  it('different customer and address is unrelated', () => expect(qualifyJob(job(), contact(), [prior({ customerKey: 'x', addressKey: 'y', createdAt: iso(T0, -1) })]).billable).toBe(true));
  it('matches on address alone', () => expect(qualifyJob(job(), contact(), [prior({ customerKey: 'x', createdAt: iso(T0, -1) })]).reasons).toContain('duplicate'));
  it('matches on customer alone', () => expect(qualifyJob(job(), contact(), [prior({ addressKey: 'y', createdAt: iso(T0, -1) })]).reasons).toContain('duplicate'));
  it('null keys never match each other', () => expect(qualifyJob(job({ customerKey: null, addressKey: null }), contact(), [prior({ customerKey: null, addressKey: null, createdAt: iso(T0, -1) })]).billable).toBe(true));
});

describe('qualifyJob — existing open job window (days matrix)', () => {
  for (const status of ['scheduled', 'en_route', 'in_progress'] as const) {
    for (const days of [2, 10, 29, 30]) {
      it(`open ${status} job ${days}d earlier blocks billing`, () => {
        const r = qualifyJob(job(), contact(), [prior({ status, createdAt: iso(T0, -24 * days) })]);
        expect(r.reasons).toContain('existing_open_job');
        expect(r.billable).toBe(false);
      });
    }
    it(`open ${status} job 31d earlier does not block`, () => expect(qualifyJob(job(), contact(), [prior({ status, createdAt: iso(T0, -24 * 31) })]).billable).toBe(true));
  }
  for (const status of ['completed', 'cancelled'] as const) {
    it(`${status} job 5d earlier does not block`, () => expect(qualifyJob(job(), contact(), [prior({ status, createdAt: iso(T0, -24 * 5) })]).billable).toBe(true));
  }
  it('respects a custom window', () => {
    const cfg: RulesConfig = { ...RESULTS_PLAN_DEFAULTS, existingWorkWindowDays: 7 };
    expect(qualifyJob(job(), contact(), [prior({ createdAt: iso(T0, -24 * 8) })], cfg).billable).toBe(true);
    expect(qualifyJob(job(), contact(), [prior({ createdAt: iso(T0, -24 * 6) })], cfg).billable).toBe(false);
  });
});

describe('qualifyJob — billing level matrix', () => {
  const states = {
    booked: { confirmedAt: null, completedAt: null, paidAt: null, status: 'scheduled' as const },
    confirmed: { confirmedAt: iso(T0, 1), completedAt: null, paidAt: null, status: 'in_progress' as const },
    completed: { confirmedAt: iso(T0, 1), completedAt: iso(T0, 48), paidAt: null, status: 'completed' as const },
    paid: { confirmedAt: iso(T0, 1), completedAt: iso(T0, 48), paidAt: iso(T0, 60), status: 'completed' as const },
  };
  const order = ['booked', 'confirmed', 'completed', 'paid'] as const;
  for (const billing of order) {
    for (const reached of order) {
      const expected = order.indexOf(reached) >= order.indexOf(billing);
      it(`billing=${billing}, reached=${reached} -> billable=${expected}`, () => {
        const r = qualifyJob(job(states[reached]), contact(), [], { ...RESULTS_PLAN_DEFAULTS, billingLevel: billing });
        expect(r.billable).toBe(expected);
        expect(r.level).toBe(reached);
        if (!expected) expect(r.reasons).toContain('below_billing_level');
      });
    }
  }
  it('completed without confirmation still reaches completed', () => expect(qualifyJob(job({ confirmedAt: null }), contact(), []).level).toBe('completed'));
});

describe('qualifyJob — cancellations', () => {
  it('cancelled before any billing event is never billed', () => {
    const r = qualifyJob(job({ status: 'cancelled', completedAt: null, confirmedAt: null, cancelledAt: iso(T0, 3) }), contact(), []);
    expect(r.billable).toBe(false);
    expect(r.reasons).toContain('cancelled_before_billing_event');
  });
  for (const h of [0, 1, 24, 71, 72]) {
    it(`cancelled ${h}h after completion voids the charge`, () => {
      const r = qualifyJob(job({ cancelledAt: iso(T0, 48 + h) }), contact(), []);
      expect(r.voided).toBe(true);
      expect(r.billable).toBe(false);
    });
  }
  for (const h of [73, 200]) {
    it(`cancelled ${h}h after completion stays billable`, () => expect(qualifyJob(job({ cancelledAt: iso(T0, 48 + h) }), contact(), []).billable).toBe(true));
  }
  it('cancelled then completed is a conflict for review', () => {
    const r = qualifyJob(job({ cancelledAt: iso(T0, 10) }), contact(), []);
    expect(r.reasons).toContain('conflicting_signals');
    expect(r.billable).toBe(false);
  });
  it('custom cancel window of 0 only voids same-instant cancels', () => {
    const cfg: RulesConfig = { ...RESULTS_PLAN_DEFAULTS, cancelWindowHours: 0 };
    expect(qualifyJob(job({ cancelledAt: iso(T0, 49) }), contact(), [], cfg).billable).toBe(true);
    expect(qualifyJob(job({ cancelledAt: iso(T0, 48) }), contact(), [], cfg).voided).toBe(true);
  });
});

describe('qualifyJob — robustness', () => {
  it('invalid createdAt is not billable', () => expect(qualifyJob(job({ createdAt: 'nope' }), contact(), []).reasons).toEqual(['invalid_timestamp']));
  it('invalid completedAt is not billable', () => expect(qualifyJob(job({ completedAt: 'x' }), contact(), []).billable).toBe(false));
  it('ignores prior jobs with a bad timestamp', () => expect(qualifyJob(job(), contact(), [prior({ createdAt: 'bad' })]).billable).toBe(true));
  it('is deterministic', () => expect(qualifyJob(job(), contact(), [])).toEqual(qualifyJob(job(), contact(), [])));
  it('does not mutate inputs', () => {
    const p = [prior()];
    const snap = JSON.stringify(p);
    qualifyJob(job(), contact(), p);
    expect(JSON.stringify(p)).toBe(snap);
  });
  it('reports all failing exclusions together', () => {
    const r = qualifyJob(job({ source: 'owner' }), contact({ isSpam: true, handledBySarah: false }), []);
    expect(r.reasons).toEqual(['not_first_contact_by_sarah', 'owner_created', 'spam']);
  });
});

describe('qualifyJob — exclusion matrix (source x spam x wrong number x Sarah)', () => {
  const sources = ['sarah', 'owner', 'crm_import', 'test', 'unknown'] as const;
  for (const source of sources) {
    for (const isSpam of [false, true]) {
      for (const isWrongNumber of [false, true]) {
        for (const handledBySarah of [true, false]) {
          const shouldBill = (source === 'sarah' || source === 'unknown') && !isSpam && !isWrongNumber && handledBySarah;
          it(`source=${source} spam=${isSpam} wrong=${isWrongNumber} sarah=${handledBySarah} -> billable=${shouldBill}`, () => {
            const r = qualifyJob(job({ source }), contact({ isSpam, isWrongNumber, handledBySarah }), []);
            expect(r.billable).toBe(shouldBill);
            expect(r.qualified).toBe(shouldBill);
          });
        }
      }
    }
  }
});

describe('unit economics (placeholder inputs)', () => {
  it('direct cost is positive', () => expect(directCostPerVerifiedJob(UNIT_COST_DEFAULTS)).toBeGreaterThan(0));
  it('price at the floor reaches the target margin', () => {
    for (const target of [20, 40, 60, 75]) {
      const p = priceFloorCents(target);
      expect(marginAtPrice(p).marginPct).toBeGreaterThanOrEqual(target - 0.5);
      expect(marginAtPrice(p - 100).marginPct).toBeLessThan(target + 0.01);
    }
  });
  it('floor is infinite when fees and credits eat the margin', () => {
    expect(priceFloorCents(95, { ...UNIT_COST_DEFAULTS, creditRate: 0.5, paymentPercentFee: 0.5 })).toBe(Number.POSITIVE_INFINITY);
  });
  it('margin rises with price', () => expect(marginAtPrice(8000).marginPct).toBeGreaterThan(marginAtPrice(3000).marginPct));
});

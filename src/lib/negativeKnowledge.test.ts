import { describe, expect, it } from 'vitest';
import {
  deriveRules,
  evaluateGuard,
  facetsFor,
  isFailure,
  technicianOutcome,
  type NegativeEvent,
  type NegativeRule,
} from '@/lib/negativeKnowledge';

const NOW = Date.parse('2026-09-24T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function event(over: Partial<NegativeEvent> = {}): NegativeEvent {
  return {
    action_kind: 'offer',
    subject_key: 'membership-20',
    outcome: 'declined',
    context: { segment: 'price_sensitive' },
    recorded_at: daysAgo(10),
    ...over,
  };
}

/** 10 healthy standard-segment conversions plus 8 price-sensitive declines. */
function clearPattern(): NegativeEvent[] {
  const healthy = Array.from({ length: 10 }, () => event({ outcome: 'converted', context: { segment: 'standard' } }));
  const failing = Array.from({ length: 8 }, () => event());
  return [...healthy, ...failing];
}

describe('classification and facets', () => {
  it('treats declines, opt-outs, callbacks and cancellations as failures', () => {
    expect(isFailure('declined')).toBe(true);
    expect(isFailure('opted_out')).toBe(true);
    expect(isFailure('callback')).toBe(true);
    expect(isFailure('cancelled')).toBe(true);
    expect(isFailure('converted')).toBe(false);
    expect(isFailure('completed')).toBe(false);
  });

  it('maps technician resolutions to outcomes', () => {
    expect(technicianOutcome('fixed_first_visit')).toBe('completed');
    expect(technicianOutcome('fixed_followup')).toBe('callback');
  });

  it('builds one base facet plus one facet per present context field', () => {
    const keys = facetsFor('offer', 'x', { segment: 'Price Sensitive', region: null, daypart: 'evening' }).map((f) => f.key);
    expect(keys).toEqual(['offer:x', 'offer:x|segment=price_sensitive', 'offer:x|daypart=evening']);
  });
});

describe('deriveRules', () => {
  it('finds a context-specific rule and does not blanket the whole offer', () => {
    const rules = deriveRules(clearPattern(), NOW);
    const hit = rules.find((r) => r.facet === 'offer:membership-20|segment=price_sensitive');
    expect(hit?.severity).toBe('avoid');
    expect(rules.some((r) => r.facet === 'offer:membership-20')).toBe(false);
  });

  it('ignores small samples', () => {
    const few = [
      ...Array.from({ length: 10 }, () => event({ outcome: 'converted', context: { segment: 'standard' } })),
      ...Array.from({ length: 3 }, () => event()),
    ];
    expect(deriveRules(few, NOW)).toEqual([]);
  });

  it('ignores events outside the learning window', () => {
    const old = Array.from({ length: 8 }, () => event({ recorded_at: daysAgo(400) }));
    expect(deriveRules(old, NOW)).toEqual([]);
  });
});

describe('evaluateGuard', () => {
  const rules: NegativeRule[] = deriveRules(clearPattern(), NOW).map((d) => ({ ...d, status: 'active' as const }));

  it('warns before offering the failing offer to a price-sensitive customer', () => {
    const result = evaluateGuard(
      { action_kind: 'offer', subject_key: 'membership-20', context: { segment: 'price_sensitive' } },
      rules,
    );
    expect(result.decision).toBe('avoid');
    expect(result.warnings[0].facet).toBe('offer:membership-20|segment=price_sensitive');
  });

  it('allows the same offer for other segments', () => {
    const result = evaluateGuard(
      { action_kind: 'offer', subject_key: 'membership-20', context: { segment: 'premium' } },
      rules,
    );
    expect(result.decision).toBe('allow');
  });

  it('never fires a dismissed rule', () => {
    const dismissed = rules.map((r) => ({ ...r, status: 'dismissed' as const }));
    const result = evaluateGuard(
      { action_kind: 'offer', subject_key: 'membership-20', context: { segment: 'price_sensitive' } },
      dismissed,
    );
    expect(result.decision).toBe('allow');
  });
});

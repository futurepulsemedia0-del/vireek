import { describe, it, expect } from 'vitest';
import { evaluateGuardrail, effectiveMaxCallSeconds } from './costGuardrail';

const limits = { softCostUsd: 10, hardCostUsd: 20, maxCallSeconds: 600 };

describe('evaluateGuardrail: emergency calls are never restricted', () => {
  it('does not restrict an emergency even past the hard cost limit and 100% of included minutes', () => {
    const r = evaluateGuardrail({ usedMinutes: 700, includedMinutes: 600, monthCostUsd: 999, limits, isEmergency: true });
    expect(r.level).toBe('hard'); // the account IS over the limit...
    expect(r.action).toBe('none'); // ...but an emergency is still served
    expect(r.reasons).toContain('emergency_never_restricted');
  });

  it('restricts NON-emergency work once the hard limit is hit (control case)', () => {
    const r = evaluateGuardrail({ usedMinutes: 10, includedMinutes: 600, monthCostUsd: 25, limits, isEmergency: false });
    expect(r.action).toBe('restrict_non_emergency');
  });

  it('a minute-allowance stop alone never restricts anything (overage is billed, not blocked)', () => {
    const r = evaluateGuardrail({ usedMinutes: 650, includedMinutes: 600, monthCostUsd: 1, limits, isEmergency: false });
    expect(r.minutesAlert).toBe(100);
    expect(r.action).toBe('alert_owner');
  });

  it('never caps the duration of an emergency call', () => {
    expect(effectiveMaxCallSeconds(limits, true)).toBeNull();
    expect(effectiveMaxCallSeconds(limits, false)).toBe(600);
    expect(effectiveMaxCallSeconds(null, false)).toBeNull();
  });
});

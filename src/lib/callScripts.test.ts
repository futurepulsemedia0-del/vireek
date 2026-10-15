import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  buildCallScriptsContext,
  classifyCallScenario,
  compareArms,
  diffLines,
  normalCdf,
  pickArm,
  sanitizeScriptText,
  summarizeScript,
  validateScriptDraft,
  wilsonInterval,
  type CallFacts,
  type CallRowFacts,
} from '../../supabase/functions/_shared/call-scripts/logic';

const call = (over: Partial<CallFacts> = {}): CallFacts => ({
  is_emergency: false,
  intent: null,
  status: 'new_lead',
  is_voicemail: false,
  booking_outcome: null,
  ...over,
});

describe('validateScriptDraft', () => {
  it('accepts a valid draft', () => {
    expect(validateScriptDraft({ scenario: 'emergency', opening_line: 'Hi', body: 'a'.repeat(30) }).ok).toBe(true);
  });

  it('rejects unknown scenario, short body, long body and long opening', () => {
    const r = validateScriptDraft({ scenario: 'nope', opening_line: 'x'.repeat(LIMITS.openingMax + 1), body: 'short' });
    expect(r.ok).toBe(false);
    expect(r.errors.scenario).toBeTruthy();
    expect(r.errors.opening_line).toBeTruthy();
    expect(r.errors.body).toBeTruthy();
    expect(validateScriptDraft({ scenario: 'emergency', opening_line: '', body: 'a'.repeat(LIMITS.bodyMax + 1) }).errors.body).toBeTruthy();
  });
});

describe('sanitizeScriptText', () => {
  it('neutralises template braces, strips control chars and caps length', () => {
    const out = sanitizeScriptText('Hi {{name}}\u0000\r\nthere', 100);
    expect(out).not.toContain('{{');
    expect(out).not.toContain('}}');
    expect(out).not.toContain('\u0000');
    expect(out).not.toContain('\r');
    expect(sanitizeScriptText('x'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('pickArm', () => {
  it('is deterministic and respects 0% / 100%', () => {
    expect(pickArm('call-1', 's1', 0)).toBe('control');
    expect(pickArm('call-1', 's1', 100)).toBe('challenger');
    expect(pickArm('call-1', 's1', 30)).toBe(pickArm('call-1', 's1', 30));
  });

  it('splits traffic close to the requested percentage', () => {
    let challenger = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) if (pickArm(`call-${i}`, 'script-x', 20) === 'challenger') challenger++;
    expect(Math.abs(challenger / n - 0.2)).toBeLessThan(0.015);
  });
});

describe('buildCallScriptsContext', () => {
  it('returns empty string with nothing to inject', () => {
    expect(buildCallScriptsContext([])).toBe('');
  });

  it('orders emergency first and never leaks template braces', () => {
    const ctx = buildCallScriptsContext([
      { scenario: 'price_quote', opening_line: 'Hi {{name}}', body: 'Ask about the unit age {{x}} first.' },
      { scenario: 'emergency', opening_line: '', body: 'Stay calm and collect the address.' },
    ]);
    expect(ctx).not.toContain('{{');
    expect(ctx.indexOf('emergency')).toBeLessThan(ctx.indexOf('price_quote'));
  });

  it('skips a whole script that would blow the budget instead of cutting it mid-sentence', () => {
    expect(buildCallScriptsContext([{ scenario: 'emergency', opening_line: '', body: 'x'.repeat(2500) }], 500)).toBe('');
  });
});

describe('classifyCallScenario', () => {
  it('applies the documented priority order', () => {
    expect(classifyCallScenario(call({ is_emergency: true }), false)).toBe('emergency');
    expect(classifyCallScenario(call({ intent: 'gas smell in the basement' }), false)).toBe('emergency');
    expect(classifyCallScenario(call({ intent: 'asking about price' }), true)).toBe('after_hours');
    expect(classifyCallScenario(call({ intent: 'wants a quote for AC install' }), false)).toBe('price_quote');
    expect(classifyCallScenario(call({ intent: 'reschedule my appointment' }), false)).toBe('reschedule_cancel');
    expect(classifyCallScenario(call({ intent: 'unhappy about last visit' }), false)).toBe('complaint');
    expect(classifyCallScenario(call({ intent: 'warranty follow-up' }), false)).toBe('existing_customer');
    expect(classifyCallScenario(call({ intent: 'AC not cooling' }), false)).toBe('new_inquiry');
    expect(classifyCallScenario(call({ intent: null }), false)).toBe('new_inquiry');
  });
});

describe('summarizeScript', () => {
  const a = (id: string, version: string, arm: 'control' | 'challenger') => ({
    call_external_id: id,
    version_id: version,
    arm,
    after_hours: false,
  });
  const row = (id: string, over: Partial<CallFacts>): CallRowFacts => ({ external_id: id, ...call(over) });

  it('counts conversions per arm and version, and separates pending / excluded', () => {
    const s = summarizeScript(
      'price_quote',
      [a('a', 'v1', 'control'), a('b', 'v2', 'challenger'), a('c', 'v1', 'control'), a('d', 'v1', 'control'), a('missing', 'v1', 'control')],
      [
        row('a', { intent: 'price check', booking_outcome: 'booked' }),
        row('b', { intent: 'quote please', status: 'booked' }),
        row('c', { intent: 'quote', is_voicemail: true }),
        row('d', { intent: 'reschedule' }),
      ],
    );
    expect(s.byArm.control).toEqual({ calls: 1, booked: 1 });
    expect(s.byArm.challenger).toEqual({ calls: 1, booked: 1 });
    expect(s.byVersion.v1).toEqual({ calls: 1, booked: 1 });
    expect(s.pending).toBe(1);
    expect(s.excluded).toBe(2);
  });

  it('does not count "already scheduled" as a conversion', () => {
    const s = summarizeScript('new_inquiry', [a('a', 'v1', 'control')], [row('a', { booking_outcome: 'already_scheduled' })]);
    expect(s.byArm.control).toEqual({ calls: 1, booked: 0 });
  });
});

describe('compareArms', () => {
  it('needs the minimum sample on BOTH arms', () => {
    expect(compareArms({ calls: 10, booked: 5 }, { calls: 200, booked: 90 }).verdict).toBe('insufficient_data');
  });

  it('detects a significant winner in either direction', () => {
    const win = compareArms({ calls: 200, booked: 60 }, { calls: 200, booked: 90 });
    expect(win.verdict).toBe('challenger_winning');
    expect(win.pValue).toBeLessThan(0.05);
    expect(win.liftPoints).toBeCloseTo(15, 5);
    expect(compareArms({ calls: 100, booked: 60 }, { calls: 100, booked: 40 }).verdict).toBe('control_winning');
  });

  it('reports no difference for noise and for identical zero rates', () => {
    expect(compareArms({ calls: 100, booked: 50 }, { calls: 100, booked: 52 }).verdict).toBe('no_difference');
    expect(compareArms({ calls: 50, booked: 0 }, { calls: 50, booked: 0 }).verdict).toBe('no_difference');
  });
});

describe('statistics helpers', () => {
  it('normalCdf matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });

  it('wilsonInterval brackets the observed rate and handles n=0', () => {
    const w = wilsonInterval(50, 100);
    expect(w).not.toBeNull();
    expect(w!.low).toBeLessThan(0.5);
    expect(w!.high).toBeGreaterThan(0.5);
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe('diffLines', () => {
  it('marks changed lines and keeps unchanged ones', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc').map((d) => d.type)).toEqual(['same', 'del', 'add', 'same']);
  });
});

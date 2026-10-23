import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_RESPONSE_SCHEMA,
  averageScore,
  buildDisclosureText,
  buildTaskDraft,
  canRecord,
  computeDueAt,
  dedupeInsights,
  detectStateFromAddress,
  formatDuration,
  insightKey,
  resolveConsentPolicy,
  retentionDaysLeft,
  safetyAlertNeeded,
  validateAnalysis,
  type ConsentState,
  type RawInsight,
} from '../../supabase/functions/_shared/conversation-intel/engine';

const ENDED = new Date('2026-10-21T12:00:00.000Z');

function insight(over: Partial<RawInsight> = {}): RawInsight {
  return {
    kind: 'commitment',
    text: 'Send the written quote tomorrow',
    speaker: 'technician',
    severity: 'medium',
    evidence: null,
    due_description: null,
    due_hours_estimate: null,
    resolved: null,
    note: null,
    ...over,
  };
}

describe('detectStateFromAddress', () => {
  it('reads state + ZIP', () => {
    expect(detectStateFromAddress('12 Oak St, Austin, TX 78701')).toBe('TX');
    expect(detectStateFromAddress('9 Pine Rd, San Jose, ca 95112-1234, USA')).toBe('CA');
  });
  it('reads a trailing state without ZIP', () => {
    expect(detectStateFromAddress('Miami, FL')).toBe('FL');
  });
  it('returns null for non-US / unknown text', () => {
    expect(detectStateFromAddress('221B Baker Street, London')).toBeNull();
    expect(detectStateFromAddress('Berlin, XX 10115')).toBeNull();
    expect(detectStateFromAddress('')).toBeNull();
    expect(detectStateFromAddress(null)).toBeNull();
  });
});

describe('resolveConsentPolicy', () => {
  it('flags all-party states and requires verbal confirmation', () => {
    const p = resolveConsentPolicy('ca');
    expect(p.mode).toBe('all_party');
    expect(p.state).toBe('CA');
    expect(p.requireVerbalConfirmation).toBe(true);
    expect(p.assumedStrictest).toBe(false);
  });
  it('still requires explicit consent in one-party states', () => {
    const p = resolveConsentPolicy('TX');
    expect(p.mode).toBe('one_party_plus');
    expect(p.requireVerbalConfirmation).toBe(false);
  });
  it('treats unknown jurisdictions as all-party', () => {
    for (const s of [null, undefined, '', 'ZZ']) {
      const p = resolveConsentPolicy(s);
      expect(p.mode).toBe('unknown_all_party');
      expect(p.assumedStrictest).toBe(true);
      expect(p.requireVerbalConfirmation).toBe(true);
    }
  });
});

describe('buildDisclosureText', () => {
  it('names the company, offers an opt-out and mentions deletion', () => {
    const t = buildDisclosureText(resolveConsentPolicy('TX'), 'Acme Plumbing');
    expect(t).toContain('Acme Plumbing');
    expect(t).toContain('if you say no, nothing is recorded');
    expect(t).toContain('delete');
    expect(t.endsWith('Is that okay with you?')).toBe(true);
  });
  it('adds the state sentence only for all-party states', () => {
    expect(buildDisclosureText(resolveConsentPolicy('CA'), 'A')).toContain('California requires everyone');
    expect(buildDisclosureText(resolveConsentPolicy(null), 'A')).toContain('clear yes from everyone');
    expect(buildDisclosureText(resolveConsentPolicy('TX'), 'A')).not.toContain('requires everyone');
  });
  it('falls back when the company name is blank', () => {
    expect(buildDisclosureText(resolveConsentPolicy('TX'), '  ')).toContain('our company');
  });
});

describe('canRecord', () => {
  const ok: ConsentState = {
    customerStatus: 'granted',
    customerConsentAt: '2026-10-21T11:00:00Z',
    technicianConsentAt: '2026-10-21T11:00:01Z',
    disclosureShownAt: '2026-10-21T10:59:00Z',
  };
  it('allows only when everything is in place', () => {
    expect(canRecord(ok).ok).toBe(true);
  });
  it('blocks every missing piece', () => {
    expect(canRecord({ ...ok, customerStatus: 'declined' }).ok).toBe(false);
    expect(canRecord({ ...ok, customerStatus: 'withdrawn' }).ok).toBe(false);
    expect(canRecord({ ...ok, customerStatus: 'not_asked' }).ok).toBe(false);
    expect(canRecord({ ...ok, customerConsentAt: null }).ok).toBe(false);
    expect(canRecord({ ...ok, technicianConsentAt: null }).ok).toBe(false);
    expect(canRecord({ ...ok, disclosureShownAt: null }).ok).toBe(false);
  });
  it('explains why', () => {
    expect(canRecord({ ...ok, customerStatus: 'declined' }).reason).toMatch(/declined/);
  });
});

describe('validateAnalysis', () => {
  it('never throws on garbage and returns an empty valid shape', () => {
    for (const bad of [null, undefined, 42, 'x', [], { insights: 'no' }]) {
      const a = validateAnalysis(bad);
      expect(a.insights).toEqual([]);
      expect(a.transcript).toBe('');
      expect(a.coaching.strengths).toEqual([]);
      expect(a.coaching.scores.communication).toBeNull();
    }
  });

  it('drops invalid kinds / too-short text and normalises enums', () => {
    const a = validateAnalysis({
      transcript: 'Technician: hi',
      insights: [
        { kind: 'weird', text: 'something long enough' },
        { kind: 'safety', text: 'ab' },
        { kind: 'safety', text: 'Smell of gas near the water heater', speaker: 'robot', severity: 'nuclear' },
        { kind: 'objection', text: 'Price is too high', resolved: 'yes' },
        null,
        'string',
      ],
    });
    expect(a.insights).toHaveLength(2);
    expect(a.insights[0].speaker).toBe('unknown');
    expect(a.insights[0].severity).toBe('high'); // safety default
    expect(a.insights[1].severity).toBe('medium');
    expect(a.insights[1].resolved).toBeNull();
  });

  it('bounds hours, only keeps them for commitments, and caps per-kind count', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'upsell', text: `Upsell number ${i}` }));
    const a = validateAnalysis({
      insights: [
        { kind: 'commitment', text: 'Return Friday with the part', due_hours_estimate: 48 },
        { kind: 'commitment', text: 'Call back sometime soon ok', due_hours_estimate: 99999 },
        { kind: 'commitment', text: 'Negative hours are invalid', due_hours_estimate: -3 },
        { kind: 'objection', text: 'Needs spouse approval', due_hours_estimate: 5, resolved: false },
        ...many,
      ],
    });
    const c = a.insights.filter((i) => i.kind === 'commitment');
    expect(c.map((x) => x.due_hours_estimate)).toEqual([48, null, null]);
    expect(a.insights.find((i) => i.kind === 'objection')?.due_hours_estimate).toBeNull();
    expect(a.insights.filter((i) => i.kind === 'upsell')).toHaveLength(8);
  });

  it('clamps scores, trims text and limits lists', () => {
    const a = validateAnalysis({
      coaching: {
        summary: '  Good   visit  ',
        strengths: ['a', 'b', 'c', 'd', 'e'],
        improvements: ['x'],
        focus_next: '   ',
        scores: { communication: 140, commitment_clarity: -5, objection_handling: 'high', safety_awareness: 72.6 },
      },
    });
    expect(a.coaching.summary).toBe('Good visit');
    expect(a.coaching.strengths).toHaveLength(4);
    expect(a.coaching.focus_next).toBeNull();
    expect(a.coaching.scores).toEqual({
      communication: 100,
      commitment_clarity: 0,
      objection_handling: null,
      safety_awareness: 73,
      upsell_discovery: null,
    });
  });

  it('truncates evidence quotes to 200 chars', () => {
    const a = validateAnalysis({ insights: [{ kind: 'safety', text: 'Exposed wiring in the attic', evidence: 'x'.repeat(500) }] });
    expect(a.insights[0].evidence).toHaveLength(200);
  });
});

describe('computeDueAt', () => {
  it('adds hours to the conversation end', () => {
    expect(computeDueAt(ENDED, 24)).toBe('2026-10-22T12:00:00.000Z');
    expect(computeDueAt(ENDED, 0.5)).toBe('2026-10-21T12:30:00.000Z');
  });
  it('returns null without an estimate', () => {
    expect(computeDueAt(ENDED, null)).toBeNull();
    expect(computeDueAt(ENDED, Number.NaN)).toBeNull();
  });
});

describe('insightKey / dedupeInsights', () => {
  it('is stable across case, punctuation and spacing', () => {
    expect(insightKey('upsell', 'Annual  maintenance plan!')).toBe(insightKey('upsell', 'annual maintenance plan'));
  });
  it('separates kinds and different text', () => {
    expect(insightKey('upsell', 'x y z')).not.toBe(insightKey('safety', 'x y z'));
    expect(insightKey('upsell', 'duct cleaning')).not.toBe(insightKey('upsell', 'water heater flush'));
  });
  it('removes duplicates and keeps order', () => {
    const list = [insight({ text: 'Send quote' }), insight({ text: 'send  quote.' }), insight({ text: 'Call back' })];
    expect(dedupeInsights(list).map((i) => i.text)).toEqual(['Send quote', 'Call back']);
  });
});

describe('buildTaskDraft', () => {
  const ctx = { customerName: 'Dana', endedAt: ENDED };

  it('commitment → due from estimate, falls back to +2 days', () => {
    const a = buildTaskDraft(insight({ due_hours_estimate: 24, due_description: 'tomorrow' }), ctx);
    expect(a?.due_at).toBe('2026-10-22T12:00:00.000Z');
    expect(a?.title).toContain('Keep promise to Dana');
    expect(a?.description).toContain('tomorrow');
    const b = buildTaskDraft(insight(), ctx);
    expect(b?.due_at).toBe('2026-10-23T12:00:00.000Z');
  });

  it('safety: critical is urgent and due within hours; low creates nothing', () => {
    const crit = buildTaskDraft(insight({ kind: 'safety', text: 'Gas leak at the meter', severity: 'critical' }), ctx);
    expect(crit?.priority).toBe('urgent');
    expect(crit?.due_at).toBe('2026-10-21T14:00:00.000Z');
    const high = buildTaskDraft(insight({ kind: 'safety', text: 'Frayed attic wiring', severity: 'high' }), ctx);
    expect(high?.priority).toBe('high');
    expect(high?.due_at).toBe('2026-10-22T12:00:00.000Z');
    expect(buildTaskDraft(insight({ kind: 'safety', text: 'Slippery driveway', severity: 'low' }), ctx)).toBeNull();
  });

  it('objection: only unresolved ones create a task', () => {
    expect(buildTaskDraft(insight({ kind: 'objection', text: 'Too expensive', resolved: true }), ctx)).toBeNull();
    const t = buildTaskDraft(insight({ kind: 'objection', text: 'Too expensive', resolved: false }), ctx);
    expect(t?.due_at).toBe('2026-10-22T12:00:00.000Z');
    expect(buildTaskDraft(insight({ kind: 'objection', text: 'Too expensive', resolved: null }), ctx)).not.toBeNull();
  });

  it('upsell: medium+ creates a +3 day task, low does not', () => {
    const t = buildTaskDraft(insight({ kind: 'upsell', text: 'Annual maintenance plan', note: 'about $199/yr' }), ctx);
    expect(t?.due_at).toBe('2026-10-24T12:00:00.000Z');
    expect(t?.description).toContain('$199');
    expect(buildTaskDraft(insight({ kind: 'upsell', text: 'Gutter guards', severity: 'low' }), ctx)).toBeNull();
  });

  it('respects the 200 / 4000 char database limits and uses a fallback name', () => {
    const long = 'a'.repeat(900);
    const t = buildTaskDraft(insight({ text: long.slice(0, 300), evidence: 'q'.repeat(200) }), { customerName: null, endedAt: ENDED });
    expect(t!.title.length).toBeLessThanOrEqual(200);
    expect(t!.description.length).toBeLessThanOrEqual(4000);
    expect(t!.title).toContain('customer');
  });
});

describe('safetyAlertNeeded', () => {
  it('returns only high/critical safety items', () => {
    const list = [
      insight({ kind: 'safety', text: 'Low thing here', severity: 'low' }),
      insight({ kind: 'safety', text: 'Medium thing here', severity: 'medium' }),
      insight({ kind: 'safety', text: 'High thing here', severity: 'high' }),
      insight({ kind: 'safety', text: 'Critical thing here', severity: 'critical' }),
      insight({ kind: 'objection', text: 'Not safety at all', severity: 'critical' }),
    ];
    expect(safetyAlertNeeded(list).map((i) => i.text)).toEqual(['High thing here', 'Critical thing here']);
  });
});

describe('response schema', () => {
  it('requires the three top-level keys and only allows known kinds', () => {
    expect(ANALYSIS_RESPONSE_SCHEMA.required).toEqual(['transcript', 'insights', 'coaching']);
    expect(ANALYSIS_RESPONSE_SCHEMA.properties.insights.items.properties.kind.enum).toEqual([
      'commitment', 'objection', 'upsell', 'safety',
    ]);
  });
});

describe('dashboard helpers', () => {
  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3599.6)).toBe('60:00');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
  it('averageScore ignores nulls', () => {
    expect(averageScore([80, null, 90, undefined])).toBe(85);
    expect(averageScore([null, undefined])).toBeNull();
    expect(averageScore([])).toBeNull();
  });
  it('retentionDaysLeft never goes negative', () => {
    expect(retentionDaysLeft('2026-10-31T12:00:00Z', ENDED)).toBe(10);
    expect(retentionDaysLeft('2026-10-01T12:00:00Z', ENDED)).toBe(0);
    expect(retentionDaysLeft(null, ENDED)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { DICTATIONS } from './dictations';
import { THRESHOLDS, aggregate, oracleExtraction, scoreCase } from './scoring';

describe('labeled dictation set', () => {
  it('has exactly 100 unique dictations split 50/35/15 across en/es/fa', () => {
    expect(DICTATIONS).toHaveLength(100);
    expect(new Set(DICTATIONS.map((d) => d.text)).size).toBe(100);
    expect(new Set(DICTATIONS.map((d) => d.id)).size).toBe(100);
    for (const [lang, n] of [['en', 50], ['es', 35], ['fa', 15]] as const) expect(DICTATIONS.filter((d) => d.lang === lang)).toHaveLength(n);
  });
  it('every label is verifiable from the dictation text itself', () => {
    for (const d of DICTATIONS) {
      for (const kw of [...d.expected.findings, ...d.expected.safety, ...d.expected.parts.map((p) => p.kw)]) {
        expect(d.text.toLowerCase(), d.id).toContain(kw.toLowerCase());
      }
    }
  });
  it('covers safety, parts, time and no-time cases', () => {
    expect(DICTATIONS.filter((d) => d.expected.safety.length).length).toBeGreaterThan(8);
    expect(DICTATIONS.filter((d) => d.expected.parts.length).length).toBeGreaterThan(30);
    expect(DICTATIONS.some((d) => d.expected.timeMinutes === null)).toBe(true);
    expect(DICTATIONS.some((d) => d.expected.timeMinutes !== null)).toBe(true);
  });
});

describe('scorer', () => {
  it('perfect extraction passes every threshold', () => {
    const m = aggregate(DICTATIONS.map((d) => scoreCase(d.expected, oracleExtraction(d))));
    expect(m).toMatchObject({ findingsRecall: 1, findingsPrecision: 1, partsExact: 1, timeAccuracy: 1, safetyRecall: 1, safetyFalseAlarm: 0, pass: true });
  });
  it('a missed safety hazard fails the gate even if everything else is perfect', () => {
    const scores = DICTATIONS.map((d) => {
      const o = oracleExtraction(d);
      return scoreCase(d.expected, { ...o, findings: o.findings.filter((f) => f.severity !== 'safety') });
    });
    const m = aggregate(scores);
    expect(m.safetyRecall).toBeLessThan(THRESHOLDS.safetyRecall);
    expect(m.failures).toContain('safetyRecall');
    expect(m.pass).toBe(false);
  });
  it('wrong quantities lower exact-part accuracy but not name-only accuracy', () => {
    const scores = DICTATIONS.map((d) => {
      const o = oracleExtraction(d);
      return scoreCase(d.expected, { ...o, parts: o.parts.map((p) => ({ ...p, quantity: p.quantity + 1 })) });
    });
    const m = aggregate(scores);
    expect(m.partsExact).toBe(0);
    expect(m.partsNameOnly).toBe(1);
    expect(m.failures).toContain('partsExact');
  });
  it('invented safety alarms are counted as false alarms', () => {
    const scores = DICTATIONS.map((d) => {
      const o = oracleExtraction(d);
      return scoreCase(d.expected, { ...o, findings: [...o.findings, { text: 'fire hazard', severity: 'safety', equipment_hint: null, confidence: 0.9 }] });
    });
    expect(aggregate(scores).safetyFalseAlarm).toBe(1);
  });
  it('wrong or invented time fails time accuracy', () => {
    const scores = DICTATIONS.map((d) => scoreCase(d.expected, { ...oracleExtraction(d), time_minutes: 7 }));
    expect(aggregate(scores).failures).toContain('timeAccuracy');
  });
});

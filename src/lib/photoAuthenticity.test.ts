import { describe, expect, it } from 'vitest';
import en from '@/locales/en/photoProvenance.json';
import fa from '@/locales/fa/photoProvenance.json';
import { c2paLineKey, capturesToAnalyse, confidenceBarPercent, orderedReasons, parseAuthenticityItems, type AuthenticityReport } from './photoAuthenticity';

const report = (over: Partial<AuthenticityReport['consistency']> = {}, c2pa: Partial<AuthenticityReport['c2pa']> = {}): AuthenticityReport => ({
  analyzerVersion: 'pa-1.0.0', analyzedSha256: 'a'.repeat(64),
  metadata: { format: 'jpeg', parsedCompletely: true, hasExif: true, hasXmp: false, hasGps: false, camera: null, software: null, exifCapturedAt: null },
  c2pa: { status: 'not_present', validation: 'unknown', trust: 'not_evaluated', problems: [], declaresGeneratedMedia: false, declaresEdits: false, signer: null, ...c2pa },
  consistency: { kind: 'metadata_consistency', notAVerdict: true, confidence: 70, level: 'strong', reasons: [], ...over },
});
const item = (id: string, r: AuthenticityReport) => ({ capture_id: id, analyzer_version: r.analyzerVersion, analyzed_at: '2026-11-10T10:00:00Z', report: r });

describe('parseAuthenticityItems', () => {
  it('keeps valid items and drops malformed ones', () => {
    const m = parseAuthenticityItems({ items: [item('a', report()), { capture_id: 'b' }, null, item('c', { ...report(), c2pa: undefined as never })] });
    expect([...m.keys()]).toEqual(['a']);
  });
  it('drops contradictory score/level pairs (a number for "insufficient", or none for "strong")', () => {
    const m = parseAuthenticityItems({ items: [item('x', report({ level: 'insufficient', confidence: 40 })), item('y', report({ level: 'strong', confidence: null })), item('z', report({ level: 'insufficient', confidence: null }))] });
    expect([...m.keys()]).toEqual(['z']);
  });
  it('tolerates garbage payloads', () => {
    expect(parseAuthenticityItems(null).size).toBe(0);
    expect(parseAuthenticityItems({ items: 'nope' }).size).toBe(0);
  });
});

describe('display helpers', () => {
  it('orders reasons by impact, information last, stable for ties', () => {
    const o = orderedReasons([
      { code: 'i', effect: 'info', weight: 0 }, { code: 'a', effect: 'supports', weight: 10 }, { code: 'b', effect: 'weakens', weight: -35 }, { code: 'c', effect: 'supports', weight: 10 },
    ]);
    expect(o.map((r) => r.code)).toEqual(['b', 'a', 'c', 'i']);
  });
  it('maps C2PA results to plain-language keys and never to "verified"', () => {
    expect(c2paLineKey(report().c2pa)).toBe('not_present');
    expect(c2paLineKey(report({}, { status: 'read', validation: 'valid', trust: 'not_evaluated' }).c2pa)).toBe('valid_not_evaluated');
    expect(c2paLineKey(report({}, { status: 'read', validation: 'valid', trust: 'untrusted' }).c2pa)).toBe('valid_untrusted_signer');
    expect(c2paLineKey(report({}, { status: 'read', validation: 'valid', trust: 'trusted' }).c2pa)).toBe('valid_trusted');
    expect(c2paLineKey(report({}, { status: 'read', validation: 'invalid' }).c2pa)).toBe('invalid');
    expect(c2paLineKey(report({}, { status: 'error' }).c2pa)).toBe('error');
  });
  it('selects only unchecked, un-erased captures and caps the batch', () => {
    const caps = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, files_erased: i === 1 }));
    const existing = parseAuthenticityItems({ items: [item('c0', report())] });
    const ids = capturesToAnalyse(caps, existing);
    expect(ids).not.toContain('c0');
    expect(ids).not.toContain('c1');
    expect(ids).toHaveLength(25);
  });
  it('clamps the bar and shows 0 for no data', () => {
    expect(confidenceBarPercent(report({ confidence: 140 }).consistency)).toBe(100);
    expect(confidenceBarPercent(report({ confidence: null, level: 'insufficient' }).consistency)).toBe(0);
  });
});

describe('locale wording', () => {
  const flat = (o: unknown, p = ''): Record<string, string> =>
    Object.entries(o as Record<string, unknown>).reduce((a, [k, v]) => (typeof v === 'string' ? { ...a, [p + k]: v } : { ...a, ...flat(v, `${p}${k}.`) }), {});
  const e = flat(en.authenticity);
  const f = flat(fa.authenticity);
  it('en and fa define exactly the same keys and the same interpolation variables', () => {
    expect(Object.keys(f).sort()).toEqual(Object.keys(e).sort());
    const vars = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort().join();
    for (const k of Object.keys(e)) expect(vars(f[k]), k).toBe(vars(e[k]));
  });
  it('English copy never issues a verdict', () => {
    const banned = /\b(authentic|genuine|fake|forged|forgery|tampered|fraud|proves? (it|the photo) is)\b/i;
    for (const [k, v] of Object.entries(e)) {
      // Allowed only in explicit negations such as "does not prove a photo is genuine or edited" and "no sign of tampering".
      if (banned.test(v)) expect(v, k).toMatch(/not|nothing|no |isn't|without/i);
    }
    expect(e.notVerdict).toMatch(/not a verdict/i);
  });
  it('every reason code the analyzer can emit has a translation', () => {
    const codes = ['c2pa_validation_failed','c2pa_declares_generated','c2pa_valid_capture_claim','c2pa_valid_intact','c2pa_edits_declared','generator_software','xmp_declares_generated','png_generator_chunks','editing_software','xmp_edit_history','dimensions_mismatch','thumbnail_mismatch','modified_after_capture','camera_tags_present','maker_note_present','capture_time_in_future','capture_time_matches_device','capture_time_differs_from_device','predates_job','capture_time_in_job_window','exif_gps_present','no_metadata','no_metadata_expected_in_app','metadata_partially_read'];
    for (const c of codes) { expect(e[`reason.${c}`], c).toBeTruthy(); expect(f[`reason.${c}`], c).toBeTruthy(); }
  });
});

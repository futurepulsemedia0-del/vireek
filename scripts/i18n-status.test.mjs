// scripts/i18n-status.test.mjs
// Unit tests (synthetic facts) for the launch-status evaluation, plus integration checks against the real repository.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { categoryOf, checkStatus, collect, evaluate, hash, renderStatusMd } from './i18n-status.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal synthetic repository facts: English has 4 keys, 2 of them human-review-required. */
function makeFacts(over = {}) {
  const base = {
    codes: ['en', 'es'],
    locales: {
      en: { tier: 'source', review: 'source', surfaces: ['S1', 'S2'], minCoverage: 1, beta: false },
      es: { tier: 'A', review: 'human-reviewed', surfaces: ['S1', 'S2'], minCoverage: 1, beta: false },
    },
    nsNames: ['common', 'consent', 'other'],
    surfaces: { common: 'S2', consent: 'S1', other: 'S4' },
    requiredNs: { en: ['common', 'consent'], es: ['common', 'consent'] },
    en: { common: ['nav.home', 'aiDisclosure.chatNotice'], consent: ['banner.title', 'banner.body'], other: ['x.recording'] },
    tr: { es: { common: ['nav.home', 'aiDisclosure.chatNotice'], consent: ['banner.title', 'banner.body'], other: null } },
    reviewIds: ['common.aiDisclosure.chatNotice', 'consent.banner.title', 'consent.banner.body', 'other.x.recording'],
    manifest: { es: ['common.aiDisclosure.chatNotice', 'consent.banner.title', 'consent.banner.body'] },
    manifestError: null,
    freshness: { es: { stale: [], untracked: 0, untrackedByNs: {} } },
    coverageGate: { exit: 0, report: [], problems: [], pending: [] },
    freshnessGate: { exit: 0, scriptFresh: { es: { stale: 0, untracked: 0 } } },
    outbound: {
      enabled: ['en'], categories: ['ai-disclosure', 'recording', 'emergency', 'opt-out'], fallback: 'en',
      serverKeys: { en: [], es: ['server.aiDisclosure.builtin', 'server.recordingConsent.script'] },
    },
  };
  return { ...base, ...over };
}
const es = (facts) => evaluate(facts).langs.find((l) => l.code === 'es');

describe('categoryOf', () => {
  it.each([
    ['consent.banner.title', 'consent'], ['common.aiDisclosure.chatNotice', 'ai-disclosure'], ['voiceLog.recording', 'recording'],
    ['a.recordingConsent.x', 'recording'], ['sarahLearn.readiness.cat.safety', 'emergency'], ['voiceResilience.status.emergency', 'emergency'],
    ['x.optOut.body', 'opt-out'], ['x.terms.intro', 'legal'], ['quote.nte.note', 'commitments'], ['common.nav.pricing', 'other'],
  ])('%s -> %s', (id, cat) => { expect(categoryOf(id)).toBe(cat); });
});

describe('evaluate: coverage, freshness, review, Beta', () => {
  it('a fully covered, reviewed, fresh language is eligible to drop Beta (manual items still apply)', () => {
    const f = makeFacts({
      manifest: { es: ['common.aiDisclosure.chatNotice', 'consent.banner.title', 'consent.banner.body'] },
      freshness: { es: { stale: [], untracked: 0, untrackedByNs: {} } },
    });
    const l = es(f);
    expect(l.gate).toMatchObject({ coverage: true, strict: true, freshness: true });
    expect(l.beta.required).toBe(false);
    expect(evaluate(f).errors).toEqual([]);
  });

  it('a missing key lowers coverage, fails the gate and requires Beta; hiding Beta is an error', () => {
    const f = makeFacts({ tr: { es: { common: ['nav.home'], consent: ['banner.title', 'banner.body'], other: null } } });
    const l = es(f);
    expect(l.required).toMatchObject({ total: 4, present: 3 });
    expect(l.required.coverage).toBe(75);
    expect(l.gate.coverage).toBe(false);
    expect(l.namespaces.find((n) => n.name === 'common').missingKeys).toEqual(['aiDisclosure.chatNotice']);
    expect(l.beta.required).toBe(true);
    expect(evaluate(f).errors.join('\n')).toMatch(/es: config shows no Beta label/);
  });

  it('never rounds a gap up to 100%', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `k${i}`);
    const f = makeFacts({ en: { common: many, consent: [], other: [] }, tr: { es: { common: many.slice(0, 1999), consent: [], other: null } }, reviewIds: [], manifest: {} });
    expect(es(f).required.coverage).toBeLessThan(100);
  });

  it('a translated legal/consent key without sign-off fails the strict gate', () => {
    const f = makeFacts({ manifest: { es: ['consent.banner.title'] } });
    const l = es(f);
    expect(l.gate.strict).toBe(false);
    expect(l.reviewed.strictBlockers).toEqual(['common.aiDisclosure.chatNotice', 'consent.banner.body']);
    expect(l.beta.required).toBe(true);
  });

  it('a stale key only blocks when it sits on a covered surface', () => {
    const covered = es(makeFacts({ freshness: { es: { stale: ['common:nav.home'], untracked: 0, untrackedByNs: {} } }, freshnessGate: { exit: 0, scriptFresh: { es: { stale: 1, untracked: 0 } } } }));
    expect(covered.gate.freshnessState).toBe('FAIL');
    expect(covered.fresh.staleCovered).toEqual(['common:nav.home']);
    const uncovered = es(makeFacts({ freshness: { es: { stale: ['other:x.recording'], untracked: 0, untrackedByNs: {} } }, freshnessGate: { exit: 0, scriptFresh: { es: { stale: 1, untracked: 0 } } } }));
    expect(uncovered.gate.freshnessState).toBe('PASS');
  });

  it('translations without a freshness record are UNVERIFIED, not fresh', () => {
    const l = es(makeFacts({ freshness: { es: { stale: [], untracked: 2, untrackedByNs: { consent: 2 } } } }));
    expect(l.gate.freshnessState).toBe('UNVERIFIED');
    expect(l.beta.required).toBe(true);
  });

  it('flags a disagreement between this script and i18n-freshness.mjs', () => {
    const f = makeFacts({ freshnessGate: { exit: 0, scriptFresh: { es: { stale: 3, untracked: 0 } } } });
    expect(evaluate(f).errors.join('\n')).toMatch(/freshness script reports stale=3/);
  });

  it('a language with no required namespace cannot pass the coverage gate vacuously', () => {
    const f = makeFacts({ requiredNs: { en: [], es: [] } });
    expect(es(f).gate.coverage).toBe(false);
  });

  it('config Beta=true is never an error, even when every automated fact holds', () => {
    const f = makeFacts({ locales: { en: makeFacts().locales.en, es: { ...makeFacts().locales.es, beta: true } } });
    expect(evaluate(f).errors).toEqual([]);
  });
});

describe('evaluate: reviewed-keys manifest integrity', () => {
  it('rejects ids that are not human-review-required English keys, unknown languages and non-arrays', () => {
    const errs = (m) => evaluate(makeFacts({ manifest: m })).errors.join('\n');
    expect(errs({ es: ['common.nav.home'] })).toMatch(/not a human-review-required key/);
    expect(errs({ xx: [] })).toMatch(/unknown language "xx"/);
    expect(errs({ es: 'consent.banner.title' })).toMatch(/must be an array/);
    expect(errs({ es: ['server.nonsense'] })).toMatch(/not a server compliance key/);
    expect(errs({ _comment: 'ignored', es: [] })).not.toMatch(/unknown language/);
  });
  it('surfaces an unreadable manifest', () => {
    expect(evaluate(makeFacts({ manifestError: 'docs/i18n/reviewed-keys.json: Unexpected token' })).errors[0]).toMatch(/Unexpected token/);
  });
});

describe('evaluate: outbound voice/SMS compliance gate', () => {
  const allReviewed = ['common.aiDisclosure.chatNotice', 'other.x.recording', 'consent.banner.title', 'consent.banner.body'];
  it('a language that is not enabled is reported as blocked but is not an error', () => {
    const l = es(makeFacts());
    expect(l.outbound).toMatchObject({ enabled: false, ready: false });
    expect(l.outbound.blockers).toEqual(['other.x.recording', 'server.aiDisclosure.builtin', 'server.recordingConsent.script']);
    expect(evaluate(makeFacts()).errors).toEqual([]);
  });
  it('enabling a language without its reviewed keys FAILS, naming the missing keys', () => {
    const f = makeFacts({ outbound: { ...makeFacts().outbound, enabled: ['en', 'es'] } });
    const msg = evaluate(f).errors.join('\n');
    expect(msg).toMatch(/es: listed in OUTBOUND_COMPLIANCE_LANGUAGES/);
    expect(msg).toMatch(/server\.aiDisclosure\.builtin/);
  });
  it('server-side wording must be reviewed too: locale keys alone are not enough', () => {
    const f = makeFacts({ manifest: { es: allReviewed }, outbound: { ...makeFacts().outbound, enabled: ['en', 'es'] } });
    expect(evaluate(f).errors.join('\n')).toMatch(/2 reviewed key\(s\) are missing/);
  });
  it('enabling passes only when every locale and server key is recorded', () => {
    const f = makeFacts({
      manifest: { es: [...allReviewed, 'server.aiDisclosure.builtin', 'server.recordingConsent.script'] },
      outbound: { ...makeFacts().outbound, enabled: ['en', 'es'] },
    });
    expect(es(f).outbound).toMatchObject({ enabled: true, ready: true, blockers: [] });
    expect(evaluate(f).errors).toEqual([]);
  });
  it('rejects unknown enabled languages and a missing English fallback', () => {
    expect(evaluate(makeFacts({ outbound: { ...makeFacts().outbound, enabled: ['en', 'pt'] } })).errors.join('\n')).toMatch(/unknown language "pt"/);
    expect(evaluate(makeFacts({ outbound: { ...makeFacts().outbound, enabled: ['es'] } })).errors.join('\n')).toMatch(/fallback language/);
  });
});

describe('render + check', () => {
  it('is deterministic and never claims manual items as verified', () => {
    const a = renderStatusMd(evaluate(makeFacts()));
    expect(renderStatusMd(evaluate(makeFacts()))).toBe(a);
    expect(a).toMatch(/NOT VERIFIED/);
    expect(a).toMatch(/\[COUNSEL\]/);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no timestamps
  });
  it('checkStatus reports a missing or stale document', () => {
    const status = evaluate(makeFacts());
    const md = renderStatusMd(status);
    expect(checkStatus(status, md, md)).toEqual([]);
    expect(checkStatus(status, md, null).join('\n')).toMatch(/missing/);
    expect(checkStatus(status, md, `${md}x`).join('\n')).toMatch(/stale/);
  });
  it('hash matches the 8-char sha1 used by i18n-freshness.mjs', () => {
    expect(hash('abc')).toBe('a9993e36');
  });
});

describe('real repository', () => {
  it('status.md is current, Beta labels follow the facts, and no language is enabled without reviewed keys', async () => {
    const facts = await collect(ROOT);
    const status = evaluate(facts);
    const onDisk = fs.existsSync(path.join(ROOT, 'docs/i18n/status.md')) ? fs.readFileSync(path.join(ROOT, 'docs/i18n/status.md'), 'utf8') : null;
    expect(checkStatus(status, renderStatusMd(status), onDisk)).toEqual([]);
  }, 60_000);

  it('consent is a required namespace for every language (the coverage gate is not vacuous)', async () => {
    const facts = await collect(ROOT);
    for (const code of facts.codes) expect(facts.requiredNs[code]).toContain('consent');
    for (const l of evaluate(facts).langs) expect(l.requiredNamespaces.length).toBeGreaterThan(0);
  }, 60_000);

  it('status numbers agree with the rows i18n-coverage.mjs reports', async () => {
    const facts = await collect(ROOT);
    const status = evaluate(facts);
    for (const row of facts.coverageGate.report) {
      const ns = status.langs.find((l) => l.code === row.code)?.namespaces.find((n) => n.name === row.ns);
      expect(ns).toBeTruthy();
      expect(Math.abs(ns.coverage / 100 - row.coverage)).toBeLessThan(0.0015);
    }
  }, 60_000);

  it('only English is cleared for outbound compliance text while reviewed-keys.json has no sign-offs', async () => {
    const facts = await collect(ROOT);
    const signedOff = Object.entries(facts.manifest).filter(([k, v]) => !k.startsWith('_') && Array.isArray(v) && v.length);
    if (signedOff.length === 0) expect(facts.outbound.enabled).toEqual(['en']);
  }, 60_000);
});

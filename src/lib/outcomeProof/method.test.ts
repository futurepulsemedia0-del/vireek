import { describe, expect, it } from 'vitest';
import { DEFAULT_ROI } from '../../../supabase/functions/_shared/economics/roi';
import {
  MIN_MEASURED_EVENTS, NOT_AUDITED_NOTICE, canonicalString, computeOutcome, computeSnapshotHash, currentConsent, periodDays,
  publicationGate, sha256Hex, verificationNotice, verifyIntegrity,
  type ProofCase, type ProofConsent, type ProofSource,
} from './method';
import { PublicationBlockedError, buildDocument, formatMoney, mdEscape, renderMarkdown } from './render';
import { mapCase, mapConsent, mapSource } from './mappers';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const src = (n: number, o: Partial<ProofSource> = {}): ProofSource => ({
  valueEventId: id(n), type: 'recovered_revenue', amount: 50_000, unit: 'cents', currency: 'USD', confidence: 'measured',
  evidenceRef: `jobs:${n}`, occurredMs: Date.UTC(2026, 9, 1 + n), included: true, exclusion: null, ...o,
});
const base = { methodVersion: 'roi-method-v1', periodStart: '2026-10-01', periodEnd: '2026-10-31', currency: 'USD', costCents: 29_900, costBasis: 'owner_entered' as const };
function mkCase(sources: ProofSource[], o: Partial<ProofCase> = {}): ProofCase {
  const c: ProofCase = { id: id(999), title: 'October results', ...base, snapshotSha256: '', verificationLevel: 'not_independently_audited', verifierName: null, verificationEvidenceUrl: null, verifiedAt: null, ...o };
  return { ...c, snapshotSha256: o.snapshotSha256 ?? computeSnapshotHash(c, sources) };
}
const six = [1, 2, 3, 4, 5, 6].map((n) => src(n));
const granted = (c: ProofCase, o: Partial<ProofConsent> = {}): ProofConsent => ({
  id: 'k1', decision: 'granted', allowBusinessName: false, allowPersonName: false, allowQuote: false, quoteText: null,
  signerName: 'Maria Ramirez', signerRole: 'Owner', consentTextVersion: 'draft-0', caseSha256: c.snapshotSha256, decidedAt: '2026-11-02T10:00:00Z', ...o,
});

describe('sha256Hex', () => {
  it('matches the published test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });
  it('hashes multi-byte text as UTF-8', () => {
    expect(sha256Hex('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
    expect(sha256Hex('😀')).toBe('f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9');
  });
});

describe('MIN_MEASURED_EVENTS', () => {
  it('stays in step with the shared ROI engine default', () => { expect(MIN_MEASURED_EVENTS).toBe(DEFAULT_ROI.minOutcomes); });
});

describe('canonicalString / integrity', () => {
  it('has the exact documented line format and is order independent', () => {
    const a = canonicalString(base, [src(2), src(1)]);
    expect(a).toBe(canonicalString(base, [src(1), src(2)]));
    expect(a.split('\n')[0]).toBe('roi-method-v1');
    expect(a.split('\n')[1]).toBe('period|2026-10-01|2026-10-31|USD');
    expect(a.split('\n')[2]).toBe('cost|29900|owner_entered');
    expect(a.split('\n')[3]).toBe(`src|${id(1)}|recovered_revenue|50000|cents|USD|measured|jobs:1|${Date.UTC(2026, 9, 2)}|1|-`);
  });
  it('escapes %, | and line breaks in evidence references', () => {
    const line = canonicalString(base, [src(1, { evidenceRef: 'a|b%c\nd\re' })]).split('\n')[3];
    expect(line).toContain('|a%7Cb%25c%0Ad%0De|');
    expect(canonicalString(base, [src(1, { evidenceRef: 'a|b' })])).not.toBe(canonicalString(base, [src(1, { evidenceRef: 'a' }), src(2, { evidenceRef: 'b' })]));
  });
  it('detects any change to a source, the cost, or the period', () => {
    const c = mkCase(six);
    expect(verifyIntegrity(c, six)).toBe(true);
    expect(verifyIntegrity(c, [{ ...six[0], amount: 50_001 }, ...six.slice(1)])).toBe(false);
    expect(verifyIntegrity(c, [{ ...six[0], confidence: 'estimated' }, ...six.slice(1)])).toBe(false);
    expect(verifyIntegrity(c, six.slice(1))).toBe(false);
    expect(verifyIntegrity({ ...c, costCents: 1 }, six)).toBe(false);
    expect(verifyIntegrity({ ...c, periodEnd: '2026-10-30' }, six)).toBe(false);
  });
  it('a null cost is written as "-"', () => {
    expect(canonicalString({ ...base, costCents: null, costBasis: 'none' }, []).split('\n')[2]).toBe('cost|-|none');
  });
});

describe('computeOutcome (roi-method-v1)', () => {
  it('gives a low/high range: low = measured only, high = measured + estimated', () => {
    const r = computeOutcome(base, [...six, src(7, { confidence: 'estimated', amount: 100_000 })]);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.valueLowCents).toBe(300_000);
    expect(r.valueHighCents).toBe(400_000);
    expect(r.roiLow).toBeCloseTo((300_000 - 29_900) / 29_900, 10);
    expect(r.roiHigh).toBeCloseTo((400_000 - 29_900) / 29_900, 10);
    expect(r.totals.estimatedCents).toBe(100_000);
  });
  it('adds avoided_cost as money, reports saved time in minutes and never converts it to money', () => {
    const r = computeOutcome(base, [...six, src(8, { type: 'avoided_cost', amount: 10_000 }), src(9, { type: 'saved_hours', unit: 'minutes', currency: null, amount: 90 })]);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.valueLowCents).toBe(310_000);
    expect(r.totals.savedMinutes).toBe(90);
  });
  it('counts excluded events by reason and ignores their amounts', () => {
    const r = computeOutcome(base, [...six,
      src(10, { included: false, exclusion: 'owner_review_not_due_to_vireek', amount: 999_999 }),
      src(11, { included: false, exclusion: 'superseded_by_measured', confidence: 'estimated' }),
      src(12, { included: false, exclusion: 'other_currency', currency: 'EUR' })]);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.excluded).toEqual({ owner_review_not_due_to_vireek: 1, superseded_by_measured: 1, other_currency: 1 });
    expect(r.valueHighCents).toBe(300_000);
  });
  it('defensively ignores an included money row in another currency', () => {
    const r = computeOutcome(base, [...six, src(13, { currency: 'EUR', amount: 777_777 })]);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.valueLowCents).toBe(300_000);
  });
  it('produces no number with fewer than 5 measured money events (estimates do not count toward the minimum)', () => {
    const r = computeOutcome(base, [...six.slice(0, 4), src(20, { confidence: 'estimated' }), src(21, { confidence: 'estimated' })]);
    expect(r.status).toBe('not_enough_data');
    if (r.status === 'not_enough_data') expect(r.reasons).toContain('measured_events_below_5');
  });
  it('produces no number without a cost', () => {
    const r = computeOutcome({ ...base, costCents: null }, six);
    expect(r.status).toBe('not_enough_data');
    if (r.status === 'not_enough_data') expect(r.reasons).toContain('cost_unknown');
  });
  it('produces no number for a period under 28 days and lists every reason', () => {
    const r = computeOutcome({ ...base, periodEnd: '2026-10-14', costCents: null }, six.slice(0, 2));
    if (r.status !== 'not_enough_data') throw new Error('expected not_enough_data');
    expect(r.reasons).toEqual(['cost_unknown', 'measured_events_below_5', 'period_below_28_days']);
  });
  it('a negative ROI is shown as negative, not clamped', () => {
    const r = computeOutcome({ ...base, costCents: 1_000_000 }, six);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.roiLow).toBeLessThan(0);
  });
  it('periodDays is inclusive and rejects bad input', () => {
    expect(periodDays('2026-10-01', '2026-10-31')).toBe(31);
    expect(periodDays('2026-10-31', '2026-10-01')).toBe(0);
    expect(periodDays('nope', '2026-10-01')).toBe(0);
  });
});

describe('publication gate', () => {
  const c = mkCase(six);
  const ok = computeOutcome(c, six);
  it('passes only with a matching granted consent, intact sources and a number', () => {
    const g = publicationGate(c, six, [granted(c)], ok);
    expect(g.mayPublish).toBe(true);
    expect(g.blocks).toEqual([]);
  });
  it('blocks with no consent', () => { expect(publicationGate(c, six, [], ok).blocks).toEqual(['no_consent']); });
  it('blocks after revocation, and the newest decision wins', () => {
    const rev = granted(c, { id: 'k2', decision: 'revoked', decidedAt: '2026-11-03T10:00:00Z' });
    expect(publicationGate(c, six, [granted(c), rev], ok).blocks).toEqual(['consent_revoked']);
    const again = granted(c, { id: 'k3', decidedAt: '2026-11-04T10:00:00Z' });
    expect(publicationGate(c, six, [granted(c), rev, again], ok).mayPublish).toBe(true);
    expect(currentConsent([again, rev])?.id).toBe('k3');
  });
  it('blocks consent given for a different snapshot', () => {
    expect(publicationGate(c, six, [granted(c, { caseSha256: 'f'.repeat(64) })], ok).blocks).toEqual(['consent_for_other_snapshot']);
  });
  it('blocks when the sources no longer hash to the snapshot', () => {
    const tampered = [{ ...six[0], amount: 1 }, ...six.slice(1)];
    expect(publicationGate(c, tampered, [granted(c)], computeOutcome(c, tampered)).blocks).toEqual(['integrity_check_failed']);
  });
  it('blocks a case that has no number', () => {
    const few = six.slice(0, 2); const c2 = mkCase(few);
    expect(publicationGate(c2, few, [granted(c2)], computeOutcome(c2, few)).blocks).toEqual(['not_enough_data']);
  });
});

describe('verificationNotice', () => {
  it('is "Not independently audited." by default', () => { expect(verificationNotice(mkCase(six))).toBe(NOT_AUDITED_NOTICE); });
  it('stays "not audited" if the level says verified but proof is missing', () => {
    expect(verificationNotice({ verificationLevel: 'independently_verified', verifierName: 'Acme Audit', verificationEvidenceUrl: null, verifiedAt: null })).toBe(NOT_AUDITED_NOTICE);
  });
  it('names the verifier, date and evidence only with complete proof', () => {
    const n = verificationNotice({ verificationLevel: 'independently_verified', verifierName: 'Acme Audit', verificationEvidenceUrl: 'https://example.com/r', verifiedAt: '2026-11-10T00:00:00Z' });
    expect(n).toContain('Acme Audit'); expect(n).toContain('2026-11-10'); expect(n).toContain('https://example.com/r');
  });
});

describe('Markdown output', () => {
  const c = mkCase(six);
  it('audit copy of an unconsented case is a labelled draft with the full source appendix and the audit notice', () => {
    const md = renderMarkdown(c, six, [], 'audit');
    expect(md).toContain('DRAFT. Not approved for publication');
    expect(md).toContain(NOT_AUDITED_NOTICE);
    expect(md).toContain('Source events (audit trail)');
    expect(md).toContain(id(1));
    expect(md).toContain(c.snapshotSha256);
  });
  it('public copy throws when blocked', () => {
    expect(() => renderMarkdown(c, six, [], 'public')).toThrow(PublicationBlockedError);
    expect(() => renderMarkdown(c, six, [granted(c, { decision: 'revoked' })], 'public')).toThrow(/consent_revoked/);
  });
  it('public copy has no event-level references, carries the audit notice, and hides names and quote unless allowed', () => {
    const md = renderMarkdown(c, six, [granted(c, { quoteText: 'Great service' })], 'public', 'Ramirez Plumbing');
    expect(md).not.toContain('Source events');
    expect(md).not.toContain(id(1));
    expect(md).not.toContain('jobs:1');
    expect(md).not.toContain('Ramirez Plumbing');
    expect(md).not.toContain('Maria Ramirez');
    expect(md).not.toContain('Great service');
    expect(md).toContain('A home-service business');
    expect(md).toContain(NOT_AUDITED_NOTICE);
    expect(md).not.toContain('DRAFT');
  });
  it('shows name, person and quote only when each is allowed', () => {
    const md = renderMarkdown(c, six, [granted(c, { allowBusinessName: true, allowPersonName: true, allowQuote: true, quoteText: 'Great service' })], 'public', 'Ramirez Plumbing');
    expect(md).toContain('Ramirez Plumbing'); expect(md).toContain('Maria Ramirez, Owner'); expect(md).toContain('Great service');
  });
  it('never shows a quote that the consent does not carry', () => {
    expect(buildDocument(c, six, [granted(c, { allowQuote: true, quoteText: null })], 'public').quote).toBeNull();
  });
  it('escapes Markdown, HTML and table injection in free text', () => {
    expect(mdEscape('a|b\n# h <script>[x](y)')).toBe('a\\|b \\# h \\<script\\>\\[x\\]\\(y\\)');
    const evil = [src(1, { evidenceRef: 'x | y\n| z <img src=x>' }), ...six.slice(1)];
    const c2 = mkCase(evil);
    const md = renderMarkdown(c2, evil, [], 'audit');
    expect(md).not.toMatch(/(^|[^\\])</);
    expect(md.split('\n').filter((l) => l.startsWith('| ' + id(1))).length).toBe(1);
  });
  it('is deterministic', () => { expect(renderMarkdown(c, six, [], 'audit')).toBe(renderMarkdown(c, six, [], 'audit')); });
  it('says no return figure is shown when data is insufficient', () => {
    const few = six.slice(0, 2); const c2 = mkCase(few);
    expect(renderMarkdown(c2, few, [], 'audit')).toContain('No return figure is shown');
  });
  it('formats money without Intl', () => {
    expect(formatMoney(320_000, 'USD')).toBe('USD 3,200.00');
    expect(formatMoney(5, 'USD')).toBe('USD 0.05');
    expect(formatMoney(-123_456, 'EUR')).toBe('-EUR 1,234.56');
  });
});

describe('row mappers', () => {
  it('map database rows and tolerate nulls', () => {
    expect(mapCase({ id: 'a', title: 't', period_start: '2026-10-01', period_end: '2026-10-31', currency: 'USD', cost_cents: '29900', cost_basis: 'none', method_version: 'roi-method-v1', snapshot_sha256: 'h', verification_level: 'not_independently_audited' }).costCents).toBe(29_900);
    expect(mapCase({ cost_cents: null }).costCents).toBeNull();
    expect(mapSource({ value_event_id: 'e', type: 'saved_hours', amount: '30', unit: 'minutes', occurred_ms: '5', included: false, exclusion: 'other_currency' })).toMatchObject({ amount: 30, unit: 'minutes', included: false, exclusion: 'other_currency', occurredMs: 5 });
    expect(mapConsent({ decision: 'weird' }).decision).toBe('revoked');
  });
});

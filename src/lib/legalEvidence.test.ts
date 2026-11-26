import { describe, expect, it } from 'vitest';
import { cleanClickContext, parseDocumentOverview, parseEvidenceRows, parseGraceDays, shortHash } from './legalEvidence';
import { decideLegalGate, graceDeadline, parseLegalAcceptanceState } from './legalAcceptance';

const sha = 'a'.repeat(64);
const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1', accepted_at: '2026-12-01T10:00:00Z', doc_key: 'terms', version: 2, title: 'Terms of Service', source: 'plan_change',
  content_sha256: sha, ip_address: '203.0.113.9', ip_source: 'x-forwarded-for', user_agent: 'UA/1', user_id: 'u1', email: 'a@b.test',
  account_owner_id: 'u1', context: { plan_id: 'business', authority_confirmed: true }, ...over,
});

describe('parseEvidenceRows', () => {
  it('keeps valid rows and stringifies context values', () => {
    const [r] = parseEvidenceRows([row()]);
    expect(r.source).toBe('plan_change');
    expect(r.context).toEqual({ plan_id: 'business', authority_confirmed: 'true' });
    expect(r.contentSha256).toBe(sha);
  });
  it('drops rows with an unknown source or missing ids, and malformed hashes become null', () => {
    expect(parseEvidenceRows([row({ source: 'bogus' }), row({ id: 5 }), null, 'x'])).toHaveLength(0);
    expect(parseEvidenceRows([row({ content_sha256: 'nothex' })])[0].contentSha256).toBeNull();
    expect(parseEvidenceRows({})).toEqual([]);
  });
  it('shortHash never invents a hash', () => {
    expect(shortHash(null)).toBe('no hash recorded');
    expect(shortHash(sha)).toBe('aaaaaaaa…aaaaaa');
  });
});

describe('cleanClickContext', () => {
  it('keeps only whitelisted keys, trims and caps length', () => {
    const out = cleanClickContext({ plan_id: ' pro ', evil: 'x', authority_confirmed: true, signer_title: 'x'.repeat(500), from_plan_id: '', n: 5 });
    expect(Object.keys(out).sort()).toEqual(['authority_confirmed', 'plan_id', 'signer_title']);
    expect(out.plan_id).toBe('pro');
    expect(out.signer_title).toHaveLength(120);
  });
});

describe('parseGraceDays', () => {
  it('accepts 0..90 whole days only', () => {
    expect(parseGraceDays('0')).toBe(0);
    expect(parseGraceDays(' 30 ')).toBe(30);
    expect(parseGraceDays('90')).toBe(90);
    for (const bad of ['91', '-1', '1.5', '', 'abc', '007x', '100']) expect(parseGraceDays(bad)).toBeNull();
  });
});

describe('parseDocumentOverview', () => {
  it('maps the staff overview and treats pending_count null as not applicable', () => {
    const [d] = parseDocumentOverview([{ id: 'v', doc_key: 'msa', version: 1, title: 'MSA', effective_at: '2026-10-08T00:00:00Z', is_material: false, status: 'published', change_count: 0, has_hash: false, gating: false, accepted_count: 3, pending_count: null }]);
    expect(d.gating).toBe(false);
    expect(d.pendingCount).toBeNull();
    expect(d.hasHash).toBe(false);
  });
});

describe('grace in the acceptance state', () => {
  const doc = (blocking: unknown, deadline: unknown) => ({
    doc_key: 'terms', version_id: 'v2', version: 2, title: 'Terms', effective_at: '2026-12-01T00:00:00Z', content_path: '/terms', accepted_version: 1,
    versions: [], ...(blocking === undefined ? {} : { blocking }), ...(deadline === undefined ? {} : { deadline }),
  });
  it('defaults to blocking for payloads from an older database (no blocking field)', () => {
    const s = parseLegalAcceptanceState({ decision: 'must_accept', required: [doc(undefined, undefined)] });
    expect(s?.required[0].blocking).toBe(true);
    expect(s?.required[0].deadline).toBeNull();
  });
  it('a document inside the grace window does not gate and exposes its deadline', () => {
    const s = parseLegalAcceptanceState({ decision: 'ok', required: [doc(false, '2026-12-08T00:00:00Z')] });
    expect(decideLegalGate(s, '/dashboard')).toBe('allow');
    expect(s?.required).toHaveLength(1);
    expect(graceDeadline(s)).toBe('2026-12-08T00:00:00Z');
  });
  it('graceDeadline is null when nothing is in grace and picks the earliest otherwise', () => {
    expect(graceDeadline(null)).toBeNull();
    expect(graceDeadline(parseLegalAcceptanceState({ decision: 'must_accept', required: [doc(true, '2026-12-01T00:00:00Z')] }))).toBeNull();
    const two = parseLegalAcceptanceState({ decision: 'ok', required: [doc(false, '2026-12-20T00:00:00Z'), { ...doc(false, '2026-12-10T00:00:00Z'), doc_key: 'privacy', version_id: 'p2' }] });
    expect(graceDeadline(two)).toBe('2026-12-10T00:00:00Z');
  });
});

import { describe, expect, it } from 'vitest';
import {
  acceptanceVersionIds,
  decideLegalGate,
  flattenChanges,
  localizedSummary,
  parseLegalAcceptanceState,
  safeContentPath,
  safeReturnPath,
} from './legalAcceptance';

const payload = (over: Record<string, unknown> = {}) => ({
  decision: 'must_accept',
  required: [
    {
      doc_key: 'terms', version_id: 'v-2', version: 2, title: 'Terms of Service', effective_at: '2026-12-01T00:00:00Z',
      content_path: '/terms', accepted_version: 1,
      versions: [
        { version: 2, effective_at: '2026-12-01T00:00:00Z', changes: [
          { section: 'Billing', kind: 'changed', summary: 'Annual plans renew at the then-current price.', i18n: { fa: 'تمدید سالانه با قیمت روز', xxx: 'bad', de: '  ' } },
          { section: 'Liability', kind: 'added', summary: 'New cap.' },
          { section: '', kind: 'added', summary: 'dropped: no section' },
          { section: 'X', kind: 'bogus', summary: 'dropped: bad kind' },
        ] },
      ],
    },
  ],
  ...over,
});

describe('parseLegalAcceptanceState', () => {
  it('parses documents and keeps only valid, localized changes', () => {
    const s = parseLegalAcceptanceState(payload());
    expect(s?.decision).toBe('must_accept');
    expect(s?.required).toHaveLength(1);
    const changes = s ? flattenChanges(s.required[0]) : [];
    expect(changes).toHaveLength(2);
    expect(Object.keys(changes[0].i18n)).toEqual(['fa']);
  });
  it('returns null for malformed payloads', () => {
    expect(parseLegalAcceptanceState(null)).toBeNull();
    expect(parseLegalAcceptanceState({ decision: 'maybe', required: [] })).toBeNull();
    expect(parseLegalAcceptanceState({ decision: 'ok' })).toBeNull();
  });
  it('never gates on a must_accept payload that lists nothing', () => {
    expect(parseLegalAcceptanceState({ decision: 'must_accept', required: [] })?.decision).toBe('ok');
  });
  it('drops external or script content paths', () => {
    expect(safeContentPath('/terms')).toBe('/terms');
    expect(safeContentPath('https://evil.test')).toBeNull();
    expect(safeContentPath('//evil.test')).toBeNull();
    expect(safeContentPath('javascript:alert(1)')).toBeNull();
    const s = parseLegalAcceptanceState(payload({ required: [{ doc_key: 'terms', version_id: 'v', content_path: '//evil.test', versions: [] }] }));
    expect(s?.required[0].content_path).toBeNull();
  });
});

describe('decideLegalGate', () => {
  const must = parseLegalAcceptanceState(payload());
  it('blocks product routes while a material version is pending', () => {
    expect(decideLegalGate(must, '/dashboard')).toBe('must_accept');
    expect(decideLegalGate(must, '/settings/security')).toBe('must_accept');
  });
  it('lets the user read the documents and reach the acceptance screen', () => {
    expect(decideLegalGate(must, '/legal/accept')).toBe('allow');
    expect(decideLegalGate(must, '/terms')).toBe('allow');
    expect(decideLegalGate(must, '/privacy')).toBe('allow');
  });
  it('does not treat look-alike prefixes as exempt', () => {
    expect(decideLegalGate(must, '/termsandconditions-fake')).toBe('must_accept');
    expect(decideLegalGate(must, '/legal/acceptance')).toBe('must_accept');
  });
  it('allows when there is nothing to accept or the state is unknown (fails open; the database stays authoritative)', () => {
    expect(decideLegalGate(null, '/dashboard')).toBe('allow');
    expect(decideLegalGate({ decision: 'ok', required: [] }, '/dashboard')).toBe('allow');
  });
});

describe('summaries and ids', () => {
  const s = parseLegalAcceptanceState(payload());
  const first = s ? flattenChanges(s.required[0])[0] : null;
  it('prefers the viewer language and falls back to the staff text', () => {
    if (!first) throw new Error('fixture');
    expect(localizedSummary(first, 'fa-IR')).toBe('تمدید سالانه با قیمت روز');
    expect(localizedSummary(first, 'fr')).toBe('Annual plans renew at the then-current price.');
    expect(localizedSummary(first, undefined)).toBe('Annual plans renew at the then-current price.');
  });
  it('collects the version ids to accept', () => {
    expect(s && acceptanceVersionIds(s)).toEqual(['v-2']);
  });
});

describe('safeReturnPath', () => {
  it('only returns same-origin paths and never loops back to the gate', () => {
    expect(safeReturnPath('/jobs?id=1')).toBe('/jobs?id=1');
    expect(safeReturnPath('https://evil.test')).toBe('/dashboard');
    expect(safeReturnPath('//evil.test')).toBe('/dashboard');
    expect(safeReturnPath('/\\evil.test')).toBe('/dashboard');
    expect(safeReturnPath('/legal/accept')).toBe('/dashboard');
    expect(safeReturnPath(undefined)).toBe('/dashboard');
  });
});

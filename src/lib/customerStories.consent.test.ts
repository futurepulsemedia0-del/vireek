import { describe, expect, it } from 'vitest';
import { PROVENANCE, getStories, isConsentComplete } from '@/lib/customerStories';

describe('social proof consent', () => {
  const ok = { provenance: 'verified' as const, consentOn: '2026-10-01', evidenceRef: 'approvals/2026-10-ramirez.pdf', approvedBy: 'Maria Ramirez, Owner' };

  it('accepts a fully documented approval', () => {
    expect(isConsentComplete(ok)).toBe(true);
  });

  it('rejects missing or invalid parts', () => {
    expect(isConsentComplete(undefined)).toBe(false);
    expect(isConsentComplete({ provenance: 'illustrative' })).toBe(false);
    expect(isConsentComplete({ ...ok, evidenceRef: '' })).toBe(false);
    expect(isConsentComplete({ ...ok, approvedBy: '  ' })).toBe(false);
    expect(isConsentComplete({ ...ok, consentOn: 'yesterday' })).toBe(false);
    expect(isConsentComplete({ ...ok, consentOn: '2999-01-01' })).toBe(false);
  });

  it('only publishes a story as verified when its consent record is complete', () => {
    for (const s of getStories()) {
      if (s.provenance === 'verified') expect(isConsentComplete(PROVENANCE[s.slug]), s.slug).toBe(true);
    }
  });

  it('has no provenance entry for a story that does not exist', () => {
    const slugs = new Set(getStories().map((s) => s.slug));
    for (const key of Object.keys(PROVENANCE)) expect(slugs.has(key), key).toBe(true);
  });
});

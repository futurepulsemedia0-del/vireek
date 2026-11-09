import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEndorsementLine, getEndorsementLineForPath, getParentOrganizationJsonLd } from './platformEndorsement';

afterEach(() => vi.unstubAllEnvs());

describe('platform endorsement (Vite env)', () => {
  it('defaults to OFF', () => {
    expect(getEndorsementLine()).toBeNull();
    expect(getParentOrganizationJsonLd()).toBeNull();
  });
  it('ON + parent -> line on platform paths only', () => {
    vi.stubEnv('VITE_PLATFORM_ENDORSEMENT_ENABLED', 'true');
    vi.stubEnv('VITE_PLATFORM_PARENT_NAME', 'Acme Group');
    expect(getEndorsementLine()).toBe('Part of Acme Group');
    expect(getEndorsementLineForPath('/pricing')).toBe('Part of Acme Group');
    expect(getEndorsementLineForPath('/quote/abc')).toBeNull();
    expect(getParentOrganizationJsonLd()).toMatchObject({ '@type': 'Organization', name: 'Vireek', parentOrganization: { name: 'Acme Group' } });
  });
  it('ON + parent unset -> nothing, no errors', () => {
    vi.stubEnv('VITE_PLATFORM_ENDORSEMENT_ENABLED', 'true');
    vi.stubEnv('VITE_PLATFORM_PARENT_NAME', '');
    expect(getEndorsementLine()).toBeNull();
    expect(getParentOrganizationJsonLd()).toBeNull();
  });
});

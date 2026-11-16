import { describe, expect, it } from 'vitest';
import { decideServiceTitanConnect, ST_PENDING_CODE } from './stOnboardingPolicy';

describe('decideServiceTitanConnect', () => {
  it('blocks a new tenant when the flag is off (default)', () => {
    expect(decideServiceTitanConnect({ flagOn: false, existingStatus: null })).toMatchObject({ allow: false, code: ST_PENDING_CODE });
    expect(decideServiceTitanConnect({ flagOn: false, existingStatus: undefined })).toMatchObject({ allow: false });
  });
  it('allows a new tenant when the flag is on', () => {
    expect(decideServiceTitanConnect({ flagOn: true, existingStatus: null })).toEqual({ allow: true, reason: 'flag' });
  });
  it('grandfathers tenants with a live connection even if the flag is off', () => {
    expect(decideServiceTitanConnect({ flagOn: false, existingStatus: 'connected' })).toEqual({ allow: true, reason: 'grandfathered' });
    expect(decideServiceTitanConnect({ flagOn: false, existingStatus: 'error' })).toEqual({ allow: true, reason: 'grandfathered' });
  });
  it('treats a disconnected tenant as new', () => {
    expect(decideServiceTitanConnect({ flagOn: false, existingStatus: 'disconnected' })).toMatchObject({ allow: false });
  });
});

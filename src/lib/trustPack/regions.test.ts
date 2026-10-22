// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  RegionNotProvisionedError, bucketFor, isRegionCode, isSafeEndpoint, isSafeRecordingUrl, objectPathFor,
  pathBelongsToTenant, resolveDataPlane, type DedicatedTenantRow,
} from './regions';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CALL = '22222222-2222-4222-8222-222222222222';
const env = (m: Record<string, string>) => (k: string) => m[k];

describe('region basics', () => {
  it('validates region codes', () => {
    expect(isRegionCode('eu')).toBe(true);
    expect(isRegionCode('EU')).toBe(false);
    expect(isRegionCode('asia')).toBe(false);
    expect(isRegionCode(null)).toBe(false);
  });
  it('names buckets per region', () => {
    expect(bucketFor('recordings', 'ca')).toBe('recordings-ca');
  });
});

describe('object paths', () => {
  it('builds tenant-scoped paths and rejects non-UUIDs', () => {
    expect(objectPathFor(OWNER, CALL)).toBe(`${OWNER}/${CALL}.enc`);
    expect(() => objectPathFor('../x', CALL)).toThrow();
  });
  it('only accepts the exact owner/uuid.enc shape', () => {
    expect(pathBelongsToTenant(`${OWNER}/${CALL}.enc`, OWNER)).toBe(true);
    expect(pathBelongsToTenant(`${CALL}/${CALL}.enc`, OWNER)).toBe(false);
    expect(pathBelongsToTenant(`${OWNER}/../${CALL}.enc`, OWNER)).toBe(false);
    expect(pathBelongsToTenant(`${OWNER}/${CALL}.wav`, OWNER)).toBe(false);
  });
});

describe('resolveDataPlane (fail-closed)', () => {
  const base = { SUPABASE_URL: 'https://primary.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'primary-key' };

  it('uses the primary project for the primary region', () => {
    const p = resolveDataPlane('us', null, env(base));
    expect(p).toMatchObject({ url: 'https://primary.supabase.co', serviceKey: 'primary-key', isolation: 'shared', recordingsBucket: 'recordings-us' });
  });
  it('honours PRIMARY_REGION', () => {
    const p = resolveDataPlane('eu', null, env({ ...base, PRIMARY_REGION: 'eu' }));
    expect(p.url).toBe('https://primary.supabase.co');
  });
  it('routes other regions to their own project', () => {
    const p = resolveDataPlane('eu', null, env({ ...base, REGION_EU_SUPABASE_URL: 'https://eu.supabase.co', REGION_EU_SERVICE_ROLE_KEY: 'eu-key' }));
    expect(p).toMatchObject({ url: 'https://eu.supabase.co', serviceKey: 'eu-key', region: 'eu' });
  });
  it('NEVER falls back to the primary when a region is not configured', () => {
    expect(() => resolveDataPlane('eu', null, env(base))).toThrow(RegionNotProvisionedError);
    expect(() => resolveDataPlane('ca', null, env({ ...base, REGION_CA_SUPABASE_URL: 'https://ca.supabase.co' }))).toThrow(RegionNotProvisionedError);
  });
  it('rejects malformed endpoints', () => {
    expect(() => resolveDataPlane('eu', null, env({ REGION_EU_SUPABASE_URL: 'http://evil.example', REGION_EU_SERVICE_ROLE_KEY: 'k' }))).toThrow(RegionNotProvisionedError);
  });

  const ded: DedicatedTenantRow = { status: 'active', region: 'eu', endpoint_url: 'https://acme.supabase.co', secret_ref: 'ACME_EU' };
  it('routes active dedicated tenants to their own endpoint', () => {
    const p = resolveDataPlane('eu', ded, env({ ...base, DEDICATED_KEY_ACME_EU: 'acme-key' }));
    expect(p).toMatchObject({ isolation: 'dedicated', url: 'https://acme.supabase.co', serviceKey: 'acme-key' });
  });
  it('fails closed for dedicated tenants with missing key, wrong region or bad ref', () => {
    expect(() => resolveDataPlane('eu', ded, env(base))).toThrow(RegionNotProvisionedError);
    expect(() => resolveDataPlane('us', ded, env({ ...base, DEDICATED_KEY_ACME_EU: 'k' }))).toThrow(RegionNotProvisionedError);
    expect(() => resolveDataPlane('eu', { ...ded, secret_ref: 'lower-case' }, env(base))).toThrow(RegionNotProvisionedError);
  });
  it('ignores dedicated rows that are not active yet', () => {
    const p = resolveDataPlane('us', { ...ded, status: 'provisioning', region: 'us' }, env(base));
    expect(p.isolation).toBe('shared');
  });
});

describe('endpoint + recording URL safety', () => {
  it('accepts https and local http only', () => {
    expect(isSafeEndpoint('https://x.supabase.co')).toBe(true);
    expect(isSafeEndpoint('http://127.0.0.1:54321')).toBe(true);
    expect(isSafeEndpoint('http://x.supabase.co')).toBe(false);
    expect(isSafeEndpoint('https://user:pw@x.supabase.co')).toBe(false);
    expect(isSafeEndpoint('not a url')).toBe(false);
  });
  it('blocks SSRF targets for recording downloads', () => {
    expect(isSafeRecordingUrl('https://storage.vapi.ai/a.wav')).toBe(true);
    for (const bad of [
      'http://storage.vapi.ai/a.wav', 'https://localhost/a', 'https://127.0.0.1/a', 'https://10.0.0.5/a', 'https://169.254.169.254/latest',
      'https://192.168.1.1/a', 'https://[::1]/a', 'https://intranet/a', 'https://svc.internal/a', 'https://a.vapi.ai:8443/a', 'https://u:p@a.vapi.ai/a', 'ftp://a.vapi.ai/a',
    ]) expect(isSafeRecordingUrl(bad)).toBe(false);
    expect(isSafeRecordingUrl('https://8.8.8.8/a')).toBe(true);
  });
  it('enforces a host allowlist when configured', () => {
    expect(isSafeRecordingUrl('https://cdn.vapi.ai/a', ['vapi.ai'])).toBe(true);
    expect(isSafeRecordingUrl('https://vapi.ai.evil.com/a', ['vapi.ai'])).toBe(false);
    expect(isSafeRecordingUrl('https://8.8.8.8/a', ['vapi.ai'])).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { isGoogleAuthUrl, parseGbpConnection, parseGbpReturn } from './gbpConnectCore';

describe('parseGbpConnection', () => {
  it('accepts the three states and keeps only valid candidates', () => {
    const c = parseGbpConnection({ state: 'needs_choice', location_name: null, candidates: [{ location: 'locations/1', title: 'A' }, { location: 'locations/x', title: 'bad' }, { location: 'locations/2' }, 5] });
    expect(c?.state).toBe('needs_choice');
    expect(c?.candidates).toEqual([{ location: 'locations/1', title: 'A' }, { location: 'locations/2', title: 'locations/2' }]);
    expect(parseGbpConnection({ state: 'connected', location_name: 'locations/9', location_title: 'Acme', candidates: [] })).toEqual({ state: 'connected', locationName: 'locations/9', locationTitle: 'Acme', candidates: [] });
    expect(parseGbpConnection({ state: 'not_connected', candidates: [] })?.state).toBe('not_connected');
  });
  it('rejects unknown shapes and malformed location names', () => {
    expect(parseGbpConnection(null)).toBeNull();
    expect(parseGbpConnection('x')).toBeNull();
    expect(parseGbpConnection({ state: 'weird' })).toBeNull();
    expect(parseGbpConnection({ state: 'connected', location_name: 'locations/../1' })?.locationName).toBeNull();
  });
});

describe('parseGbpReturn', () => {
  it('reads the callback result', () => {
    expect(parseGbpReturn('?gbp=connected')).toEqual({ status: 'connected', reason: null });
    expect(parseGbpReturn('?gbp=choose')).toEqual({ status: 'choose', reason: null });
    expect(parseGbpReturn('?gbp=error&reason=access_denied')).toEqual({ status: 'error', reason: 'access_denied' });
  });
  it('ignores anything else and collapses unknown reasons', () => {
    expect(parseGbpReturn('')).toBeNull();
    expect(parseGbpReturn('?gbp=hacked')).toBeNull();
    expect(parseGbpReturn('?gbp=error&reason=<script>')).toEqual({ status: 'error', reason: 'unknown' });
    expect(parseGbpReturn('?gbp=error')).toEqual({ status: 'error', reason: 'unknown' });
    expect(parseGbpReturn('?other=1')).toBeNull();
  });
});

describe('isGoogleAuthUrl', () => {
  it('allows only https accounts.google.com', () => {
    expect(isGoogleAuthUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true);
    expect(isGoogleAuthUrl('http://accounts.google.com/o/oauth2/v2/auth')).toBe(false);
    expect(isGoogleAuthUrl('https://accounts.google.com.evil.com/x')).toBe(false);
    expect(isGoogleAuthUrl('https://evil.com/?u=accounts.google.com')).toBe(false);
    expect(isGoogleAuthUrl('javascript:alert(1)')).toBe(false);
    expect(isGoogleAuthUrl(null)).toBe(false);
    expect(isGoogleAuthUrl('not a url')).toBe(false);
  });
});

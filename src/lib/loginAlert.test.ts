import { describe, expect, it } from 'vitest';
import {
  buildAlertEmail,
  classifyLogin,
  decodeJwtPayload,
  describeDevice,
  describeMethod,
  escapeHtml,
  formatLocation,
  hashUserAgent,
  isPublicIp,
  maskIp,
  parseGeoResponse,
  primaryAuthMethod,
  type PriorLoginEvent,
} from '../../supabase/functions/_shared/security/login-alert-engine';

const prior = (over: Partial<PriorLoginEvent> = {}): PriorLoginEvent => ({
  device_cookie_hash: 'cookie-A',
  ua_hash: 'ua-A',
  country: 'US',
  ...over,
});
const signals = (over: Partial<{ cookieDeviceHash: string | null; uaHash: string; country: string | null }> = {}) => ({
  cookieDeviceHash: 'cookie-A' as string | null,
  uaHash: 'ua-A',
  geo: { country: 'US' as string | null, region: null, city: null },
  ...(over.cookieDeviceHash !== undefined ? { cookieDeviceHash: over.cookieDeviceHash } : {}),
  ...(over.uaHash !== undefined ? { uaHash: over.uaHash } : {}),
  ...(over.country !== undefined ? { geo: over.country ? { country: over.country, region: null, city: null } : null } : {}),
});

describe('classifyLogin', () => {
  it('records the very first event silently as a baseline', () => {
    const v = classifyLogin(signals(), []);
    expect(v).toEqual({ isBaseline: true, isNewDevice: false, isNewLocation: false, shouldAlert: false });
  });

  it('does not alert for a known cookie from a known country', () => {
    expect(classifyLogin(signals(), [prior()]).shouldAlert).toBe(false);
  });

  it('alerts for an unseen device cookie', () => {
    const v = classifyLogin(signals({ cookieDeviceHash: 'cookie-NEW' }), [prior()]);
    expect(v.isNewDevice).toBe(true);
    expect(v.isNewLocation).toBe(false);
    expect(v.shouldAlert).toBe(true);
  });

  it('alerts for a new country on a known device', () => {
    const v = classifyLogin(signals({ country: 'DE' }), [prior()]);
    expect(v.isNewDevice).toBe(false);
    expect(v.isNewLocation).toBe(true);
    expect(v.shouldAlert).toBe(true);
  });

  it('flags both when device and country are new', () => {
    const v = classifyLogin(signals({ cookieDeviceHash: 'x', country: 'JP' }), [prior()]);
    expect(v.isNewDevice && v.isNewLocation).toBe(true);
  });

  it('falls back to user-agent matching when there is no cookie', () => {
    expect(classifyLogin(signals({ cookieDeviceHash: null }), [prior()]).isNewDevice).toBe(false);
    expect(classifyLogin(signals({ cookieDeviceHash: null, uaHash: 'ua-NEW' }), [prior()]).isNewDevice).toBe(true);
  });

  it('treats a first-time cookie as the same browser if that UA signed in cookie-less before', () => {
    const history = [prior({ device_cookie_hash: null })];
    expect(classifyLogin(signals({ cookieDeviceHash: 'cookie-NEW' }), history).isNewDevice).toBe(false);
  });

  it('does not raise a location alert when geo is unknown', () => {
    expect(classifyLogin(signals({ country: null }), [prior()]).isNewLocation).toBe(false);
  });

  it('does not raise a location alert when no prior event had a country', () => {
    expect(classifyLogin(signals({ country: 'DE' }), [prior({ country: null })]).isNewLocation).toBe(false);
  });

  it('accepts any previously seen country', () => {
    const history = [prior({ country: 'US' }), prior({ country: 'DE' })];
    expect(classifyLogin(signals({ country: 'DE' }), history).isNewLocation).toBe(false);
  });
});

describe('ip helpers', () => {
  it('masks IPv4 and IPv6 to a network prefix', () => {
    expect(maskIp('203.0.113.77')).toBe('203.0.113.0');
    expect(maskIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3:8d3::');
    expect(maskIp(null)).toBeNull();
    expect(maskIp('not-an-ip')).toBeNull();
  });

  it('detects public vs private addresses', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    for (const ip of ['10.0.0.1', '192.168.1.5', '172.20.0.1', '127.0.0.1', '169.254.1.1', '::1', 'fe80::1', 'fd00::1']) {
      expect(isPublicIp(ip)).toBe(false);
    }
    expect(isPublicIp(null)).toBe(false);
  });
});

describe('parseGeoResponse', () => {
  it('normalises ipwho.is style payloads', () => {
    expect(parseGeoResponse({ success: true, country_code: 'de', region: 'Berlin', city: 'Berlin' })).toEqual({
      country: 'DE',
      region: 'Berlin',
      city: 'Berlin',
    });
  });
  it('normalises ip-api style payloads', () => {
    expect(parseGeoResponse({ status: 'success', countryCode: 'US', regionName: 'Texas', city: 'Austin' })).toEqual({
      country: 'US',
      region: 'Texas',
      city: 'Austin',
    });
  });
  it('rejects failures and junk', () => {
    expect(parseGeoResponse({ success: false })).toBeNull();
    expect(parseGeoResponse({ status: 'fail' })).toBeNull();
    expect(parseGeoResponse(null)).toBeNull();
    expect(parseGeoResponse({})).toBeNull();
    expect(parseGeoResponse({ country_code: 'USA' })).toBeNull();
  });
});

describe('labels', () => {
  it('describes devices', () => {
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Version/17 Safari/605')).toBe('Safari on Mac');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537 Edg/120')).toBe('Edge on Windows');
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605 CriOS/120 Mobile Safari/604')).toBe('Chrome on iOS');
    expect(describeDevice(null)).toBe('Unknown device');
  });
  it('describes auth methods', () => {
    expect(describeMethod('webauthn')).toBe('Passkey');
    expect(describeMethod('password')).toBe('Password');
    expect(describeMethod('oauth')).toBe('Google or Apple');
    expect(describeMethod(undefined)).toBe('Sign-in');
  });
  it('formats locations', () => {
    expect(formatLocation({ country: 'DE', region: 'Berlin', city: 'Berlin' })).toBe('Berlin, Berlin, DE');
    expect(formatLocation({ country: 'DE', region: null, city: null })).toBe('DE');
    expect(formatLocation(null)).toBe('Unknown location');
  });
});

describe('buildAlertEmail', () => {
  const base = {
    deviceLabel: 'Chrome on Windows',
    methodLabel: 'Passkey',
    location: 'Berlin, DE',
    ipMasked: '203.0.113.0',
    whenUtc: new Date('2027-04-02T10:15:30Z'),
    isNewDevice: true,
    isNewLocation: false,
    securityUrl: 'https://app.vireek.com/dashboard/settings/security',
  };

  it('builds subject, text and html with the security link', () => {
    const m = buildAlertEmail(base);
    expect(m.subject).toBe('New device signed in to your Vireek account');
    expect(m.text).toContain('2027-04-02 10:15 UTC');
    expect(m.text).toContain(base.securityUrl);
    expect(m.html).toContain('href="https://app.vireek.com/dashboard/settings/security"');
  });

  it('uses the location subject when only the location is new', () => {
    expect(buildAlertEmail({ ...base, isNewDevice: false, isNewLocation: true }).subject).toBe(
      'Sign-in from a new location on your Vireek account',
    );
  });

  it('escapes untrusted values (user agent derived) in HTML', () => {
    const m = buildAlertEmail({ ...base, deviceLabel: '<script>alert(1)</script>' });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(escapeHtml(`"'&<>`)).toBe('&quot;&#39;&amp;&lt;&gt;');
  });
});

describe('jwt helpers', () => {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const token = `h.${b64({ session_id: 'abc', amr: [{ method: 'webauthn', timestamp: 1 }] })}.s`;

  it('decodes the payload and reads the primary method', () => {
    const p = decodeJwtPayload(token);
    expect(p?.session_id).toBe('abc');
    expect(primaryAuthMethod(p)).toBe('webauthn');
  });
  it('returns null on malformed tokens and missing amr', () => {
    expect(decodeJwtPayload('garbage')).toBeNull();
    expect(primaryAuthMethod(null)).toBeNull();
    expect(primaryAuthMethod({ amr: [] })).toBeNull();
    expect(primaryAuthMethod({ amr: ['password'] })).toBe('password');
  });
});

describe('hashUserAgent', () => {
  it('is stable, case-insensitive and namespaced per user', async () => {
    const a = await hashUserAgent('u1', 'Mozilla/5.0 X');
    expect(a).toBe(await hashUserAgent('u1', ' mozilla/5.0 x '));
    expect(a).not.toBe(await hashUserAgent('u2', 'Mozilla/5.0 X'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

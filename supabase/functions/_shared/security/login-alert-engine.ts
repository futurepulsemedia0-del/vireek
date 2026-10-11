// Pure, dependency-free logic for new-device / new-location login alerts.
// No Deno / Node / network APIs beyond Web Crypto, so it runs unchanged in
// the `login-alert` edge function and under Vitest (src/lib/loginAlert.test.ts).

export interface GeoInfo {
  country: string | null; // ISO-3166 alpha-2, upper-case
  region: string | null;
  city: string | null;
}

export interface PriorLoginEvent {
  device_cookie_hash: string | null;
  ua_hash: string;
  country: string | null;
}

export interface LoginSignals {
  cookieDeviceHash: string | null;
  uaHash: string;
  geo: GeoInfo | null;
}

export interface LoginClassification {
  isBaseline: boolean;
  isNewDevice: boolean;
  isNewLocation: boolean;
  shouldAlert: boolean;
}

/**
 * Decide whether a completed sign-in deserves an alert.
 *
 * - Baseline: the user has no history at all (brand-new account, or first
 *   call after this feature shipped). We record it silently — alerting on
 *   "everything is new" would be noise and would spam every existing user
 *   the day this deploys.
 * - New device: when the browser carries the httpOnly `vrk_device` cookie we
 *   trust that as the identity. A cookie-less sign-in (e.g. Google/Apple,
 *   which don't register a trusted device) falls back to a hash of the user
 *   agent. A cookie that appears for the first time is still treated as a
 *   known browser if the same user agent previously signed in cookie-less —
 *   otherwise "Google login, then password+OTP on the same browser" would
 *   raise a false alarm. Trade-off: two different machines with an
 *   identical user-agent string that both signed in cookie-less are
 *   indistinguishable.
 * - New location: country-level, and only when both this sign-in and at
 *   least one prior event have a known country (no geo => no false alarms).
 */
export function classifyLogin(signals: LoginSignals, prior: PriorLoginEvent[]): LoginClassification {
  if (prior.length === 0) {
    return { isBaseline: true, isNewDevice: false, isNewLocation: false, shouldAlert: false };
  }

  let knownDevice: boolean;
  if (signals.cookieDeviceHash) {
    const cookie = signals.cookieDeviceHash;
    knownDevice = prior.some(
      (p) =>
        p.device_cookie_hash === cookie ||
        (p.device_cookie_hash === null && p.ua_hash === signals.uaHash),
    );
  } else {
    knownDevice = prior.some((p) => p.ua_hash === signals.uaHash);
  }

  const country = signals.geo?.country ?? null;
  const priorCountries = prior.map((p) => p.country).filter((c): c is string => Boolean(c));
  const isNewLocation = Boolean(country) && priorCountries.length > 0 && !priorCountries.includes(country as string);

  const isNewDevice = !knownDevice;
  return { isBaseline: false, isNewDevice, isNewLocation, shouldAlert: isNewDevice || isNewLocation };
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Hash of the user agent, namespaced per user so hashes can't be correlated across accounts. */
export function hashUserAgent(userId: string, userAgent: string | null): Promise<string> {
  return sha256Hex(`${userId}:${(userAgent ?? 'unknown').trim().toLowerCase()}`);
}

/** Keep the network prefix only: a.b.c.0 for IPv4, first 4 hextets for IPv6. */
export function maskIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = ip.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    const p = v.split('.');
    return `${p[0]}.${p[1]}.${p[2]}.0`;
  }
  if (v.includes(':')) {
    const head = v.split(':').filter(Boolean).slice(0, 4);
    return head.length ? `${head.join(':')}::` : null;
  }
  return null;
}

/** Private / loopback / link-local addresses can't be geolocated. */
export function isPublicIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const v = ip.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    const [a, b] = v.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (v.includes(':')) {
    const l = v.toLowerCase();
    return !(l === '::1' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd'));
  }
  return false;
}

/** Normalise the response shape of common IP-geo APIs (ipwho.is, ipapi.co, ip-api style). */
export function parseGeoResponse(raw: unknown): GeoInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.success === false || o.error === true || o.status === 'fail') return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const cc = str(o.country_code) ?? str(o.countryCode) ?? str(o.country_iso);
  const country = cc && /^[A-Za-z]{2}$/.test(cc) ? cc.toUpperCase() : null;
  const region = str(o.region) ?? str(o.regionName) ?? str(o.region_name);
  const city = str(o.city);
  if (!country && !region && !city) return null;
  return { country, region, city };
}

export function describeDevice(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const isIOS = /iPhone|iPad|iPod/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isMac = /Macintosh/.test(ua);
  const isWindows = /Windows/.test(ua);
  const isLinux = /Linux/.test(ua) && !isAndroid;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const platform = isIOS ? 'iOS' : isAndroid ? 'Android' : isMac ? 'Mac' : isWindows ? 'Windows' : isLinux ? 'Linux' : 'device';
  return `${browser} on ${platform}`;
}

export function describeMethod(method: string | null | undefined): string {
  switch ((method ?? '').toLowerCase()) {
    case 'password':
      return 'Password';
    case 'otp':
    case 'email':
    case 'magiclink':
      return 'Email link or code';
    case 'oauth':
      return 'Google or Apple';
    case 'webauthn':
    case 'passkey':
      return 'Passkey';
    case 'sso/saml':
    case 'saml':
      return 'Company SSO';
    case 'totp':
      return 'Authenticator app';
    default:
      return 'Sign-in';
  }
}

export function formatLocation(geo: GeoInfo | null): string {
  if (!geo) return 'Unknown location';
  const parts = [geo.city, geo.region, geo.country].filter((p): p is string => Boolean(p));
  return parts.length ? parts.join(', ') : 'Unknown location';
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface AlertEmailInput {
  deviceLabel: string;
  methodLabel: string;
  location: string;
  ipMasked: string | null;
  whenUtc: Date;
  isNewDevice: boolean;
  isNewLocation: boolean;
  securityUrl: string;
}

export function alertReason(i: Pick<AlertEmailInput, 'isNewDevice' | 'isNewLocation'>): string {
  if (i.isNewDevice && i.isNewLocation) return 'a new device in a new location';
  if (i.isNewDevice) return 'a new device';
  return 'a new location';
}

export function buildAlertEmail(i: AlertEmailInput): { subject: string; html: string; text: string } {
  const when = `${i.whenUtc.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const reason = alertReason(i);
  const subject = i.isNewDevice ? 'New device signed in to your Vireek account' : 'Sign-in from a new location on your Vireek account';
  const rows: Array<[string, string]> = [
    ['Device', i.deviceLabel],
    ['Method', i.methodLabel],
    ['Location', i.location],
    ['Network', i.ipMasked ?? 'Unknown'],
    ['Time', when],
  ];
  const text =
    `We noticed a sign-in to your Vireek account from ${reason}.\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\nIf this was you, no action is needed.\n` +
    `If it wasn't, secure your account now: ${i.securityUrl}\n` +
    `(Sign out other sessions, remove unknown passkeys and trusted devices, and change your password.)\n`;
  const rowHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#64748b;font-size:14px">${escapeHtml(k)}</td>` +
        `<td style="padding:6px 0;color:#0f172a;font-size:14px;font-weight:600">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">` +
    `<h2 style="margin:0 0 8px;font-size:20px;color:#0f172a">New sign-in to your account</h2>` +
    `<p style="margin:0 0 16px;color:#334155;font-size:15px;line-height:1.5">We noticed a sign-in from ${escapeHtml(reason)}.</p>` +
    `<table role="presentation" style="border-collapse:collapse;margin-bottom:20px">${rowHtml}</table>` +
    `<p style="margin:0 0 16px;color:#334155;font-size:15px">If this was you, no action is needed.</p>` +
    `<a href="${escapeHtml(i.securityUrl)}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600">This wasn’t me — secure my account</a>` +
    `<p style="margin:20px 0 0;color:#94a3b8;font-size:12px;line-height:1.5">You can sign out other sessions and remove unknown passkeys or trusted devices from Security settings.</p>` +
    `</div>`;
  return { subject, html, text };
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const b64 = token.split('.')[1];
    if (!b64) return null;
    const norm = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = norm.padEnd(norm.length + ((4 - (norm.length % 4)) % 4), '=');
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Most recent authentication method from the token's `amr` claim. */
export function primaryAuthMethod(payload: Record<string, unknown> | null): string | null {
  const amr = payload?.amr;
  if (!Array.isArray(amr) || amr.length === 0) return null;
  const first = amr[0] as unknown;
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && typeof (first as { method?: unknown }).method === 'string') {
    return (first as { method: string }).method;
  }
  return null;
}

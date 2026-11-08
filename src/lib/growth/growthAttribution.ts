/**
 * First-touch acquisition attribution (UTM + referrer host), strictly consent-gated.
 *
 * - Nothing is read, stored or sent unless `hasConsent()` (analytics category of src/lib/consent/engine.ts) is true.
 * - Stored value is first-touch only, expires after 30 days, and is removed when analytics consent is withdrawn.
 * - Only low-cardinality tokens are kept (no full URLs, no query strings, no click ids, no emails).
 * - The server (record_signup_attribution) re-validates every field and only writes for the account owner within
 *   7 days of signup, so a tampered client cannot rewrite history.
 */

export const ATTRIBUTION_STORAGE_KEY = 'vireek-attrib-v1';
export const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Attribution {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  referrerHost: string | null;
  capturedAt: number;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const TOKEN_RE = /^[a-z0-9][a-z0-9._~-]*$/;

/** Mirrors growth_clean_token() in SQL. */
export function cleanToken(raw: string | null | undefined, max = 64): string | null {
  if (raw === null || raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  return v.length >= 1 && v.length <= max && TOKEN_RE.test(v) ? v : null;
}

function hostOf(referrer: string): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Returns null when the landing carries no acquisition signal (direct visit or internal navigation). */
export function parseLanding(search: string, referrer: string, ownHost: string, now: number): Attribution | null {
  const params = new URLSearchParams(search);
  const source = cleanToken(params.get('utm_source'));
  const medium = cleanToken(params.get('utm_medium'));
  const campaign = cleanToken(params.get('utm_campaign'), 100);
  const refHost = hostOf(referrer);
  const external = refHost !== null && refHost !== ownHost.toLowerCase() && !refHost.endsWith(`.${ownHost.toLowerCase()}`);
  const referrerHost = external ? cleanToken(refHost, 100) : null;
  if (!source && !medium && !campaign && !referrerHost) return null;
  return { source, medium, campaign, referrerHost, capturedAt: now };
}

export function readStored(storage: StorageLike, now: number): Attribution | null {
  try {
    const raw = storage.getItem(ATTRIBUTION_STORAGE_KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return null;
    const r = v as Record<string, unknown>;
    const capturedAt = typeof r.capturedAt === 'number' ? r.capturedAt : NaN;
    if (!Number.isFinite(capturedAt) || now - capturedAt > ATTRIBUTION_TTL_MS || capturedAt > now + 60_000) {
      storage.removeItem(ATTRIBUTION_STORAGE_KEY);
      return null;
    }
    return {
      source: cleanToken(typeof r.source === 'string' ? r.source : null),
      medium: cleanToken(typeof r.medium === 'string' ? r.medium : null),
      campaign: cleanToken(typeof r.campaign === 'string' ? r.campaign : null, 100),
      referrerHost: cleanToken(typeof r.referrerHost === 'string' ? r.referrerHost : null, 100),
      capturedAt,
    };
  } catch {
    return null;
  }
}

export function clearAttribution(storage: StorageLike): void {
  try {
    storage.removeItem(ATTRIBUTION_STORAGE_KEY);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

export interface CaptureDeps {
  storage: StorageLike;
  hasConsent: () => boolean;
  now: () => number;
  search: string;
  referrer: string;
  ownHost: string;
}

/** Stores the landing's attribution if consent is granted and no unexpired first touch exists. Returns whether it stored. */
export function captureLanding(d: CaptureDeps): boolean {
  if (!d.hasConsent()) return false;
  const now = d.now();
  if (readStored(d.storage, now)) return false; // first touch wins
  const a = parseLanding(d.search, d.referrer, d.ownHost, now);
  if (!a) return false;
  try {
    d.storage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(a));
    return true;
  } catch {
    return false;
  }
}

export interface SendArgs {
  p_source: string | null;
  p_medium: string | null;
  p_campaign: string | null;
  p_referrer_host: string | null;
}

/**
 * Sends the stored first touch once the user is signed in, then clears it. Both server outcomes (recorded / not
 * applicable) are final, so the value is cleared either way; a thrown error keeps it for a later retry.
 */
export async function flushAttribution(
  d: Pick<CaptureDeps, 'storage' | 'hasConsent' | 'now'>,
  send: (args: SendArgs) => Promise<void>,
): Promise<boolean> {
  if (!d.hasConsent()) {
    clearAttribution(d.storage);
    return false;
  }
  const a = readStored(d.storage, d.now());
  if (!a) return false;
  await send({ p_source: a.source, p_medium: a.medium, p_campaign: a.campaign, p_referrer_host: a.referrerHost });
  clearAttribution(d.storage);
  return true;
}

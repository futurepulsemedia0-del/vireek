// Agent Readiness — Google Business Profile read model. Pure (no imports, no network, no clock):
// runs in Deno, Vitest and the browser.
//
// What is read, and why it is small: only the fields the score and the NAP comparison need. The raw Google
// payload is never stored — `parseLocation` reduces it to `GbpFacts` and drops everything else.
//
// Field names follow the Business Information API v1 `Location` resource and the My Business v4 media list.
// [VERIFY] against Google's current reference before each release; reviewBy is tracked in rules.ts.

export type GbpOpenStatus = 'OPEN' | 'CLOSED_PERMANENTLY' | 'CLOSED_TEMPORARILY' | 'UNSPECIFIED';

export interface GbpAddress { lines: string[]; locality: string | null; region: string | null; postalCode: string | null; country: string | null }

export interface GbpFacts {
  title: string | null;
  primaryCategory: string | null;
  additionalCategories: number;
  phone: string | null;
  additionalPhones: number;
  website: string | null;
  address: GbpAddress | null;
  /** Days that have at least one regular opening period. */
  openDays: number;
  specialHoursPeriods: number;
  serviceItems: number;
  descriptionLength: number;
  openStatus: GbpOpenStatus | null;
  /** `metadata.hasVoiceOfMerchant`. false = the owner cannot manage this listing (unverified or suspended); Google does not say which. */
  voiceOfMerchant: boolean | null;
  /** null when the media list could not be read (it needs the account id and is a separate, non-fatal call). */
  photoCount: number | null;
}

export type GbpStatus = 'ok' | 'disabled' | 'not_connected' | 'no_location' | 'forbidden' | 'unauthorized' | 'not_found' | 'rate_limited' | 'unavailable';

export interface GbpResult {
  status: GbpStatus;
  facts: GbpFacts | null;
  /** True when `facts` come from an older successful read because the live read failed. */
  stale: boolean;
  fetchedAt: string | null;
}

export const LOCATION_RE = /^locations\/\d{1,24}$/;
export const ACCOUNT_RE = /^accounts\/\d{1,24}$/;

/** Fields requested from Google. Keep in sync with `parseLocation`. */
export const LOCATION_READ_MASK = 'name,title,phoneNumbers,categories,storefrontAddress,websiteUri,regularHours,specialHours,serviceItems,profile,openInfo,metadata';

const OPEN_STATUSES: readonly string[] = ['OPEN', 'CLOSED_PERMANENTLY', 'CLOSED_TEMPORARILY', 'OPEN_FOR_BUSINESS_UNSPECIFIED'];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 500): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function categoryName(v: unknown): string | null {
  if (!isObj(v)) return null;
  return str(v.displayName, 120) ?? str(v.name, 120);
}

function parseAddress(v: unknown): GbpAddress | null {
  if (!isObj(v)) return null;
  const lines = arr(v.addressLines).map((l) => str(l, 200)).filter((l): l is string => !!l).slice(0, 5);
  const out: GbpAddress = {
    lines, locality: str(v.locality, 120), region: str(v.administrativeArea, 120), postalCode: str(v.postalCode, 20), country: str(v.regionCode, 8),
  };
  return lines.length || out.locality || out.postalCode ? out : null;
}

/** Reduce a Business Information API `Location` to the facts the scorer needs. Throws nothing; returns null on a non-object. */
export function parseLocation(raw: unknown): GbpFacts | null {
  if (!isObj(raw)) return null;
  const cats = isObj(raw.categories) ? raw.categories : {};
  const phones = isObj(raw.phoneNumbers) ? raw.phoneNumbers : {};
  const periods = arr(isObj(raw.regularHours) ? raw.regularHours.periods : null);
  const days = new Set<string>();
  for (const p of periods) if (isObj(p) && typeof p.openDay === 'string') days.add(p.openDay);
  const special = arr(isObj(raw.specialHours) ? raw.specialHours.specialHourPeriods : null);
  const openInfo = isObj(raw.openInfo) ? raw.openInfo : {};
  const status = typeof openInfo.status === 'string' ? openInfo.status : null;
  const meta = isObj(raw.metadata) ? raw.metadata : {};
  const profile = isObj(raw.profile) ? raw.profile : {};
  return {
    title: str(raw.title, 200),
    primaryCategory: categoryName(cats.primaryCategory),
    additionalCategories: arr(cats.additionalCategories).filter((c) => categoryName(c) !== null).length,
    phone: str(phones.primaryPhone, 40),
    additionalPhones: arr(phones.additionalPhones).filter((p) => str(p, 40) !== null).length,
    website: str(raw.websiteUri, 500),
    address: parseAddress(raw.storefrontAddress),
    openDays: days.size,
    specialHoursPeriods: special.length,
    serviceItems: arr(raw.serviceItems).length,
    descriptionLength: (str(profile.description, 2000) ?? '').length,
    openStatus: status === null ? null : OPEN_STATUSES.includes(status) ? (status === 'OPEN_FOR_BUSINESS_UNSPECIFIED' ? 'UNSPECIFIED' : (status as GbpOpenStatus)) : 'UNSPECIFIED',
    voiceOfMerchant: typeof meta.hasVoiceOfMerchant === 'boolean' ? meta.hasVoiceOfMerchant : null,
    photoCount: null,
  };
}

/** `totalMediaItemCount` from the v4 media list; null when absent or malformed. */
export function parseMediaCount(raw: unknown): number | null {
  if (!isObj(raw)) return null;
  const n = raw.totalMediaItemCount;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 0) return Math.min(n, 100000);
  // The list is empty when the location has no media; Google then omits the count.
  if (Array.isArray(raw.mediaItems) && raw.mediaItems.length === 0) return 0;
  if (raw.mediaItems === undefined && raw.totalMediaItemCount === undefined && Object.keys(raw).length === 0) return 0;
  return null;
}

/** Facts are re-validated when they come back from the cache table: it is jsonb and could hold an older shape. */
export function revalidateFacts(raw: unknown): GbpFacts | null {
  if (!isObj(raw)) return null;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const addr = isObj(raw.address) ? parseAddress({
    addressLines: raw.address.lines, locality: raw.address.locality, administrativeArea: raw.address.region, postalCode: raw.address.postalCode, regionCode: raw.address.country,
  }) : null;
  const os = raw.openStatus;
  return {
    title: str(raw.title, 200), primaryCategory: str(raw.primaryCategory, 120), additionalCategories: n(raw.additionalCategories),
    phone: str(raw.phone, 40), additionalPhones: n(raw.additionalPhones), website: str(raw.website, 500), address: addr,
    openDays: Math.min(7, n(raw.openDays)), specialHoursPeriods: n(raw.specialHoursPeriods), serviceItems: n(raw.serviceItems),
    descriptionLength: n(raw.descriptionLength),
    openStatus: os === 'OPEN' || os === 'CLOSED_PERMANENTLY' || os === 'CLOSED_TEMPORARILY' || os === 'UNSPECIFIED' ? os : null,
    voiceOfMerchant: typeof raw.voiceOfMerchant === 'boolean' ? raw.voiceOfMerchant : null,
    photoCount: typeof raw.photoCount === 'number' && Number.isInteger(raw.photoCount) && raw.photoCount >= 0 ? raw.photoCount : null,
  };
}

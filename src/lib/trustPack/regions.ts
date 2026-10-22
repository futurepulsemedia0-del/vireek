// Enterprise Trust Pack — regional data residency + data-plane routing.
//
// ISOMORPHIC: imported by the dashboard (Vite) AND by Deno edge functions
// (supabase/functions/**) — so no `@/` alias, no DOM, no Node-only APIs.
//
// How residency works (see supabase/migrations/20271021000000_enterprise_trust_pack.sql):
//   * Control plane  = the primary Supabase project (auth, accounts, billing, jobs).
//   * Data plane     = one Supabase project per region (US/EU/CA) that stores the
//                      highest-sensitivity content: call recordings and sealed fields.
//   * A tenant picks a region once; the edge router below resolves the matching
//     data plane and FAILS CLOSED — it never falls back to another region.
//   * A tenant on a dedicated plan gets its own data plane (own project/endpoint).

export const REGION_CODES = ['us', 'eu', 'ca'] as const;
export type RegionCode = (typeof REGION_CODES)[number];
export const DEFAULT_REGION: RegionCode = 'us';

export interface RegionInfo {
  code: RegionCode;
  label: string;
  jurisdiction: string;
  frameworks: string[];
}

export const REGIONS: Record<RegionCode, RegionInfo> = {
  us: { code: 'us', label: 'United States', jurisdiction: 'United States', frameworks: ['CCPA / CPRA'] },
  eu: { code: 'eu', label: 'European Union', jurisdiction: 'European Union', frameworks: ['GDPR'] },
  ca: { code: 'ca', label: 'Canada', jurisdiction: 'Canada', frameworks: ['PIPEDA'] },
};

export function isRegionCode(value: unknown): value is RegionCode {
  return typeof value === 'string' && (REGION_CODES as readonly string[]).includes(value);
}

export function regionLabel(code: string | null | undefined): string {
  return isRegionCode(code) ? REGIONS[code].label : 'United States';
}

/**
 * What is (and is not) region-pinned. The UI renders this verbatim so we never
 * claim more than the architecture enforces.
 */
export type ResidencyScopeStatus = 'enforced' | 'control_plane' | 'third_party';

export interface ResidencyScopeItem {
  id: string;
  label: string;
  status: ResidencyScopeStatus;
  note: string;
}

export const RESIDENCY_SCOPE: ResidencyScopeItem[] = [
  {
    id: 'call_recordings',
    label: 'Call recordings',
    status: 'enforced',
    note: 'Archived as encrypted objects in your region’s storage bucket. Writes to any other region are rejected.',
  },
  {
    id: 'sealed_fields',
    label: 'Sealed sensitive fields (call transcripts)',
    status: 'enforced',
    note: 'Ciphertext is stored in your region’s data plane and can only be opened through your encryption key.',
  },
  {
    id: 'account_records',
    label: 'Accounts, jobs, customers and billing records',
    status: 'control_plane',
    note: 'Stored in Vireek’s primary control plane. A dedicated tenant moves these to an isolated deployment.',
  },
  {
    id: 'ai_processing',
    label: 'Live voice and AI processing',
    status: 'third_party',
    note: 'Performed in transit by sub-processors that operate in the United States — see the impact list below.',
  },
];

// ---------------------------------------------------------------------------
// Storage routing
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export type StorageKind = 'recordings';

export function bucketFor(kind: StorageKind, region: RegionCode): string {
  return `${kind}-${region}`;
}

/** Objects always live under `<account owner>/<source row>.enc`. */
export function objectPathFor(ownerId: string, sourceId: string): string {
  if (!isUuid(ownerId) || !isUuid(sourceId)) throw new Error('objectPathFor: ids must be UUIDs');
  return `${ownerId.toLowerCase()}/${sourceId.toLowerCase()}.enc`;
}

/** True only when `path` is exactly `<ownerId>/<uuid>.enc` — blocks path traversal and cross-tenant reads. */
export function pathBelongsToTenant(path: string, ownerId: string): boolean {
  if (!isUuid(ownerId)) return false;
  const m = /^([0-9a-f-]{36})\/([0-9a-f-]{36})\.enc$/i.exec(path);
  return !!m && m[1].toLowerCase() === ownerId.toLowerCase() && isUuid(m[2]);
}

// ---------------------------------------------------------------------------
// Data-plane router (fail-closed)
// ---------------------------------------------------------------------------

export type EnvReader = (key: string) => string | undefined;

export interface DedicatedTenantRow {
  status: string;
  region: string;
  endpoint_url: string | null;
  secret_ref: string | null;
}

export interface DataPlane {
  region: RegionCode;
  url: string;
  serviceKey: string;
  isolation: 'shared' | 'dedicated';
  recordingsBucket: string;
}

export class RegionNotProvisionedError extends Error {
  readonly code = 'REGION_NOT_PROVISIONED';
  readonly region: string;
  constructor(region: string, detail: string) {
    super(`Data plane for region "${region}" is not available: ${detail}`);
    this.name = 'RegionNotProvisionedError';
    this.region = region;
  }
}

const SECRET_REF_RE = /^[A-Z0-9_]{1,40}$/;

export function isSafeEndpoint(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  // Local `supabase start` only.
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

/**
 * Picks the Supabase project that must hold a tenant's regional data.
 *
 *  - dedicated + active  -> the tenant's own endpoint (key from env DEDICATED_KEY_<secret_ref>)
 *  - region == PRIMARY   -> SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *  - otherwise           -> REGION_<CODE>_SUPABASE_URL / REGION_<CODE>_SERVICE_ROLE_KEY
 *
 * Anything missing or malformed throws RegionNotProvisionedError. There is deliberately
 * no fallback to the primary project: a mis-configured EU tenant must fail, not leak to US.
 */
export function resolveDataPlane(
  region: RegionCode,
  dedicated: DedicatedTenantRow | null | undefined,
  env: EnvReader,
): DataPlane {
  if (dedicated && dedicated.status === 'active') {
    if (dedicated.region !== region) {
      throw new RegionNotProvisionedError(region, 'dedicated tenant region does not match tenant residency');
    }
    const ref = dedicated.secret_ref ?? '';
    if (!SECRET_REF_RE.test(ref)) throw new RegionNotProvisionedError(region, 'dedicated tenant has an invalid secret reference');
    const url = dedicated.endpoint_url ?? '';
    if (!isSafeEndpoint(url)) throw new RegionNotProvisionedError(region, 'dedicated tenant endpoint is missing or unsafe');
    const key = env(`DEDICATED_KEY_${ref}`);
    if (!key) throw new RegionNotProvisionedError(region, 'dedicated tenant service key is not configured');
    return { region, url: url.replace(/\/+$/, ''), serviceKey: key, isolation: 'dedicated', recordingsBucket: bucketFor('recordings', region) };
  }

  const primaryRaw = env('PRIMARY_REGION');
  const primary: RegionCode = isRegionCode(primaryRaw) ? primaryRaw : DEFAULT_REGION;
  const code = region.toUpperCase();
  const url = region === primary ? env('SUPABASE_URL') : env(`REGION_${code}_SUPABASE_URL`);
  const key = region === primary ? env('SUPABASE_SERVICE_ROLE_KEY') : env(`REGION_${code}_SERVICE_ROLE_KEY`);
  if (!url || !key) throw new RegionNotProvisionedError(region, 'endpoint or service key is not configured');
  if (!isSafeEndpoint(url)) throw new RegionNotProvisionedError(region, 'endpoint is malformed');
  return { region, url: url.replace(/\/+$/, ''), serviceKey: key, isolation: 'shared', recordingsBucket: bucketFor('recordings', region) };
}

// ---------------------------------------------------------------------------
// Recording fetch safety (SSRF guard for the archive step)
// ---------------------------------------------------------------------------

export const MAX_RECORDING_BYTES = 40 * 1024 * 1024;

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/**
 * Only fetch recordings from public https hosts. When `allowedHostSuffixes` is given
 * (env TRUST_RECORDING_HOSTS, e.g. "vapi.ai,vapicdn.com") the host must also match one.
 */
export function isSafeRecordingUrl(raw: string, allowedHostSuffixes: string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  const host = u.hostname.toLowerCase();
  if (host.startsWith('[') || host.includes(':')) return false; // no IPv6 literals
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return false;
  if (/^[\d.]+$/.test(host)) {
    // IP literals: only a well-formed PUBLIC IPv4, and never when an allowlist is configured.
    return allowedHostSuffixes.length === 0 && /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && !isPrivateIpv4(host);
  }
  if (allowedHostSuffixes.length > 0) {
    return allowedHostSuffixes.some((s) => host === s || host.endsWith(`.${s}`));
  }
  return true;
}

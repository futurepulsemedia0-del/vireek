// Pure release-policy helpers for the native app: version compare, staged "update available" prompts and
// the OTA (live bundle) compatibility check. No imports, so it is trivially testable.

/** Dotted numeric compare ("1.10.0" > "1.9.2"); suffixes after "-" and junk parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => String(v).split('-')[0].split('.').map((p) => (Number.parseInt(p, 10) || 0));
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Stable 0-99 bucket from an install id (FNV-1a). The same install always lands in the same bucket. */
export function bucketFromId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

const INSTALL_ID_KEY = 'vireek:install-id:v1';

/** Random per-install id kept in localStorage (no device identifiers, nothing leaves the device). */
export function installBucket(): number {
  try {
    let id = window.localStorage.getItem(INSTALL_ID_KEY);
    if (!id) {
      id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      window.localStorage.setItem(INSTALL_ID_KEY, id);
    }
    return bucketFromId(id);
  } catch {
    return 0; // storage unavailable: show the (harmless) soft prompt
  }
}

/** Soft-update staging only. A FORCE update (below min_version) is never staged. */
export function isInRollout(bucket: number | null, rolloutPct: number | undefined): boolean {
  if (rolloutPct === undefined || rolloutPct >= 100) return true;
  if (bucket === null) return false;
  return bucket < Math.max(0, rolloutPct);
}

export interface OtaBundle { minNativeVersion: string; maxNativeVersion?: string | null }

/**
 * May this web bundle be applied over the installed native shell? An OTA bundle that needs a newer native
 * binary (new plugin, new permission) must NOT be applied: the user has to update from the store first.
 */
export function canApplyOta(nativeVersion: string, bundle: OtaBundle, policyOtaMinNative?: string | null): { ok: boolean; reason?: string } {
  if (compareVersions(nativeVersion, bundle.minNativeVersion) < 0) return { ok: false, reason: `bundle needs native >= ${bundle.minNativeVersion}` };
  if (bundle.maxNativeVersion && compareVersions(nativeVersion, bundle.maxNativeVersion) > 0) return { ok: false, reason: `bundle supports native <= ${bundle.maxNativeVersion}` };
  if (policyOtaMinNative && compareVersions(nativeVersion, policyOtaMinNative) < 0) return { ok: false, reason: `OTA disabled below native ${policyOtaMinNative}` };
  return { ok: true };
}

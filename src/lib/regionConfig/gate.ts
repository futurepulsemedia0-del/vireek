/* ------------------------------------------------------------------ */
/*  regionConfig/gate — flag + per-account module entitlement           */
/*                                                                      */
/*  RULES                                                               */
/*   - The default region (US) is ALWAYS allowed: zero behaviour change */
/*     for existing US accounts, whatever the flag/entitlement say.     */
/*   - Any other region needs BOTH the feature flag AND the module      */
/*     entitlement. Both default OFF (unknown / loading = OFF).         */
/*   - Fail closed: anything unexpected resolves to "not allowed".      */
/*  Pure. Server enforcement for writes lives in the migration's RPCs;  */
/*  this gate decides what the CLIENT and new capabilities may use.     */
/* ------------------------------------------------------------------ */

import { DEFAULT_REGIONAL, type RegionalSettings } from '../regional';

export const REGION_CONFIG_FLAG = 'regional_config';
export const REGION_CONFIG_MODULE = 'regional_config';
export const DEFAULT_REGION_COUNTRY = 'US';
export const MODULE_KEY_RE = /^[a-z][a-z0-9_]{1,62}[a-z0-9]$/;

export type RegionAccessReason = 'default_region' | 'enabled' | 'flag_off' | 'not_entitled';
export interface RegionAccess { allowed: boolean; reason: RegionAccessReason }

export interface RegionAccessInput {
  country: string | null | undefined;
  flagEnabled: boolean | null | undefined;
  moduleEntitled: boolean | null | undefined;
}

export function resolveRegionAccess(i: RegionAccessInput): RegionAccess {
  const country = (i.country ?? DEFAULT_REGION_COUNTRY).toString().trim().toUpperCase() || DEFAULT_REGION_COUNTRY;
  if (country === DEFAULT_REGION_COUNTRY) return { allowed: true, reason: 'default_region' };
  if (i.flagEnabled !== true) return { allowed: false, reason: 'flag_off' };
  if (i.moduleEntitled !== true) return { allowed: false, reason: 'not_entitled' };
  return { allowed: true, reason: 'enabled' };
}

/**
 * Settings that NEW regional capabilities (TaxProvider, legal slots, consent hooks) may act on.
 * When access is denied they see the default US profile, so a non-default region can never leak
 * into new code paths before it is switched on. Existing regional.ts consumers are untouched.
 */
export function effectiveRegionForCapabilities(settings: RegionalSettings, access: RegionAccess): RegionalSettings {
  return access.allowed ? settings : DEFAULT_REGIONAL;
}

/** Parses the get_my_module_entitlements() RPC payload defensively. */
export function parseEntitledModules(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const v of raw) {
    const key = typeof v === 'string' ? v : (v && typeof v === 'object' ? (v as { module_key?: unknown }).module_key : null);
    if (typeof key === 'string' && MODULE_KEY_RE.test(key)) out.add(key);
  }
  return out;
}

// src/lib/native/appUpdate.ts — "update required / available" policy for the installed app.
// Policy comes from the app_release_policy table (get_app_release_policy RPC) and is cached, so a
// required update still holds offline while an unreachable server NEVER blocks field work.

import { supabase } from '@/lib/supabase';
import type { NativePlatform } from './platform';
import { compareVersions, isInRollout } from './releaseStaging';

export { compareVersions };

export interface ReleasePolicy {
  min_version: string;
  latest_version: string;
  store_url: string | null;
  message: string | null;
}

export type UpdateState =
  | { kind: 'none' }
  | { kind: 'soft'; latest: string; message: string | null; storeUrl: string | null }
  | { kind: 'force'; latest: string; message: string | null; storeUrl: string | null };

const CACHE_KEY = 'vireek:release-policy:v1';
const DISMISSED_KEY = 'vireek:update-dismissed';


export function evaluatePolicy(current: string, policy: ReleasePolicy | null, dismissedVersion: string | null): UpdateState {
  if (!policy) return { kind: 'none' };
  const base = { latest: policy.latest_version, message: policy.message, storeUrl: policy.store_url };
  if (compareVersions(current, policy.min_version) < 0) return { kind: 'force', ...base };
  if (compareVersions(current, policy.latest_version) < 0 && dismissedVersion !== policy.latest_version && isInRollout(bucket, policy.rollout_pct)) return { kind: 'soft', ...base };
  return { kind: 'none' };
}

export function readCachedPolicy(): ReleasePolicy | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as ReleasePolicy) : null;
  } catch {
    return null;
  }
}

export async function loadPolicy(platform: NativePlatform): Promise<ReleasePolicy | null> {
  try {
    let { data, error } = await supabase.rpc('get_app_release_policy_v2', { p_platform: platform });
    if (error) ({ data, error } = await supabase.rpc('get_app_release_policy', { p_platform: platform })); // older backend
    if (error) return readCachedPolicy();
    const row = (Array.isArray(data) ? data[0] : data) as ReleasePolicy | undefined;
    if (!row) return readCachedPolicy();
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(row));
    return row;
  } catch {
    return readCachedPolicy();
  }
}

export function readDismissedVersion(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function dismissVersion(version: string): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    /* private mode — the banner simply comes back next launch */
  }
}

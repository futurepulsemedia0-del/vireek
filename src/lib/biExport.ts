/**
 * BI export: client API.
 *
 * The browser never sees bucket secrets and never writes BI tables. It reads targets / schedules / runs /
 * reader logins through RLS (can_export_data) and asks the `bi-export-run` edge function to change anything.
 * Validators, labels and view names come from the SAME shared files the server uses.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  BI_INTERVAL_OPTIONS,
  BI_MODES,
  BI_MODE_META,
  BI_PII_MODE_META,
  BI_PII_MODES,
  BI_PROVIDERS,
  BI_PROVIDER_META,
  BI_VIEW_NAMES,
  biPiiViewName,
  biViewName,
  hasPii,
  type BiMode,
  type BiProvider,
} from '../../supabase/functions/_shared/exports/bi';
import { DATASETS, DATASET_KEYS, type DatasetKey, type PiiMode } from '../../supabase/functions/_shared/data-platform/catalog';

export {
  BI_INTERVAL_OPTIONS, BI_MODES, BI_MODE_META, BI_PII_MODE_META, BI_PII_MODES, BI_PROVIDERS, BI_PROVIDER_META, BI_VIEW_NAMES,
  biPiiViewName, biViewName, hasPii, DATASETS, DATASET_KEYS,
};
export type { BiMode, BiProvider, DatasetKey, PiiMode };

export interface BiTarget {
  id: string;
  name: string;
  provider: BiProvider;
  bucket: string;
  region: string;
  prefix: string;
  access_key_id: string;
  status: 'untested' | 'connected' | 'error';
  last_tested_at: string | null;
  last_error: string | null;
}

export interface BiSchedule {
  id: string;
  target_id: string;
  name: string;
  datasets: DatasetKey[];
  mode: BiMode;
  pii_mode: PiiMode;
  interval_minutes: number;
  enabled: boolean;
  next_run_at: string;
  locked_until: string | null;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
}

export interface BiRun {
  id: string;
  schedule_id: string | null;
  schedule_name: string;
  trigger: 'manual' | 'scheduled';
  status: 'running' | 'success' | 'partial' | 'failed';
  stats: { datasets?: Record<string, { rows: number; parts: number; bytes: number; complete: boolean }> };
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface BiReader {
  role_name: string;
  label: string;
  include_pii: boolean;
  created_at: string;
  revoked_at: string | null;
}

export class BiApiError extends Error {
  constructor(message: string, public fieldErrors: Record<string, string> = {}) {
    super(message);
  }
}

async function invoke<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke('bi-export-run', { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      try {
        const p = await error.context.json();
        if (p && typeof p.error === 'string') throw new BiApiError(p.error, p.errors && typeof p.errors === 'object' ? p.errors : {});
      } catch (e) {
        if (e instanceof BiApiError) throw e;
      }
    }
    throw new BiApiError(fallback);
  }
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string' && (data as { ok?: boolean }).ok !== false) {
    throw new BiApiError((data as { error: string }).error);
  }
  return data as T;
}

export interface SaveTargetInput {
  id?: string;
  name: string;
  provider: BiProvider;
  bucket: string;
  region: string;
  prefix: string;
  access_key_id: string;
  /** Empty while editing = keep the stored secret. */
  secret_access_key?: string;
}

export const saveTarget = (i: SaveTargetInput) =>
  invoke<{ id: string; signing_secret: string | null; signing_key_id: string }>({ action: 'save_target', ...i }, 'Could not save the destination.');
export const testTarget = (id: string) => invoke<{ ok: boolean; error?: string; cleaned_up?: boolean }>({ action: 'test_target', id }, 'Could not test the destination.');
export const deleteTarget = (id: string) => invoke<{ ok: true }>({ action: 'delete_target', id }, 'Could not delete the destination.');

export interface SaveScheduleInput {
  id?: string;
  name: string;
  target_id: string;
  datasets: DatasetKey[];
  mode: BiMode;
  pii_mode: PiiMode;
  interval_minutes: number;
  enabled: boolean;
}
export const saveSchedule = (i: SaveScheduleInput) => invoke<{ id: string }>({ action: 'save_schedule', ...i }, 'Could not save the schedule.');
export const deleteSchedule = (id: string) => invoke<{ ok: true }>({ action: 'delete_schedule', id }, 'Could not delete the schedule.');
export const runScheduleNow = (schedule_id: string) => invoke<{ ok: true }>({ action: 'run_now', schedule_id }, 'Could not start the delivery.');
export const rotateSigningSecret = () => invoke<{ signing_secret: string; signing_key_id: string }>({ action: 'rotate_signing' }, 'Could not rotate the signing secret.');

export interface NewReader {
  role_name: string;
  password: string;
  host: string;
  port: number;
  database: string;
  pooler_user: string;
}
export const createReader = (label: string, include_pii: boolean) => invoke<NewReader>({ action: 'create_reader', label, include_pii }, 'Could not create the login.');
export const revokeReader = (role_name: string) => invoke<{ ok: true }>({ action: 'revoke_reader', role_name }, 'Could not revoke the login.');

// ---------------- reads (RLS: owner or can_export_data) ----------------

export async function listTargets(ownerId: string): Promise<BiTarget[]> {
  const { data, error } = await supabase.from('bi_export_targets').select('id, name, provider, bucket, region, prefix, access_key_id, status, last_tested_at, last_error').eq('user_id', ownerId).order('created_at');
  if (error) throw error;
  return (data ?? []) as unknown as BiTarget[];
}
export async function listSchedules(ownerId: string): Promise<BiSchedule[]> {
  const { data, error } = await supabase.from('bi_export_schedules').select('id, target_id, name, datasets, mode, pii_mode, interval_minutes, enabled, next_run_at, locked_until, last_run_at, last_success_at, last_error, consecutive_failures').eq('user_id', ownerId).order('created_at');
  if (error) throw error;
  return (data ?? []) as unknown as BiSchedule[];
}
export async function listBiRuns(ownerId: string, limit = 25): Promise<BiRun[]> {
  const { data, error } = await supabase.from('bi_export_runs').select('id, schedule_id, schedule_name, trigger, status, stats, error, started_at, finished_at').eq('user_id', ownerId).order('started_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as BiRun[];
}
export async function listReaders(ownerId: string): Promise<BiReader[]> {
  const { data, error } = await supabase.from('bi_reader_roles').select('role_name, label, include_pii, created_at, revoked_at').eq('user_id', ownerId).is('revoked_at', null).order('created_at');
  if (error) throw error;
  return (data ?? []) as unknown as BiReader[];
}
export async function canExportPii(): Promise<boolean> {
  const { data, error } = await supabase.rpc('bi_can_export_pii');
  return !error && data === true;
}

export function useCanManageBi(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || permissions.can_export_data === true;
}
export function useBiOwnerId(): string | undefined {
  const { isOwner, profile, teamMember } = useAuth();
  return isOwner ? profile?.id : teamMember?.account_owner_id;
}

export const isRunning = (s: Pick<BiSchedule, 'locked_until'>, now = Date.now()): boolean => !!s.locked_until && new Date(s.locked_until).getTime() > now;

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Never';
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const intervalLabel = (m: number): string => BI_INTERVAL_OPTIONS.find((o) => o.value === m)?.label ?? `${m} min`;

/** Power BI "Blank query" for one view over a direct Postgres login. */
export function powerBiQuery(host: string, view: string): string {
  return `let\n  Source = PostgreSQL.Database("${host}:5432", "postgres"),\n  Data = Source{[Schema="public", Item="${view}"]}[Data]\nin\n  Data`;
}

/** Verification snippet customers can run on a downloaded part + manifest. */
export const VERIFY_SNIPPET = `# Verify a delivery (Python 3). Needs the signing secret shown when you connected the destination.
import hashlib, hmac, json, sys

def canonical(v):
    if isinstance(v, dict):
        return "{" + ",".join(json.dumps(k) + ":" + canonical(v[k]) for k in sorted(v)) + "}"
    if isinstance(v, list):
        return "[" + ",".join(canonical(x) for x in v) + "]"
    return json.dumps(v, separators=(",", ":"), ensure_ascii=False)

manifest = json.load(open("manifest.json"))
sig = manifest.pop("signature")
expected = hmac.new(SECRET.encode(), canonical(manifest).encode(), hashlib.sha256).hexdigest()
assert hmac.compare_digest(expected, sig["value"]), "manifest signature mismatch"
for p in manifest["parts"]:
    data = open(p["name"], "rb").read()
    assert len(data) == p["bytes"] and hashlib.sha256(data).hexdigest() == p["sha256"], p["name"]
print("OK", manifest["dataset"], manifest["row_count"], "rows")`;

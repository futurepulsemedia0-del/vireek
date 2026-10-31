/**
 * BI Connectors: client API.
 *
 * Same rules as the Data Platform: the browser never sees credentials or token hashes and never writes
 * the tables. It reads through RLS (can_export_data) and asks edge functions to change anything.
 * Constants and validators come from the shared server files, so the UI can never offer what the server rejects.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { ApiError, DATASETS, DATASET_KEYS, DEFAULT_DATASETS, PII_MODES, PII_MODE_META, type DatasetKey, type PiiMode } from '@/lib/dataPlatform';
import { EXPORT_INTERVALS, EXPORT_META, ROWS_PER_FILE_OPTIONS, type ExportKind } from '../../supabase/functions/_shared/bi/export';
import { entitySetName } from '../../supabase/functions/_shared/bi/odata';

export { ApiError, DATASETS, DATASET_KEYS, DEFAULT_DATASETS, PII_MODES, PII_MODE_META, EXPORT_INTERVALS, EXPORT_META, ROWS_PER_FILE_OPTIONS, entitySetName };
export type { DatasetKey, ExportKind, PiiMode };

export interface BiToken {
  id: string;
  name: string;
  token_hint: string;
  datasets: DatasetKey[];
  pii_mode: PiiMode;
  rate_limit_per_minute: number;
  expires_at: string | null;
  status: 'active' | 'revoked';
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface ExportTargetRow {
  id: string;
  kind: ExportKind;
  name: string;
  config: Record<string, unknown>;
  settings: Record<string, unknown>;
  status: 'connected' | 'error';
  auto_sync: boolean;
  interval_minutes: number;
  next_run_at: string;
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  locked_until: string | null;
  consecutive_failures: number;
  created_at: string;
}

export interface ExportRunRow {
  id: string;
  target_id: string;
  trigger: 'manual' | 'scheduled';
  mode: 'incremental' | 'snapshot' | 'full';
  status: 'running' | 'success' | 'partial' | 'failed';
  stats: Record<string, unknown>;
  error: string | null;
  manifest_key: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface RequestLogRow { id: number; token_id: string; at: string; dataset: string | null; rows: number | null; status: number | null }
export interface TestCheck { name: string; ok: boolean; detail: string }

export const EXPIRY_OPTIONS: { value: number | null; label: string }[] = [
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '180 days (recommended)' },
  { value: 365, label: '1 year' },
  { value: null, label: 'Never expires' },
];

// ---------------- edge function calls ----------------

async function readError(error: unknown, fallback: string): Promise<ApiError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = await error.context.json();
      if (payload && typeof payload.error === 'string') return new ApiError(payload.error, payload.errors && typeof payload.errors === 'object' ? payload.errors : {});
    } catch {
      /* keep fallback */
    }
  }
  return new ApiError(fallback);
}

async function invoke<T>(fn: string, body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) throw await readError(error, fallback);
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') throw new ApiError((data as { error: string }).error);
  return data as T;
}

export interface CreateTokenInput { name: string; datasets: DatasetKey[]; pii_mode: PiiMode; rate_limit_per_minute: number; expires_in_days: number | null }
export const createToken = (input: CreateTokenInput) => invoke<{ token: BiToken; secret: string }>('bi-admin', { action: 'create_token', ...input }, 'Could not create the token.');
export const revokeToken = (id: string) => invoke<{ ok: true }>('bi-admin', { action: 'revoke_token', id }, 'Could not revoke the token.');

export interface SaveTargetInput {
  id?: string;
  kind: ExportKind;
  name: string;
  config: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  settings: Record<string, unknown>;
  auto_sync: boolean;
  interval_minutes: number;
}
export const saveTarget = (input: SaveTargetInput) => invoke<{ target: ExportTargetRow }>('bi-admin', { action: 'save_export_target', ...input }, 'Could not save the export target.');
export const testTarget = (id: string) => invoke<{ ok: boolean; checks: TestCheck[] }>('bi-admin', { action: 'test_export_target', id }, 'Could not test the connection.');
export const deleteTarget = (id: string) => invoke<{ ok: true }>('bi-admin', { action: 'delete_export_target', id }, 'Could not delete the target.');
export const probeSftpHost = (host: string, port: string) => invoke<{ fingerprint: string }>('bi-admin', { action: 'probe_sftp_host', host, port }, 'Could not read the server’s host key.');
export const runTarget = (id: string, full = false) => invoke<{ run_id: string }>('bi-export-run', { action: 'run', target_id: id, full }, 'Could not start the export.');

// ---------------- reads (RLS; never select token_hash) ----------------

const TOKEN_COLS = 'id, name, token_hint, datasets, pii_mode, rate_limit_per_minute, expires_at, status, last_used_at, created_at, revoked_at';
const TARGET_COLS = 'id, kind, name, config, settings, status, auto_sync, interval_minutes, next_run_at, last_run_at, last_success_at, last_error, locked_until, consecutive_failures, created_at';
const RUN_COLS = 'id, target_id, trigger, mode, status, stats, error, manifest_key, started_at, finished_at';

export async function listTokens(ownerId: string): Promise<BiToken[]> {
  const { data, error } = await supabase.from('bi_access_tokens').select(TOKEN_COLS).eq('user_id', ownerId).order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as BiToken[];
}
export async function listTargets(ownerId: string): Promise<ExportTargetRow[]> {
  const { data, error } = await supabase.from('bi_export_targets').select(TARGET_COLS).eq('user_id', ownerId).order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as ExportTargetRow[];
}
export async function listExportRuns(ownerId: string, limit = 30): Promise<ExportRunRow[]> {
  const { data, error } = await supabase.from('bi_export_runs').select(RUN_COLS).eq('user_id', ownerId).order('started_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as ExportRunRow[];
}
export async function listRequests(ownerId: string, limit = 15): Promise<RequestLogRow[]> {
  const { data, error } = await supabase.from('bi_request_log').select('id, token_id, at, dataset, rows, status').eq('user_id', ownerId).order('at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as RequestLogRow[];
}

// ---------------- pure helpers ----------------

export const gatewayBase = (): string => `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '')}/functions/v1/bi-gateway`;

export const tokenState = (t: BiToken, now = Date.now()): 'active' | 'expired' | 'revoked' =>
  t.status === 'revoked' ? 'revoked' : t.expires_at && new Date(t.expires_at).getTime() <= now ? 'expired' : 'active';

export const isTargetRunning = (t: ExportTargetRow, now = Date.now()): boolean => !!t.locked_until && new Date(t.locked_until).getTime() > now;

export function describeExportStats(stats: Record<string, unknown>): string {
  const n = (k: string) => (typeof stats[k] === 'number' ? (stats[k] as number) : 0);
  const ds = stats.datasets as Record<string, { rows: number }> | undefined;
  const rows = ds ? Object.values(ds).reduce((a, d) => a + (d?.rows ?? 0), 0) : 0;
  if (!ds && !('files' in stats)) return '';
  const mb = n('bytes') / 1_048_576;
  return `${rows.toLocaleString()} row${rows === 1 ? '' : 's'} in ${n('files')} file${n('files') === 1 ? '' : 's'}${n('bytes') ? ` (${mb < 0.1 ? '<0.1' : mb.toFixed(1)} MB)` : ''}`;
}

export type WarehouseTool = 'bigquery' | 'snowflake' | 'postgres';

/** Least-privilege, read-only grants for the BI tool's own account on the customer's warehouse. */
export function readOnlyGrantSql(kind: WarehouseTool, o: { dataset: string; schema?: string; database?: string }): string {
  const ident = (v: string, fallback: string) => (/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(v) ? v : fallback);
  if (kind === 'bigquery') {
    const ds = ident(o.dataset, 'vireek');
    return `-- BigQuery: give your BI service account read-only access to the Vireek dataset only.
-- 1) Replace <project> and <bi-service-account>.
GRANT \`roles/bigquery.dataViewer\` ON SCHEMA \`<project>.${ds}\` TO "serviceAccount:<bi-service-account>";
-- 2) The account also needs permission to run queries in your project (not to see data):
--    IAM → grant "BigQuery Job User" to <bi-service-account> on <project>.`;
  }
  if (kind === 'snowflake') {
    const db = ident(o.database ?? '', 'ANALYTICS').toUpperCase();
    const sc = ident(o.schema ?? o.dataset, 'VIREEK').toUpperCase();
    return `-- Snowflake: a read-only role for Metabase / Looker / Power BI.
CREATE ROLE IF NOT EXISTS VIREEK_BI_READ;
GRANT USAGE ON DATABASE ${db} TO ROLE VIREEK_BI_READ;
GRANT USAGE ON SCHEMA ${db}.${sc} TO ROLE VIREEK_BI_READ;
GRANT SELECT ON ALL TABLES IN SCHEMA ${db}.${sc} TO ROLE VIREEK_BI_READ;
GRANT SELECT ON FUTURE TABLES IN SCHEMA ${db}.${sc} TO ROLE VIREEK_BI_READ;
GRANT USAGE ON WAREHOUSE <your_bi_warehouse> TO ROLE VIREEK_BI_READ;
GRANT ROLE VIREEK_BI_READ TO USER <bi_user>;`;
  }
  const sc = ident(o.schema ?? o.dataset, 'vireek');
  return `-- Postgres replica: a read-only login for Metabase / Looker / Power BI.
CREATE ROLE vireek_bi_read LOGIN PASSWORD '<generate-a-long-random-password>';
GRANT CONNECT ON DATABASE <your_database> TO vireek_bi_read;
GRANT USAGE ON SCHEMA ${sc} TO vireek_bi_read;
GRANT SELECT ON ALL TABLES IN SCHEMA ${sc} TO vireek_bi_read;
ALTER DEFAULT PRIVILEGES IN SCHEMA ${sc} GRANT SELECT ON TABLES TO vireek_bi_read;`;
}

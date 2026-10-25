/**
 * Data Platform: client API.
 *
 * The browser never sees credentials and never writes the Data Platform tables. It reads
 * destinations / runs / embeds through RLS (can_export_data) and asks edge functions to change
 * anything. Catalog, metric definitions and validators come from the SAME shared files the server
 * uses, so the UI can never offer something the server would reject.
 */

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  DATASETS,
  DATASET_KEYS,
  DEFAULT_DATASETS,
  PII_MODES,
  PII_MODE_META,
  allColumns,
  renderDataDictionaryMarkdown,
  type DatasetKey,
  type PiiMode,
} from '../../supabase/functions/_shared/data-platform/catalog';
import {
  DIMENSIONS,
  DIMENSION_LABELS,
  METRICS,
  METRIC_IDS,
  formatMetric,
  type Dimension,
  type Granularity,
  type MetricId,
  type MetricsResponse,
} from '../../supabase/functions/_shared/data-platform/metrics';
import {
  WAREHOUSE_KINDS,
  WAREHOUSE_META,
  tableRef,
  type WarehouseKind,
} from '../../supabase/functions/_shared/data-platform/warehouse';
import {
  MODELS,
  MODEL_KEYS,
  REVERSE_KINDS,
  REVERSE_META,
  type ModelKey,
  type ReverseDestinationKind,
} from '../../supabase/functions/_shared/data-platform/reverseEtl';
import type { EmbedConfig } from '../../supabase/functions/_shared/data-platform/embed';

export {
  DATASETS,
  DATASET_KEYS,
  DEFAULT_DATASETS,
  DIMENSIONS,
  DIMENSION_LABELS,
  METRICS,
  METRIC_IDS,
  MODELS,
  MODEL_KEYS,
  PII_MODES,
  PII_MODE_META,
  REVERSE_KINDS,
  REVERSE_META,
  WAREHOUSE_KINDS,
  WAREHOUSE_META,
  allColumns,
  formatMetric,
  renderDataDictionaryMarkdown,
  tableRef,
};
export type { DatasetKey, Dimension, EmbedConfig, Granularity, MetricId, MetricsResponse, ModelKey, PiiMode, ReverseDestinationKind, WarehouseKind };

export type DestinationKind = WarehouseKind | ReverseDestinationKind;

export interface Destination {
  id: string;
  role: 'warehouse' | 'reverse';
  kind: DestinationKind;
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

export interface SyncRun {
  id: string;
  destination_id: string;
  trigger: 'manual' | 'scheduled';
  mode: 'incremental' | 'full' | 'reverse';
  status: 'running' | 'success' | 'partial' | 'failed';
  stats: Record<string, unknown>;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface SyncState {
  destination_id: string;
  dataset: DatasetKey;
  watermark: string | null;
  rows_total: number;
  last_synced_at: string | null;
}

export interface EmbedRow {
  id: string;
  name: string;
  config: EmbedConfig;
  status: 'active' | 'revoked';
  rate_limit_per_minute: number;
  last_used_at: string | null;
  created_at: string;
}

export interface TestCheck { name: string; ok: boolean; detail: string }

export const INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 15, label: 'Every 15 minutes' },
  { value: 60, label: 'Hourly' },
  { value: 360, label: 'Every 6 hours' },
  { value: 1440, label: 'Daily' },
];

// ---------------- permissions ----------------

/** Same gate as the nav item, route and every server call (owner, or can_export_data). */
export function useCanManageDataPlatform(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || permissions.can_export_data === true;
}

/** Revenue and margin are billing-sensitive: same rule as Reports and Analytics. */
export function useCanViewMetrics(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || permissions.can_view_billing === true;
}

export function useDataPlatformOwnerId(): string | undefined {
  const { isOwner, profile, teamMember } = useAuth();
  return isOwner ? profile?.id : teamMember?.account_owner_id;
}

// ---------------- edge function calls ----------------

export class ApiError extends Error {
  constructor(message: string, public fieldErrors: Record<string, string> = {}) {
    super(message);
  }
}

async function readError(error: unknown, fallback: string): Promise<ApiError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const payload = await error.context.json();
      if (payload && typeof payload.error === 'string') {
        return new ApiError(payload.error, payload.errors && typeof payload.errors === 'object' ? payload.errors : {});
      }
    } catch {
      /* keep fallback */
    }
  }
  return new ApiError(fallback);
}

async function invoke<T>(fn: string, body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) throw await readError(error, fallback);
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') {
    throw new ApiError((data as { error: string }).error);
  }
  return data as T;
}

export interface SaveDestinationInput {
  id?: string;
  role: 'warehouse' | 'reverse';
  kind: DestinationKind;
  name: string;
  config: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  settings: Record<string, unknown>;
  auto_sync: boolean;
  interval_minutes: number;
}

export const saveDestination = (input: SaveDestinationInput) =>
  invoke<{ destination: Destination }>('data-platform-admin', { action: 'save_destination', ...input }, 'Could not save the destination.');

export const testDestination = (id: string) =>
  invoke<{ ok: boolean; checks: TestCheck[] }>('data-platform-admin', { action: 'test_destination', id }, 'Could not test the connection.');

export const deleteDestination = (id: string) =>
  invoke<{ ok: true }>('data-platform-admin', { action: 'delete_destination', id }, 'Could not delete the destination.');

export const runDestination = (id: string, full = false) =>
  invoke<{ run_id: string }>('data-platform-run', { action: 'run', destination_id: id, full }, 'Could not start the sync.');

export const refreshMetricHistory = () =>
  invoke<{ rows: number; skipped?: boolean }>('data-platform-run', { action: 'snapshots' }, 'Could not refresh metric history.');

export const createEmbed = (name: string, config: Partial<EmbedConfig>, rate_limit_per_minute?: number) =>
  invoke<{ embed: EmbedRow; signing_secret: string }>('data-platform-admin', { action: 'create_embed', name, config, rate_limit_per_minute }, 'Could not create the embed.');

export const updateEmbed = (id: string, patch: { name?: string; config?: Partial<EmbedConfig>; rate_limit_per_minute?: number }) =>
  invoke<{ embed: EmbedRow }>('data-platform-admin', { action: 'update_embed', id, ...patch }, 'Could not update the embed.');

export const rotateEmbedSecret = (id: string) =>
  invoke<{ signing_secret: string }>('data-platform-admin', { action: 'rotate_embed_secret', id }, 'Could not rotate the secret.');

export const revokeEmbed = (id: string) =>
  invoke<{ ok: true }>('data-platform-admin', { action: 'revoke_embed', id }, 'Could not revoke the embed.');

export interface MetricsRequest {
  metrics: MetricId[];
  from: string;
  to: string;
  granularity?: Granularity;
  groupBy?: Dimension | null;
  compare?: boolean;
}

export type MetricsPayload = MetricsResponse & { truncated: boolean; generated_at: string };

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export const queryMetrics = (req: MetricsRequest) =>
  invoke<MetricsPayload>('metrics-query', { ...req, tz: browserTimeZone() }, 'Could not load metrics.');

// ---------------- reads (RLS) ----------------

const DEST_COLS =
  'id, role, kind, name, config, settings, status, auto_sync, interval_minutes, next_run_at, last_run_at, last_success_at, last_error, locked_until, consecutive_failures, created_at';

export async function listDestinations(ownerId: string): Promise<Destination[]> {
  const { data, error } = await supabase.from('dp_destinations').select(DEST_COLS).eq('user_id', ownerId).order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as Destination[];
}

export async function listRuns(ownerId: string, limit = 30): Promise<SyncRun[]> {
  const { data, error } = await supabase
    .from('dp_runs')
    .select('id, destination_id, trigger, mode, status, stats, error, started_at, finished_at')
    .eq('user_id', ownerId)
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as SyncRun[];
}

export async function listSyncState(ownerId: string): Promise<SyncState[]> {
  const { data, error } = await supabase.from('dp_sync_state').select('destination_id, dataset, watermark, rows_total, last_synced_at').eq('user_id', ownerId);
  if (error) throw error;
  return (data ?? []) as unknown as SyncState[];
}

export async function listEmbeds(ownerId: string): Promise<EmbedRow[]> {
  const { data, error } = await supabase
    .from('dp_embeds')
    .select('id, name, config, status, rate_limit_per_minute, last_used_at, created_at')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as EmbedRow[];
}

// ---------------- pure helpers ----------------

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Never';
  const mins = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function isRunning(d: Destination, now = Date.now()): boolean {
  return !!d.locked_until && new Date(d.locked_until).getTime() > now;
}

export const destinationLabel = (kind: DestinationKind): string =>
  (WAREHOUSE_META as Record<string, { label: string }>)[kind]?.label ?? (REVERSE_META as Record<string, { label: string }>)[kind]?.label ?? kind;

/** "12,345 rows across 6 tables" style summary of a run's stats. */
export function describeRunStats(stats: Record<string, unknown>): string {
  const ds = stats.datasets as Record<string, { rows: number }> | undefined;
  if (ds) {
    const total = Object.values(ds).reduce((a, d) => a + (d?.rows ?? 0), 0);
    return `${total.toLocaleString()} row${total === 1 ? '' : 's'} across ${Object.keys(ds).length} table${Object.keys(ds).length === 1 ? '' : 's'}`;
  }
  const n = (k: string) => (typeof stats[k] === 'number' ? (stats[k] as number) : 0);
  if ('sent' in stats) {
    const skipped = n('skipped_no_consent') + n('skipped_no_email');
    return `${n('sent').toLocaleString()} sent${skipped ? `, ${skipped.toLocaleString()} skipped (no consent or email)` : ''}${n('failed') ? `, ${n('failed')} failed` : ''}`;
  }
  if ('rows' in stats) return `${n('rows').toLocaleString()} row${n('rows') === 1 ? '' : 's'} written${stats.truncated ? ' (truncated)' : ''}`;
  return '';
}

export function downloadText(filename: string, text: string, mime = 'text/markdown'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Where the static embed page lives, relative to the deployed app. */
export const EMBED_PAGE_PATH = '/embed/analytics.html';

export function embedSnippets(supabaseFunctionsBase: string, origin: string, embedId: string): { node: string; python: string; html: string } {
  const node = `// Node.js (server side — never in the browser)
import { createHmac } from 'node:crypto';

const EMBED_ID = '${embedId}';
const SECRET = process.env.VIREEK_EMBED_SECRET; // shown once when you create the embed

export function vireekEmbedUrl({ viewer, filters } = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = { eid: EMBED_ID, iat, exp: iat + 3600, ...(viewer ? { sub: viewer } : {}), ...(filters ? { filters } : {}) };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update('v1.' + body).digest('base64url');
  return '${origin}${EMBED_PAGE_PATH}#token=v1.' + body + '.' + sig;
}`;
  const python = `# Python (server side)
import base64, hashlib, hmac, json, os, time

EMBED_ID = "${embedId}"
SECRET = os.environ["VIREEK_EMBED_SECRET"].encode()

def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def vireek_embed_url(viewer=None, filters=None):
    iat = int(time.time())
    payload = {"eid": EMBED_ID, "iat": iat, "exp": iat + 3600}
    if viewer: payload["sub"] = viewer
    if filters: payload["filters"] = filters
    body = b64url(json.dumps(payload, separators=(",", ":")).encode())
    sig = b64url(hmac.new(SECRET, ("v1." + body).encode(), hashlib.sha256).digest())
    return "${origin}${EMBED_PAGE_PATH}#token=v1." + body + "." + sig`;
  const html = `<iframe
  src="<URL returned by your server>"
  title="Analytics"
  loading="lazy"
  style="width:100%;height:560px;border:0;border-radius:12px"
  referrerpolicy="no-referrer"></iframe>
<!-- API (JSON): POST ${supabaseFunctionsBase}/analytics-embed  with  Authorization: Bearer <token> -->`;
  return { node, python, html };
}

/** Dashboard snapshots — Supabase access. Pure logic lives in dashboardSnapshot.ts. */

import { supabase } from '@/lib/supabase';
import {
  buildPayload,
  periodFromDays,
  sanitizePayload,
  type CallRow,
  type JobRow,
  type LeadRow,
  type SnapshotOptions,
  type SnapshotPayload,
  type SnapshotSource,
} from '@/lib/dashboardSnapshot';

const PAGE = 1000;
const MAX_PAGES = 20; // 20k rows per table; beyond that we refuse rather than publish wrong numbers

async function fetchAll<T>(table: 'calls' | 'jobs' | 'leads', columns: string, dateColumn: string, sinceIso: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .gte(dateColumn, sinceIso)
      .order(dateColumn, { ascending: true })
      .order('id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`Could not load ${table}: ${error.message}`);
    const batch = (data ?? []) as unknown as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
  throw new Error(`Too many ${table} in this period to snapshot accurately. Choose a shorter period.`);
}

export async function loadSnapshotSource(periodDays: number): Promise<SnapshotSource> {
  const since = new Date(periodFromDays(periodDays).startMs).toISOString();
  const [calls, jobs, leads] = await Promise.all([
    fetchAll<CallRow>('calls', 'call_datetime, status, is_emergency, sentiment, lead_source', 'call_datetime', since),
    fetchAll<JobRow>('jobs', 'created_at, job_status, invoice_status, invoice_amount', 'created_at', since),
    fetchAll<LeadRow>('leads', 'created_at, stage', 'created_at', since),
  ]);
  return { calls, jobs, leads };
}

export interface CreatedSnapshot {
  id: string;
  token: string;
  expiresAt: string;
  payload: SnapshotPayload;
}

export async function createSnapshot(options: SnapshotOptions): Promise<CreatedSnapshot> {
  const source = await loadSnapshotSource(options.periodDays);
  const payload = buildPayload(source, options.widgetKeys, periodFromDays(options.periodDays));
  const { data, error } = await supabase.rpc('create_dashboard_snapshot', {
    p_title: options.title,
    p_audience: options.audience || null,
    p_widget_keys: options.widgetKeys,
    p_payload: payload,
    p_period_days: options.periodDays,
    p_expiry_days: options.expiryDays,
  });
  if (error) throw new Error(error.message || 'Could not create the snapshot.');
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.token || !row?.snapshot_id) throw new Error('Could not create the snapshot.');
  return { id: row.snapshot_id, token: row.token, expiresAt: row.expires_at, payload };
}

export interface SnapshotListItem {
  id: string;
  title: string;
  audience: string | null;
  widget_keys: string[];
  payload: unknown;
  period_days: number;
  expires_at: string;
  revoked_at: string | null;
  view_count: number;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  created_at: string;
}

export async function listSnapshots(): Promise<SnapshotListItem[]> {
  const { data, error } = await supabase
    .from('dashboard_snapshots')
    .select('id, title, audience, widget_keys, payload, period_days, expires_at, revoked_at, view_count, first_viewed_at, last_viewed_at, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as SnapshotListItem[];
}

export interface SnapshotView {
  id: string;
  viewed_at: string;
  user_agent: string | null;
}

export async function listSnapshotViews(snapshotId: string): Promise<SnapshotView[]> {
  const { data, error } = await supabase
    .from('dashboard_snapshot_views')
    .select('id, viewed_at, user_agent')
    .eq('snapshot_id', snapshotId)
    .order('viewed_at', { ascending: false })
    .limit(25);
  if (error) throw new Error(error.message);
  return (data ?? []) as SnapshotView[];
}

export async function revokeSnapshot(id: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_dashboard_snapshot', { p_id: id });
  if (error) throw new Error(error.message || 'Could not revoke the snapshot.');
}

export interface PublicSnapshot {
  title: string;
  audience: string | null;
  businessName: string;
  createdAt: string;
  expiresAt: string;
  payload: SnapshotPayload;
}

/** Null for unknown, expired or revoked links — the caller cannot tell which. */
export async function fetchPublicSnapshot(token: string): Promise<PublicSnapshot | null> {
  const { data, error } = await supabase.rpc('get_dashboard_snapshot', { p_token: token });
  if (error || !data) return null;
  const payload = sanitizePayload((data as { payload?: unknown }).payload);
  if (!payload) return null;
  const d = data as Record<string, unknown>;
  return {
    title: String(d.title ?? '').slice(0, 80),
    audience: d.audience ? String(d.audience).slice(0, 80) : null,
    businessName: String(d.business_name ?? '').slice(0, 120),
    createdAt: String(d.created_at ?? ''),
    expiresAt: String(d.expires_at ?? ''),
    payload,
  };
}

export async function recordSnapshotView(token: string): Promise<void> {
  await supabase.rpc('record_dashboard_snapshot_view', { p_token: token, p_user_agent: navigator.userAgent.slice(0, 160) });
}

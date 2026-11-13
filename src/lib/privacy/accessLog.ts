// Client API for the sensitive-read access log. All data comes from SECURITY DEFINER RPCs
// (the log table itself is not readable by clients). No content is ever sent or received here.
import { supabase } from '@/lib/supabase';

export type AccessAssetClass = 'call_recording' | 'transcript' | 'customer_pii' | 'payment_data' | 'document' | 'export';
export type AccessViewerKind = 'user' | 'vireek_support' | 'api_key' | 'system' | 'public_link';

export interface AccessHistoryRow {
  occurredAt: string;
  viewerKind: AccessViewerKind;
  viewerEmail: string | null;
  assetClass: AccessAssetClass;
  action: string;
  channel: string;
  recordCount: number;
  isYou: boolean;
}
export interface StaffTrailRow { occurredAt: string; event: string; assetClass: string | null; recordCount: number | null }
export type AlertRule = 'bulk_scraping' | 'off_hours_spike' | 'former_employee_access' | 'export_volume';
export interface AccessAlert {
  id: string; rule: AlertRule; severity: 'medium' | 'high' | 'critical'; observed: number; threshold: number;
  windowStart: string; windowEnd: string; status: 'open' | 'acknowledged' | 'dismissed'; createdAt: string;
}
export interface SensitiveCall { recordingUrl: string | null; transcript: string | null }

export type AccessErrorKind = 'forbidden' | 'rate_limited' | 'unauthenticated' | 'step_up_required' | 'unknown';
export class AccessLogError extends Error {
  readonly kind: AccessErrorKind;
  constructor(kind: AccessErrorKind) { super(kind); this.name = 'AccessLogError'; this.kind = kind; }
}

const ASSETS: readonly string[] = ['call_recording', 'transcript', 'customer_pii', 'payment_data', 'document', 'export'];
const VIEWERS: readonly string[] = ['user', 'vireek_support', 'api_key', 'system', 'public_link'];
const RULES: readonly string[] = ['bulk_scraping', 'off_hours_spike', 'former_employee_access', 'export_volume'];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export function classifyAccessError(err: { code?: string; message?: string } | null): AccessLogError {
  switch (err?.code) {
    case '42501': return new AccessLogError('forbidden');
    case 'SR429': return new AccessLogError('rate_limited');
    case 'SR401': return new AccessLogError('step_up_required');
    case '28000': return new AccessLogError('unauthenticated');
    default: return new AccessLogError('unknown');
  }
}

export function parseAccessHistory(data: unknown): AccessHistoryRow[] {
  if (!Array.isArray(data)) return [];
  const out: AccessHistoryRow[] = [];
  for (const r of data) {
    if (!isRec(r)) continue;
    const asset = str(r.asset_class), viewer = str(r.viewer_kind), at = str(r.occurred_at);
    if (!at || !asset || !ASSETS.includes(asset) || !viewer || !VIEWERS.includes(viewer)) continue;
    out.push({
      occurredAt: at, viewerKind: viewer as AccessViewerKind, viewerEmail: str(r.viewer_email), assetClass: asset as AccessAssetClass,
      action: str(r.action) ?? 'view', channel: str(r.channel) ?? 'rpc', recordCount: num(r.record_count) || 1, isYou: r.is_you === true,
    });
  }
  return out;
}

export function parseStaffTrail(data: unknown): StaffTrailRow[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((r): StaffTrailRow[] => {
    if (!isRec(r)) return [];
    const at = str(r.occurred_at), ev = str(r.event);
    return at && ev ? [{ occurredAt: at, event: ev, assetClass: str(r.asset_class), recordCount: typeof r.record_count === 'number' ? r.record_count : null }] : [];
  });
}

export function parseAlerts(data: unknown): AccessAlert[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((r): AccessAlert[] => {
    if (!isRec(r)) return [];
    const id = str(r.id), rule = str(r.rule), sev = str(r.severity), status = str(r.status);
    if (!id || !rule || !RULES.includes(rule) || !sev || !status) return [];
    return [{
      id, rule: rule as AlertRule, severity: sev as AccessAlert['severity'], observed: num(r.observed), threshold: num(r.threshold),
      windowStart: str(r.window_start) ?? '', windowEnd: str(r.window_end) ?? '', status: status as AccessAlert['status'], createdAt: str(r.created_at) ?? '',
    }];
  });
}

/** Protected read of recording + transcript. The read is logged inside the same DB transaction. */
export async function readCallSensitive(callId: string): Promise<SensitiveCall | null> {
  const { data, error } = await supabase.rpc('read_call_sensitive', { p_call_id: callId });
  if (error) throw classifyAccessError(error);
  const row = Array.isArray(data) ? data[0] : null;
  if (!isRec(row)) return null;
  return { recordingUrl: str(row.recording_url), transcript: str(row.transcript) };
}

/**
 * Server-side call search over name / phone / summary / transcript. Every token must match.
 * Returns call ids only (no content); the database logs the match as one aggregated read.
 */
export async function searchCallsText(tokens: string[]): Promise<string[]> {
  const clean = tokens.map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 8);
  if (clean.length === 0) return [];
  const { data, error } = await supabase.rpc('search_calls_text', { p_tokens: clean });
  if (error) throw classifyAccessError(error);
  return Array.isArray(data) ? data.filter((id): id is string => typeof id === 'string') : [];
}

export async function fetchAccessHistory(targetTable: string, targetId: string, before?: string): Promise<AccessHistoryRow[]> {
  const { data, error } = await supabase.rpc('list_sensitive_access_history', {
    p_target_table: targetTable, p_target_id: targetId, p_limit: 50, p_before: before ?? null,
  });
  if (error) throw classifyAccessError(error);
  return parseAccessHistory(data);
}

export async function fetchStaffAccessTrail(): Promise<StaffTrailRow[]> {
  const { data, error } = await supabase.rpc('list_staff_access_trail', { p_limit: 100, p_before: null });
  if (error) throw classifyAccessError(error);
  return parseStaffTrail(data);
}

export async function fetchOpenAlerts(): Promise<AccessAlert[]> {
  const { data, error } = await supabase.from('sensitive_read_alerts')
    .select('id, rule, severity, observed, threshold, window_start, window_end, status, created_at')
    .order('created_at', { ascending: false }).limit(50);
  if (error) throw classifyAccessError(error);
  return parseAlerts(data);
}

export async function setAlertStatus(id: string, status: 'acknowledged' | 'dismissed'): Promise<void> {
  const { error } = await supabase.rpc('set_sensitive_read_alert_status', { p_alert_id: id, p_status: status });
  if (error) throw classifyAccessError(error);
}

export async function setViewerVisibility(show: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_sensitive_read_viewer_visibility', { p_show: show });
  if (error) throw classifyAccessError(error);
}

export async function fetchViewerVisibility(): Promise<boolean> {
  const { data, error } = await supabase.from('sensitive_read_settings').select('show_viewers_to_team').maybeSingle();
  if (error) throw classifyAccessError(error);
  return isRec(data) && data.show_viewers_to_team === true;
}

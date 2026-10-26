/**
 * Enterprise Value & Exit-Readiness — data access (owner only).
 *
 * Everything is RLS + owner-gated in the database (exit_is_owner()); nothing here widens that.
 * Reuses the Data Quality Center score. Metrics come from one RPC (exit_get_metrics) that reads the
 * account's own accounting, memberships, payroll, SOP and credential data.
 */

import { supabase } from '@/lib/supabase';
import { buildDataHealth } from '@/lib/dataQualityApi';
import { generateToken, sha256Hex } from '@/lib/speedToLead';
import { getPublicOrigin } from '@/lib/appOrigin';
import {
  DEFAULT_SETTINGS,
  type ActionStatus,
  type AddBack,
  type AddBackKind,
  type DriverKey,
  type ExitMetrics,
  type ExitSettings,
  type IndustryKey,
  type MultipleRange,
  type SnapshotLite,
  type ValuationMethod,
} from '@/lib/exitReadiness';

interface PgError {
  message?: string;
  code?: string;
}

/** Only messages raised by our own RPCs (22023 / 53400 / 54000) are shown; anything else gets the fallback. */
function toError(e: PgError | null, fallback: string): Error {
  if (e?.code === '42501') return new Error('Only the account owner can use Exit Readiness.');
  if (e?.code && ['22023', '53400', '54000', 'P0002'].includes(e.code) && e.message) return new Error(e.message);
  if (e?.code === '23514') return new Error('One of the values is outside the allowed range.');
  return new Error(fallback);
}

// ------------------------------------------------------------------ metrics + data quality

export async function fetchMetrics(): Promise<ExitMetrics> {
  const { data, error } = await supabase.rpc('exit_get_metrics');
  if (error) throw toError(error, 'Could not load your business metrics.');
  return data as ExitMetrics;
}

/** Data Quality Center score; null when it cannot be computed (the driver is then left out). */
export async function fetchDataQualityScore(): Promise<number | null> {
  try {
    return (await buildDataHealth()).score;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ settings

interface SettingsRow {
  industry_key: IndustryKey;
  method: ValuationMethod;
  sde_low: number | null; sde_mid: number | null; sde_high: number | null;
  ebitda_low: number | null; ebitda_mid: number | null; ebitda_high: number | null;
  owner_market_salary_cents: number | string;
  owner_weekly_hours: number | string | null;
  readiness_adjusts: boolean;
}

const range = (l: number | null, m: number | null, h: number | null): MultipleRange | null =>
  l !== null && m !== null && h !== null ? { low: Number(l), mid: Number(m), high: Number(h) } : null;

export async function fetchSettings(ownerId: string): Promise<ExitSettings> {
  const { data, error } = await supabase
    .from('exit_readiness_settings')
    .select('industry_key, method, sde_low, sde_mid, sde_high, ebitda_low, ebitda_mid, ebitda_high, owner_market_salary_cents, owner_weekly_hours, readiness_adjusts')
    .eq('account_owner_id', ownerId)
    .maybeSingle();
  if (error) throw toError(error, 'Could not load your settings.');
  if (!data) return DEFAULT_SETTINGS;
  const r = data as unknown as SettingsRow;
  return {
    industryKey: r.industry_key,
    method: r.method,
    sdeMultiple: range(r.sde_low, r.sde_mid, r.sde_high),
    ebitdaMultiple: range(r.ebitda_low, r.ebitda_mid, r.ebitda_high),
    ownerMarketSalaryCents: Number(r.owner_market_salary_cents),
    ownerWeeklyHours: r.owner_weekly_hours === null ? null : Number(r.owner_weekly_hours),
    readinessAdjusts: r.readiness_adjusts,
  };
}

export async function saveSettings(ownerId: string, s: ExitSettings): Promise<void> {
  const { error } = await supabase.from('exit_readiness_settings').upsert(
    {
      account_owner_id: ownerId,
      industry_key: s.industryKey,
      method: s.method,
      sde_low: s.sdeMultiple?.low ?? null,
      sde_mid: s.sdeMultiple?.mid ?? null,
      sde_high: s.sdeMultiple?.high ?? null,
      ebitda_low: s.ebitdaMultiple?.low ?? null,
      ebitda_mid: s.ebitdaMultiple?.mid ?? null,
      ebitda_high: s.ebitdaMultiple?.high ?? null,
      owner_market_salary_cents: Math.max(0, Math.round(s.ownerMarketSalaryCents)),
      owner_weekly_hours: s.ownerWeeklyHours,
      readiness_adjusts: s.readinessAdjusts,
    },
    { onConflict: 'account_owner_id' },
  );
  if (error) throw toError(error, 'Could not save your settings.');
}

// ------------------------------------------------------------------ add-backs

interface AddBackRow {
  id: string;
  kind: AddBackKind;
  label: string;
  amount_cents: number | string;
  justification: string;
  evidence_ref: string | null;
  active: boolean;
}

export async function fetchAddBacks(ownerId: string): Promise<AddBack[]> {
  const { data, error } = await supabase
    .from('exit_addbacks')
    .select('id, kind, label, amount_cents, justification, evidence_ref, active')
    .eq('account_owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw toError(error, 'Could not load your add-backs.');
  return ((data ?? []) as unknown as AddBackRow[]).map((r) => ({
    id: r.id, kind: r.kind, label: r.label, amountCents: Number(r.amount_cents),
    justification: r.justification, evidenceRef: r.evidence_ref, active: r.active,
  }));
}

export async function createAddBack(
  ownerId: string,
  input: { kind: AddBackKind; label: string; amountCents: number; justification: string; evidenceRef: string },
): Promise<void> {
  const { error } = await supabase.from('exit_addbacks').insert({
    account_owner_id: ownerId,
    kind: input.kind,
    label: input.label.trim(),
    amount_cents: input.amountCents,
    justification: input.justification.trim(),
    evidence_ref: input.evidenceRef.trim() || null,
  });
  if (error) throw toError(error, 'Could not save the add-back.');
}

export async function setAddBackActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('exit_addbacks').update({ active }).eq('id', id);
  if (error) throw toError(error, 'Could not update the add-back.');
}

export async function deleteAddBack(id: string): Promise<void> {
  const { error } = await supabase.from('exit_addbacks').delete().eq('id', id);
  if (error) throw toError(error, 'Could not delete the add-back.');
}

// ------------------------------------------------------------------ snapshots + action states

interface SnapshotRow {
  period_month: string;
  readiness_score: number | string | null;
  value_point_cents: number | string | null;
  driver_scores: Partial<Record<DriverKey, number | null>> | null;
}

export async function fetchSnapshots(ownerId: string): Promise<SnapshotLite[]> {
  const { data, error } = await supabase
    .from('exit_snapshots')
    .select('period_month, readiness_score, value_point_cents, driver_scores')
    .eq('account_owner_id', ownerId)
    .order('period_month', { ascending: true })
    .limit(60);
  if (error) throw toError(error, 'Could not load your KPI history.');
  return ((data ?? []) as unknown as SnapshotRow[]).map((r) => ({
    periodMonth: r.period_month,
    readinessScore: r.readiness_score === null ? null : Number(r.readiness_score),
    valuePointCents: r.value_point_cents === null ? null : Number(r.value_point_cents),
    driverScores: r.driver_scores ?? {},
  }));
}

export async function saveSnapshot(input: {
  score: number | null;
  lowCents: number;
  pointCents: number;
  highCents: number;
  driverScores: Partial<Record<DriverKey, number | null>>;
  metrics: ExitMetrics;
}): Promise<void> {
  const { error } = await supabase.rpc('exit_save_snapshot', {
    p_period: new Date().toISOString().slice(0, 10),
    p_score: input.score,
    p_low: input.lowCents,
    p_point: input.pointCents,
    p_high: input.highCents,
    p_driver_scores: input.driverScores,
    p_metrics: input.metrics,
  });
  if (error) throw toError(error, 'Could not save this month’s snapshot.');
}

export async function fetchActionStates(ownerId: string): Promise<Record<string, ActionStatus>> {
  const { data, error } = await supabase
    .from('exit_action_states')
    .select('action_key, status')
    .eq('account_owner_id', ownerId);
  if (error) throw toError(error, 'Could not load action progress.');
  const out: Record<string, ActionStatus> = {};
  for (const r of (data ?? []) as unknown as { action_key: string; status: ActionStatus }[]) out[r.action_key] = r.status;
  return out;
}

export async function setActionState(ownerId: string, key: string, status: ActionStatus): Promise<void> {
  const { error } = await supabase
    .from('exit_action_states')
    .upsert({ account_owner_id: ownerId, action_key: key, status }, { onConflict: 'account_owner_id,action_key' });
  if (error) throw toError(error, 'Could not update the action.');
}

// ------------------------------------------------------------------ data room (owner side)

export interface DataRoomLink {
  id: string;
  packageId: string;
  label: string;
  recipientLabel: string | null;
  tokenHint: string;
  expiresAt: string;
  maxViews: number;
  viewCount: number;
  lastViewedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  sections: string[];
}

export interface AccessLogEntry {
  id: string;
  linkId: string | null;
  outcome: 'granted' | 'expired' | 'revoked' | 'exhausted' | 'invalid_token';
  userAgent: string | null;
  accessedAt: string;
}

export async function fetchLinks(ownerId: string): Promise<DataRoomLink[]> {
  const { data, error } = await supabase
    .from('exit_dataroom_links')
    .select('id, package_id, recipient_label, token_hint, expires_at, max_views, view_count, last_viewed_at, revoked_at, created_at, exit_dataroom_packages(label, sections)')
    .eq('account_owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw toError(error, 'Could not load data-room links.');
  type Row = {
    id: string; package_id: string; recipient_label: string | null; token_hint: string; expires_at: string;
    max_views: number; view_count: number; last_viewed_at: string | null; revoked_at: string | null; created_at: string;
    exit_dataroom_packages: { label: string; sections: string[] } | { label: string; sections: string[] }[] | null;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => {
    const pkg = Array.isArray(r.exit_dataroom_packages) ? r.exit_dataroom_packages[0] : r.exit_dataroom_packages;
    return {
      id: r.id, packageId: r.package_id, label: pkg?.label ?? 'Data room', sections: pkg?.sections ?? [],
      recipientLabel: r.recipient_label, tokenHint: r.token_hint, expiresAt: r.expires_at, maxViews: r.max_views,
      viewCount: r.view_count, lastViewedAt: r.last_viewed_at, revokedAt: r.revoked_at, createdAt: r.created_at,
    };
  });
}

export async function fetchAccessLogs(ownerId: string): Promise<AccessLogEntry[]> {
  const { data, error } = await supabase
    .from('exit_dataroom_access_logs')
    .select('id, link_id, outcome, user_agent, accessed_at')
    .eq('account_owner_id', ownerId)
    .order('accessed_at', { ascending: false })
    .limit(200);
  if (error) throw toError(error, 'Could not load the access log.');
  return ((data ?? []) as unknown as { id: string; link_id: string | null; outcome: AccessLogEntry['outcome']; user_agent: string | null; accessed_at: string }[]).map(
    (r) => ({ id: r.id, linkId: r.link_id, outcome: r.outcome, userAgent: r.user_agent, accessedAt: r.accessed_at }),
  );
}

export function dataRoomUrl(token: string): string {
  // The token lives in the URL fragment so it is never sent to a server or leaked in a Referer header.
  return `${getPublicOrigin()}/data-room#${token}`;
}

export async function createDataRoom(input: {
  label: string;
  sections: string[];
  recipient: string;
  expiresHours: number;
  maxViews: number;
  includeNames: boolean;
  valuation: Record<string, unknown> | null;
}): Promise<{ url: string; expiresAt: string }> {
  const token = generateToken();
  const { data, error } = await supabase.rpc('exit_create_data_room', {
    p_label: input.label.trim(),
    p_sections: input.sections,
    p_recipient: input.recipient.trim() || null,
    p_expires_hours: input.expiresHours,
    p_max_views: input.maxViews,
    p_include_names: input.includeNames,
    p_valuation: input.valuation,
    p_token_hash: await sha256Hex(token),
    p_token_hint: token.slice(-4),
  });
  if (error) throw toError(error, 'Could not create the data room.');
  return { url: dataRoomUrl(token), expiresAt: (data as { expiresAt: string }).expiresAt };
}

export async function revokeLink(linkId: string): Promise<void> {
  const { error } = await supabase.rpc('exit_revoke_link', { p_link_id: linkId });
  if (error) throw toError(error, 'Could not revoke the link.');
}

// ------------------------------------------------------------------ data room (buyer side)

export interface PublicDataRoom {
  label: string;
  expiresAt: string;
  viewsRemaining: number;
  content: {
    generatedAt: string;
    disclaimer: string;
    sections: Record<string, unknown>;
  };
}

export type OpenResult = { ok: true; room: PublicDataRoom } | { ok: false; reason: 'unavailable' | 'rate_limited' | 'error' };

export async function openDataRoom(token: string): Promise<OpenResult> {
  const { data, error } = await supabase.functions.invoke('exit-dataroom-public', { body: { token } });
  if (error) {
    const status = (error as { context?: { status?: number } }).context?.status;
    if (status === 404) return { ok: false, reason: 'unavailable' };
    if (status === 429) return { ok: false, reason: 'rate_limited' };
    return { ok: false, reason: 'error' };
  }
  return { ok: true, room: data as PublicDataRoom };
}

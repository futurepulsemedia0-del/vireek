/**
 * Playbook Library — client library.
 *
 * Catalog + rules:   supabase/functions/_shared/playbooks/*  (pure, shared with the scheduler)
 * Tables + RPCs:     supabase/migrations/20280415000000_playbook_library.sql
 * Scheduler/signals: supabase/functions/playbook-tick
 *
 * Every write goes through a SECURITY DEFINER RPC that re-validates the definition server-side.
 * Nothing here is a trust boundary; it only shapes the UX.
 */

import { supabase } from '@/lib/supabase';
import { PLAYBOOKS, findPlaybook } from '../../supabase/functions/_shared/playbooks/catalog';
import {
  buildDiff, defaultEnabledIds, detectConflicts, filterPlaybooks, requiresApproval, resolveWindow,
  suggestPlaybooks, validateSelection,
} from '../../supabase/functions/_shared/playbooks/engine';
import type {
  ActivationStatus, CurrentState, DiffRow, Playbook,
} from '../../supabase/functions/_shared/playbooks/types';

export * from '../../supabase/functions/_shared/playbooks/types';
export {
  PLAYBOOKS, findPlaybook, buildDiff, defaultEnabledIds, detectConflicts, filterPlaybooks, requiresApproval,
  resolveWindow, suggestPlaybooks, validateSelection,
};

export interface ActivationRow {
  id: string;
  playbook_key: string;
  playbook_version: number;
  playbook_name: string;
  source: 'library' | 'custom';
  trigger_source: 'manual' | 'scheduled' | 'signal';
  signal: Record<string, unknown>;
  status: ActivationStatus;
  definition: Playbook;
  enabled_item_ids: string[];
  starts_at: string;
  ends_at: string;
  suggest_expires_at: string | null;
  applied_at: string | null;
  rolled_back_at: string | null;
  rollback_reason: string | null;
  created_at: string;
}

export interface ActivationItemRow {
  id: string;
  activation_id: string;
  position: number;
  item_id: string;
  kind: string;
  title: string;
  status: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  note: string | null;
}

export interface AuditRow { id: number; activation_id: string | null; playbook_key: string | null; event: string; actor_type: string; detail: Record<string, unknown>; created_at: string }
export interface CustomPlaybookRow { id: string; user_id: string; key: string; name: string; version: number; definition: Playbook; shared_group_id: string | null; updated_at: string }
export interface BannerInfo { id: string; playbookKey: string; name: string; endsAt: string; activeCount: number; canManage: boolean }

export type RpcResult = {
  status: string;
  activation_id?: string;
  error?: string;
  idempotent?: boolean;
  dry_run?: boolean;
  items?: { item_id: string; kind: string; status: string; before?: Record<string, unknown>; after?: Record<string, unknown>; note?: string | null }[];
  conflicts?: { item_id: string; surface: string; playbook_key: string; playbook_name: string; activation_id: string }[];
};

function newRequestId(): string {
  return crypto.randomUUID();
}

async function rpc<T = RpcResult>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args as never);
  if (error) throw new Error(error.message);
  return data as T;
}

// ---------------------------------------------------------------- reads

export const fetchCurrentState = () => rpc<CurrentState & { trade: string | null }>('playbook_current_state');
export const fetchBanner = () => rpc<BannerInfo | null>('playbook_banner');

export async function fetchActivations(): Promise<ActivationRow[]> {
  const { data, error } = await supabase.from('playbook_activations').select('*').order('created_at', { ascending: false }).limit(60);
  if (error) throw new Error(error.message);
  return (data ?? []) as ActivationRow[];
}

export async function fetchActivationItems(activationId: string): Promise<ActivationItemRow[]> {
  const { data, error } = await supabase.from('playbook_activation_items').select('*').eq('activation_id', activationId).order('position', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ActivationItemRow[];
}

export async function fetchAudit(limit = 50): Promise<AuditRow[]> {
  const { data, error } = await supabase.from('playbook_audit_log').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as AuditRow[];
}

export async function fetchCustomPlaybooks(): Promise<CustomPlaybookRow[]> {
  const { data, error } = await supabase.from('playbook_custom').select('*').order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as CustomPlaybookRow[];
}

export async function fetchSettings(): Promise<{ suggestions_enabled: boolean; auto_apply_keys: string[] }> {
  const { data, error } = await supabase.from('playbook_settings').select('suggestions_enabled, auto_apply_keys').maybeSingle();
  if (error) throw new Error(error.message);
  return (data as { suggestions_enabled: boolean; auto_apply_keys: string[] } | null) ?? { suggestions_enabled: true, auto_apply_keys: [] };
}

// ---------------------------------------------------------------- writes

export interface ActivateInput {
  playbook: Playbook;
  enabledItemIds: string[];
  mode: 'now' | 'schedule' | 'dry_run';
  startsAt?: Date | null;
  endsAt?: Date | null;
  customId?: string | null;
}

/** A fresh request id per attempt keeps retries of the SAME click idempotent, but a new click new. */
export function activate(input: ActivateInput, requestId: string = newRequestId()): Promise<RpcResult> {
  return rpc('playbook_create_activation', {
    p_request_id: requestId,
    p_playbook_key: input.playbook.key,
    p_playbook_version: input.playbook.version,
    p_source: input.customId ? 'custom' : 'library',
    p_custom_id: input.customId ?? null,
    p_definition: input.customId ? null : input.playbook,
    p_enabled_items: input.enabledItemIds,
    p_starts_at: input.startsAt ? input.startsAt.toISOString() : null,
    p_ends_at: input.endsAt ? input.endsAt.toISOString() : null,
    p_mode: input.mode,
  });
}

export const confirmActivation = (id: string, dryRun = false) => rpc('playbook_confirm', { p_activation_id: id, p_dry_run: dryRun });
export const rollbackActivation = (id: string) => rpc('playbook_rollback', { p_activation_id: id });
export const approveItem = (itemId: string) => rpc('playbook_approve_item', { p_item_id: itemId });
export const updateSettings = (suggestions: boolean, autoKeys: string[]) => rpc('playbook_update_settings', { p_suggestions_enabled: suggestions, p_auto_apply_keys: autoKeys });
export const saveCustomPlaybook = (key: string, definition: Playbook) => rpc('playbook_custom_save', { p_key: key, p_definition: definition });
export const shareCustomPlaybook = (id: string, share: boolean) => rpc('playbook_custom_share', { p_id: id, p_share: share });
export const deleteCustomPlaybook = (id: string) => rpc('playbook_custom_delete', { p_id: id });

// ---------------------------------------------------------------- helpers for the UI

export function previewFor(pb: Playbook, enabledIds: string[], state: CurrentState, start: Date, end: Date | null): { diff: DiffRow[]; violations: ReturnType<typeof validateSelection>; window: { startsAt: Date; endsAt: Date } } {
  const { window, violations: wv } = resolveWindow(pb, start, end);
  const violations = [...validateSelection(pb, enabledIds), ...wv];
  return { diff: buildDiff(pb, enabledIds, state, window), violations, window };
}

export const REASON_TEXT: Record<string, string> = {
  conflict: 'Another active playbook already controls part of this. Roll it back or switch the conflicting items off.',
  already_live: 'This playbook is already suggested, scheduled or active.',
  owner_required: 'Some items change owner-only settings. The account owner needs to approve this.',
  invalid: 'This playbook did not pass the safety checks.',
  expired: 'The time window has already ended.',
  no_profile: 'Finish setting up your business profile first.',
};

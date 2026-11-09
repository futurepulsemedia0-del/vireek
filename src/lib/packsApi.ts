/**
 * Trade Pack framework — data access (the only file here that talks to Supabase).
 * Reads go through RLS-scoped tables; every write is an RPC (pack_apply / pack_customize / staff_*),
 * which re-checks the feature flag, entitlement, permission and per-artifact guards on the server.
 * Server counterpart: supabase/migrations/20290301000000_pack_framework.sql
 */

import { supabase } from '@/lib/supabase';
import {
  flattenPack, artifactId, validateArtifactContent, parseArtifactId,
  type AccountState, type ArtifactId, type InstallEvent, type Op, type PackManifest, type Plan,
} from '@/lib/packs';

export interface PackInstallRow {
  version: string | null;
  status: 'installed' | 'uninstalled';
}

export interface PackEventRow extends InstallEvent {
  ord: number;
  createdAt: string;
  revertsEventId: string | null;
}

export interface PackAccountView {
  install: PackInstallRow | null;
  state: AccountState;
  events: PackEventRow[];
  /** Latest install/upgrade event that has not been rolled back (the only one that can be). */
  revertible: PackEventRow | null;
}

const ERROR_TEXT: Record<string, string> = {
  feature_disabled: 'Trade packs are not enabled for your account yet.',
  not_entitled: 'Your plan does not include this pack. Contact support to add it.',
  not_permitted: 'You do not have permission to manage trade packs.',
  stale_plan: 'Something changed while you were reviewing. Reload and preview again — nothing was applied.',
  already_installed: 'This pack is already installed.',
  not_installed: 'This pack is not installed.',
  already_reverted: 'That change was already rolled back.',
  not_latest_event: 'Only the most recent change can be rolled back.',
  unknown_version: 'This pack version has not been published yet. Contact support.',
  downgrade_requires_rollback: 'Use rollback to go back to an earlier version.',
  version_immutable: 'That version is already published with different content. Publish a new version instead.',
  version_not_monotonic: 'A newer version of this pack is already published.',
};

export function friendlyPackError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const msg = err instanceof Error ? err.message : typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : '';
  for (const [code, text] of Object.entries(ERROR_TEXT)) if (msg.includes(code)) return text;
  if (/invariant_violation|incomplete_plan|base_not_in_target_version|live_not_allowed|malformed_|invalid_/.test(msg)) {
    return 'The change could not be applied safely. Reload and try again; if it persists, contact support.';
  }
  return fallback;
}

const newKey = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0'));

/** Pack ids the account is entitled to (`packs:<id>`). Empty when none / not signed in. */
export async function fetchEntitledPackIds(): Promise<string[]> {
  const { data, error } = await supabase.from('pack_entitlements').select('pack_id').is('revoked_at', null);
  if (error) throw error;
  return (data ?? []).map((r: { pack_id: string }) => r.pack_id);
}

export async function fetchPackAccountView(packId: string): Promise<PackAccountView> {
  const [inst, arts, evs] = await Promise.all([
    supabase.from('pack_installs').select('version,status').eq('pack_id', packId).maybeSingle(),
    supabase.from('pack_artifacts').select('artifact_id,content,base_content').eq('pack_id', packId).limit(2000),
    supabase.from('pack_events').select('id,ord,kind,from_version,to_version,reverts_event_id,ops,created_at').eq('pack_id', packId).order('ord', { ascending: false }).limit(50),
  ]);
  if (inst.error) throw inst.error;
  if (arts.error) throw arts.error;
  if (evs.error) throw evs.error;

  const state: AccountState = {};
  for (const a of (arts.data ?? []) as Array<{ artifact_id: string; content: unknown; base_content: unknown | null }>) {
    state[a.artifact_id] = { live: a.content, base: a.base_content ?? null };
  }
  const events: PackEventRow[] = ((evs.data ?? []) as Array<Record<string, unknown>>).map((e) => ({
    id: String(e.id), ord: Number(e.ord), kind: e.kind as PackEventRow['kind'],
    fromVersion: (e.from_version as string | null) ?? null, toVersion: (e.to_version as string | null) ?? null,
    revertsEventId: (e.reverts_event_id as string | null) ?? null, ops: (e.ops as Op[]) ?? [], createdAt: String(e.created_at),
  }));
  const reverted = new Set(events.map((e) => e.revertsEventId).filter(Boolean));
  const revertible = events.find((e) => (e.kind === 'install' || e.kind === 'upgrade') && !reverted.has(e.id)) ?? null;
  return { install: (inst.data as PackInstallRow | null) ?? null, state, events, revertible };
}

/** Applies a plan (install / upgrade / rollback). Safe to retry: the idempotency key makes a repeat a no-op. */
export async function applyPlan(plan: Plan, revertsEventId?: string, idempotencyKey: string = newKey()): Promise<{ eventId: string; replayed: boolean }> {
  const { data, error } = await supabase.rpc('pack_apply', {
    p_pack: plan.packId,
    p_kind: plan.kind,
    p_to_version: plan.kind === 'rollback' ? null : plan.toVersion,
    p_ops: plan.ops,
    p_idempotency_key: idempotencyKey,
    p_reverts: plan.kind === 'rollback' ? revertsEventId ?? null : null,
  });
  if (error) throw error;
  return { eventId: String((data as { event_id: string }).event_id), replayed: Boolean((data as { replayed: boolean }).replayed) };
}

/** Saves an account's own version of one artifact. Validated here with the same rules packs use. */
export async function customizeArtifact(packId: string, id: ArtifactId, content: Record<string, unknown>): Promise<void> {
  const parsed = parseArtifactId(id);
  if (!parsed) throw new Error('invalid_artifact_id');
  const issues = validateArtifactContent(parsed.kind, content);
  if (issues.length) throw new Error(`invalid_content: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`);
  const { error } = await supabase.rpc('pack_customize', { p_pack: packId, p_artifact_id: id, p_content: content, p_idempotency_key: newKey() });
  if (error) throw error;
}

/* ------------------------------ staff ------------------------------ */

/** Publishes one immutable version (staff only; the server re-checks). The manifest must already be valid. */
export async function publishPackVersion(pack: PackManifest): Promise<{ published: boolean }> {
  const artifacts: Record<string, unknown> = {};
  for (const a of flattenPack(pack)) artifacts[artifactId(a.kind, a.key)] = a.content;
  const { data, error } = await supabase.rpc('staff_publish_pack_version', { p_pack: pack.id, p_version: pack.version, p_name: pack.name, p_artifacts: artifacts });
  if (error) throw error;
  return { published: Boolean((data as { published: boolean }).published) };
}

export async function publishedVersions(): Promise<Array<{ pack_id: string; version: string }>> {
  const { data, error } = await supabase.from('pack_versions').select('pack_id,version').order('pack_id').order('seq');
  if (error) throw error;
  return (data ?? []) as Array<{ pack_id: string; version: string }>;
}

export async function setPackEntitlement(tenantId: string, packId: string, granted: boolean): Promise<void> {
  const { error } = await supabase.rpc('staff_set_pack_entitlement', { p_tenant: tenantId, p_pack: packId, p_granted: granted });
  if (error) throw error;
}

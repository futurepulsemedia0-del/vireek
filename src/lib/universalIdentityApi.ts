import { supabase } from '@/lib/supabase';
import {
  normalizeChain, normalizeDossier, normalizeGraph, normalizeOverview, normalizeSearch, normalizeEntity,
  type ChainStatus, type EntityType, type IdentityDossier, type IdentityEntity, type IdentityGraph, type IdentityOverview,
  type LifecycleState, type SearchResult,
} from '@/lib/universalIdentity';

/**
 * Data access for the Universal Identity Layer. Thin and typed: every payload is normalised in
 * lib/universalIdentity.ts, and every write goes through a SECURITY DEFINER RPC (the tables are
 * read-only for clients). Errors are thrown as-is; UI code maps them with identityErrorMessage().
 */

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export interface ExternalRefInput { system: string; ref_type: string; ref_value: string }
export interface SourceInput { source_type?: string; source_system?: string; source_ref?: string; method?: string; confidence?: number }

export async function fetchIdentityOverview(): Promise<IdentityOverview> {
  return normalizeOverview(await rpc('get_identity_overview'));
}

export async function searchIdentities(opts: { query?: string; types?: EntityType[]; states?: LifecycleState[]; limit?: number; offset?: number } = {}): Promise<SearchResult> {
  return normalizeSearch(await rpc('search_identity_entities', {
    p_query: opts.query?.trim() || null,
    p_types: opts.types && opts.types.length > 0 ? opts.types : null,
    p_states: opts.states && opts.states.length > 0 ? opts.states : null,
    p_limit: opts.limit ?? 25,
    p_offset: opts.offset ?? 0,
  }));
}

export async function fetchIdentityDossier(entityId: string): Promise<IdentityDossier> {
  return normalizeDossier(await rpc('get_identity_entity', { p_entity_id: entityId }));
}

export async function fetchIdentityGraph(entityId: string, depth = 2, includeEnded = false): Promise<IdentityGraph> {
  return normalizeGraph(await rpc('get_identity_graph', { p_entity_id: entityId, p_depth: depth, p_limit: 150, p_include_ended: includeEnded }));
}

export async function verifyIdentityChain(entityId: string): Promise<ChainStatus> {
  return normalizeChain(await rpc('verify_identity_chain', { p_entity_id: entityId }));
}

export async function resolveIdentityUid(uid: string): Promise<{ found: boolean; redirected: boolean; entity: IdentityEntity | null }> {
  const r = await rpc<Record<string, unknown>>('identity_resolve_uid', { p_uid: uid });
  return { found: r?.found === true, redirected: r?.redirected === true, entity: normalizeEntity(r?.entity) };
}

export async function registerIdentity(input: {
  type: EntityType; name: string; attributes?: Record<string, unknown>; refs?: ExternalRefInput[]; source?: SourceInput;
}): Promise<{ created: boolean; entityId: string; uid: string }> {
  const r = await rpc<{ created: boolean; entity_id: string; uid: string }>('identity_register_entity', {
    p_entity_type: input.type, p_display_name: input.name, p_attributes: input.attributes ?? {}, p_refs: input.refs ?? [], p_source: input.source ?? {},
  });
  return { created: r.created, entityId: r.entity_id, uid: r.uid };
}

export async function updateIdentity(entityId: string, patch: { name?: string; attributes?: Record<string, unknown>; expectedVersion?: number; source?: SourceInput }): Promise<{ changed: boolean; version: number }> {
  return rpc('identity_update_entity', {
    p_entity_id: entityId, p_patch: patch.attributes ?? {}, p_display_name: patch.name ?? null,
    p_expected_version: patch.expectedVersion ?? null, p_source: patch.source ?? {},
  });
}

export async function addIdentityRef(entityId: string, ref: ExternalRefInput): Promise<void> {
  await rpc('identity_add_ref', { p_entity_id: entityId, p_system: ref.system, p_ref_type: ref.ref_type, p_ref_value: ref.ref_value });
}

export async function linkIdentities(srcId: string, dstId: string, relType: string, source?: SourceInput): Promise<string> {
  const r = await rpc<{ relationship_id: string }>('identity_link', { p_src_id: srcId, p_dst_id: dstId, p_rel_type: relType, p_source: source ?? {} });
  return r.relationship_id;
}

export async function unlinkIdentities(relationshipId: string, reason?: string): Promise<void> {
  await rpc('identity_unlink', { p_relationship_id: relationshipId, p_reason: reason ?? null });
}

export async function transitionIdentity(entityId: string, to: LifecycleState, reason?: string): Promise<void> {
  await rpc('identity_transition', { p_entity_id: entityId, p_to_state: to, p_reason: reason ?? null });
}

export async function mergeIdentities(survivorId: string, duplicateId: string, reason: string): Promise<void> {
  await rpc('identity_merge', { p_survivor_id: survivorId, p_duplicate_id: duplicateId, p_reason: reason });
}

export async function eraseIdentity(entityId: string, reason: string): Promise<void> {
  await rpc('identity_erase', { p_entity_id: entityId, p_reason: reason });
}

export async function grantIdentityAccess(input: {
  entityId: string; kind: 'tenant' | 'agent'; granteeId: string; actions: string[]; purpose: string; expiresAt?: string | null;
}): Promise<void> {
  await rpc('identity_grant_access', {
    p_entity_id: input.entityId, p_grantee_kind: input.kind, p_grantee_id: input.granteeId, p_actions: input.actions,
    p_purpose: input.purpose, p_expires_at: input.expiresAt ?? null,
  });
}

export async function revokeIdentityGrant(grantId: string, reason?: string): Promise<void> {
  await rpc('identity_revoke_grant', { p_grant_id: grantId, p_reason: reason ?? null });
}

/** Backfill / repair for the current account. Returns whether another call is needed. */
export async function syncOperationalIdentities(limit = 400): Promise<{ synced: Record<string, number>; more: boolean }> {
  const r = await rpc<{ synced?: Record<string, number>; more?: boolean }>('identity_sync_operational', { p_limit: limit });
  return { synced: r?.synced ?? {}, more: r?.more === true };
}

/** Registry of valid relationship types per (source type → target type); used to build the "link" picker. */
export async function fetchRelationshipRegistry(): Promise<Array<{ rel_type: string; src_type: EntityType; dst_type: EntityType; label: string }>> {
  const { data, error } = await supabase.from('identity_relationship_types').select('rel_type, src_type, dst_type, label').order('rel_type');
  if (error) throw error;
  return (data ?? []) as Array<{ rel_type: string; src_type: EntityType; dst_type: EntityType; label: string }>;
}

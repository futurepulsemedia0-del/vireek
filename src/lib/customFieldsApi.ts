/**
 * Custom Fields — Supabase API + hooks.
 *
 * Every call is scoped to the ACCOUNT OWNER id (for a team member that is NOT
 * their own user id — same rule as the calls / jobs pages), on top of RLS.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  CUSTOM_ENTITY_META,
  normalizeOptions,
  slugifyKey,
  sortDefs,
  type CustomData,
  type CustomEntity,
  type CustomFieldDef,
  type CustomFieldType,
} from '@/lib/customFields';

export function useAccountOwnerId(): string | undefined {
  const { isOwner, profile, teamMember } = useAuth();
  return isOwner ? profile?.id : teamMember?.account_owner_id;
}

/** Permission gate for managing field DEFINITIONS (reuses can_edit_business_profile). */
export function useCanManageCustomFields(): boolean {
  const { isOwner, permissions } = useAuth();
  return isOwner || permissions.can_edit_business_profile === true;
}

const DEF_COLUMNS =
  'id, user_id, entity, key, label, field_type, options, required, show_in_table, show_in_filters, sort_order, archived_at, created_at, updated_at';

/** Turns a Postgres / PostgREST error into a sentence a user can act on. */
export function friendlyFieldError(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return fallback;
  if (e.code === '23505') return 'A field with this name already exists.';
  if (e.code === '42501') return "You don't have permission to do that.";
  if ((e.code === '22023' || e.code === '54000') && e.message) return e.message;
  return fallback;
}

// Definitions are tiny and read by many components at once (every card on a
// board asks for them). A short-lived shared cache + in-flight de-dupe turns
// N requests into one. Any write below invalidates it.
const DEF_CACHE_TTL_MS = 30_000;
const defCache = new Map<string, { at: number; promise: Promise<CustomFieldDef[]> }>();

export function invalidateCustomFieldCache(): void {
  defCache.clear();
}

async function fetchCustomFields(entity: CustomEntity, ownerId: string): Promise<CustomFieldDef[]> {
  const { data, error } = await supabase
    .from('custom_field_definitions')
    .select(DEF_COLUMNS)
    .eq('user_id', ownerId)
    .eq('entity', entity)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as CustomFieldDef[]).map((d) => ({
    ...d,
    options: Array.isArray(d.options) ? d.options : [],
  }));
}

export function listCustomFields(entity: CustomEntity, ownerId: string): Promise<CustomFieldDef[]> {
  const k = `${ownerId}:${entity}`;
  const hit = defCache.get(k);
  if (hit && Date.now() - hit.at < DEF_CACHE_TTL_MS) return hit.promise;
  const promise = fetchCustomFields(entity, ownerId).catch((err) => {
    defCache.delete(k);
    throw err;
  });
  defCache.set(k, { at: Date.now(), promise });
  return promise;
}

export interface NewFieldInput {
  entity: CustomEntity;
  label: string;
  field_type: CustomFieldType;
  options: string[];
  required: boolean;
  show_in_table: boolean;
  show_in_filters: boolean;
}

export async function createCustomField(input: NewFieldInput, existing: CustomFieldDef[]): Promise<void> {
  const key = slugifyKey(
    input.label,
    existing.map((d) => d.key),
  );
  const nextOrder = existing.reduce((m, d) => Math.max(m, d.sort_order), -1) + 1;
  const { error } = await supabase.from('custom_field_definitions').insert({
    entity: input.entity,
    key,
    label: input.label.trim(),
    field_type: input.field_type,
    options: input.field_type === 'select' ? normalizeOptions(input.options) : [],
    required: input.field_type === 'boolean' ? false : input.required,
    show_in_table: input.show_in_table,
    show_in_filters: input.show_in_filters,
    sort_order: nextOrder,
  });
  if (error) throw error;
  invalidateCustomFieldCache();
}

export type FieldPatch = Partial<
  Pick<CustomFieldDef, 'label' | 'options' | 'required' | 'show_in_table' | 'show_in_filters' | 'sort_order' | 'archived_at'>
>;

export async function updateCustomField(id: string, ownerId: string, patch: FieldPatch): Promise<void> {
  const { error } = await supabase
    .from('custom_field_definitions')
    .update(patch)
    .eq('id', id)
    .eq('user_id', ownerId);
  if (error) throw error;
  invalidateCustomFieldCache();
}

export async function setFieldOrder(ownerId: string, ordered: CustomFieldDef[]): Promise<void> {
  const changed = ordered.map((d, i) => ({ d, i })).filter(({ d, i }) => d.sort_order !== i);
  const results = await Promise.all(changed.map(({ d, i }) => updateCustomField(d.id, ownerId, { sort_order: i }).then(() => null, (e) => e)));
  const failed = results.find((r) => r !== null);
  if (failed) throw failed;
}

/** Hard delete: also strips the values from every record (DB function). */
export async function deleteCustomField(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_custom_field', { p_id: id });
  if (error) throw error;
  invalidateCustomFieldCache();
}

export async function saveCustomData(
  entity: CustomEntity,
  recordId: string,
  ownerId: string,
  data: CustomData,
): Promise<void> {
  const { error } = await supabase
    .from(CUSTOM_ENTITY_META[entity].table)
    .update({ custom_data: data })
    .eq('id', recordId)
    .eq('user_id', ownerId);
  if (error) throw error;
  emitCustomDataSaved(entity, recordId, data);
}

// ============================================================
// HOOKS
// ============================================================

export function useCustomFieldDefs(entity: CustomEntity) {
  const ownerId = useAccountOwnerId();
  const [defs, setDefs] = useState<CustomFieldDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const reqRef = useRef(0);

  const reload = useCallback(async () => {
    if (!ownerId) return;
    const req = ++reqRef.current;
    setLoading(true);
    try {
      const rows = await listCustomFields(entity, ownerId);
      if (req !== reqRef.current) return; // a newer request superseded this one
      setDefs(sortDefs(rows));
      setError(false);
    } catch {
      if (req === reqRef.current) setError(true);
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, [entity, ownerId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { defs, loading, error, reload, ownerId };
}

// --- keep list pages in sync after a detail panel saves -----------------

const SAVED_EVENT = 'vireek:custom-data-saved';

function emitCustomDataSaved(entity: CustomEntity, id: string, data: CustomData) {
  window.dispatchEvent(new CustomEvent(SAVED_EVENT, { detail: { entity, id, data } }));
}

/** Call from a list page so its rows update when a detail panel saves custom fields. */
export function useCustomDataSync(entity: CustomEntity, onSaved: (id: string, data: CustomData) => void) {
  const ref = useRef(onSaved);
  ref.current = onSaved;
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<{ entity: CustomEntity; id: string; data: CustomData }>).detail;
      if (d.entity === entity) ref.current(d.id, d.data);
    };
    window.addEventListener(SAVED_EVENT, handler);
    return () => window.removeEventListener(SAVED_EVENT, handler);
  }, [entity]);
}

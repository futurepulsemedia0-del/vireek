/**
 * Status / stage engine — network layer. Pure logic lives in statusEngine.ts.
 *
 * Reads are scoped by RLS to the caller's account. Definition writes are owner-only (RLS) and
 * validated again by triggers. Moving a job ALWAYS goes through the SECURITY DEFINER RPC
 * `move_job_to_status`, which enforces transition rules, required fields/notes and reuses the
 * existing hold/SLA machinery. Failures return stable codes (mapped to i18n by the caller).
 */
import { supabase } from '@/lib/supabase';
import {
  deriveKey,
  validateDefinitionDraft,
  type DefinitionDraft,
  type DefinitionErrors,
  type StatusDefinition,
  type StatusTransition,
  type TeamRole,
} from '@/lib/statusEngine';

const DEFINITION_COLUMNS =
  'id, user_id, scope, key, label, label_i18n, color, canonical_status, sort_order, is_system, requires_note, required_fields, sla_minutes, version, archived_at, created_at, updated_at';
const TRANSITION_COLUMNS = 'id, from_definition_id, to_definition_id, allowed_roles, requires_note';

export type MoveStatusCode =
  | 'ok'
  | 'unchanged'
  | 'not_found'
  | 'forbidden'
  | 'archived'
  | 'transition_not_allowed'
  | 'note_required'
  | 'missing_fields'
  | 'reason_required'
  | 'invalid'
  | 'invalid_transition'
  | 'slot_conflict'
  | 'error';

const MOVE_CODES: readonly string[] = [
  'ok', 'unchanged', 'not_found', 'forbidden', 'archived', 'transition_not_allowed', 'note_required',
  'missing_fields', 'reason_required', 'invalid', 'invalid_transition', 'slot_conflict',
];

export interface MoveResult {
  ok: boolean;
  code: MoveStatusCode;
  /** Present for `missing_fields`: custom-field keys to fill in first. */
  fields?: string[];
}

export interface MoveJobInput {
  jobId: string;
  definitionId: string;
  reasonCode?: string | null;
  note?: string | null;
  expectedResumeAt?: string | null;
}

export async function moveJobToStatus(input: MoveJobInput): Promise<MoveResult> {
  const { data, error } = await supabase.rpc('move_job_to_status', {
    p_job_id: input.jobId,
    p_definition_id: input.definitionId,
    p_reason_code: input.reasonCode ?? null,
    p_note: input.note && input.note.trim() ? input.note.trim() : null,
    p_expected_resume_at: input.expectedResumeAt ?? null,
  });
  if (error) return { ok: false, code: 'error' };
  const row = (data ?? {}) as { status?: unknown; fields?: unknown };
  if (typeof row.status !== 'string' || !MOVE_CODES.includes(row.status)) return { ok: false, code: 'error' };
  const code = row.status as MoveStatusCode;
  const fields = Array.isArray(row.fields) ? row.fields.filter((f): f is string => typeof f === 'string') : undefined;
  return { ok: code === 'ok', code, ...(fields && fields.length ? { fields } : {}) };
}

/** Seeds the 11 system definitions on first use (idempotent), then returns every definition. */
export async function listStatusDefinitions(): Promise<StatusDefinition[]> {
  const seed = await supabase.rpc('ensure_status_definitions');
  if (seed.error) throw seed.error;
  const { data, error } = await supabase
    .from('status_definitions')
    .select(DEFINITION_COLUMNS)
    .eq('scope', 'job')
    .order('sort_order', { ascending: true })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as unknown as StatusDefinition[];
}

export async function listStatusTransitions(): Promise<StatusTransition[]> {
  const { data, error } = await supabase.from('status_transitions').select(TRANSITION_COLUMNS).eq('scope', 'job').limit(1000);
  if (error) throw error;
  return (data ?? []) as unknown as StatusTransition[];
}

export type SaveDefinitionResult =
  | { ok: true; definition: StatusDefinition }
  | { ok: false; errors: DefinitionErrors; serverError?: true };

export async function createStatusDefinition(draft: DefinitionDraft, existing: readonly StatusDefinition[]): Promise<SaveDefinitionResult> {
  const verdict = validateDefinitionDraft(draft, existing);
  if (!verdict.ok) return { ok: false, errors: verdict.errors };
  const nextOrder = existing.reduce((max, d) => Math.max(max, d.sort_order), 0) + 10;
  const { data, error } = await supabase
    .from('status_definitions')
    .insert({
      key: draft.key ?? deriveKey(draft.label),
      label: draft.label.trim(),
      color: draft.color,
      canonical_status: draft.canonical_status,
      requires_note: draft.requires_note ?? false,
      required_fields: draft.required_fields ?? [],
      sla_minutes: draft.sla_minutes ?? null,
      sort_order: Math.min(nextOrder, 10000),
    })
    .select(DEFINITION_COLUMNS)
    .single();
  if (error || !data) return { ok: false, errors: { form: 'limitReached' }, serverError: true };
  return { ok: true, definition: data as unknown as StatusDefinition };
}

export type DefinitionPatch = Partial<
  Pick<StatusDefinition, 'label' | 'label_i18n' | 'color' | 'canonical_status' | 'requires_note' | 'required_fields' | 'sla_minutes' | 'sort_order'>
>;

export async function updateStatusDefinition(
  id: string,
  patch: DefinitionPatch,
  existing: readonly StatusDefinition[],
): Promise<SaveDefinitionResult> {
  const current = existing.find((d) => d.id === id);
  if (!current) return { ok: false, errors: { form: 'limitReached' }, serverError: true };
  const merged = { ...current, ...patch };
  const verdict = validateDefinitionDraft(
    {
      label: merged.label,
      color: merged.color,
      canonical_status: merged.canonical_status,
      requires_note: merged.requires_note,
      required_fields: merged.required_fields,
      sla_minutes: merged.sla_minutes,
    },
    existing,
    id,
  );
  if (!verdict.ok) return { ok: false, errors: verdict.errors };
  const { data, error } = await supabase.from('status_definitions').update(patch).eq('id', id).select(DEFINITION_COLUMNS).single();
  if (error || !data) return { ok: false, errors: { form: 'limitReached' }, serverError: true };
  return { ok: true, definition: data as unknown as StatusDefinition };
}

/** Definitions are never deleted: archiving hides them from pickers; jobs already using one keep it. */
export async function setStatusDefinitionArchived(id: string, archived: boolean): Promise<boolean> {
  const { error } = await supabase
    .from('status_definitions')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', id);
  return !error;
}

export interface TransitionRuleInput {
  fromDefinitionId: string | null;
  toDefinitionId: string;
  allowedRoles: TeamRole[];
  requiresNote: boolean;
}

export async function saveStatusTransition(rule: TransitionRuleInput): Promise<boolean> {
  if (rule.allowedRoles.length === 0) return false;
  let lookup = supabase.from('status_transitions').select('id').eq('to_definition_id', rule.toDefinitionId);
  lookup = rule.fromDefinitionId ? lookup.eq('from_definition_id', rule.fromDefinitionId) : lookup.is('from_definition_id', null);
  const existing = await lookup.maybeSingle();
  if (existing.error) return false;
  const values = { allowed_roles: rule.allowedRoles, requires_note: rule.requiresNote };
  if (existing.data) {
    const { error } = await supabase.from('status_transitions').update(values).eq('id', (existing.data as { id: string }).id);
    return !error;
  }
  const { error } = await supabase
    .from('status_transitions')
    .insert({ ...values, from_definition_id: rule.fromDefinitionId, to_definition_id: rule.toDefinitionId });
  return !error;
}

export async function deleteStatusTransition(id: string): Promise<boolean> {
  const { error } = await supabase.from('status_transitions').delete().eq('id', id);
  return !error;
}

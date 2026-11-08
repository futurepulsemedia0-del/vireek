/**
 * Status / stage engine — pure domain logic (no network, no React).
 *
 * A business-defined status is a label layer over the 11 canonical `jobs.job_status` values.
 * Every definition maps to exactly one canonical status, so reports, AI engines, RLS and the
 * public API keep reading `job_status` unchanged. The database is the source of truth
 * (supabase/migrations/20281110000000_status_stage_engine.sql); the helpers below mirror its
 * rules so the UI can explain a refusal BEFORE a save. Returned error values are i18n key
 * suffixes (`statusEngine.errors.<code>`), never user-facing text.
 */
import { WORKFLOW_STATUSES, isWorkflowStatus } from '@/lib/jobWorkflow';

export const LEGACY_STATUSES = ['scheduled', 'en_route', 'in_progress', 'completed', 'cancelled', 'no_show'] as const;
export const CANONICAL_STATUSES = [...LEGACY_STATUSES, ...WORKFLOW_STATUSES] as const;
export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number];

export function isCanonicalStatus(value: unknown): value is CanonicalStatus {
  return typeof value === 'string' && (CANONICAL_STATUSES as readonly string[]).includes(value);
}

export const STATUS_COLORS = ['neutral', 'info', 'success', 'warning', 'danger', 'accent', 'orange'] as const;
export type StatusColor = (typeof STATUS_COLORS)[number];

/** Design-token classes only (same tokens the job workflow badges already use). */
export const STATUS_COLOR_CLASSES: Record<StatusColor, { dot: string; badge: string }> = {
  neutral: { dot: 'bg-text-secondary', badge: 'bg-bg-tertiary text-text-secondary' },
  info: { dot: 'bg-blue-500', badge: 'bg-blue-500/10 text-blue-500' },
  success: { dot: 'bg-success-500', badge: 'bg-success-500/10 text-success-500' },
  warning: { dot: 'bg-warning-500', badge: 'bg-warning-500/10 text-warning-500' },
  danger: { dot: 'bg-danger', badge: 'bg-danger/10 text-danger' },
  accent: { dot: 'bg-accent', badge: 'bg-accent/10 text-accent' },
  orange: { dot: 'bg-orange-500', badge: 'bg-orange-500/10 text-orange-500' },
};

export function isStatusColor(value: unknown): value is StatusColor {
  return typeof value === 'string' && (STATUS_COLORS as readonly string[]).includes(value);
}

export const TEAM_ROLES = ['owner', 'admin', 'member', 'technician'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const MAX_ACTIVE_DEFINITIONS = 40;
export const MAX_LABEL_LENGTH = 60;
export const MAX_REQUIRED_FIELDS = 10;
export const MIN_SLA_MINUTES = 5;
export const MAX_SLA_MINUTES = 525_600;
export const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export interface StatusDefinition {
  id: string;
  user_id: string;
  scope: 'job';
  key: string;
  label: string;
  label_i18n: Record<string, string>;
  color: StatusColor;
  canonical_status: CanonicalStatus;
  sort_order: number;
  is_system: boolean;
  requires_note: boolean;
  required_fields: string[];
  sla_minutes: number | null;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StatusTransition {
  id: string;
  from_definition_id: string | null;
  to_definition_id: string;
  allowed_roles: TeamRole[];
  requires_note: boolean;
}

/** Mirror of seed_status_definitions() — a unit test keeps both in sync. */
export const SYSTEM_DEFINITION_DEFAULTS: ReadonlyArray<{
  key: CanonicalStatus;
  label: string;
  color: StatusColor;
  sortOrder: number;
}> = [
  { key: 'scheduled', label: 'Scheduled', color: 'info', sortOrder: 10 },
  { key: 'en_route', label: 'En route', color: 'accent', sortOrder: 20 },
  { key: 'in_progress', label: 'In progress', color: 'warning', sortOrder: 30 },
  { key: 'completed', label: 'Completed', color: 'success', sortOrder: 40 },
  { key: 'cancelled', label: 'Cancelled', color: 'danger', sortOrder: 50 },
  { key: 'no_show', label: 'No show', color: 'neutral', sortOrder: 60 },
  { key: 'on_hold', label: 'On hold', color: 'neutral', sortOrder: 70 },
  { key: 'waiting_on_parts', label: 'Waiting on parts', color: 'orange', sortOrder: 80 },
  { key: 'waiting_on_customer', label: 'Waiting on customer', color: 'info', sortOrder: 90 },
  { key: 'needs_follow_up', label: 'Needs follow-up', color: 'warning', sortOrder: 100 },
  { key: 'return_visit_needed', label: 'Return visit needed', color: 'accent', sortOrder: 110 },
];

// ============================================================
// DRAFT VALIDATION
// ============================================================

export interface DefinitionDraft {
  key?: string;
  label: string;
  color: StatusColor;
  canonical_status: CanonicalStatus;
  requires_note?: boolean;
  required_fields?: string[];
  sla_minutes?: number | null;
}

export type DefinitionErrorCode =
  | 'labelRequired'
  | 'labelTooLong'
  | 'labelTaken'
  | 'keyInvalid'
  | 'keyTaken'
  | 'colorInvalid'
  | 'canonicalInvalid'
  | 'requiredFieldsInvalid'
  | 'slaNotSupported'
  | 'slaOutOfRange'
  | 'limitReached';

export type DefinitionErrors = Partial<Record<'label' | 'key' | 'color' | 'canonical_status' | 'required_fields' | 'sla_minutes' | 'form', DefinitionErrorCode>>;

/** Lower-case slug used as the immutable key (a–z, 0–9, underscore). Empty when nothing usable remains. */
export function deriveKey(label: string): string {
  const slug = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '');
  return /^[a-z]/.test(slug) ? slug : slug ? `s_${slug}`.slice(0, 40) : '';
}

export function validateDefinitionDraft(
  draft: DefinitionDraft,
  existing: readonly StatusDefinition[],
  editingId?: string,
): { ok: boolean; errors: DefinitionErrors } {
  const errors: DefinitionErrors = {};
  const others = existing.filter((d) => d.id !== editingId);
  const active = others.filter((d) => d.archived_at === null);
  const label = draft.label.trim();

  if (!label) errors.label = 'labelRequired';
  else if (label.length > MAX_LABEL_LENGTH) errors.label = 'labelTooLong';
  else if (active.some((d) => d.label.trim().toLowerCase() === label.toLowerCase())) errors.label = 'labelTaken';

  if (!editingId) {
    const key = draft.key ?? deriveKey(label);
    if (!KEY_PATTERN.test(key)) errors.key = 'keyInvalid';
    else if (others.some((d) => d.key === key)) errors.key = 'keyTaken';
    if (active.length >= MAX_ACTIVE_DEFINITIONS) errors.form = 'limitReached';
  }

  if (!isStatusColor(draft.color)) errors.color = 'colorInvalid';
  if (!isCanonicalStatus(draft.canonical_status)) errors.canonical_status = 'canonicalInvalid';

  const fields = draft.required_fields ?? [];
  if (fields.length > MAX_REQUIRED_FIELDS || fields.some((f) => !FIELD_KEY_PATTERN.test(f)) || new Set(fields).size !== fields.length) {
    errors.required_fields = 'requiredFieldsInvalid';
  }

  if (draft.sla_minutes != null) {
    if (!isWorkflowStatus(draft.canonical_status)) errors.sla_minutes = 'slaNotSupported';
    else if (!Number.isInteger(draft.sla_minutes) || draft.sla_minutes < MIN_SLA_MINUTES || draft.sla_minutes > MAX_SLA_MINUTES) {
      errors.sla_minutes = 'slaOutOfRange';
    }
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

// ============================================================
// RESOLUTION + TRANSITIONS
// ============================================================

export interface JobStatusRef {
  job_status: string;
  custom_status_id?: string | null;
}

/**
 * The definition a job currently shows. A missing/unknown custom id (e.g. definitions not loaded
 * yet) falls back to the system definition for `job_status`; never throws.
 */
export function resolveJobDefinition(job: JobStatusRef, defs: readonly StatusDefinition[]): StatusDefinition | null {
  if (job.custom_status_id) {
    const custom = defs.find((d) => d.id === job.custom_status_id && d.canonical_status === job.job_status);
    if (custom) return custom;
  }
  return defs.find((d) => d.is_system && d.key === job.job_status) ?? null;
}

/** Statuses a person can pick: active definitions, in display order. */
export function activeDefinitions(defs: readonly StatusDefinition[]): StatusDefinition[] {
  return defs
    .filter((d) => d.archived_at === null)
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));
}

export type TransitionErrorCode =
  | 'archived'
  | 'unchanged'
  | 'transitionNotAllowed'
  | 'noteRequired'
  | 'reasonRequired'
  | 'missingFields';

export type TransitionVerdict =
  | { allowed: true; needsReason: boolean }
  | { allowed: false; code: TransitionErrorCode; fields?: string[] };

export interface TransitionInput {
  from: StatusDefinition | null;
  to: StatusDefinition;
  role: TeamRole;
  rules: readonly StatusTransition[];
  note?: string | null;
  reasonCode?: string | null;
  customData?: Record<string, unknown> | null;
}

/** Mirror of the checks in move_job_to_status(); the RPC still decides. */
export function evaluateTransition(input: TransitionInput): TransitionVerdict {
  const { from, to, role, rules } = input;
  const note = (input.note ?? '').trim();
  if (to.archived_at !== null) return { allowed: false, code: 'archived' };
  if (from && from.id === to.id) return { allowed: false, code: 'unchanged' };

  let rule: StatusTransition | undefined;
  if (rules.length > 0) {
    const candidates = rules
      .filter(
        (r) =>
          r.to_definition_id === to.id &&
          (r.from_definition_id === null || r.from_definition_id === from?.id) &&
          (role === 'owner' || r.allowed_roles.includes(role)),
      )
      .sort((a, b) => Number(b.from_definition_id !== null) - Number(a.from_definition_id !== null));
    rule = candidates[0];
    if (!rule) return { allowed: false, code: 'transitionNotAllowed' };
  }

  if ((to.requires_note || rule?.requires_note) && note.length < 3) return { allowed: false, code: 'noteRequired' };

  const missing = missingRequiredFields(to.required_fields, input.customData);
  if (missing.length > 0) return { allowed: false, code: 'missingFields', fields: missing };

  const needsReason = isWorkflowStatus(to.canonical_status) && from?.canonical_status !== to.canonical_status;
  if (needsReason && !input.reasonCode) return { allowed: false, code: 'reasonRequired' };

  return { allowed: true, needsReason };
}

export function missingRequiredFields(required: readonly string[], customData: Record<string, unknown> | null | undefined): string[] {
  const data = customData ?? {};
  return required
    .filter((key) => {
      const v = data[key];
      return v === undefined || v === null || (typeof v === 'string' ? v.trim() === '' : false);
    })
    .sort();
}

/** Display label: stored per-locale override → stored label. System labels are translated by the caller via i18next. */
export function definitionLabel(def: StatusDefinition, locale: string): string {
  const lang = locale.toLowerCase();
  return def.label_i18n[lang] ?? def.label_i18n[lang.split('-')[0] ?? ''] ?? def.label;
}

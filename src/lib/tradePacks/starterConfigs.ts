/**
 * Trade Pack starter statuses (Phase 3).
 *
 * Extends the existing Trade Packs: a pack that is installed can ALSO seed ready-made job statuses on
 * top of the status engine (statusEngine.ts). Every starter maps to a canonical status, so reports,
 * automations and AI keep working. Keys carry the pack prefix (like the pack's custom fields), the
 * install is idempotent, and nothing existing is overwritten — the owner can rename or archive them.
 */
import type { PackKey } from '@/lib/tradePacks/types';
import {
  validateDefinitionDraft,
  type CanonicalStatus,
  type DefinitionDraft,
  type DefinitionErrorCode,
  type StatusColor,
  type StatusDefinition,
} from '@/lib/statusEngine';

export interface StarterStatus {
  key: string;
  label: string;
  color: StatusColor;
  canonical: CanonicalStatus;
  requiresNote?: boolean;
  /** Job custom-field keys that must be filled before entering the status (dropped when the field doesn't exist). */
  requiredFields?: string[];
  /** Only for waiting/hold canonical statuses (uses the existing hold reminder + overdue timers). */
  slaMinutes?: number;
}

export const STARTER_STATUSES: Record<PackKey, readonly StarterStatus[]> = {
  pest_control: [
    { key: 'pest_awaiting_access', label: 'Waiting for site access', color: 'info', canonical: 'waiting_on_customer', slaMinutes: 2880 },
    { key: 'pest_followup_due', label: 'Follow-up treatment due', color: 'warning', canonical: 'needs_follow_up', slaMinutes: 10080 },
    { key: 'pest_retreatment', label: 'Re-treatment needed', color: 'accent', canonical: 'return_visit_needed', requiresNote: true },
    { key: 'pest_treatment_complete', label: 'Treatment complete', color: 'success', canonical: 'completed', requiredFields: ['pest_primary_target'] },
  ],
  pool_service: [
    { key: 'pool_awaiting_access', label: 'Gate or access issue', color: 'info', canonical: 'waiting_on_customer', slaMinutes: 1440 },
    { key: 'pool_waiting_parts', label: 'Waiting on equipment parts', color: 'orange', canonical: 'waiting_on_parts', slaMinutes: 4320 },
    { key: 'pool_rebalance', label: 'Water rebalance needed', color: 'accent', canonical: 'return_visit_needed', requiresNote: true },
    { key: 'pool_service_complete', label: 'Service complete', color: 'success', canonical: 'completed' },
  ],
};

export type StarterSkipReason = 'exists' | DefinitionErrorCode;

export interface StarterPlan {
  create: DefinitionDraft[];
  skipped: { key: string; reason: StarterSkipReason }[];
  droppedFields: { key: string; field: string }[];
}

/** Pure, idempotent plan: what an install would create right now. */
export function planStarterStatuses(
  packKey: PackKey,
  existing: readonly StatusDefinition[],
  jobFieldKeys: ReadonlySet<string>,
): StarterPlan {
  const plan: StarterPlan = { create: [], skipped: [], droppedFields: [] };
  const working: StatusDefinition[] = [...existing];
  for (const s of STARTER_STATUSES[packKey]) {
    if (existing.some((d) => d.key === s.key)) {
      plan.skipped.push({ key: s.key, reason: 'exists' });
      continue;
    }
    const kept = (s.requiredFields ?? []).filter((f) => {
      const ok = jobFieldKeys.has(f);
      if (!ok) plan.droppedFields.push({ key: s.key, field: f });
      return ok;
    });
    const draft: DefinitionDraft = {
      key: s.key,
      label: s.label,
      color: s.color,
      canonical_status: s.canonical,
      requires_note: s.requiresNote ?? false,
      required_fields: kept,
      sla_minutes: s.slaMinutes ?? null,
    };
    const verdict = validateDefinitionDraft(draft, working);
    if (!verdict.ok) {
      const code = Object.values(verdict.errors)[0] as DefinitionErrorCode;
      plan.skipped.push({ key: s.key, reason: code });
      continue;
    }
    plan.create.push(draft);
    // Track it so a later starter with the same label is caught within this very plan.
    working.push({
      id: `plan:${s.key}`, user_id: '', scope: 'job', key: s.key, label: s.label, label_i18n: {}, color: s.color,
      canonical_status: s.canonical, sort_order: 0, is_system: false, requires_note: draft.requires_note ?? false,
      required_fields: kept, sla_minutes: draft.sla_minutes ?? null, version: 1, archived_at: null, created_at: '', updated_at: '',
    });
  }
  return plan;
}

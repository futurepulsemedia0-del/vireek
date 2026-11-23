// src/lib/migrationApi.ts
//
// Client API for the migration checklist page. Every read/write is tenant-scoped by RLS
// (user_id = get_account_owner_id()); accountOwnerId is also passed explicitly, matching importWizard.ts.
// Writes are additionally limited by RLS to people who may run data imports.

import { supabase } from './supabase';
import {
  normalizeControlTotals, normalizeSnapshot,
  type ControlTotals, type MigrationSnapshot, type MigrationSource,
} from './migrationValidation';
import { MANUAL_STEP_IDS } from './migrationChecklist';

export async function fetchValidationSnapshot(source: MigrationSource): Promise<MigrationSnapshot> {
  const { data, error } = await supabase.rpc('migration_validation_snapshot', { p_source: source });
  if (error) throw new Error(error.message);
  return normalizeSnapshot(data, source);
}

export async function fetchManualProgress(accountOwnerId: string, source: MigrationSource): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('migration_checklist_progress')
    .select('step_id')
    .eq('user_id', accountOwnerId)
    .eq('source', source);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r) => String((r as { step_id: string }).step_id)).filter((id) => MANUAL_STEP_IDS.has(id)));
}

export async function setManualStep(accountOwnerId: string, source: MigrationSource, stepId: string, done: boolean): Promise<void> {
  if (!MANUAL_STEP_IDS.has(stepId)) throw new Error('Unknown checklist step.');
  if (done) {
    const { error } = await supabase
      .from('migration_checklist_progress')
      .upsert({ user_id: accountOwnerId, source, step_id: stepId }, { onConflict: 'user_id,source,step_id', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  } else {
    const { error } = await supabase
      .from('migration_checklist_progress')
      .delete()
      .eq('user_id', accountOwnerId).eq('source', source).eq('step_id', stepId);
    if (error) throw new Error(error.message);
  }
}

export async function fetchControlTotals(accountOwnerId: string, source: MigrationSource): Promise<ControlTotals> {
  const { data, error } = await supabase
    .from('migration_control_totals')
    .select('totals')
    .eq('user_id', accountOwnerId).eq('source', source)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return normalizeControlTotals((data as { totals?: unknown } | null)?.totals);
}

export async function saveControlTotals(accountOwnerId: string, source: MigrationSource, totals: ControlTotals): Promise<void> {
  const { error } = await supabase
    .from('migration_control_totals')
    .upsert({ user_id: accountOwnerId, source, totals: normalizeControlTotals(totals), updated_at: new Date().toISOString() }, { onConflict: 'user_id,source' });
  if (error) throw new Error(error.message);
}

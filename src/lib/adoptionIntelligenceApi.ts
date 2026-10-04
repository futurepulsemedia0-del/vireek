/**
 * Vireek Change Management / Adoption OS - data access.
 *
 * Thin, typed wrappers over Supabase. All scoping is enforced by RLS and the
 * SECURITY DEFINER RPC in 20270210000000_adoption_os.sql, so nothing here decides
 * who may see or write what: managers see the whole account, technicians only themselves.
 */

import { supabase } from '@/lib/supabase';
import type {
  AdoptionDimension,
  AdoptionSignalRow,
  OnboardingStep,
} from '@/lib/adoptionIntelligence';

export type AdoptionWindowDays = 30 | 60 | 90;
export type InterventionKind = 'onboarding' | 'coaching' | 'ride_along' | 'recognition';
export type InterventionStatus = 'open' | 'completed' | 'dismissed';

export interface AdoptionIntervention {
  id: string;
  account_owner_id: string;
  team_member_id: string;
  kind: InterventionKind;
  focus: AdoptionDimension[];
  steps: OnboardingStep[];
  note: string | null;
  status: InterventionStatus;
  baseline_score: number | null;
  outcome_score: number | null;
  due_date: string | null;
  created_at: string;
  closed_at: string | null;
}

const INTERVENTION_COLUMNS =
  'id, account_owner_id, team_member_id, kind, focus, steps, note, status, baseline_score, outcome_score, due_date, created_at, closed_at';

/** One row per technician for a window of `days` ending `offsetDays` ago. */
export async function fetchAdoptionSignals(
  days: AdoptionWindowDays,
  offsetDays = 0,
): Promise<AdoptionSignalRow[]> {
  const { data, error } = await supabase.rpc('get_adoption_signals', {
    p_days: days,
    p_offset_days: offsetDays,
  });
  if (error) throw error;
  return (data as AdoptionSignalRow[]) ?? [];
}

export async function fetchInterventions(): Promise<AdoptionIntervention[]> {
  const { data, error } = await supabase
    .from('adoption_interventions')
    .select(INTERVENTION_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data as AdoptionIntervention[]) ?? [];
}

export async function createIntervention(input: {
  teamMemberId: string;
  kind?: InterventionKind;
  focus: AdoptionDimension[];
  steps: OnboardingStep[];
  note?: string | null;
  baselineScore: number | null;
  dueDate?: string | null;
}): Promise<AdoptionIntervention> {
  const { data, error } = await supabase
    .from('adoption_interventions')
    .insert({
      team_member_id: input.teamMemberId,
      kind: input.kind ?? 'onboarding',
      focus: input.focus,
      steps: input.steps,
      note: input.note?.trim() || null,
      baseline_score: input.baselineScore,
      due_date: input.dueDate || null,
    })
    .select(INTERVENTION_COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505')
      throw new Error('This technician already has an open onboarding plan.');
    throw error;
  }
  return data as AdoptionIntervention;
}

/** Closing records the outcome score so the plan's real effect can be measured later. */
export async function closeIntervention(
  id: string,
  status: Exclude<InterventionStatus, 'open'>,
  outcomeScore: number | null,
): Promise<void> {
  const { error } = await supabase
    .from('adoption_interventions')
    .update({
      status,
      outcome_score: status === 'completed' ? outcomeScore : null,
      closed_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'open');
  if (error) throw error;
}

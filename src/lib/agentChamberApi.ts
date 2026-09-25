import { supabase } from '@/lib/supabase';
import { checkConstitution } from '@/lib/constitution';
import {
  buildChamberCase,
  deriveCampaignSignals,
  type CampaignForm,
  type CampaignSignals,
  type ChamberCase,
  type ChamberRaw,
} from '@/lib/agentChamber';

const DAY_MS = 86_400_000;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
const isoDaysAhead = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();

/** Gathers everything a campaign decision needs. Read-only. */
export async function fetchChamberRaw(ownerId: string): Promise<ChamberRaw> {
  const [scheduled, completed, outcomes, team, settings] = await Promise.all([
    supabase
      .from('jobs')
      .select('scheduled_datetime, duration_minutes, assigned_technician_id')
      .eq('user_id', ownerId)
      .in('job_status', ['scheduled', 'en_route', 'in_progress'])
      .gte('scheduled_datetime', new Date().toISOString())
      .lte('scheduled_datetime', isoDaysAhead(7))
      .limit(5000),
    supabase
      .from('jobs')
      .select('duration_minutes, invoice_amount')
      .eq('user_id', ownerId)
      .eq('job_status', 'completed')
      .gte('completed_at', isoDaysAgo(90))
      .limit(5000),
    supabase
      .from('job_outcomes')
      .select('revenue_cents, cost_cents, caused_callback, is_rework')
      .eq('user_id', ownerId)
      .gte('recorded_at', isoDaysAgo(180))
      .limit(5000),
    supabase.from('team_members').select('id', { count: 'exact', head: true }).eq('account_owner_id', ownerId),
    supabase.from('cash_flow_settings').select('quote_win_rate').eq('user_id', ownerId).maybeSingle(),
  ]);

  for (const result of [scheduled, completed, outcomes, team, settings]) {
    if (result.error) throw result.error;
  }

  const winRate = settings.data as { quote_win_rate: number | string } | null;

  return {
    scheduledJobs: (scheduled.data ?? []) as ChamberRaw['scheduledJobs'],
    completedJobs: (completed.data ?? []) as ChamberRaw['completedJobs'],
    outcomes: (outcomes.data ?? []) as ChamberRaw['outcomes'],
    technicianCount: team.count ?? 0,
    quoteWinRatePct: winRate ? Number(winRate.quote_win_rate) : null,
  };
}

async function isCampaignBlocked(ownerId: string): Promise<boolean> {
  // Use the action_type string your constitution rules are written against.
  const result = await checkConstitution(ownerId, 'outbound_campaign', {});
  return !result.allowed;
}

/** Convenes the chamber for one campaign and saves the case so the owner can decide on it. */
export async function conveneCampaignChamber(
  ownerId: string,
  form: Omit<CampaignForm, 'constitutionBlocked'>,
): Promise<{ id: string; case: ChamberCase; signals: CampaignSignals }> {
  const [raw, blocked] = await Promise.all([fetchChamberRaw(ownerId), isCampaignBlocked(ownerId)]);
  const signals = deriveCampaignSignals(raw, { ...form, constitutionBlocked: blocked });
  const chamberCase = buildChamberCase(signals);

  const { data, error } = await supabase
    .from('agent_chamber_cases')
    .insert({
      user_id: ownerId,
      title: chamberCase.title,
      signals,
      positions: chamberCase.positions,
      conflicts: chamberCase.conflicts,
      tradeoff: chamberCase.tradeoff,
      ceo: chamberCase.ceo,
    })
    .select('id')
    .single();
  if (error) throw error;

  return { id: (data as { id: string }).id, case: chamberCase, signals };
}

/** Records what the owner did with the CEO recommendation. Overrides must carry a reason. */
export async function decideChamberCase(id: string, decision: 'accepted' | 'overridden', note: string | null): Promise<void> {
  const { error } = await supabase
    .from('agent_chamber_cases')
    .update({ owner_decision: decision, owner_note: note, decided_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export interface SavedChamberSummary {
  id: string;
  title: string;
  owner_decision: 'accepted' | 'overridden' | null;
  ceo: { action: string; headline: string };
  created_at: string;
}

export async function fetchRecentChamberCases(ownerId: string, limit = 10): Promise<SavedChamberSummary[]> {
  const { data, error } = await supabase
    .from('agent_chamber_cases')
    .select('id, title, owner_decision, ceo, created_at')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as SavedChamberSummary[];
}

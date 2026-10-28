import { supabase } from './supabase';
import { normalizeHistory, normalizeOverview, type HistoryEntry, type OrgOverview } from './orgChart';

export async function getOrgOverview(): Promise<OrgOverview> {
  const { data, error } = await supabase.rpc('org_chart_overview');
  if (error) throw error;
  return normalizeOverview(data);
}

export async function getOrgHistory(memberId: string): Promise<HistoryEntry[]> {
  const { data, error } = await supabase.rpc('org_chart_history', { p_member: memberId });
  if (error) throw error;
  return normalizeHistory(data);
}

/** `reportsTo` null = reports to the account owner. Resolves to whether anything changed. */
export async function setOrgPosition(args: {
  memberId: string;
  title: string;
  reportsTo: string | null;
  note: string;
}): Promise<boolean> {
  const { data, error } = await supabase.rpc('org_chart_set_position', {
    p_member: args.memberId,
    p_title: args.title,
    p_reports_to: args.reportsTo,
    p_note: args.note,
  });
  if (error) throw error;
  return (data as { changed?: boolean } | null)?.changed === true;
}

import { supabase } from '@/lib/supabase';
import type { OverdueTicket, Severity } from '@/lib/supportSla';

/** Staff only: RLS + the view's own is_vireek_staff() filter return zero rows for everyone else. */
export async function fetchOverdueTickets(): Promise<OverdueTicket[]> {
  const { data, error } = await supabase
    .from('support_overdue_tickets')
    .select('id,severity,severity_confirmed,overdue_kind,overdue_seconds')
    .limit(500);
  if (error) throw error;
  return ((data ?? []) as unknown as OverdueTicket[]).map((r) => ({ ...r, overdue_seconds: Number(r.overdue_seconds) }));
}

/** The trigger stamps confirmed_by/at server-side; the timestamp sent here only signals "confirm". */
export async function setTicketSeverity(conversationId: string, severity: Severity): Promise<void> {
  const { error } = await supabase
    .from('support_conversations')
    .update({ severity, severity_confirmed_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (error) throw error;
}

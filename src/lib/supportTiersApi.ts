import { supabase } from '@/lib/supabase';
import type { OverdueKind } from '@/lib/supportSla';
import type { SupportTierId } from '@/lib/supportTiers';

export interface TierOverdueTicket {
  id: string;
  ticket_number: number | null;
  tier: SupportTierId;
  overdue_kind: OverdueKind;
  overdue_seconds: number;
}

/** Staff only: the view filters on is_vireek_staff(), so everyone else gets zero rows. */
export async function fetchTierOverdueTickets(): Promise<TierOverdueTicket[]> {
  const { data, error } = await supabase
    .from('support_tier_overdue_tickets')
    .select('id,ticket_number,tier,overdue_kind,overdue_seconds')
    .limit(500);
  if (error) throw error;
  return ((data ?? []) as unknown as TierOverdueTicket[]).map((r) => ({ ...r, overdue_seconds: Number(r.overdue_seconds) }));
}

import { supabase } from '@/lib/supabase';
import { isDoubleBookingError, DOUBLE_BOOKING_MESSAGE } from '@/lib/bookingConflict';
import {
  EMPTY_BALANCE,
  LIVE_WINDOW_MS,
  buildQuoteSeed,
  type LiveCall,
  type ScreenPopData,
} from '@/lib/csrScreenPop';

const CALL_COLUMNS =
  'id, caller_phone, caller_name, call_datetime, duration_seconds, is_emergency, is_voicemail, human_transfer_requested, status, sentiment, summary, intent';

export const CALL_SELECT = CALL_COLUMNS;

export async function fetchLiveCalls(ownerId: string): Promise<LiveCall[]> {
  const since = new Date(Date.now() - LIVE_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from('calls')
    .select(CALL_COLUMNS)
    .eq('user_id', ownerId)
    .is('duration_seconds', null)
    .eq('is_voicemail', false)
    .neq('status', 'spam')
    .gte('call_datetime', since)
    .order('call_datetime', { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as unknown as LiveCall[];
}

/** Recently finished calls — lets a CSR open the pop for a call that just ended. */
export async function fetchRecentCalls(ownerId: string, limit = 8): Promise<LiveCall[]> {
  const { data, error } = await supabase
    .from('calls')
    .select(CALL_COLUMNS)
    .eq('user_id', ownerId)
    .eq('is_voicemail', false)
    .order('call_datetime', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as LiveCall[];
}

export async function fetchScreenPop(callId: string): Promise<ScreenPopData> {
  const { data, error } = await supabase.rpc('csr_screen_pop', { p_call_id: callId });
  if (error) throw error;
  if (!data) throw new Error('Call not found');
  const d = data as Partial<ScreenPopData>;
  return {
    matched: Boolean(d.matched),
    customer: d.customer ?? null,
    open_jobs: d.open_jobs ?? [],
    recent_jobs: d.recent_jobs ?? [],
    equipment: d.equipment ?? [],
    balance: d.balance ?? { ...EMPTY_BALANCE },
    open_quotes: d.open_quotes ?? [],
    last_conversation: d.last_conversation ?? null,
    memory: d.memory ?? [],
    history: d.history ?? { total_calls: 0, last_call_at: null },
  };
}

export interface TransferTarget {
  key: string;
  label: string;
  target: { type: 'forwarding' } | { type: 'team_member'; id: string };
}

export async function fetchTransferTargets(ownerId: string): Promise<TransferTarget[]> {
  const targets: TransferTarget[] = [{ key: 'forwarding', label: 'Main line / on-call', target: { type: 'forwarding' } }];
  const { data } = await supabase
    .from('team_members')
    .select('id, member_name, member_phone, role')
    .eq('account_owner_id', ownerId)
    .eq('invite_status', 'active')
    .not('member_phone', 'is', null)
    .order('member_name');
  for (const m of (data ?? []) as { id: string; member_name: string | null; member_phone: string | null; role: string }[]) {
    if (!m.member_phone) continue;
    targets.push({
      key: m.id,
      label: `${m.member_name ?? 'Team member'} (${m.role})`,
      target: { type: 'team_member', id: m.id },
    });
  }
  return targets;
}

export async function transferCall(callId: string, target: TransferTarget['target']): Promise<string> {
  const { data, error } = await supabase.functions.invoke('csr-call-transfer', { body: { call_id: callId, target } });
  if (error) throw new Error(error.message || 'Transfer failed');
  if (!data?.success) throw new Error(data?.error || 'Transfer failed');
  return (data.destination_label as string) ?? 'team';
}

async function audit(ownerId: string, callId: string, action: 'book' | 'quote', detail: Record<string, unknown>) {
  // Best-effort: an audit failure must never block the action the CSR just completed.
  await supabase.from('csr_call_actions').insert({ user_id: ownerId, call_id: callId, action, status: 'success', detail });
}

export interface BookInput {
  ownerId: string;
  call: LiveCall;
  data: ScreenPopData;
  scheduledAt: Date;
  serviceType: string;
  address: string;
  durationMinutes: number;
}

export async function bookJobFromCall(input: BookInput): Promise<{ id: string }> {
  const { ownerId, call, data, scheduledAt, serviceType, address, durationMinutes } = input;
  const { data: job, error } = await supabase
    .from('jobs')
    .insert({
      user_id: ownerId,
      call_id: call.id,
      customer_id: data.customer?.id ?? null,
      customer_name: data.customer?.name ?? call.caller_name ?? 'Unknown caller',
      customer_phone: data.customer?.phone ?? call.caller_phone,
      customer_type: data.customer?.customer_type ?? 'residential',
      service_type: serviceType.trim() || null,
      address: address.trim() || null,
      scheduled_datetime: scheduledAt.toISOString(),
      duration_minutes: durationMinutes,
      job_status: 'scheduled',
    })
    .select('id')
    .single();
  if (error) {
    if (isDoubleBookingError(error)) throw new Error(DOUBLE_BOOKING_MESSAGE);
    throw new Error('Could not book the job');
  }
  await supabase.from('calls').update({ status: 'booked', booking_outcome: 'booked' }).eq('id', call.id);
  void audit(ownerId, call.id, 'book', { job_id: job.id, scheduled_at: scheduledAt.toISOString() });
  return { id: job.id as string };
}

export async function createQuoteDraftFromCall(ownerId: string, call: LiveCall, data: ScreenPopData): Promise<{ id: string }> {
  const seed = buildQuoteSeed(call, data);
  const { data: quote, error } = await supabase
    .from('quotes')
    .insert({
      user_id: ownerId,
      customer_name: seed.customer_name,
      customer_phone: seed.customer_phone,
      customer_email: seed.customer_email,
      line_items: seed.line_items,
      ai_generated: false,
      ai_detected_issue: seed.ai_detected_issue,
    })
    .select('id')
    .single();
  if (error) throw new Error('Could not create the quote');
  void audit(ownerId, call.id, 'quote', { quote_id: quote.id });
  return { id: quote.id as string };
}

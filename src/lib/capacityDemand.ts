import { supabase } from '@/lib/supabase';

export type CapacityStatus = 'low' | 'optimal' | 'full' | 'no_capacity';

export interface CapacityPolicy {
  low_threshold_pct: number;
  full_threshold_pct: number;
  emergency_reserve_slots: number;
  waitlist_enabled: boolean;
  auto_demand_campaigns_enabled: boolean;
}

export interface CapacityStatusResult {
  date: string;
  status: CapacityStatus;
  day_load: number;
  day_capacity: number;
  load_pct: number | null;
  normal_slots_remaining: number;
  emergency_slots_remaining: number;
  policy: CapacityPolicy;
  action_taken?: string;
}

export interface CapacityDemandInsight {
  title: string;
  description: string;
  recommended_action: string;
  priority: number;
}

export interface CapacityWaitlistEntry {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  service_type: string | null;
  requested_date: string;
  notes: string | null;
  priority: number;
  status: 'waiting' | 'offered' | 'booked' | 'expired' | 'cancelled';
  offered_slot: string | null;
  offer_expires_at: string | null;
  job_id: string | null;
  created_at: string;
  updated_at: string;
}

export const STATUS_LABELS: Record<CapacityStatus, string> = {
  low: 'Under capacity — worth generating demand',
  optimal: 'Comfortably booked',
  full: 'At capacity — protect the schedule',
  no_capacity: 'No dispatch-enabled technicians',
};

export const STATUS_COLORS: Record<CapacityStatus, string> = {
  low: 'bg-warning-500/10 text-warning-500',
  optimal: 'bg-success-500/10 text-success-500',
  full: 'bg-danger/10 text-danger',
  no_capacity: 'bg-bg-tertiary text-text-secondary',
};

const ACTION_LABELS: Record<string, string> = {
  demand_campaign_recommended: 'Demand campaign recommended',
  none_campaigns_disabled: 'No action — auto campaigns off',
  waitlist_mode_enabled: 'Waitlist mode enabled',
  campaigns_paused_recommended: 'Pause outbound campaigns recommended',
  no_technicians_configured: 'No technicians configured',
  none: 'No action needed',
};

export function describeAction(action: string | undefined): string {
  if (!action) return '';
  return ACTION_LABELS[action] ?? action;
}

export async function fetchCapacityPolicy(): Promise<CapacityPolicy | null> {
  const { data, error } = await supabase.rpc('get_or_create_capacity_policy');
  if (error) throw error;
  return data as CapacityPolicy | null;
}

export async function updateCapacityPolicy(patch: Partial<CapacityPolicy>): Promise<CapacityPolicy> {
  const { data, error } = await supabase.rpc('update_capacity_demand_policy', {
    p_low_threshold_pct: patch.low_threshold_pct ?? null,
    p_full_threshold_pct: patch.full_threshold_pct ?? null,
    p_emergency_reserve_slots: patch.emergency_reserve_slots ?? null,
    p_waitlist_enabled: patch.waitlist_enabled ?? null,
    p_auto_demand_campaigns_enabled: patch.auto_demand_campaigns_enabled ?? null,
  });
  if (error) throw error;
  return data as CapacityPolicy;
}

export async function fetchCapacityStatus(date?: string): Promise<CapacityStatusResult> {
  const { data, error } = await supabase.rpc('get_capacity_status', { p_date: date ?? null });
  if (error) throw error;
  return data as CapacityStatusResult;
}

/** Runs the decision + logs it + returns it, ready for the AI narrative call below. */
export async function runCapacityDemandControl(date?: string): Promise<CapacityStatusResult> {
  const { data, error } = await supabase.rpc('run_capacity_demand_control', { p_date: date ?? null });
  if (error) throw error;
  return data as CapacityStatusResult;
}

export async function fetchCapacityDemandInsights(
  date?: string,
): Promise<{ status: CapacityStatusResult; insights: CapacityDemandInsight[] }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('capacity-demand-insight', {
    body: { date },
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw error;
  return { status: data?.status, insights: data?.insights ?? [] };
}

export async function fetchCapacityWaitlist(): Promise<CapacityWaitlistEntry[]> {
  const { data, error } = await supabase
    .from('capacity_waitlist_entries')
    .select('*')
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as CapacityWaitlistEntry[]) ?? [];
}

export interface AddWaitlistInput {
  customerName: string;
  requestedDate: string;
  customerPhone?: string;
  customerEmail?: string;
  serviceType?: string;
  notes?: string;
  priority?: number;
}

export async function addToCapacityWaitlist(input: AddWaitlistInput): Promise<CapacityWaitlistEntry> {
  const { data, error } = await supabase.rpc('add_to_capacity_waitlist', {
    p_customer_name: input.customerName,
    p_requested_date: input.requestedDate,
    p_customer_phone: input.customerPhone ?? null,
    p_customer_email: input.customerEmail ?? null,
    p_service_type: input.serviceType ?? null,
    p_notes: input.notes ?? null,
    p_priority: input.priority ?? 0,
  });
  if (error) throw error;
  return data as CapacityWaitlistEntry;
}

export async function updateCapacityWaitlistStatus(
  entryId: string,
  status: CapacityWaitlistEntry['status'],
  offeredSlot?: Date,
  jobId?: string,
): Promise<CapacityWaitlistEntry> {
  const { data, error } = await supabase.rpc('update_capacity_waitlist_status', {
    p_entry_id: entryId,
    p_status: status,
    p_offered_slot: offeredSlot ? offeredSlot.toISOString() : null,
    p_job_id: jobId ?? null,
  });
  if (error) throw error;
  return data as CapacityWaitlistEntry;
}

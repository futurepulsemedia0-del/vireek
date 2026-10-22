import { supabase } from '@/lib/supabase';
import {
  normalizeCampaigns,
  normalizeEvents,
  normalizeOutreach,
  normalizeScan,
  type OutreachAction,
  type OutreachChannel,
  type OutreachEvent,
  type OutreachRow,
  type RecallCampaign,
  type ScanResult,
} from '@/lib/recallMatching';

/**
 * Data access for Recall & Safety-Alert Matching.
 * All reads are tenant + permission scoped by the database (RLS / RPC); every write goes through a
 * SECURITY DEFINER function that re-checks the account and re-validates the status transition.
 * See supabase/migrations/20271018000000_recall_safety_matching.sql.
 */

export async function fetchRecallCampaigns(): Promise<RecallCampaign[]> {
  const { data, error } = await supabase.rpc('get_recall_campaigns');
  if (error) throw error;
  return normalizeCampaigns(data);
}

export async function fetchRecallOutreach(campaignId: string): Promise<OutreachRow[]> {
  const { data, error } = await supabase.rpc('get_recall_outreach', { p_campaign_id: campaignId });
  if (error) throw error;
  return normalizeOutreach(data);
}

export async function fetchOutreachEvents(outreachId: string): Promise<OutreachEvent[]> {
  const { data, error } = await supabase
    .from('recall_outreach_events')
    .select('id, event_type, channel, from_status, to_status, note, created_at')
    .eq('outreach_id', outreachId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return normalizeEvents(data);
}

/** Re-checks every recall and bulletin against this account's equipment. Safe to run repeatedly. */
export async function scanMyAccountForRecalls(): Promise<ScanResult> {
  const { data, error } = await supabase.rpc('recall_scan_my_account');
  if (error) throw error;
  return normalizeScan(data);
}

export interface LogOutreachInput {
  outreachId: string;
  action: OutreachAction;
  channel?: OutreachChannel | null;
  note?: string;
  followUpAt?: string | null;
  jobId?: string | null;
}

export async function logRecallOutreach(input: LogOutreachInput): Promise<void> {
  const { error } = await supabase.rpc('recall_log_outreach', {
    p_outreach_id: input.outreachId,
    p_action: input.action,
    p_channel: input.channel ?? null,
    p_note: input.note?.trim() ? input.note.trim() : null,
    p_follow_up_at: input.followUpAt ?? null,
    p_job_id: input.jobId ?? null,
  });
  if (error) throw error;
}

export async function setRecallCampaignStatus(campaignId: string, status: 'active' | 'paused' | 'cancelled', note?: string): Promise<void> {
  const { error } = await supabase.rpc('recall_set_campaign_status', {
    p_campaign_id: campaignId,
    p_status: status,
    p_note: note?.trim() ? note.trim() : null,
  });
  if (error) throw error;
}

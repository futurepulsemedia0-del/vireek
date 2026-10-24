// Open Job Board — data access.
//
// Every mutation goes through a SECURITY DEFINER RPC (migration
// 20271102000000_open_job_board.sql). Tables are dispatcher-read-only; technicians
// read through getMyOffers(); subcontractors use the token RPCs (no account).
// Functions throw an Error whose message is the RPC's machine code — pass it to
// describeJobBoardError() for user-facing copy.

import { supabase } from '@/lib/supabase';
import type {
  AudienceEntry,
  FairnessRow,
  JobBoardBid,
  JobBoardEvent,
  JobBoardPost,
  JobBoardRecipient,
  JobBoardSettings,
  JobBoardSummary,
  JobBoardVendor,
  PostAudience,
  PostJobInput,
  PostPriority,
  TechOffer,
  VendorOffer,
} from '@/lib/jobBoard';

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export interface PostableJob {
  id: string;
  customer_name: string;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  duration_minutes: number | null;
  assigned_technician_id: string | null;
  job_status: string;
}

export const jobBoardApi = {
  // ---- dispatcher: rules & subcontractors --------------------------------
  settings: () => rpc<JobBoardSettings>('get_job_board_settings'),
  saveSettings: (s: Partial<JobBoardSettings>) => rpc<void>('save_job_board_settings', { p: s }),
  vendors: () => rpc<JobBoardVendor[]>('get_job_board_vendors'),
  saveVendorProfile: (vendorId: string, enabled: boolean, skills: string[], areaIds: string[], notes: string) =>
    rpc<void>('save_job_board_vendor_profile', {
      p_vendor_id: vendorId,
      p_enabled: enabled,
      p_skills: skills,
      p_area_ids: areaIds,
      p_notes: notes,
    }),

  // ---- dispatcher: posts --------------------------------------------------
  summary: () => rpc<JobBoardSummary>('get_job_board_summary'),
  fairness: () => rpc<FairnessRow[]>('get_job_board_fairness'),
  /** Marks stale open posts as expired (auto-awards opted-in bidding posts). Idempotent. */
  expire: () => rpc<number>('expire_job_board_posts'),

  previewAudience: (jobId: string, skill: string, areaId: string | null, audience: PostAudience, priority: PostPriority) =>
    rpc<AudienceEntry[]>('preview_job_board_audience', {
      p_job_id: jobId,
      p_skill: skill || null,
      p_area_id: areaId,
      p_audience: audience,
      p_priority: priority,
    }),

  post: (i: PostJobInput) =>
    rpc<string>('post_job_board_job', {
      p_job_id: i.jobId,
      p_source: i.source,
      p_audience: i.audience,
      p_claim_mode: i.claimMode,
      p_priority: i.priority,
      p_skill: i.skill || null,
      p_area_id: i.areaId,
      p_title: i.title,
      p_summary: i.summary || null,
      p_location_label: i.locationLabel || null,
      p_offer_cents: i.offerCents,
      p_max_bid_cents: i.maxBidCents,
      p_expires_minutes: i.expiresMinutes,
      p_auto_award: i.autoAward,
    }),

  awardBid: (postId: string, bidId: string, priceCents?: number | null) =>
    rpc<void>('award_job_board_post', {
      p_post_id: postId,
      p_bid_id: bidId,
      p_price_cents: priceCents ?? null,
    }),

  /** Dispatcher override: straight to one technician OR one vendor, with a mandatory reason. */
  override: (postId: string, target: { technicianId?: string; vendorId?: string }, reason: string, priceCents?: number | null) =>
    rpc<void>('award_job_board_post', {
      p_post_id: postId,
      p_technician_id: target.technicianId ?? null,
      p_vendor_id: target.vendorId ?? null,
      p_price_cents: priceCents ?? null,
      p_override: true,
      p_reason: reason,
    }),

  reopen: (postId: string, minutes?: number | null) =>
    rpc<void>('reopen_job_board_post', { p_post_id: postId, p_minutes: minutes ?? null }),
  cancel: (postId: string) => rpc<void>('cancel_job_board_post', { p_post_id: postId }),

  /** Hands the post to the existing Contractor Network handoff flow; stays in sync afterwards. */
  escalate: (postId: string, trade: string, referralFeePct: number, notes: string, smartMatch: boolean) =>
    rpc<string>('escalate_job_board_post_to_network', {
      p_post_id: postId,
      p_trade: trade,
      p_referral_fee_pct: referralFeePct,
      p_notes: notes || null,
      p_smart_match: smartMatch,
    }),

  /** Rotates and returns a fresh raw token (shown once). */
  issueVendorLink: (postId: string, vendorId: string) =>
    rpc<string>('issue_job_board_vendor_link', { p_post_id: postId, p_vendor_id: vendorId }),

  // ---- dispatcher: reads (RLS: dispatchers only) --------------------------
  async listPosts(): Promise<JobBoardPost[]> {
    const { data, error } = await supabase
      .from('job_board_posts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as JobBoardPost[];
  },

  async listRecipients(postIds: string[]): Promise<JobBoardRecipient[]> {
    if (postIds.length === 0) return [];
    const { data, error } = await supabase.from('job_board_recipients').select('*').in('post_id', postIds);
    if (error) throw new Error(error.message);
    return (data ?? []) as JobBoardRecipient[];
  },

  async listBids(postIds: string[]): Promise<JobBoardBid[]> {
    if (postIds.length === 0) return [];
    const { data, error } = await supabase.from('job_board_bids').select('*').in('post_id', postIds);
    if (error) throw new Error(error.message);
    return (data ?? []) as JobBoardBid[];
  },

  async listEvents(postId: string): Promise<JobBoardEvent[]> {
    const { data, error } = await supabase
      .from('job_board_events')
      .select('id, post_id, actor_label, event, detail, created_at')
      .eq('post_id', postId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as JobBoardEvent[];
  },

  /** Jobs that could be posted: not finished, not already live on the board. */
  async listPostableJobs(): Promise<PostableJob[]> {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, customer_name, service_type, address, scheduled_datetime, duration_minutes, assigned_technician_id, job_status')
      .in('job_status', ['scheduled'])
      .order('scheduled_datetime', { ascending: true, nullsFirst: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return (data ?? []) as PostableJob[];
  },

  async listTechnicians(): Promise<Array<{ id: string; name: string }>> {
    const { data, error } = await supabase
      .from('team_members')
      .select('id, member_name, member_email')
      .eq('role', 'technician')
      .eq('invite_status', 'active')
      .order('member_name', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map((t) => ({
      id: t.id as string,
      name: ((t.member_name as string | null)?.trim() || (t.member_email as string)) ?? '',
    }));
  },

  async listAreas(): Promise<Array<{ id: string; name: string }>> {
    const { data, error } = await supabase.from('service_areas').select('id, name').eq('is_active', true).order('name');
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ id: string; name: string }>;
  },

  // ---- technician ---------------------------------------------------------
  getMyOffers: () => rpc<{ server_now: string; offers: TechOffer[] }>('get_my_job_board_offers'),
  claim: (postId: string, note?: string) => rpc<'awarded' | 'bid'>('claim_job_board_post', { p_post_id: postId, p_note: note ?? null }),
  decline: (postId: string, reason?: string) => rpc<void>('decline_job_board_post', { p_post_id: postId, p_reason: reason ?? null }),
  withdraw: (postId: string) => rpc<void>('withdraw_job_board_bid', { p_post_id: postId }),

  // ---- subcontractor (public, token-secured) ------------------------------
  getOffer: (token: string) => rpc<VendorOffer>('get_job_board_offer', { p_token: token }),
  respondOffer: (token: string, action: 'bid' | 'decline' | 'withdraw', priceCents?: number | null, note?: string) =>
    rpc<VendorOffer>('respond_job_board_offer', {
      p_token: token,
      p_action: action,
      p_price_cents: priceCents ?? null,
      p_note: note ?? null,
    }),
};

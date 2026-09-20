/**
 * Marketing ROI Attribution — Click-to-Cash.
 *
 * Follows the same architecture as Technician Performance OS and Skill
 * Graph: no new analysis pipeline, everything aggregated client-side from
 * data that (mostly) already exists:
 * - `marketing_attribution_touches` — web clicks with source/medium/
 *   campaign/UTM, keyed by lead_id or customer_id.
 * - `calls.lead_source` / `calls.source_label` — phone-in leads.
 * - `jobs.booking_channel` — self-serve web bookings with no matched
 *   UTM touch.
 * - `jobs.lead_id` / `jobs.customer_id` / `jobs.call_id` — the join keys
 *   from a click to the job it produced.
 * - The `job_profitability` view (via `@/lib/jobCosting`) — REAL revenue
 *   and cost per job, not just invoice amount. "Cash" in this feature
 *   means true gross profit after labor/material/equipment/subcontractor/
 *   permit/other cost, exactly what the Profitability page already shows
 *   per job — this reuses that, it does not recompute margin itself.
 *
 * The one new table, `marketing_channel_spend`, exists only because ROI
 * has no meaning without a cost side, and nothing in the schema tracks
 * ad spend. Everything else here is a join + aggregation.
 */

import { supabase, Job, Lead, Call } from '@/lib/supabase';
import type { JobProfitability } from '@/lib/jobCosting';

// ============================================================
// TYPES
// ============================================================

export interface AttributionTouch {
  id: string;
  user_id: string;
  customer_id: string | null;
  lead_id: string | null;
  anonymous_id: string;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  is_first_touch: boolean;
  occurred_at: string;
}

export interface ChannelSpend {
  id: string;
  user_id: string;
  channel: string;
  campaign: string | null;
  period_start: string;
  period_end: string;
  spend_cents: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type ChannelSpendFormState = {
  channel: string;
  campaign: string;
  period_start: string;
  period_end: string;
  spend: string; // dollars, as typed in the input
  notes: string;
};

export const EMPTY_CHANNEL_SPEND_FORM: ChannelSpendFormState = {
  channel: '',
  campaign: '',
  period_start: '',
  period_end: '',
  spend: '',
  notes: '',
};

export interface ChannelFunnel {
  channel: string;
  clicksOrCalls: number;
  leads: number;
  jobsBooked: number;
  jobsPaid: number;
  revenueCents: number;
  grossProfitCents: number; // real margin, from job_profitability
  spendCents: number;
  roiPct: number | null; // (grossProfit - spend) / spend * 100
  costPerLeadCents: number | null;
  costPerAcquisitionCents: number | null; // spend / jobsPaid
  clickToLeadPct: number | null;
  leadToJobPct: number | null;
  jobToPaidPct: number | null;
}

export interface ClickToCashResult {
  periodStart: string;
  periodEnd: string;
  channels: ChannelFunnel[];
  unattributedRevenueCents: number; // revenue from jobs we couldn't trace to any channel
}

// ============================================================
// HELPERS
// ============================================================

function round(n: number, decimals = 1): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function normalizeChannel(raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return 'Unknown / Direct';
  return raw.trim().toLowerCase();
}

function inRange(iso: string | null | undefined, start: Date, end: Date): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return d >= start && d <= end;
}

// ============================================================
// CHANNEL RESOLUTION
// ============================================================

/**
 * For one job, resolves which marketing channel produced it, in order of
 * specificity: a matched UTM touch (by lead_id, then customer_id, first
 * touch preferred) > the originating call's lead_source/source_label >
 * the job's own booking_channel (self-serve booking, no matched touch) >
 * unattributed.
 */
function resolveChannel(
  job: Job,
  touchesByLeadId: Map<string, AttributionTouch[]>,
  touchesByCustomerId: Map<string, AttributionTouch[]>,
  callsById: Map<string, Call>,
  leadsById: Map<string, Lead>,
): string | null {
  const pickTouch = (touches: AttributionTouch[] | undefined): AttributionTouch | null => {
    if (!touches || touches.length === 0) return null;
    const firstTouch = touches.find((t) => t.is_first_touch);
    return firstTouch ?? [...touches].sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())[0];
  };

  const touch =
    (job.lead_id ? pickTouch(touchesByLeadId.get(job.lead_id)) : null) ??
    (job.customer_id ? pickTouch(touchesByCustomerId.get(job.customer_id)) : null);
  if (touch) return normalizeChannel(touch.source);

  const call = job.call_id
    ? callsById.get(job.call_id)
    : job.lead_id
      ? (() => {
          const lead = leadsById.get(job.lead_id as string);
          return lead?.call_id ? callsById.get(lead.call_id) : undefined;
        })()
      : undefined;
  if (call) return normalizeChannel(call.lead_source ?? call.source_label);

  if (job.booking_channel) return normalizeChannel(job.booking_channel as string);

  return null;
}

// ============================================================
// MAIN AGGREGATION
// ============================================================

export function computeClickToCash(
  allJobs: Job[],
  allLeads: Lead[],
  allCalls: Call[],
  allTouches: AttributionTouch[],
  allSpend: ChannelSpend[],
  allProfitability: JobProfitability[],
  periodStart: Date,
  periodEnd: Date,
): ClickToCashResult {
  const touchesByLeadId = new Map<string, AttributionTouch[]>();
  const touchesByCustomerId = new Map<string, AttributionTouch[]>();
  for (const t of allTouches) {
    if (t.lead_id) touchesByLeadId.set(t.lead_id, [...(touchesByLeadId.get(t.lead_id) ?? []), t]);
    if (t.customer_id) touchesByCustomerId.set(t.customer_id, [...(touchesByCustomerId.get(t.customer_id) ?? []), t]);
  }
  const callsById = new Map(allCalls.map((c) => [c.id, c]));
  const leadsById = new Map(allLeads.map((l) => [l.id, l]));
  const profitabilityByJobId = new Map(allProfitability.map((p) => [p.job_id, p]));

  const jobsInRange = allJobs.filter((j) => j.job_status !== 'cancelled' && inRange(j.scheduled_datetime, periodStart, periodEnd));

  const byChannel = new Map<
    string,
    { clicksOrCalls: number; leadIds: Set<string>; jobsBooked: Job[]; jobsPaid: Job[]; revenueCents: number; grossProfitCents: number }
  >();
  const getBucket = (channel: string) => {
    const existing = byChannel.get(channel);
    if (existing) return existing;
    const fresh = { clicksOrCalls: 0, leadIds: new Set<string>(), jobsBooked: [] as Job[], jobsPaid: [] as Job[], revenueCents: 0, grossProfitCents: 0 };
    byChannel.set(channel, fresh);
    return fresh;
  };

  // Top-of-funnel: every touch and every lead-generating call counts as a click/call.
  for (const t of allTouches) {
    if (!inRange(t.occurred_at, periodStart, periodEnd)) continue;
    getBucket(normalizeChannel(t.source)).clicksOrCalls += 1;
  }
  for (const c of allCalls) {
    if (!inRange(c.call_datetime, periodStart, periodEnd)) continue;
    if (!c.lead_source && !c.source_label) continue;
    getBucket(normalizeChannel(c.lead_source ?? c.source_label)).clicksOrCalls += 1;
  }

  // Leads, in range by creation date.
  for (const lead of allLeads) {
    if (!inRange(lead.created_at, periodStart, periodEnd)) continue;
    const touch = touchesByLeadId.get(lead.id);
    let channel: string | null = null;
    if (touch && touch.length > 0) {
      channel = normalizeChannel((touch.find((t) => t.is_first_touch) ?? touch[0]).source);
    } else if (lead.call_id) {
      const call = callsById.get(lead.call_id);
      if (call) channel = normalizeChannel(call.lead_source ?? call.source_label);
    }
    if (channel) getBucket(channel).leadIds.add(lead.id);
  }

  let unattributedRevenueCents = 0;

  for (const job of jobsInRange) {
    const channel = resolveChannel(job, touchesByLeadId, touchesByCustomerId, callsById, leadsById);
    const profitability = profitabilityByJobId.get(job.id);

    if (!channel) {
      if (profitability && job.invoice_status === 'paid') unattributedRevenueCents += profitability.revenue_cents;
      continue;
    }

    const bucket = getBucket(channel);
    bucket.jobsBooked.push(job);
    if (job.invoice_status === 'paid' && profitability) {
      bucket.jobsPaid.push(job);
      bucket.revenueCents += profitability.revenue_cents;
      bucket.grossProfitCents += profitability.gross_profit_cents;
    }
  }

  const spendByChannel = new Map<string, number>();
  for (const s of allSpend) {
    // Spend applies if its logged period overlaps the requested window at all.
    const sStart = new Date(s.period_start);
    const sEnd = new Date(s.period_end);
    if (sEnd < periodStart || sStart > periodEnd) continue;
    const key = normalizeChannel(s.channel);
    spendByChannel.set(key, (spendByChannel.get(key) ?? 0) + s.spend_cents);
  }
  // Make sure a channel with spend but no traffic yet still shows up (a
  // campaign just launched, or one that flopped and produced nothing).
  for (const channel of spendByChannel.keys()) getBucket(channel);

  const channels: ChannelFunnel[] = [...byChannel.entries()].map(([channel, b]) => {
    const spendCents = spendByChannel.get(channel) ?? 0;
    const leads = b.leadIds.size;
    const jobsBooked = b.jobsBooked.length;
    const jobsPaid = b.jobsPaid.length;

    return {
      channel,
      clicksOrCalls: b.clicksOrCalls,
      leads,
      jobsBooked,
      jobsPaid,
      revenueCents: b.revenueCents,
      grossProfitCents: b.grossProfitCents,
      spendCents,
      roiPct: spendCents > 0 ? round(((b.grossProfitCents - spendCents) / spendCents) * 100) : null,
      costPerLeadCents: spendCents > 0 && leads > 0 ? Math.round(spendCents / leads) : null,
      costPerAcquisitionCents: spendCents > 0 && jobsPaid > 0 ? Math.round(spendCents / jobsPaid) : null,
      clickToLeadPct: b.clicksOrCalls > 0 ? round((leads / b.clicksOrCalls) * 100) : null,
      leadToJobPct: leads > 0 ? round((jobsBooked / leads) * 100) : null,
      jobToPaidPct: jobsBooked > 0 ? round((jobsPaid / jobsBooked) * 100) : null,
    };
  });

  channels.sort((a, b) => b.grossProfitCents - a.grossProfitCents);

  return { periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), channels, unattributedRevenueCents };
}

// ============================================================
// PERSISTENCE
// ============================================================

export async function fetchAttributionTouches(): Promise<AttributionTouch[]> {
  const { data, error } = await supabase.from('marketing_attribution_touches').select('*').order('occurred_at', { ascending: false }).limit(5000);
  if (error) throw error;
  return (data as AttributionTouch[]) ?? [];
}

export async function fetchChannelSpend(): Promise<ChannelSpend[]> {
  const { data, error } = await supabase.from('marketing_channel_spend').select('*').order('period_start', { ascending: false });
  if (error) throw error;
  return (data as ChannelSpend[]) ?? [];
}

export function spendFormToPayload(form: ChannelSpendFormState, userId: string) {
  return {
    user_id: userId,
    channel: form.channel.trim(),
    campaign: form.campaign.trim() || null,
    period_start: form.period_start,
    period_end: form.period_end,
    spend_cents: Math.round(parseFloat(form.spend || '0') * 100),
    notes: form.notes.trim() || null,
  };
}

export async function saveChannelSpend(form: ChannelSpendFormState, userId: string, existingId?: string): Promise<ChannelSpend> {
  const payload = spendFormToPayload(form, userId);
  if (existingId) {
    const { data, error } = await supabase.from('marketing_channel_spend').update(payload).eq('id', existingId).select().single();
    if (error) throw error;
    return data as ChannelSpend;
  }
  const { data, error } = await supabase.from('marketing_channel_spend').insert(payload).select().single();
  if (error) throw error;
  return data as ChannelSpend;
}

export async function deleteChannelSpend(id: string): Promise<void> {
  const { error } = await supabase.from('marketing_channel_spend').delete().eq('id', id);
  if (error) throw error;
}

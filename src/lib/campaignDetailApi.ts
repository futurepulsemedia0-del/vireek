import { supabase } from '@/lib/supabase';
import type {
  CampaignStatus,
  MarketingCampaign,
  MarketingCampaignEnrollment,
  MarketingCampaignStep,
} from '@/lib/marketing';
import { cloneName, type CampaignSend, type ContactInfo, type PaidJob } from '@/lib/campaignDetail';

const PAGE = 1000;
/** Hard ceiling per table so a huge campaign can't freeze the browser; the UI warns when hit. */
const MAX_ROWS = 5000;
const CHUNK = 100;

export interface CampaignBundle {
  campaign: MarketingCampaign;
  steps: MarketingCampaignStep[];
  enrollments: MarketingCampaignEnrollment[];
  sends: CampaignSend[];
  contacts: Map<string, ContactInfo>;
  paidJobs: PaidJob[];
  truncated: boolean;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchAll<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await run(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** Returns null when the campaign does not exist in this account (wrong id or another tenant). */
export async function fetchCampaignBundle(ownerId: string, campaignId: string): Promise<CampaignBundle | null> {
  const { data: campaign, error: campaignError } = await supabase
    .from('marketing_campaigns')
    .select('*')
    .eq('id', campaignId)
    .eq('user_id', ownerId)
    .maybeSingle();
  if (campaignError) throw new Error(campaignError.message);
  if (!campaign) return null;

  const [stepsRes, enrollRes] = await Promise.all([
    supabase
      .from('marketing_campaign_steps')
      .select('id, campaign_id, step_order, delay_hours, channel, subject, body')
      .eq('campaign_id', campaignId)
      .eq('user_id', ownerId)
      .order('step_order', { ascending: true }),
    fetchAll<MarketingCampaignEnrollment>((from, to) =>
      supabase
        .from('marketing_campaign_enrollments')
        .select('id, campaign_id, customer_id, lead_id, contact_email, contact_phone, current_step, status, enrolled_at, next_send_at, converted_at')
        .eq('campaign_id', campaignId)
        .eq('user_id', ownerId)
        .order('enrolled_at', { ascending: false })
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ]);
  if (stepsRes.error) throw new Error(stepsRes.error.message);
  const steps = (stepsRes.data ?? []) as MarketingCampaignStep[];
  const enrollments = enrollRes.rows;

  const stepIds = steps.map((s) => s.id);
  const sendsRes = stepIds.length
    ? await fetchAll<CampaignSend>((from, to) =>
        supabase
          .from('marketing_campaign_sends')
          .select('enrollment_id, step_id, channel, status, error, sent_at')
          .in('step_id', stepIds)
          .eq('user_id', ownerId)
          .order('sent_at', { ascending: false })
          .order('enrollment_id', { ascending: true })
          .range(from, to),
      )
    : { rows: [] as CampaignSend[], truncated: false };

  const customerIds = [...new Set(enrollments.map((e) => e.customer_id).filter((v): v is string => !!v))];
  const leadIds = [...new Set(enrollments.map((e) => e.lead_id).filter((v): v is string => !!v))];

  const [contacts, paidJobs] = await Promise.all([
    fetchContacts(ownerId, customerIds, leadIds),
    fetchPaidJobs(ownerId, customerIds, leadIds),
  ]);

  return {
    campaign: campaign as MarketingCampaign,
    steps,
    enrollments,
    sends: sendsRes.rows,
    contacts,
    paidJobs,
    truncated: enrollRes.truncated || sendsRes.truncated,
  };
}

async function fetchContacts(ownerId: string, customerIds: string[], leadIds: string[]): Promise<Map<string, ContactInfo>> {
  const map = new Map<string, ContactInfo>();
  const jobs: PromiseLike<void>[] = [];
  for (const ids of chunk(customerIds, CHUNK)) {
    jobs.push(
      supabase
        .from('customers')
        .select('id, name')
        .eq('user_id', ownerId)
        .in('id', ids)
        .then(({ data, error }) => {
          if (error) throw new Error(error.message);
          for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) {
            map.set(`c:${r.id}`, { name: r.name?.trim() || 'Unnamed customer' });
          }
        }),
    );
  }
  for (const ids of chunk(leadIds, CHUNK)) {
    jobs.push(
      supabase
        .from('leads')
        .select('id, name')
        .eq('user_id', ownerId)
        .in('id', ids)
        .then(({ data, error }) => {
          if (error) throw new Error(error.message);
          for (const r of (data ?? []) as Array<{ id: string; name: string | null }>) {
            map.set(`l:${r.id}`, { name: r.name?.trim() || 'Unnamed lead' });
          }
        }),
    );
  }
  await Promise.all(jobs);
  return map;
}

async function fetchPaidJobs(ownerId: string, customerIds: string[], leadIds: string[]): Promise<PaidJob[]> {
  const byId = new Map<string, PaidJob>();
  const jobs: PromiseLike<void>[] = [];
  const collect = (column: 'customer_id' | 'lead_id', ids: string[]) => {
    for (const part of chunk(ids, CHUNK)) {
      jobs.push(
        supabase
          .from('jobs')
          .select('id, customer_id, lead_id, invoice_amount, created_at')
          .eq('user_id', ownerId)
          .eq('invoice_status', 'paid')
          .in(column, part)
          .limit(PAGE)
          .then(({ data, error }) => {
            if (error) throw new Error(error.message);
            for (const j of (data ?? []) as PaidJob[]) byId.set(j.id, j);
          }),
      );
    }
  };
  collect('customer_id', customerIds);
  collect('lead_id', leadIds);
  await Promise.all(jobs);
  return [...byId.values()];
}

export async function setCampaignStatus(ownerId: string, campaignId: string, status: CampaignStatus): Promise<void> {
  const { data, error } = await supabase
    .from('marketing_campaigns')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', campaignId)
    .eq('user_id', ownerId)
    .select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('Campaign not found or you do not have permission to change it.');
}

/** Copies the campaign and its steps into a new draft. Enrollments and sends are never copied. */
export async function cloneCampaign(
  ownerId: string,
  source: MarketingCampaign,
  steps: MarketingCampaignStep[],
): Promise<string> {
  const { data: created, error } = await supabase
    .from('marketing_campaigns')
    .insert({
      user_id: ownerId,
      name: cloneName(source.name),
      campaign_type: source.campaign_type,
      segment_id: source.segment_id,
      trigger_type: source.trigger_type,
      trigger_event: source.trigger_event,
      goal_event: source.goal_event,
      status: 'draft',
    })
    .select('id')
    .single();
  if (error || !created) throw new Error(error?.message ?? 'Could not create the copy.');

  if (steps.length > 0) {
    const { error: stepsError } = await supabase.from('marketing_campaign_steps').insert(
      steps.map((s) => ({
        campaign_id: created.id,
        user_id: ownerId,
        step_order: s.step_order,
        delay_hours: s.delay_hours,
        channel: s.channel,
        subject: s.subject,
        body: s.body,
      })),
    );
    if (stepsError) {
      // Never leave a half-copied campaign behind.
      await supabase.from('marketing_campaigns').delete().eq('id', created.id).eq('user_id', ownerId);
      throw new Error(stepsError.message);
    }
  }
  return created.id as string;
}

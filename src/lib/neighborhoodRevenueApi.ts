import { supabase } from '@/lib/supabase';
import {
  canTransition, requiresAck,
  type CampaignStatus, type EquipmentSnapshot, type NearbyProperty, type NeighborhoodChannel,
} from '@/lib/neighborhoodRevenue';

export interface OpportunityOverview {
  opportunity_id: string;
  status: 'open' | 'campaign_planned';
  radius_m: number;
  source_job_id: string;
  customer_name: string;
  service_type: string | null;
  address: string | null;
  completed_at: string | null;
  latitude: number | null;
  longitude: number | null;
  scheduled_nearby: number;
  created_at: string;
}

export interface NeighborhoodCampaign {
  id: string;
  opportunity_id: string;
  channel: NeighborhoodChannel;
  status: CampaignStatus;
  offer_text: string;
  budget: number;
  starts_on: string | null;
  ends_on: string | null;
  compliance_ack_at: string | null;
  created_at: string;
}

export interface CampaignResult {
  campaign_id: string;
  zone_jobs: number;
  zone_completed: number;
  zone_revenue: number;
}

export async function fetchOverview(): Promise<OpportunityOverview[]> {
  const { data, error } = await supabase.rpc('neighborhood_opportunities_overview');
  if (error) throw error;
  return (data ?? []) as OpportunityOverview[];
}

export async function fetchNearbyProperties(opportunityId: string): Promise<NearbyProperty[]> {
  const { data, error } = await supabase.rpc('neighborhood_nearby_properties', { p_opportunity_id: opportunityId });
  if (error) throw error;
  return ((data ?? []) as Array<Omit<NearbyProperty, 'equipment'> & { equipment: unknown }>).map((row) => ({
    ...row,
    equipment: Array.isArray(row.equipment) ? (row.equipment as EquipmentSnapshot[]) : [],
  }));
}

export async function fetchCampaigns(): Promise<NeighborhoodCampaign[]> {
  const { data, error } = await supabase
    .from('neighborhood_campaigns')
    .select('id, opportunity_id, channel, status, offer_text, budget, starts_on, ends_on, compliance_ack_at, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as NeighborhoodCampaign[];
}

export async function fetchCampaignResults(): Promise<CampaignResult[]> {
  const { data, error } = await supabase.rpc('neighborhood_campaign_results');
  if (error) throw error;
  return ((data ?? []) as CampaignResult[]).map((r) => ({ ...r, zone_revenue: Number(r.zone_revenue) || 0 }));
}

export async function createCampaignDraft(input: {
  opportunityId: string;
  channel: NeighborhoodChannel;
  offerText: string;
  budget: number;
  startsOn: string | null;
  endsOn: string | null;
}): Promise<NeighborhoodCampaign> {
  const offer = input.offerText.trim();
  if (!offer) throw new Error('Write the offer text first.');
  if (!Number.isFinite(input.budget) || input.budget < 0) throw new Error('Budget must be zero or more.');
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) throw new Error('End date is before the start date.');

  const { data, error } = await supabase
    .from('neighborhood_campaigns')
    .insert({
      opportunity_id: input.opportunityId,
      channel: input.channel,
      offer_text: offer,
      budget: input.budget,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
    })
    .select('id, opportunity_id, channel, status, offer_text, budget, starts_on, ends_on, compliance_ack_at, created_at')
    .single();
  if (error) throw error;
  return data as NeighborhoodCampaign;
}

export async function transitionCampaign(
  campaign: NeighborhoodCampaign,
  next: CampaignStatus,
  acknowledged: boolean
): Promise<void> {
  if (!canTransition(campaign.status, next)) throw new Error(`Cannot move a ${campaign.status} campaign to ${next}.`);
  if (requiresAck(next) && !acknowledged && !campaign.compliance_ack_at) {
    throw new Error('Confirm the compliance checklist first.');
  }
  const patch: Record<string, unknown> = { status: next, updated_at: new Date().toISOString() };
  if (requiresAck(next) && !campaign.compliance_ack_at) patch.compliance_ack_at = new Date().toISOString();

  const { data, error } = await supabase.from('neighborhood_campaigns').update(patch).eq('id', campaign.id).select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('This campaign could not be updated.');
}

export async function dismissOpportunity(opportunityId: string): Promise<void> {
  const { data, error } = await supabase
    .from('neighborhood_opportunities')
    .update({ status: 'dismissed', updated_at: new Date().toISOString() })
    .eq('id', opportunityId)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('This opportunity could not be dismissed.');
}

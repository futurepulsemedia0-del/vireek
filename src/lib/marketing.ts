import type { LucideIcon } from 'lucide-react';
import { Droplets, RefreshCw, Gift, Target } from 'lucide-react';

export type CampaignType = 'drip' | 'lifecycle' | 'reactivation' | 'referral';
export type CampaignStatus = 'draft' | 'active' | 'paused';
export type TriggerType = 'segment_entry' | 'event' | 'manual';
export type TriggerEvent = 'lead_created' | 'job_completed' | 'job_paid';
export type StepChannel = 'email' | 'sms';
export type EnrollmentStatus = 'active' | 'completed' | 'stopped' | 'converted';

export interface CampaignTypeConfig {
  type: CampaignType;
  label: string;
  icon: LucideIcon;
  description: string;
}

export const CAMPAIGN_TYPES: CampaignTypeConfig[] = [
  { type: 'drip', label: 'Drip campaign', icon: Droplets, description: 'A timed sequence of emails/texts sent after someone enters a segment.' },
  { type: 'lifecycle', label: 'Lifecycle marketing', icon: Target, description: 'Messaging tied to where a customer sits in their lifecycle (lead → active → VIP).' },
  { type: 'reactivation', label: 'Customer reactivation', icon: RefreshCw, description: 'Wins back customers who have gone quiet for a while.' },
  { type: 'referral', label: 'Referral campaign', icon: Gift, description: 'Turns customers into a referral source with trackable codes and rewards.' },
];

export function getCampaignTypeConfig(type: CampaignType): CampaignTypeConfig {
  return CAMPAIGN_TYPES.find((c) => c.type === type) ?? CAMPAIGN_TYPES[0];
}

export interface MarketingSegment {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  filter: Record<string, unknown>;
  is_dynamic: boolean;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface MarketingCampaign {
  id: string;
  user_id: string;
  name: string;
  campaign_type: CampaignType;
  segment_id: string | null;
  trigger_type: TriggerType;
  trigger_event: TriggerEvent | null;
  status: CampaignStatus;
  goal_event: string | null;
  created_at: string;
  updated_at: string;
}

export interface MarketingCampaignStep {
  id: string;
  campaign_id: string;
  step_order: number;
  delay_hours: number;
  channel: StepChannel;
  subject: string | null;
  body: string;
}

export interface MarketingCampaignEnrollment {
  id: string;
  campaign_id: string;
  customer_id: string | null;
  lead_id: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  current_step: number;
  status: EnrollmentStatus;
  enrolled_at: string;
  next_send_at: string | null;
  converted_at: string | null;
}

export interface LeadScore {
  customer_id: string | null;
  lead_id: string | null;
  score: number;
  grade: 'cold' | 'warm' | 'hot';
  factors: Record<string, number>;
  updated_at: string;
}

export interface ReferralCode {
  id: string;
  customer_id: string | null;
  code: string;
  reward_type: 'credit' | 'discount' | 'cash';
  reward_value: number;
  clicks: number;
  created_at: string;
}

export interface ReferralConversion {
  id: string;
  referral_code_id: string;
  referred_customer_id: string | null;
  status: 'pending' | 'converted' | 'rewarded';
  converted_at: string | null;
  rewarded_at: string | null;
}

export function formatGrade(grade: LeadScore['grade']): string {
  return { cold: 'Cold', warm: 'Warm', hot: 'Hot 🔥' }[grade];
}

export function formatEnrollmentStatus(status: EnrollmentStatus): string {
  const labels: Record<EnrollmentStatus, string> = {
    active: 'In progress',
    completed: 'Completed',
    stopped: 'Stopped',
    converted: 'Converted',
  };
  return labels[status] ?? status;
}

export function generateReferralCode(customerName: string): string {
  const base = customerName.replace(/[^a-zA-Z]/g, '').slice(0, 6).toUpperCase() || 'FRIEND';
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${suffix}`;
}

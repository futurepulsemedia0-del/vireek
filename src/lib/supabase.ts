import { createClient } from '@supabase/supabase-js';
import type { PlanId } from '@/lib/pricing';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  company_name: string | null;
  phone: string | null;
  plan: PlanId;
  minutes_used_this_month: number;
  minutes_included: number;
  status: 'active' | 'suspended' | 'canceled';
  role: 'owner' | 'admin' | 'member';
  onboarding_completed: boolean;
  forwarding_number: string | null;
  toll_free_verification_status: 'not_applicable' | 'not_started' | 'pending' | 'verified' | 'rejected';
  toll_free_verification_requested_at: string | null;
    escalation_enabled: boolean;
  escalation_phone: string | null;
  escalation_mode: 'warm_transfer' | 'barge_in';
  agent_orchestration_enabled: boolean;
  external_id: string | null;
  customer_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: 'active' | 'past_due' | 'suspended';
  dunning_stage: number;
  payment_failed_at: string | null;
  payment_grace_period_ends_at: string | null;
  last_payment_error: string | null;
  business_country: string | null;
  business_vat_number: string | null;
  invoice_currency: string;
  notify_emergency_call?: boolean;
  notify_usage_alert?: boolean;
  notify_ai_insight?: boolean;
  notify_job_update?: boolean;
  notify_new_lead?: boolean;
  notify_missed_call?: boolean;
  created_at: string;
}

export interface Call {
  [key: string]: unknown;
  id: string;
  user_id: string;
  external_id: string | null;
  caller_phone: string | null;
  caller_name: string | null;
  call_datetime: string;
  duration_seconds: number | null;
  summary: string | null;
  transcript: string | null;
  recording_url: string | null;
  is_emergency: boolean;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  status: 'new_lead' | 'booked' | 'missed' | 'callback_requested' | 'spam';
    tags: string[];
  lead_source: string | null;
  is_voicemail: boolean;
  voicemail_listened_at: string | null;
  escalated_to: string | null;
  escalated_at: string | null;
  source_label: string | null;
  call_score: number | null;
  lead_score: number | null;
  intent: string | null;
  booking_outcome: 'booked' | 'not_booked' | 'already_scheduled' | 'not_applicable' | null;
  missed_opportunity_reason: string | null;
  recommended_follow_up: string | null;
  objections_raised: string[];
  objections_resolved: boolean | null;
  upsell_opportunities: string[];
  coaching_tip: string | null;
  price_accuracy_status: 'verified' | 'mismatch' | 'unverified' | 'not_applicable' | null;
  price_accuracy_details: unknown[];
  price_lookups_performed: number;
  created_at: string;
}

export interface Customer {
  id: string;
  user_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  customer_type: 'residential' | 'commercial';
  lifecycle_stage: 'lead' | 'active' | 'vip' | 'inactive';
  tags: string[];
  notes: string | null;
  source: 'manual' | 'call' | 'lead' | 'job' | 'import';
  last_contacted_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface Customer {
  id: string;
  user_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  customer_type: 'residential' | 'commercial';
  lifecycle_stage: 'lead' | 'active' | 'vip' | 'inactive';
  tags: string[];
  notes: string | null;
  source: 'manual' | 'call' | 'lead' | 'job' | 'import';
  last_contacted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommercialContract {
  id: string;
  user_id: string;
  customer_id: string | null;
  job_id: string | null;
  contract_number: string | null;
  contract_name: string;
  contract_type: 'service_agreement' | 'maintenance_contract' | 'msa' | 'sla_only' | 'other';
  status: 'draft' | 'active' | 'expiring_soon' | 'expired' | 'terminated' | 'renewed';
  start_date: string | null;
  end_date: string | null;
  auto_renew: boolean;
  renewal_notice_days: number;
  billing_frequency: 'monthly' | 'quarterly' | 'annual' | 'one_time';
  contract_value_cents: number | null;
  sla_response_minutes_standard: number | null;
  sla_response_minutes_critical: number | null;
  sla_resolution_hours: number | null;
  penalty_percentage: number | null;
  penalty_cap_percentage: number | null;
  signed_by: string | null;
  signed_at: string | null;
  document_url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContractSlaBreach {
  id: string;
  user_id: string;
  contract_id: string;
  job_id: string | null;
  breach_type: 'response_time' | 'resolution_time' | 'other';
  severity: 'minor' | 'major' | 'critical';
  expected_at: string | null;
  actual_at: string | null;
  minutes_over: number | null;
  penalty_amount_cents: number | null;
  resolved: boolean;
  notes: string | null;
  created_at: string;
}

export interface LaborMarketplaceListing {
  id: string;
  user_id: string;
  listing_type: 'offering' | 'requesting';
  trade_category: 'hvac' | 'plumbing' | 'electrical' | 'roofing' | 'restoration' | 'locksmith' | 'general';
  title: string;
  description: string | null;
  technicians_count: number;
  start_date: string | null;
  end_date: string | null;
  hourly_rate_cents: number | null;
  location_city: string | null;
  location_region: string | null;
  business_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  status: 'open' | 'matched' | 'closed' | 'expired';
  created_at: string;
  updated_at: string;
}

export interface LaborMarketplaceMatch {
  id: string;
  listing_id: string;
  user_id: string;
  business_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  agreed_technicians_count: number | null;
  agreed_rate_cents: number | null;
  message: string | null;
  status: 'proposed' | 'accepted' | 'declined' | 'completed' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export interface Equipment {
  id: string;
  user_id: string;
  customer_id: string;
  equipment_type: 'hvac_system' | 'water_heater' | 'furnace' | 'boiler' | 'generator' | 'sump_pump' | 'other';
  name: string;
  brand: string | null;
  model: string | null;
  serial_number: string | null;
  install_date: string | null;
  expected_lifespan_years: number;
  service_interval_months: number;
  last_service_date: string | null;
  notes: string | null;
  status: 'active' | 'replaced' | 'removed';
  created_at: string;
  updated_at: string;
}

export interface EquipmentMaintenanceAlert {
  id: string;
  user_id: string;
  equipment_id: string;
  risk_level: 'low' | 'medium' | 'high';
  predicted_issue: string;
  recommended_action: string | null;
  predicted_service_due: string | null;
  is_dismissed: boolean;
  metric_snapshot: Record<string, unknown> | null;
  created_at: string;
}
export interface Lead {
  id: string;
  user_id: string;
  call_id: string | null;
  customer_id: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  service_interested: string | null;
  notes: string | null;
  stage: 'new' | 'contacted' | 'quoted' | 'won' | 'lost';
    tags: string[];
  quote_amount: number | null;
  quote_sent_at: string | null;
  follow_up_count: number;
  last_follow_up_at: string | null;
  created_at: string;
}

export interface Job {
  [key: string]: unknown;
  id: string;
  user_id: string;
  lead_id: string | null;
  call_id: string | null;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  duration_minutes: number | null;
  assigned_technician_id: string | null;
  job_status: 'scheduled' | 'en_route' | 'in_progress' | 'completed' | 'cancelled';
    tags: string[];
  invoice_amount: number | null;
  invoice_status: 'not_sent' | 'sent' | 'paid';
  customer_country: string | null;
  customer_vat_number: string | null;
  invoice_currency: string | null;
  invoice_vat_rate: number | null;
  invoice_vat_amount: number | null;
  invoice_reverse_charge: boolean;
  dispatch_note: string | null;
  reschedule_token: string;
  rescheduled_by_customer_at: string | null;
  customer_type: 'residential' | 'commercial';
  sla_response_hours: number | null;
  contract_reference: string | null;
  is_rework: boolean;
  rework_of_job_id: string | null;
  created_at: string;
}

export interface OutboundCampaign {
  id: string;
  user_id: string;
  campaign_type: 'quote_followup' | 'appointment_reminder' | 'review_request_call';
  enabled: boolean;
  trigger_after_hours: number;
  created_at: string;
  updated_at: string;
}

export interface OutboundCall {
  id: string;
  user_id: string;
  campaign_type: 'quote_followup' | 'appointment_reminder' | 'review_request_call';
  lead_id: string | null;
  job_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  status: 'queued' | 'calling' | 'connected' | 'no_answer' | 'voicemail_left' | 'converted' | 'opted_out' | 'failed';
  scheduled_for: string;
  called_at: string | null;
  outcome_notes: string | null;
  created_at: string;
  enrollment_id: string | null;
  step_number: number | null;
}
export type FollowupAgentStepChannel = 'call' | 'sms';

export interface FollowupAgentStep {
  id: string;
  user_id: string;
  campaign_type: 'quote_followup' | 'appointment_reminder' | 'review_request_call';
  step_number: number;
  channel: FollowupAgentStepChannel;
  delay_hours: number;
  sms_body: string | null;
  call_context: string | null;
  created_at: string;
  updated_at: string;
}

export interface FollowupAgentEnrollment {
  id: string;
  user_id: string;
  campaign_type: 'quote_followup' | 'appointment_reminder' | 'review_request_call';
  lead_id: string | null;
  job_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  current_step: number;
  status: 'active' | 'completed' | 'stopped' | 'opted_out';
  stop_reason: string | null;
  attempt_count: number;
  next_action_at: string;
  created_at: string;
  updated_at: string;
}

export interface OutboundSms {
  id: string;
  user_id: string;
  campaign_type: 'quote_followup' | 'appointment_reminder' | 'review_request_call';
  enrollment_id: string | null;
  lead_id: string | null;
  job_id: string | null;
  step_number: number | null;
  customer_name: string;
  customer_phone: string | null;
  body: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'opted_out';
  twilio_sid: string | null;
  outcome_notes: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface OnCallSchedule {
  id: string;
  user_id: string;
  name: string;
  rotation_type: 'daily' | 'weekly';
  timezone: string;
  rotation_start_date: string;
  handoff_hour: number;
  is_active: boolean;
  created_at: string;
}

export interface OnCallScheduleMember {
  id: string;
  schedule_id: string;
  team_member_id: string;
  position: number;
  created_at: string;
}

export interface EscalationTier {
  id: string;
  schedule_id: string;
  tier_order: number;
  team_member_id: string | null;
  delay_minutes: number;
  notify_via: 'sms' | 'call' | 'both';
  created_at: string;
}

export interface EscalationEvent {
  id: string;
  user_id: string;
  call_id: string | null;
  schedule_id: string;
  current_tier: number;
  status: 'active' | 'acknowledged' | 'exhausted' | 'cancelled';
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  last_notified_at: string | null;
  ack_token: string;
  reason: string | null;
  created_at: string;
}

export interface MembershipPlan {
  id: string;
  user_id: string;
  name: string;
  price_cents: number;
  billing_interval: 'monthly' | 'yearly';
  benefits: string[];
  active: boolean;
  created_at: string;
}

export interface Membership {
  id: string;
  user_id: string;
  plan_id: string | null;
  lead_id: string | null;
  job_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  status: 'offered' | 'active' | 'cancelled';
  offered_at: string;
  started_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}
export interface Quote {
  id: string;
  user_id: string;
  lead_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  ai_generated: boolean;
  ai_detected_issue: string | null;
  source_photo_paths: string[];
  line_items: { description: string; quantity: number; unit_price_cents: number }[];
    options: unknown[];
  photos: unknown[];
  recommended_option_id: string | null;
  selected_option_id: string | null;
  accepted_total_cents: number | null;
  presentation_note: string | null;
  deposit_percent: number;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  tax_percent: number;
  status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired';
  quote_token: string;
  valid_until: string | null;
  sent_at: string | null;
  responded_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface InsuranceClaim {
  id: string;
  user_id: string;
  lead_id: string | null;
  job_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  property_address: string | null;
  loss_type: 'water_damage' | 'fire_damage' | 'smoke_damage' | 'mold' | 'storm_wind' | 'other';
  date_of_loss: string | null;
  insurance_carrier: string | null;
  policy_number: string | null;
  claim_number: string | null;
  adjuster_name: string | null;
  adjuster_phone: string | null;
  adjuster_email: string | null;
  deductible_cents: number | null;
  estimated_damage_cents: number | null;
  status:
    | 'intake'
    | 'documentation'
    | 'submitted_to_carrier'
    | 'adjuster_scheduled'
    | 'approved'
    | 'denied'
    | 'in_repair'
    | 'closed';
  notes: string | null;
  created_at: string;
  updated_at: string;
}
export interface BusinessProfileHoliday {
  id: string;
  date: string;
  label: string;
  message?: string;
}

export interface BusinessProfileEscalationRule {
  id: string;
  trigger: 'emergency' | 'after_hours' | 'no_answer' | 'human_request';
  action: 'transfer' | 'sms' | 'email';
  target: string;
  note?: string;
}

export interface BusinessProfile {
  id: string;
  user_id: string;
  business_hours: Record<string, { open: string; close: string }> | null;
  holidays: BusinessProfileHoliday[] | null;
  escalation_rules: BusinessProfileEscalationRule[] | null;
  surge_mode_active: boolean;
  surge_mode_note: string | null;
  surge_mode_activated_at: string | null;
  financing_partner_name: string | null;
  financing_note: string | null;
  services_offered: string[] | null;
  greeting_script: string | null;
  faqs: { question: string; answer: string }[] | null;
  service_area: string | null;
  google_review_url: string | null;
  primary_industry: string | null;
  team_size: string | null;
  current_call_handling: string | null;
  scheduling_tool: string | null;
  avg_job_value: number | null;
  handles_emergency_calls: string | null;
  assistant_name?: string | null;
  assistant_voice?: string | null;
  assistant_tone?: string | null;
  custom_voice_id?: string | null;
  custom_voice_status?: 'none' | 'processing' | 'ready' | 'failed';
  custom_voice_error?: string | null;
  allow_customer_self_reschedule: boolean;
  commercial_sla_policy: string | null;
  onboarding_wizard_state?: {
  current_step: string;
  completed_steps: string[];
  calendar_provider: 'google' | 'outlook' | 'other' | 'none';
  test_call_completed: boolean;
  updated_at: string;
  } | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: string;
  account_owner_id: string;
  member_email: string;
  member_name: string | null;
  role: 'owner' | 'admin' | 'technician' | 'member';
  permissions: {
    can_view_billing: boolean;
    can_manage_team: boolean;
    can_edit_business_profile: boolean;
    can_view_all_jobs: boolean;
  };
  invite_status: 'pending' | 'active';
  last_invited_at: string | null;
  skills: string[];
  languages: string[];
  service_area: string | null;
  max_jobs_per_day: number;
  dispatch_enabled: boolean;
  member_phone: string | null;
  /** What this technician costs the business per hour, in cents — internal only, never shown to customers. */
  hourly_cost_rate_cents: number | null;
  created_at: string;
}

export interface Integration {
  id: string;
  user_id: string;
  integration_type: string;
  status: 'connected' | 'disconnected' | 'error';
  config: Record<string, unknown> | null;
  created_at: string;
}

export interface CashFlowSettings {
  user_id: string;
  starting_cash_balance: number;
  default_cost_ratio: number;
  quote_win_rate: number;
  updated_at: string;
}

export interface CashFlowFixedExpense {
  id: string;
  user_id: string;
  name: string;
  amount: number;
  frequency: 'one_time' | 'weekly' | 'biweekly' | 'monthly';
  next_due_date: string;
  active: boolean;
  created_at: string;
}

export interface CashFlowWeekBucket {
  week_index: number;
  week_start: string;
  week_end: string;
  committed_inflow: number;
  pipeline_inflow: number;
  fixed_outflow: number;
  variable_outflow: number;
  net_committed: number;
  projected_balance_committed: number;
  projected_balance_optimistic: number;
}

export interface CashFlowSnapshot {
  id: string;
  user_id: string;
  starting_balance: number;
  weeks: CashFlowWeekBucket[];
  narrative: { severity: 'info' | 'warning' | 'critical'; week_index: number; message: string }[];
  cost_ratio_used: number | null;
  cost_ratio_source: 'actual' | 'default';
  created_at: string;
}

export interface BusinessDecisionSettings {
  user_id: string;
  autonomy_enabled: boolean;
  surge_mode_auto_control: boolean;
  min_confidence_threshold: number;
  updated_at: string;
}

export interface BusinessDecision {
  id: string;
  user_id: string;
  category: 'pricing' | 'dispatch' | 'staffing' | 'marketing' | 'collections' | 'retention' | 'operations';
  title: string;
  reasoning: string;
  recommended_action: string;
  confidence_score: number;
  estimated_impact: number | null;
  status: 'pending' | 'approved' | 'rejected' | 'auto_executed' | 'expired';
  is_auto_executable: boolean;
  executed_at: string | null;
  metric_snapshot: Record<string, unknown>;
  created_at: string;
}

export interface AiInsight {
  id: string;
  user_id: string;
  insight_type: 'pattern' | 'suggestion' | 'alert';
  title: string;
  description: string;
  is_dismissed: boolean;
  priority: number;
  recommended_action: string | null;
  metric_snapshot: Record<string, unknown> | null;
  created_at: string;
}

export interface ReviewRequest {
  id: string;
  user_id: string;
  job_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  status: 'sent' | 'completed' | 'declined';
  rating: number | null;
  sent_at: string;
  completed_at: string | null;
  created_at: string;
}
export interface WebhookLog {
  id: string;
  user_id: string | null;
  direction: 'incoming' | 'outgoing';
  event_type: string;
  status: 'success' | 'error';
  status_code: number | null;
  target_url: string | null;
  error_message: string | null;
  request_id: string | null;
  created_at: string;
  endpoint_id: string | null;
  attempt: number;
}

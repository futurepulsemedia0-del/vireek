import { createClient } from '@supabase/supabase-js';

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
  plan: 'starter' | 'professional';
  minutes_used_this_month: number;
  minutes_included: number;
  status: 'active' | 'suspended' | 'canceled';
  role: 'owner' | 'admin' | 'member';
  onboarding_completed: boolean;
  forwarding_number: string | null;
  external_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
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
  created_at: string;
}

export interface Lead {
  id: string;
  user_id: string;
  call_id: string | null;
  name: string;
  phone: string | null;
  email: string | null;
  service_interested: string | null;
  notes: string | null;
  stage: 'new' | 'contacted' | 'quoted' | 'won' | 'lost';
  created_at: string;
}

export interface Job {
  [key: string]: unknown;
  id: string;
  user_id: string;
  lead_id: string | null;
  call_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  duration_minutes: number | null;
  assigned_technician_id: string | null;
  job_status: 'scheduled' | 'en_route' | 'in_progress' | 'completed' | 'cancelled';
  invoice_amount: number | null;
  invoice_status: 'not_sent' | 'sent' | 'paid';
  created_at: string;
}

export interface BusinessProfileHoliday {
  id: string;
  date: string;
  label: string;
  message?: string;
}

export interface BusinessProfileEscalationRule {
  id: string;
  trigger: 'emergency' | 'after_hours' | 'no_answer';
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

export interface AiInsight {
  id: string;
  user_id: string;
  insight_type: 'pattern' | 'suggestion' | 'alert';
  title: string;
  description: string;
  is_dismissed: boolean;
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

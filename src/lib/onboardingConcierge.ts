import { Profile, BusinessProfile } from './supabase';

export type PrimaryIndustry = 'hvac' | 'plumbing' | 'electrical' | 'roofing' | 'general_home_services' | 'other';
export type TeamSize = 'solo' | '2-5' | '6-15' | '16+';
export type CallHandling = 'in_house' | 'answering_service' | 'voicemail' | 'another_ai_tool' | 'none';
export type SchedulingTool = 'service_titan' | 'housecall_pro' | 'jobber' | 'other' | 'none';
export type EmergencyHandling = 'yes_premium' | 'yes_same_rate' | 'business_hours_only';
export type BusinessHours = Record<string, { open: string; close: string }>;

export interface OnboardingFields {
  full_name?: string;
  company_name?: string;
  phone?: string;
  forwarding_number?: string;
  primary_industry?: PrimaryIndustry;
  team_size?: TeamSize;
  service_area?: string;
  services_offered?: string[];
  current_call_handling?: CallHandling;
  scheduling_tool?: SchedulingTool;
  avg_job_value?: number;
  handles_emergency_calls?: EmergencyHandling;
  business_hours?: BusinessHours;
}

export interface ConciergeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const CONCIERGE_WELCOME =
  "Hi! I'm here to get your account set up — just tell me about your business in your own words (what you do, where you work, how big your team is) and I'll fill in the details as we go. What's your company called, and what trade are you in?";

interface ChecklistItem {
  key: keyof OnboardingFields;
  label: string;
}

export const CHECKLIST_ITEMS: ChecklistItem[] = [
  { key: 'company_name', label: 'Company name' },
  { key: 'primary_industry', label: 'Industry' },
  { key: 'service_area', label: 'Service area' },
  { key: 'services_offered', label: 'Services offered' },
  { key: 'current_call_handling', label: 'How calls are handled today' },
  { key: 'business_hours', label: 'Business hours' },
  { key: 'team_size', label: 'Team size' },
  { key: 'scheduling_tool', label: 'Scheduling software' },
  { key: 'handles_emergency_calls', label: 'Emergency call handling' },
];

function isFilled(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

export function checklistProgress(known: OnboardingFields) {
  const items = CHECKLIST_ITEMS.map((item) => ({ ...item, done: isFilled(known[item.key]) }));
  return { done: items.filter((i) => i.done).length, total: items.length, items };
}

export function isReadyToFinish(known: OnboardingFields): boolean {
  const essential: (keyof OnboardingFields)[] = ['company_name', 'primary_industry', 'service_area', 'current_call_handling'];
  return essential.every((key) => isFilled(known[key]));
}

/** Builds the initial "known" snapshot the concierge starts from, from whatever's already on the account. */
export function knownFromProfile(profile: Profile | null, businessProfile: BusinessProfile | null): OnboardingFields {
  return {
    full_name: profile?.full_name ?? undefined,
    company_name: profile?.company_name ?? undefined,
    phone: profile?.phone ?? undefined,
    forwarding_number: profile?.forwarding_number ?? undefined,
    primary_industry: (businessProfile?.primary_industry as PrimaryIndustry) ?? undefined,
    team_size: (businessProfile?.team_size as TeamSize) ?? undefined,
    service_area: businessProfile?.service_area ?? undefined,
    services_offered: businessProfile?.services_offered ?? undefined,
    current_call_handling: (businessProfile?.current_call_handling as CallHandling) ?? undefined,
    scheduling_tool: (businessProfile?.scheduling_tool as SchedulingTool) ?? undefined,
    avg_job_value: businessProfile?.avg_job_value ?? undefined,
    handles_emergency_calls: (businessProfile?.handles_emergency_calls as EmergencyHandling) ?? undefined,
    business_hours: (businessProfile?.business_hours as BusinessHours) ?? undefined,
  };
}

/** Splits captured fields into the `profiles` row they belong on, ready to update. */
export function toProfilePayload(fields: OnboardingFields): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (fields.full_name !== undefined) payload.full_name = fields.full_name;
  if (fields.company_name !== undefined) payload.company_name = fields.company_name;
  if (fields.phone !== undefined) payload.phone = fields.phone;
  if (fields.forwarding_number !== undefined) payload.forwarding_number = fields.forwarding_number;
  return payload;
}

/** Splits captured fields into the `business_profile` row they belong on, ready to upsert. */
export function toBusinessProfilePayload(fields: OnboardingFields): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (fields.primary_industry !== undefined) payload.primary_industry = fields.primary_industry;
  if (fields.team_size !== undefined) payload.team_size = fields.team_size;
  if (fields.service_area !== undefined) payload.service_area = fields.service_area;
  if (fields.services_offered !== undefined) payload.services_offered = fields.services_offered;
  if (fields.current_call_handling !== undefined) payload.current_call_handling = fields.current_call_handling;
  if (fields.scheduling_tool !== undefined) payload.scheduling_tool = fields.scheduling_tool;
  if (fields.avg_job_value !== undefined) payload.avg_job_value = fields.avg_job_value;
  if (fields.handles_emergency_calls !== undefined) payload.handles_emergency_calls = fields.handles_emergency_calls;
  if (fields.business_hours !== undefined) payload.business_hours = fields.business_hours;
  return payload;
}

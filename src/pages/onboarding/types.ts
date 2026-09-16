import type { LucideIcon } from 'lucide-react';
import {
  Building2,
  Wrench,
  Clock,
  Phone,
  CalendarDays,
  Sparkles,
  BookOpen,
  PhoneCall,
  ClipboardCheck,
  Rocket,
} from 'lucide-react';

// ============================================================
// STEP REGISTRY
// ============================================================
// Single source of truth for the unified onboarding path:
// Business info → Operations → Hours → Phone → Calendar →
// Sarah setup → Knowledge → Test call → Confirm → Launch.
// Adding/removing a step only ever touches this array — every
// other piece of the wizard (progress bar, autosave, back/next,
// resume-where-you-left-off) is derived from it.

export type StepId =
  | 'business'
  | 'operations'
  | 'hours'
  | 'phone'
  | 'calendar'
  | 'sarah'
  | 'knowledge'
  | 'test_call'
  | 'confirm'
  | 'launch';

export interface StepDef {
  id: StepId;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
  optional: boolean;
}

export const STEPS: StepDef[] = [
  { id: 'business', label: 'Business Info', shortLabel: 'Business', icon: Building2, optional: false },
  { id: 'operations', label: 'Operations', shortLabel: 'Ops', icon: Wrench, optional: true },
  { id: 'hours', label: 'Business Hours', shortLabel: 'Hours', icon: Clock, optional: true },
  { id: 'phone', label: 'Phone Number', shortLabel: 'Phone', icon: Phone, optional: true },
  { id: 'calendar', label: 'Calendar', shortLabel: 'Calendar', icon: CalendarDays, optional: true },
  { id: 'sarah', label: 'Meet Sarah', shortLabel: 'Sarah', icon: Sparkles, optional: true },
  { id: 'knowledge', label: 'Knowledge Base', shortLabel: 'Knowledge', icon: BookOpen, optional: true },
  { id: 'test_call', label: 'Test Call', shortLabel: 'Test Call', icon: PhoneCall, optional: true },
  { id: 'confirm', label: 'Review', shortLabel: 'Review', icon: ClipboardCheck, optional: false },
  { id: 'launch', label: 'Launch', shortLabel: 'Launch', icon: Rocket, optional: false },
];

export const STEP_INDEX: Record<StepId, number> = STEPS.reduce(
  (acc, s, i) => ({ ...acc, [s.id]: i }),
  {} as Record<StepId, number>,
);

// ============================================================
// OPTION LISTS (shared across steps)
// ============================================================

export const DAYS_OF_WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

export const DAY_LABELS: Record<string, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export const SERVICE_SUGGESTIONS = [
  'Plumbing',
  'HVAC',
  'Electrical',
  'Roofing',
  'Landscaping',
  'Cleaning',
  'Painting',
  'Appliance Repair',
  'General Contracting',
  'Pest Control',
];

export const INDUSTRY_OPTIONS = [
  { value: 'hvac', label: 'HVAC' },
  { value: 'plumbing', label: 'Plumbing' },
  { value: 'electrical', label: 'Electrical' },
  { value: 'roofing', label: 'Roofing' },
  { value: 'general_home_services', label: 'General Home Services' },
  { value: 'other', label: 'Other' },
];

export const TEAM_SIZE_OPTIONS = [
  { value: 'solo', label: "It's just me" },
  { value: '2-5', label: '2–5 people' },
  { value: '6-15', label: '6–15 people' },
  { value: '16+', label: '16+ people' },
];

export const CALL_HANDLING_OPTIONS = [
  { value: 'in_house', label: 'In-house staff answers' },
  { value: 'answering_service', label: 'Outsourced answering service' },
  { value: 'voicemail', label: 'Calls go to voicemail' },
  { value: 'another_ai_tool', label: 'Another AI receptionist tool' },
  { value: 'none', label: "We're missing calls today" },
];

export const SCHEDULING_TOOL_OPTIONS = [
  { value: 'service_titan', label: 'ServiceTitan' },
  { value: 'housecall_pro', label: 'Housecall Pro' },
  { value: 'jobber', label: 'Jobber' },
  { value: 'other', label: 'Something else' },
  { value: 'none', label: "Don't use one yet" },
];

export const EMERGENCY_HANDLING_OPTIONS = [
  { value: 'yes_premium', label: 'Yes — we charge an emergency/premium rate' },
  { value: 'yes_same_rate', label: 'Yes — same rate any time' },
  { value: 'business_hours_only', label: 'No — business hours only' },
];

export const ASSISTANT_VOICE_OPTIONS = [
  { value: 'friendly_female', label: 'Friendly (female)' },
  { value: 'friendly_male', label: 'Friendly (male)' },
  { value: 'professional_female', label: 'Professional (female)' },
  { value: 'professional_male', label: 'Professional (male)' },
];

export const ASSISTANT_TONE_OPTIONS = [
  { value: 'warm', label: 'Warm & conversational' },
  { value: 'professional', label: 'Polished & professional' },
  { value: 'concise', label: 'Brisk & to the point' },
];

export const CALENDAR_PROVIDER_OPTIONS = [
  { value: 'google', label: 'Google Calendar' },
  { value: 'outlook', label: 'Microsoft / Outlook' },
  { value: 'other', label: 'Something else' },
  { value: 'none', label: "I'll connect this later" },
] as const;

export type CalendarProvider = (typeof CALENDAR_PROVIDER_OPTIONS)[number]['value'];

// ============================================================
// SHARED CLASS NAMES (keep visual language identical everywhere)
// ============================================================

export const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

export const chipClass = (active: boolean) =>
  `focus-ring cursor-pointer rounded-full border px-3.5 py-1.5 text-sm font-medium transition-all ${
    active
      ? 'border-accent bg-accent/10 text-accent'
      : 'border-border bg-bg-primary text-text-secondary hover:border-accent/30 hover:text-text-primary'
  }`;

// ============================================================
// WIZARD DATA — everything a step can read or write
// ============================================================

export interface WizardData {
  // Business info
  fullName: string;
  companyName: string;
  phone: string;
  forwardingNumber: string;
  serviceArea: string;
  services: string[];

  // Operations
  primaryIndustry: string;
  teamSize: string;
  currentCallHandling: string;
  schedulingTool: string;
  avgJobValue: string;
  handlesEmergencyCalls: string;

  // Hours
  hours: Record<string, { open: string; close: string }>;

  // Phone
  phoneChoice: 'existing_number' | 'new_number' | 'skip';
  newPhoneNumber: string | null;
  newPhoneFriendlyName: string;

  // Calendar
  calendarProvider: CalendarProvider;

  // Sarah
  assistantName: string;
  assistantVoice: string;
  assistantTone: string;
  greetingScript: string;

  // Knowledge
  faqs: { question: string; answer: string }[];

  // Test call
  testCallCompleted: boolean;

  // Progress
  completedSteps: StepId[];
}

export const EMPTY_WIZARD_DATA: WizardData = {
  fullName: '',
  companyName: '',
  phone: '',
  forwardingNumber: '',
  serviceArea: '',
  services: [],

  primaryIndustry: '',
  teamSize: '',
  currentCallHandling: '',
  schedulingTool: '',
  avgJobValue: '',
  handlesEmergencyCalls: '',

  hours: {},

  phoneChoice: 'skip',
  newPhoneNumber: null,
  newPhoneFriendlyName: 'Main Line',

  calendarProvider: 'none',

  assistantName: 'Sarah',
  assistantVoice: 'friendly_female',
  assistantTone: 'warm',
  greetingScript: '',

  faqs: [],

  testCallCompleted: false,

  completedSteps: [],
};

/** Shape persisted in `business_profile.onboarding_wizard_state` (see migration). */
export interface OnboardingWizardState {
  current_step: StepId;
  completed_steps: StepId[];
  calendar_provider: CalendarProvider;
  test_call_completed: boolean;
  updated_at: string;
}

export interface StepProps {
  data: WizardData;
  update: (patch: Partial<WizardData>) => void;
  onBack?: () => void;
  onNext: () => void;
  onSkip?: () => void;
  saving: boolean;
}

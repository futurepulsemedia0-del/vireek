// supabase/functions/_shared/playbooks/types.ts
//
// Playbook Library — typed model (no I/O, no Deno APIs, no browser APIs).
// Shared by src/lib/playbookLibrary.ts (UI), supabase/functions/playbook-tick (scheduler)
// and the unit tests. The DATABASE re-validates every definition before applying it
// (see playbook_validate_definition() in 20280410000000_playbook_library.sql), so these
// types are a convenience for authoring/preview, never the trust boundary.

export const TRADES = ['hvac', 'plumbing', 'roofing', 'electrical', 'restoration', 'locksmith', 'all'] as const;
export type TradeKey = (typeof TRADES)[number];

export const SEASONS = ['spring', 'summer', 'fall', 'winter', 'any'] as const;
export type Season = (typeof SEASONS)[number];

export const GOALS = ['capture_demand', 'protect_capacity', 'revenue', 'continuity', 'reputation'] as const;
export type Goal = (typeof GOALS)[number];

export const GOAL_LABELS: Record<Goal, string> = {
  capture_demand: 'Capture demand',
  protect_capacity: 'Protect capacity',
  revenue: 'Grow revenue',
  continuity: 'Keep the business running',
  reputation: 'Reviews & reputation',
};

/** Mirrors SCENARIOS in call-scripts/logic.ts (kept literal so this file has no imports). */
export const SCRIPT_SCENARIOS = [
  'emergency', 'after_hours', 'new_inquiry', 'price_quote', 'reschedule_cancel', 'existing_customer', 'complaint',
] as const;
export type ScriptScenario = (typeof SCRIPT_SCENARIOS)[number];

export type PlaybookKey =
  | 'heatwave-hvac'
  | 'cold-snap-freeze'
  | 'post-storm-surge'
  | 'hurricane-wildfire-prep'
  | 'holiday-hours'
  | 'spring-tune-up'
  | 'fall-furnace-check'
  | 'water-damage-response'
  | 'peak-season-overflow'
  | 'slow-season-boost'
  | 'vacation-closed'
  | 'grand-opening';

// ---------------------------------------------------------------------------
// Items — each is previewable and individually toggleable
// ---------------------------------------------------------------------------

export type ItemKind =
  | 'call_script'
  | 'surge'
  | 'escalation_rule'
  | 'capacity'
  | 'message_template'
  | 'closure'
  | 'after_hours_fee'
  | 'automation'
  | 'advisory';

export interface CallScriptParams { scenario: ScriptScenario; opening_line: string; body: string }
export interface SurgeParams { message: string; priority: string; maxBookingsPerDay?: number }
export interface EscalationParams { trigger: 'emergency' | 'after_hours' | 'no_answer'; action: 'sms' | 'transfer'; note: string }
export interface CapacityParams {
  /** Percent change applied to max_slots_per_day (clamped 1..48). Negative = fewer slots. */
  maxSlotsScalePct?: number;
  /** Extra emergency-reserve slots. Only ever INCREASES the reserve (emergency protection). */
  emergencyReserveAdd?: number;
  overbookJobsPerTech?: number;
  waitlistEnabled?: boolean;
}
export interface TemplateParams {
  channel: 'sms' | 'email';
  category: 'appointment' | 'service_update' | 'payment' | 'review_request' | 'follow_up' | 'marketing';
  name: string;
  subject?: string;
  body: string;
}
export interface ClosureParams { label: string; message: string }
export interface AfterHoursFeeParams { amountCents: number; note: string }
export interface AutomationParams { slug: string }
export interface AdvisoryParams {
  area: 'staffing' | 'ads' | 'followup' | 'marketing' | 'hiring' | 'operations';
  detail: string;
  /** Ads/price-adjacent suggestions are never executed automatically. */
  action?: 'pause' | 'boost' | 'none';
  boostPct?: number;
}

export type ItemParamsByKind = {
  call_script: CallScriptParams;
  surge: SurgeParams;
  escalation_rule: EscalationParams;
  capacity: CapacityParams;
  message_template: TemplateParams;
  closure: ClosureParams;
  after_hours_fee: AfterHoursFeeParams;
  automation: AutomationParams;
  advisory: AdvisoryParams;
};

export interface PlaybookItem<K extends ItemKind = ItemKind> {
  id: string;
  kind: K;
  title: string;
  /** Plain-language "why this is here" shown in the preview. */
  why: string;
  params: ItemParamsByKind[K];
  /** Off by default (e.g. closing every day in the window). Still toggleable. */
  defaultEnabled?: boolean;
}
export type AnyPlaybookItem = { [K in ItemKind]: PlaybookItem<K> }[ItemKind];

// ---------------------------------------------------------------------------
// Playbook
// ---------------------------------------------------------------------------

export type TriggerKind = 'manual' | 'scheduled' | 'weather' | 'call_spike' | 'seasonal';

export interface PlaybookTrigger {
  /** NWS event names (exact, as stored in weather_surge_events.event_type). */
  nwsEvents?: string[];
  /** Calendar months (1-12) in which a seasonal suggestion is reasonable. Northern hemisphere / US product. */
  months?: number[];
  /** Suggest when 24h call volume >= ratio x trailing daily average (and >= minCalls). */
  callSpike?: { ratio: number; minCalls: number };
}

export interface ImpactEstimate {
  metric: string;
  lowPct: number;
  highPct: number;
  /** Stated openly: these are planning ranges, not measured Vireek results. */
  assumptions: string[];
}

export interface Playbook {
  key: PlaybookKey;
  /** Bump when ANY item changes. Activations store the version they were created from. */
  version: number;
  name: string;
  tagline: string;
  trades: TradeKey[];
  seasons: Season[];
  goals: Goal[];
  summary: string;
  whenToUse: string;
  trigger: PlaybookTrigger;
  defaultDurationHours: number;
  maxDurationHours: number;
  rollback: string;
  items: AnyPlaybookItem[];
  impact: ImpactEstimate[];
  /** Domain/compliance notes surfaced to the owner before activation. */
  compliance: string[];
}

// ---------------------------------------------------------------------------
// Activation lifecycle
// ---------------------------------------------------------------------------

export type ActivationStatus =
  | 'suggested' | 'scheduled' | 'pending_approval' | 'active' | 'expired' | 'rolled_back' | 'dismissed' | 'failed';
export type ActivationSource = 'manual' | 'scheduled' | 'signal';
export type ItemStatus =
  | 'planned' | 'applied' | 'pending_approval' | 'advisory' | 'skipped' | 'conflict' | 'rolled_back' | 'rollback_skipped';

/** Exclusive surfaces: only one live activation item may own each at a time. */
export type Surface = string;

export interface CurrentState {
  surge: { active: boolean; source: string | null; message: string | null; priority: string | null; maxBookingsPerDay: number | null };
  escalationRules: { id: string; trigger: string; action: string; target: string }[];
  holidays: { id: string; date: string }[];
  afterHoursFeeCents: number | null;
  ownerPhone: string | null;
  timezone: string | null;
  bookingPolicy: { enabled: boolean; maxSlotsPerDay: number; overbookJobsPerTech: number } | null;
  demandPolicy: { emergencyReserveSlots: number; waitlistEnabled: boolean } | null;
  templateNames: string[];
  automations: Record<string, string>;
  scriptActive: Record<string, boolean>;
  emergencyOpsEnabled: boolean;
  /** surface -> playbook activation currently holding it */
  liveSurfaces: Record<string, { activationId: string; playbookKey: string; playbookName?: string }>;
}

export type DiffStatus = 'will_change' | 'no_change' | 'needs_approval' | 'advisory' | 'blocked' | 'inactive';

export interface DiffRow {
  itemId: string;
  kind: ItemKind;
  title: string;
  status: DiffStatus;
  surface: Surface | null;
  before: string;
  after: string;
  reason?: string;
}

export interface Conflict {
  surface: Surface;
  itemId: string;
  heldBy: { activationId: string; playbookKey: string; playbookName?: string };
}

export interface GuardrailViolation {
  itemId: string | null;
  code:
    | 'unknown_kind' | 'bad_shape' | 'text_too_long' | 'compliance_override' | 'price_in_text'
    | 'emergency_disable' | 'reserve_decrease' | 'bad_range' | 'duration' | 'template_compliance';
  message: string;
}

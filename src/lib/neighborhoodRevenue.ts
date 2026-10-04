// Neighborhood Revenue Engine — pure logic (no I/O), fully unit-tested.

export type ServiceCategory = 'hvac' | 'plumbing' | 'electrical' | 'roofing' | 'general';
export type NeedSignal = 'replacement_window' | 'maintenance_due' | 'none';
export type NeighborhoodChannel = 'door_hanger' | 'direct_mail' | 'geo_ad' | 'email_opt_in' | 'sms_opt_in';
export type CampaignStatus = 'draft' | 'approved' | 'active' | 'completed' | 'cancelled';

export interface EquipmentSnapshot {
  equipment_type: string;
  install_date: string | null;
  expected_lifespan_years: number;
  service_interval_months: number;
  last_service_date: string | null;
}

export interface NearbyProperty {
  customer_id: string;
  customer_name: string;
  address: string | null;
  distance_m: number;
  last_job_at: string | null;
  last_service_type: string | null;
  jobs_count: number;
  equipment: EquipmentSnapshot[];
  marketing_opt_in: boolean;
  has_phone: boolean;
  has_email: boolean;
  on_dnc: boolean;
}

export interface NeedAssessment {
  signal: NeedSignal;
  reason: string;
  equipmentType: string | null;
  ageYears: number | null;
}

export interface AssessedProperty {
  property: NearbyProperty;
  need: NeedAssessment;
}

export const MS_PER_YEAR = 365.25 * 86_400_000;
export const MS_PER_MONTH = MS_PER_YEAR / 12;

/** Equipment at/after this share of its expected lifespan is in its replacement window. */
export const REPLACEMENT_RATIO = 0.8;
/** With no equipment records, same-category service older than this counts as "maintenance due". */
export const COLD_START_MONTHS = 12;
/** Planning assumptions — estimates only; measured results come from the database. */
export const CONVERSION_OPT_IN = 0.12;
export const CONVERSION_ZONE = 0.03;
export const DRIVE_MINUTES_SAVED_PER_CLUSTERED_STOP = 13;
export const OPPORTUNITY_STALE_DAYS = 60;

const CATEGORY_PATTERNS: Record<Exclude<ServiceCategory, 'general'>, RegExp> = {
  hvac: /(hvac|furnace|a\/c|\bac\b|air.?con|heat.?pump|cooling|heating|boiler|duct|thermostat)/i,
  plumbing: /(plumb|water.?heater|drain|pipe|sewer|faucet|toilet|sump)/i,
  electrical: /(electric|panel|wiring|breaker|outlet|generator)/i,
  roofing: /(roof|shingle|gutter)/i,
};

export function serviceCategory(text: string | null | undefined): ServiceCategory {
  if (!text) return 'general';
  for (const [category, pattern] of Object.entries(CATEGORY_PATTERNS)) {
    if (pattern.test(text)) return category as ServiceCategory;
  }
  return 'general';
}

function toTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

const NO_NEED: NeedAssessment = { signal: 'none', reason: 'No service need detected', equipmentType: null, ageYears: null };

export function evaluateNeed(p: NearbyProperty, category: ServiceCategory, now: number = Date.now()): NeedAssessment {
  const relevant =
    category === 'general' ? p.equipment : p.equipment.filter((e) => serviceCategory(e.equipment_type) === category);
  let best: NeedAssessment = NO_NEED;

  for (const e of relevant) {
    const installed = toTime(e.install_date);
    const ageYears = installed === null ? null : Math.max(0, (now - installed) / MS_PER_YEAR);

    if (ageYears !== null && e.expected_lifespan_years > 0 && ageYears / e.expected_lifespan_years >= REPLACEMENT_RATIO) {
      if (best.signal !== 'replacement_window' || ageYears > (best.ageYears ?? 0)) {
        best = {
          signal: 'replacement_window',
          reason: `${e.equipment_type} is ${Math.round(ageYears)} yrs old (expected life ${e.expected_lifespan_years} yrs)`,
          equipmentType: e.equipment_type,
          ageYears,
        };
      }
      continue;
    }
    if (best.signal !== 'none') continue;
    const reference = toTime(e.last_service_date) ?? installed;
    if (reference !== null && e.service_interval_months > 0) {
      const months = (now - reference) / MS_PER_MONTH;
      if (months > e.service_interval_months) {
        best = {
          signal: 'maintenance_due',
          reason: `${e.equipment_type} last serviced ${Math.floor(months)} months ago`,
          equipmentType: e.equipment_type,
          ageYears,
        };
      }
    }
  }

  // Cold start: no equipment records at all — fall back to service recency.
  if (best.signal === 'none' && relevant.length === 0 && category !== 'general') {
    const last = toTime(p.last_job_at);
    if (last !== null && serviceCategory(p.last_service_type) === category) {
      const months = (now - last) / MS_PER_MONTH;
      if (months >= COLD_START_MONTHS) {
        return { signal: 'maintenance_due', reason: `No ${category} service recorded in ${Math.floor(months)} months`, equipmentType: null, ageYears: null };
      }
    }
  }
  return best;
}

export function assessProperties(props: NearbyProperty[], category: ServiceCategory, now: number = Date.now()): AssessedProperty[] {
  return props.map((property) => ({ property, need: evaluateNeed(property, category, now) }));
}

// ------------------------------------------------------------------
// Channels & compliance
// ------------------------------------------------------------------
export const CHANNEL_META: Record<NeighborhoodChannel, { label: string; personal: boolean; description: string; notes: string[] }> = {
  door_hanger: {
    label: 'Door hangers',
    personal: false,
    description: 'Physical drop in the zone while your crew is on site. No personal data used.',
    notes: ['Check local door-to-door / solicitation permit rules.', 'Never leave material where a No Soliciting sign is posted.'],
  },
  direct_mail: {
    label: 'Direct mail (zone)',
    personal: false,
    description: 'Postal mailer to the delivery area (e.g. EDDM-style). No personal data used.',
    notes: ['Print your business name, physical address and license number where your state requires it.'],
  },
  geo_ad: {
    label: 'Geo-targeted ads',
    personal: false,
    description: 'Ads shown to people inside the radius. Area targeting only.',
    notes: ['Target by area only; do not upload customer lists without consent.', 'No sensitive-category targeting.'],
  },
  email_opt_in: {
    label: 'Email (opted-in customers)',
    personal: true,
    description: 'Only your own customers who gave marketing opt-in and have an email.',
    notes: ['Include your physical address and a working unsubscribe link (CAN-SPAM).'],
  },
  sms_opt_in: {
    label: 'SMS (opted-in customers)',
    personal: true,
    description: 'Only your own customers with recorded opt-in who are not on the do-not-contact list.',
    notes: ['Include opt-out instructions (e.g. STOP).', 'Send only during permitted hours in the recipient\u2019s local time.'],
  },
};

export const CHANNEL_ORDER: NeighborhoodChannel[] = ['door_hanger', 'direct_mail', 'geo_ad', 'email_opt_in', 'sms_opt_in'];

export function channelEligibility(p: NearbyProperty, channel: NeighborhoodChannel): { eligible: boolean; reason?: string } {
  if (!CHANNEL_META[channel].personal) return { eligible: true };
  if (!p.marketing_opt_in) return { eligible: false, reason: 'No recorded marketing opt-in' };
  if (channel === 'email_opt_in') return p.has_email ? { eligible: true } : { eligible: false, reason: 'No email on file' };
  if (!p.has_phone) return { eligible: false, reason: 'No phone on file' };
  if (p.on_dnc) return { eligible: false, reason: 'On do-not-contact list' };
  return { eligible: true };
}

// ------------------------------------------------------------------
// Plan, density, scoring
// ------------------------------------------------------------------
export interface NeighborhoodPlan {
  totalNearby: number;
  withSignal: number;
  replacementWindow: number;
  maintenanceDue: number;
  reachable: Record<'email_opt_in' | 'sms_opt_in', number>;
  suppressedByDnc: number;
  projectedBookings: { low: number; expected: number; high: number };
  stopsInZone: { existing: number; expected: number };
  stopsPerKm2: number;
  densityGrade: 'dense' | 'building' | 'sparse';
  estimatedDriveMinutesSaved: number;
}

export function buildNeighborhoodPlan(assessed: AssessedProperty[], scheduledNearby: number, radiusM: number): NeighborhoodPlan {
  const signalled = assessed.filter((a) => a.need.signal !== 'none');
  const reachable = { email_opt_in: 0, sms_opt_in: 0 };
  let optInReachable = 0;
  for (const a of signalled) {
    const email = channelEligibility(a.property, 'email_opt_in').eligible;
    const sms = channelEligibility(a.property, 'sms_opt_in').eligible;
    if (email) reachable.email_opt_in += 1;
    if (sms) reachable.sms_opt_in += 1;
    if (email || sms) optInReachable += 1;
  }
  const rawExpected = optInReachable * CONVERSION_OPT_IN + (signalled.length - optInReachable) * CONVERSION_ZONE;
  const expected = Math.round(rawExpected);
  const existing = Math.max(0, Math.floor(scheduledNearby));
  const stops = existing + expected;
  const areaKm2 = Math.PI * (radiusM / 1000) ** 2;

  return {
    totalNearby: assessed.length,
    withSignal: signalled.length,
    replacementWindow: signalled.filter((a) => a.need.signal === 'replacement_window').length,
    maintenanceDue: signalled.filter((a) => a.need.signal === 'maintenance_due').length,
    reachable,
    suppressedByDnc: assessed.filter((a) => a.property.on_dnc).length,
    projectedBookings: { low: Math.floor(rawExpected * 0.5), expected, high: Math.ceil(rawExpected * 1.6) },
    stopsInZone: { existing, expected },
    stopsPerKm2: Math.round((stops / areaKm2) * 10) / 10,
    densityGrade: stops >= 4 ? 'dense' : stops >= 2 ? 'building' : 'sparse',
    estimatedDriveMinutesSaved: Math.max(0, stops - 1) * DRIVE_MINUTES_SAVED_PER_CLUSTERED_STOP,
  };
}

export function isStaleOpportunity(completedAt: string | null, now: number = Date.now()): boolean {
  const t = toTime(completedAt);
  return t !== null && (now - t) / 86_400_000 > OPPORTUNITY_STALE_DAYS;
}

/** 0–100 priority. Weights: need 45, density 25, freshness 15, sample size 15. */
export function opportunityScore(
  input: { withSignal: number; totalNearby: number; scheduledNearby: number; completedAt: string | null },
  now: number = Date.now()
): number {
  const t = toTime(input.completedAt);
  const days = t === null ? 60 : Math.max(0, (now - t) / 86_400_000);
  const freshness = days <= 14 ? 1 : Math.max(0, 1 - (days - 14) / 46);
  const score =
    45 * Math.min(1, input.withSignal / 8) +
    25 * Math.min(1, (input.scheduledNearby + 1) / 4) +
    15 * freshness +
    15 * Math.min(1, input.totalNearby / 15);
  return Math.round(Math.max(0, Math.min(100, score)));
}

// ------------------------------------------------------------------
// Campaign workflow
// ------------------------------------------------------------------
const TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['approved', 'cancelled'],
  approved: ['active', 'draft', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function allowedTransitions(from: CampaignStatus): CampaignStatus[] {
  return TRANSITIONS[from];
}
export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
/** Leaving draft requires the owner's compliance acknowledgement. */
export function requiresAck(to: CampaignStatus): boolean {
  return to === 'approved' || to === 'active';
}

export function buildOfferTemplate(category: ServiceCategory, channel: NeighborhoodChannel): string {
  const service =
    category === 'general' ? 'service' : category === 'hvac' ? 'heating & cooling' : category;
  if (CHANNEL_META[channel].personal) {
    return `Hi {first_name}, our crew just finished a ${service} job near you. As a past customer you get priority scheduling and a free ${service} check this month. Reply or call to book. Reply STOP to opt out.`;
  }
  return `Our ${service} crew is working in your neighborhood this week. Book a free ${service} check and get scheduled on the same visit route. Limited slots.`;
}

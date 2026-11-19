// src/lib/safety/heat.ts
//
// Heat-index alerts for technicians. Pure and dependency-free so the browser, the Deno tick and unit tests share one
// implementation (same pattern as ./core.ts).
//
// What this is: an estimate of the "feels like" temperature from air temperature and relative humidity, plus company
// reminders to take water and rest breaks. What it is NOT: medical advice, a diagnosis, a heat-illness risk score for a
// person, or an emergency-services integration. Nothing here contacts anyone: prompts are shown to the technician only.
//
// [VERIFY] The default reminder intervals below are conservative company defaults, not a standard. Confirm them against
// your safety officer's heat plan and local rules before relying on them; managers can change them in settings.

export const HEAT_TIERS = ['low', 'caution', 'high', 'very_high', 'extreme'] as const;
export type HeatTier = (typeof HEAT_TIERS)[number];

/** Lower bound (°F heat index, inclusive) of each tier. Bands follow the public NWS heat-index chart. */
export const HEAT_TIER_FLOOR_F: Readonly<Record<HeatTier, number>> = {
  low: -Infinity,
  caution: 80,
  high: 90,
  very_high: 103,
  extreme: 125,
};

export interface HeatIntervals {
  /** Minutes between water reminders per tier. 0 = no reminder at that tier. */
  waterEveryMin: Readonly<Record<HeatTier, number>>;
  /** Minutes between rest/shade reminders per tier. 0 = no reminder at that tier. */
  restEveryMin: Readonly<Record<HeatTier, number>>;
}

export const DEFAULT_HEAT_INTERVALS: HeatIntervals = {
  waterEveryMin: { low: 0, caution: 60, high: 30, very_high: 20, extreme: 15 },
  restEveryMin: { low: 0, caution: 0, high: 120, very_high: 60, extreme: 30 },
};

export const MIN_REMINDER_MIN = 5;
export const MAX_REMINDER_MIN = 480;
/** A watch older than this is closed by the tick so a forgotten phone never prompts all night. */
export const MAX_WATCH_HOURS = 14;
/** A reading older than this is shown as stale and never raises a new tier alert. */
export const READING_STALE_MIN = 90;

/** Shown wherever heat prompts appear. No medical claims. */
export const HEAT_NOTICE =
  'Heat reminders are estimates from the weather forecast, not medical advice. Stop and rest any time you feel unwell. ' +
  'Vireek does not contact emergency services. If someone may be in danger, call your local emergency number first.';

/**
 * NWS heat index (°F) from air temperature (°F) and relative humidity (%), using the published Rothfusz regression with
 * the NWS low-humidity and high-humidity adjustments. Below the regression's valid range the simpler Steadman formula
 * is used, as the NWS does. Returns null for non-finite or physically impossible inputs.
 */
export function heatIndexF(tempF: number, rhPct: number): number | null {
  if (!Number.isFinite(tempF) || !Number.isFinite(rhPct)) return null;
  if (tempF < -60 || tempF > 150 || rhPct < 0 || rhPct > 100) return null;
  const T = tempF;
  const R = rhPct;

  const simple = 0.5 * (T + 61.0 + (T - 68.0) * 1.2 + R * 0.094);
  if ((simple + T) / 2 < 80) return round1(simple);

  let hi =
    -42.379 +
    2.04901523 * T +
    10.14333127 * R -
    0.22475541 * T * R -
    0.00683783 * T * T -
    0.05481717 * R * R +
    0.00122874 * T * T * R +
    0.00085282 * T * R * R -
    0.00000199 * T * T * R * R;

  if (R < 13 && T >= 80 && T <= 112) {
    hi -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
  } else if (R > 85 && T >= 80 && T <= 87) {
    hi += ((R - 85) / 10) * ((87 - T) / 5);
  }
  return round1(hi);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function celsiusToF(c: number): number {
  return c * 1.8 + 32;
}

export function tierForHeatIndex(hiF: number | null): HeatTier {
  if (hiF === null || !Number.isFinite(hiF)) return 'low';
  if (hiF >= HEAT_TIER_FLOOR_F.extreme) return 'extreme';
  if (hiF >= HEAT_TIER_FLOOR_F.very_high) return 'very_high';
  if (hiF >= HEAT_TIER_FLOOR_F.high) return 'high';
  if (hiF >= HEAT_TIER_FLOOR_F.caution) return 'caution';
  return 'low';
}

export function tierRank(t: HeatTier): number {
  return HEAT_TIERS.indexOf(t);
}

/** True when a company-entered interval map is safe to store: every tier present, integers, 0 or within range. */
export function validateIntervals(i: unknown): i is HeatIntervals {
  if (!i || typeof i !== 'object') return false;
  const o = i as Record<string, unknown>;
  for (const key of ['waterEveryMin', 'restEveryMin'] as const) {
    const m = o[key];
    if (!m || typeof m !== 'object') return false;
    for (const t of HEAT_TIERS) {
      const v = (m as Record<string, unknown>)[t];
      if (typeof v !== 'number' || !Number.isInteger(v)) return false;
      if (v !== 0 && (v < MIN_REMINDER_MIN || v > MAX_REMINDER_MIN)) return false;
    }
  }
  return true;
}

export interface HeatWatchState {
  status: 'active' | 'ended';
  startedAt: Date;
  /** Tier of the previous reading (what the technician was last told). */
  tier: HeatTier;
  /** When the technician last acknowledged (or started with) a water reminder / rest reminder. */
  lastWaterAt: Date;
  lastRestAt: Date;
  /** Dedupe keys already recorded for this watch. */
  doneKeys: ReadonlySet<string>;
}

export interface HeatReading {
  heatIndexF: number | null;
  observedAt: Date;
}

export type HeatAction =
  | { kind: 'tier_change'; key: string; from: HeatTier; to: HeatTier }
  | { kind: 'water_prompt'; key: string }
  | { kind: 'rest_prompt'; key: string }
  | { kind: 'end_watch'; key: string; reason: 'max_duration' };

const MIN = 60_000;

/**
 * Decides what must happen NOW for one heat watch. Pure and idempotent: it only returns actions whose dedupe key is not
 * in `doneKeys`, so the cron can run every few minutes (or twice) without double prompts. Reminder cycles restart when
 * the technician acknowledges (lastWaterAt / lastRestAt move forward), which changes the key.
 */
export function planHeatActions(
  w: HeatWatchState,
  reading: HeatReading | null,
  intervals: HeatIntervals,
  now: Date,
): { tier: HeatTier; actions: HeatAction[] } {
  if (w.status === 'ended') return { tier: w.tier, actions: [] };
  const t = now.getTime();
  const actions: HeatAction[] = [];
  const push = (a: HeatAction) => { if (!w.doneKeys.has(a.key)) actions.push(a); };

  if (t - w.startedAt.getTime() >= MAX_WATCH_HOURS * 60 * MIN) {
    push({ kind: 'end_watch', key: 'end:max', reason: 'max_duration' });
    return { tier: w.tier, actions };
  }

  const fresh = reading !== null && reading.heatIndexF !== null && t - reading.observedAt.getTime() <= READING_STALE_MIN * MIN;
  if (!fresh) return { tier: w.tier, actions }; // never prompt from a missing or stale reading

  const tier = tierForHeatIndex(reading.heatIndexF);
  if (tier !== w.tier) {
    // Key by the reading time so a tier that flaps produces one record per observation, not one per cron run.
    push({ kind: 'tier_change', key: `tier:${tier}:${reading.observedAt.getTime()}`, from: w.tier, to: tier });
  }

  const water = intervals.waterEveryMin[tier];
  if (water > 0 && t >= w.lastWaterAt.getTime() + water * MIN) {
    push({ kind: 'water_prompt', key: `water:${w.lastWaterAt.getTime()}` });
  }
  const rest = intervals.restEveryMin[tier];
  if (rest > 0 && t >= w.lastRestAt.getTime() + rest * MIN) {
    push({ kind: 'rest_prompt', key: `rest:${w.lastRestAt.getTime()}` });
  }
  return { tier, actions };
}

/** NWS event names (current and legacy) that mean an official heat alert is in effect for the area. */
export const HEAT_ALERT_EVENTS: ReadonlySet<string> = new Set([
  'Extreme Heat Warning',
  'Extreme Heat Watch',
  'Excessive Heat Warning',
  'Excessive Heat Watch',
  'Heat Advisory',
]);

export function isHeatAlertEvent(eventType: string | null | undefined): boolean {
  return !!eventType && HEAT_ALERT_EVENTS.has(eventType);
}

export function isValidUsZip(zip: string): boolean {
  return /^[0-9]{5}$/.test(zip);
}

/** Technician-facing wording. Plain language, no medical claims. English source strings live in the i18n namespace. */
export const HEAT_PROMPT_KEYS = { water: 'prompt.water', rest: 'prompt.rest' } as const;

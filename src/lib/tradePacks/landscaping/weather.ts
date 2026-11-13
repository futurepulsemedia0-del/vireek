/**
 * Landscaping pack — weather skip rules (pure) + the WeatherAdapter boundary.
 *
 * A real forecast provider is an EXTERNAL dependency and therefore lives behind `WeatherAdapter`.
 * This repo ships only the interface, a deterministic `MockWeatherAdapter` (tests / demos) and
 * `NullWeatherAdapter` (production default until a provider is wired and reviewed: it never
 * skips anything). No scraping, no credentials in code.
 *
 * Safety principle: an UNKNOWN forecast never cancels a customer's visit. The crew is only
 * rerouted when a configured rule is positively met by data we actually have.
 */

import { nextWorkday, type ISODate } from './calendar.ts';

export interface DailyForecast {
  date: ISODate;
  /** Probability of precipitation 0–100. */
  precipProbPct: number | null;
  precipMm: number | null;
  snowCm: number | null;
  windKph: number | null;
  tempMinC: number | null;
  tempMaxC: number | null;
  /** Free-text alert titles (e.g. “Flood Watch”). */
  alerts: string[];
  /** Adapter id that produced the data (kept on the visit for the audit trail). */
  source: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface WeatherAdapter {
  readonly id: string;
  /** Returns null when the provider has no data for that point/date. Must not throw for “no data”. */
  getDailyForecast(point: GeoPoint, date: ISODate): Promise<DailyForecast | null>;
}

export class NullWeatherAdapter implements WeatherAdapter {
  readonly id = 'none';
  async getDailyForecast(): Promise<DailyForecast | null> {
    return null;
  }
}

/** Deterministic adapter for tests and demos. */
export class MockWeatherAdapter implements WeatherAdapter {
  readonly id = 'mock';
  readonly calls: Array<{ point: GeoPoint; date: ISODate }> = [];
  private readonly byDate: Record<ISODate, Partial<DailyForecast>>;
  constructor(byDate: Record<ISODate, Partial<DailyForecast>>) {
    this.byDate = byDate;
  }
  async getDailyForecast(point: GeoPoint, date: ISODate): Promise<DailyForecast | null> {
    this.calls.push({ point, date });
    const f = this.byDate[date];
    if (!f) return null;
    return { date, precipProbPct: null, precipMm: null, snowCm: null, windKph: null, tempMinC: null, tempMaxC: null, alerts: [], source: 'mock', ...f };
  }
}

export type WeatherRuleKind = 'rain_prob_pct' | 'rain_mm' | 'snow_cm' | 'wind_kph' | 'freeze_c' | 'heat_c' | 'alert_keyword';

export interface WeatherSkipRule {
  kind: WeatherRuleKind;
  /** Numeric threshold (unit implied by `kind`); unused for `alert_keyword`. */
  threshold?: number;
  /** For `alert_keyword`: case-insensitive substrings, e.g. ["flood", "tornado"]. */
  keywords?: string[];
}

export type MakeupPolicy = 'next_workday' | 'none';

export interface WeatherPolicy {
  rules: WeatherSkipRule[];
  makeup: MakeupPolicy;
}

export const RULE_LABELS: Record<WeatherRuleKind, string> = {
  rain_prob_pct: 'Chance of rain at or above (%)',
  rain_mm: 'Rain at or above (mm)',
  snow_cm: 'Snow at or above (cm)',
  wind_kph: 'Wind at or above (km/h)',
  freeze_c: 'Low at or below (°C)',
  heat_c: 'High at or above (°C)',
  alert_keyword: 'Weather alert mentions',
};

export const MAX_WEATHER_RULES = 8;

export function validateWeatherPolicy(p: WeatherPolicy): string[] {
  const e: string[] = [];
  if (!p || !Array.isArray(p.rules) || p.rules.length > MAX_WEATHER_RULES) return [`At most ${MAX_WEATHER_RULES} weather rules`];
  if (p.makeup !== 'next_workday' && p.makeup !== 'none') e.push('Unknown make-up policy');
  for (const r of p.rules) {
    if (!(r.kind in RULE_LABELS)) {
      e.push('Unknown weather rule');
      continue;
    }
    if (r.kind === 'alert_keyword') {
      if (!Array.isArray(r.keywords) || r.keywords.length === 0 || r.keywords.length > 10 || r.keywords.some((k) => typeof k !== 'string' || k.trim().length < 3 || k.length > 40)) {
        e.push('Alert keywords must be 1–10 words of at least 3 letters');
      }
    } else if (typeof r.threshold !== 'number' || !Number.isFinite(r.threshold)) {
      e.push(`${RULE_LABELS[r.kind]} needs a number`);
    } else if ((r.kind === 'rain_prob_pct' && (r.threshold < 0 || r.threshold > 100)) || (['rain_mm', 'snow_cm', 'wind_kph'].includes(r.kind) && r.threshold < 0)) {
      e.push(`${RULE_LABELS[r.kind]} is out of range`);
    }
  }
  return [...new Set(e)];
}

export interface WeatherDecision {
  decision: 'proceed' | 'skip' | 'unknown';
  /** Human-readable reasons for each rule that fired. */
  reasons: string[];
}

function fired(rule: WeatherSkipRule, f: DailyForecast): { evaluable: boolean; hit: string | null } {
  const num = (v: number | null) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (rule.kind) {
    case 'rain_prob_pct': {
      const v = num(f.precipProbPct);
      return v === null ? { evaluable: false, hit: null } : { evaluable: true, hit: v >= (rule.threshold ?? 101) ? `Rain chance ${v}%` : null };
    }
    case 'rain_mm': {
      const v = num(f.precipMm);
      return v === null ? { evaluable: false, hit: null } : { evaluable: true, hit: v >= (rule.threshold ?? Infinity) ? `Rain ${v} mm` : null };
    }
    case 'snow_cm': {
      const v = num(f.snowCm);
      return v === null ? { evaluable: false, hit: null } : { evaluable: true, hit: v >= (rule.threshold ?? Infinity) ? `Snow ${v} cm` : null };
    }
    case 'wind_kph': {
      const v = num(f.windKph);
      return v === null ? { evaluable: false, hit: null } : { evaluable: true, hit: v >= (rule.threshold ?? Infinity) ? `Wind ${v} km/h` : null };
    }
    case 'freeze_c': {
      const v = num(f.tempMinC);
      return v === null ? { evaluable: false, hit: null } : { evaluable: true, hit: v <= (rule.threshold ?? -Infinity) ? `Low ${v} °C` : null };
    }
    case 'heat_c': {
      const v = num(f.tempMaxC);
      return v === null ? { evaluable: false, hit: null } : { evaluable: true, hit: v >= (rule.threshold ?? Infinity) ? `High ${v} °C` : null };
    }
    case 'alert_keyword': {
      const kws = (rule.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean);
      const hit = f.alerts.find((a) => kws.some((k) => a.toLowerCase().includes(k)));
      return { evaluable: true, hit: hit ? `Alert: ${hit}` : null };
    }
  }
}

/**
 * Skip when at least one rule fires. `unknown` when there are rules but none could be evaluated
 * with the data at hand (or no forecast) — callers must treat `unknown` as “keep the visit”.
 */
export function evaluateWeather(policy: WeatherPolicy, forecast: DailyForecast | null): WeatherDecision {
  if (!policy.rules.length) return { decision: 'proceed', reasons: [] };
  if (!forecast) return { decision: 'unknown', reasons: [] };
  const reasons: string[] = [];
  let evaluable = 0;
  for (const r of policy.rules) {
    const res = fired(r, forecast);
    if (res.evaluable) evaluable += 1;
    if (res.hit) reasons.push(res.hit);
  }
  if (reasons.length) return { decision: 'skip', reasons };
  return { decision: evaluable === 0 ? 'unknown' : 'proceed', reasons: [] };
}

/**
 * Make-up date for a weather-skipped visit: the next working day that is not a holiday and not
 * already taken by another visit of the same contract. null = no make-up (policy `none`, or no free day within a week).
 */
export function makeupDate(
  date: ISODate,
  policy: MakeupPolicy,
  workdays: readonly number[],
  isHoliday: (d: ISODate) => string | null,
  occupied: ReadonlySet<ISODate> = new Set(),
): ISODate | null {
  if (policy === 'none') return null;
  let cursor = date;
  for (let i = 0; i < 6; i += 1) {
    const next = nextWorkday(cursor, workdays, isHoliday, 7);
    if (!next) return null;
    if (!occupied.has(next)) return next;
    cursor = next;
  }
  return null;
}

/** Snow add-on trigger: observed/forecast snowfall at or above the contract's threshold. */
export function snowEventTriggered(forecast: DailyForecast | null, thresholdCm: number): boolean {
  return !!forecast && typeof forecast.snowCm === 'number' && forecast.snowCm >= thresholdCm && thresholdCm > 0;
}

/** Evaluate every (visit, forecast) pair for one date — tiny helper so cron and tests share the loop. */
export async function decideForDate<T extends { id: string; point: GeoPoint | null; policy: WeatherPolicy }>(
  adapter: WeatherAdapter,
  date: ISODate,
  items: readonly T[],
): Promise<Array<{ id: string; decision: WeatherDecision; forecast: DailyForecast | null }>> {
  const cache = new Map<string, DailyForecast | null>();
  const out: Array<{ id: string; decision: WeatherDecision; forecast: DailyForecast | null }> = [];
  for (const it of items) {
    let forecast: DailyForecast | null = null;
    if (it.point) {
      // ~1 km grid: neighbouring properties share one provider call.
      const key = `${it.point.lat.toFixed(2)},${it.point.lng.toFixed(2)}`;
      if (!cache.has(key)) {
        try {
          cache.set(key, await adapter.getDailyForecast(it.point, date));
        } catch {
          cache.set(key, null); // provider outage ⇒ unknown ⇒ visit kept
        }
      }
      forecast = cache.get(key) ?? null;
    }
    out.push({ id: it.id, decision: evaluateWeather(it.policy, forecast), forecast });
  }
  return out;
}


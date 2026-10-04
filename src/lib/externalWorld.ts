/**
 * External World Graph — client library.
 *
 * Extends the Business World Model (src/lib/worldModel.ts) with the world
 * OUTSIDE the business: where each property is, its weather and climate,
 * natural-hazard exposure, and local energy price, plus owner-entered facts
 * for domains that have no reliable free API (regulations, incentives,
 * labor, competitors, suppliers, construction ...).
 *
 * Nothing here duplicates the internal graph. External data is stored per
 * property in `external_world_signals` (server side, see
 * supabase/functions/external-world-sync) and joined to the World Model's
 * existing property / asset nodes at read time.
 *
 * Decision Intelligence rules are transparent and fixed (same philosophy as
 * causalGraph.ts): every insight lists the exact internal and external
 * drivers behind it. No hidden scoring.
 *
 * Server counterpart: supabase/migrations/20270301000000_external_world_graph.sql
 */

import { supabase } from '@/lib/supabase';
import type { WorldModel, WorldNode } from '@/lib/worldModel';

// ============================================================
// TYPES
// ============================================================

export type SignalKey = 'nws_alerts' | 'nws_forecast' | 'nasa_climate' | 'fema_nri' | 'eia_electricity';
export type SignalDomain = 'weather' | 'climate' | 'hazards' | 'energy';

export type FactDomain =
  | 'regulations'
  | 'permits'
  | 'labor'
  | 'market'
  | 'competitors'
  | 'suppliers'
  | 'construction'
  | 'incentives'
  | 'economy'
  | 'other';

export type FactScope = 'national' | 'state' | 'county' | 'local';
export type FactImpact = 'positive' | 'negative' | 'neutral';

export const FACT_DOMAIN_LABELS: Record<FactDomain, string> = {
  regulations: 'Regulations',
  permits: 'Permits',
  labor: 'Labor',
  market: 'Market',
  competitors: 'Competitors',
  suppliers: 'Suppliers',
  construction: 'Construction',
  incentives: 'Incentives',
  economy: 'Economy',
  other: 'Other',
};

export const FACT_SCOPE_LABELS: Record<FactScope, string> = {
  national: 'National',
  state: 'State (e.g. TX)',
  county: 'County FIPS (e.g. 48201)',
  local: 'Local / free text',
};

export interface ExternalLocation {
  id: string;
  user_id: string;
  property_key: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  state: string | null;
  county_fips: string | null;
  county_name: string | null;
  geocode_status: 'pending' | 'geocoded' | 'not_found';
  geocoded_at: string | null;
}

export interface NwsAlert {
  id: string;
  event: string;
  severity: string | null;
  headline: string | null;
  expires: string | null;
}
export interface AlertsValue { alerts: NwsAlert[] }
export interface ForecastValue { max_f: number | null; min_f: number | null }
export interface ClimateValue {
  mean_c: number | null;
  max_c: number | null;
  min_c: number | null;
  /** annual heating degree-days, °C-days, base 18.3 °C (65 °F) */
  hdd_c: number | null;
  /** annual cooling degree-days, °C-days, base 18.3 °C (65 °F) */
  cdd_c: number | null;
  estimated: boolean;
}
export interface NriValue {
  risk_rating: string | null;
  risk_score: number | null;
  eal_total: number | null;
  county_name: string | null;
  /** FEMA hazard code -> rating text, e.g. { HRCN: 'Relatively High' } */
  hazards: Record<string, string>;
}
export interface EnergyValue { cents_per_kwh: number; period: string | null }

export interface ExternalSignal {
  id: string;
  location_id: string;
  domain: SignalDomain;
  signal_key: SignalKey;
  value: Record<string, unknown>;
  source: string;
  source_url: string | null;
  as_of: string | null;
  expires_at: string;
  fetched_at: string;
}

export interface ExternalFact {
  id: string;
  user_id: string;
  domain: FactDomain;
  scope: FactScope;
  region: string | null;
  title: string;
  detail: string | null;
  impact: FactImpact;
  effective_date: string | null;
  source_url: string | null;
  created_at: string;
}

export interface ExternalState {
  locations: ExternalLocation[];
  signals: ExternalSignal[];
  facts: ExternalFact[];
}

export interface PropertyContext {
  propertyKey: string;
  label: string;
  location: ExternalLocation | null;
  alerts: NwsAlert[];
  forecast: ForecastValue | null;
  climate: ClimateValue | null;
  hazards: NriValue | null;
  energy: EnergyValue | null;
  facts: ExternalFact[];
  lastFetchedAt: string | null;
}

// ============================================================
// FETCH / WRITE
// ============================================================

export async function fetchExternalState(): Promise<ExternalState> {
  const [locRes, sigRes, factRes] = await Promise.all([
    supabase.from('external_world_locations').select('*').limit(500),
    supabase.from('external_world_signals').select('*').limit(2500),
    supabase.from('external_world_facts').select('*').order('created_at', { ascending: false }).limit(300),
  ]);
  if (locRes.error) throw locRes.error;
  if (sigRes.error) throw sigRes.error;
  if (factRes.error) throw factRes.error;
  return {
    locations: (locRes.data as ExternalLocation[]) ?? [],
    signals: (sigRes.data as ExternalSignal[]) ?? [],
    facts: (factRes.data as ExternalFact[]) ?? [],
  };
}

export interface NewFactInput {
  domain: FactDomain;
  scope: FactScope;
  region: string | null;
  title: string;
  detail: string | null;
  impact: FactImpact;
  effectiveDate: string | null;
  sourceUrl: string | null;
}

export async function addExternalFact(input: NewFactInput): Promise<void> {
  const title = input.title.trim();
  if (!title) throw new Error('A fact needs a title.');
  if (input.scope !== 'national' && !input.region?.trim()) throw new Error('Enter a region for this scope.');
  const { error } = await supabase.from('external_world_facts').insert({
    domain: input.domain,
    scope: input.scope,
    region: input.scope === 'national' ? null : input.region!.trim(),
    title,
    detail: input.detail?.trim() || null,
    impact: input.impact,
    effective_date: input.effectiveDate || null,
    source_url: input.sourceUrl?.trim() || null,
  });
  if (error) throw error;
}

export async function deleteExternalFact(id: string): Promise<void> {
  const { error } = await supabase.from('external_world_facts').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================
// SYNC — asks the Edge Function to pull live external data
// ============================================================

const SYNC_BATCH = 6;
const SYNC_MAX_PROPERTIES = 30;

export interface SyncSummary {
  properties: number;
  signalsWritten: number;
  skippedFresh: number;
  notFound: number;
  remaining: number;
  eiaConfigured: boolean;
}

function normalizeAddress(a: string | null | undefined): string | null {
  if (!a) return null;
  const t = a.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

/** Never-synced properties first, then those with installed equipment — where external context matters most. */
function propertiesToSync(model: WorldModel, syncedKeys: ReadonlySet<string>): WorldNode[] {
  const withAssets = new Set<string>();
  for (const e of model.edges) if (e.relation === 'installed_at') withAssets.add(e.target);
  const rank = (n: WorldNode) => Number(!syncedKeys.has(n.key)) * 2 + Number(withAssets.has(n.key));
  return model.nodes.filter((n) => n.type === 'property').sort((a, b) => rank(b) - rank(a));
}

export async function syncExternalWorld(
  model: WorldModel,
  force = false,
  syncedKeys: ReadonlySet<string> = new Set()
): Promise<SyncSummary> {
  const all = propertiesToSync(model, syncedKeys);
  const targets = all.slice(0, SYNC_MAX_PROPERTIES);

  // Reuse coordinates already geocoded for jobs so we don't geocode twice.
  const coords = new Map<string, { latitude: number; longitude: number }>();
  const { data: jobRows } = await supabase
    .from('jobs')
    .select('address, latitude, longitude')
    .not('latitude', 'is', null)
    .limit(500);
  for (const r of (jobRows as { address: string | null; latitude: number | null; longitude: number | null }[] | null) ?? []) {
    const k = normalizeAddress(r.address);
    if (k && r.latitude != null && r.longitude != null && !coords.has(k)) {
      coords.set(k, { latitude: r.latitude, longitude: r.longitude });
    }
  }

  const summary: SyncSummary = {
    properties: 0,
    signalsWritten: 0,
    skippedFresh: 0,
    notFound: 0,
    remaining: Math.max(0, all.length - targets.length),
    eiaConfigured: false,
  };

  for (let i = 0; i < targets.length; i += SYNC_BATCH) {
    const batch = targets.slice(i, i + SYNC_BATCH).map((n) => ({
      key: n.key,
      address: n.label,
      ...(coords.get(n.id) ?? {}),
    }));
    const { data, error } = await supabase.functions.invoke('external-world-sync', {
      body: { properties: batch, force },
    });
    if (error) throw new Error(error.message || 'External sync failed');
    if (data?.error) throw new Error(String(data.error));
    summary.properties += Number(data?.properties ?? 0);
    summary.signalsWritten += Number(data?.signals_written ?? 0);
    summary.skippedFresh += Number(data?.skipped_fresh ?? 0);
    summary.notFound += Array.isArray(data?.not_found) ? data.not_found.length : 0;
    summary.eiaConfigured = summary.eiaConfigured || Boolean(data?.eia_configured);
  }
  return summary;
}

// ============================================================
// JOIN — external signals onto the World Model's property nodes
// ============================================================

/** Alerts and forecasts older than this are ignored by the rules. */
const LIVE_SIGNAL_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function factApplies(f: ExternalFact, loc: ExternalLocation | null): boolean {
  if (f.scope === 'national') return true;
  if (!loc || !f.region) return false;
  const region = f.region.trim().toLowerCase();
  if (f.scope === 'state') return (loc.state ?? '').toLowerCase() === region;
  if (f.scope === 'county') return (loc.county_fips ?? '') === region;
  return loc.address.toLowerCase().includes(region);
}

export function buildPropertyContexts(model: WorldModel, state: ExternalState, now = Date.now()): PropertyContext[] {
  const locByKey = new Map(state.locations.map((l) => [l.property_key, l]));
  const sigsByLoc = new Map<string, ExternalSignal[]>();
  for (const s of state.signals) {
    const list = sigsByLoc.get(s.location_id);
    if (list) list.push(s);
    else sigsByLoc.set(s.location_id, [s]);
  }

  return model.nodes
    .filter((n) => n.type === 'property')
    .map((n) => {
      const location = locByKey.get(n.key) ?? null;
      const sigs = location ? sigsByLoc.get(location.id) ?? [] : [];
      const get = <T,>(key: SignalKey, liveOnly = false): T | null => {
        const s = sigs.find((x) => x.signal_key === key);
        if (!s) return null;
        if (liveOnly && now - new Date(s.fetched_at).getTime() > LIVE_SIGNAL_MAX_AGE_MS) return null;
        return s.value as T;
      };
      const alertsValue = get<AlertsValue>('nws_alerts', true);
      const alerts = (alertsValue?.alerts ?? []).filter((a) => !a.expires || new Date(a.expires).getTime() > now);
      const lastFetchedAt = sigs.reduce<string | null>((acc, s) => (!acc || s.fetched_at > acc ? s.fetched_at : acc), null);
      return {
        propertyKey: n.key,
        label: n.label,
        location,
        alerts,
        forecast: get<ForecastValue>('nws_forecast', true),
        climate: get<ClimateValue>('nasa_climate'),
        hazards: get<NriValue>('fema_nri'),
        energy: get<EnergyValue>('eia_electricity'),
        facts: state.facts.filter((f) => factApplies(f, location)),
        lastFetchedAt,
      };
    });
}

// ============================================================
// ASSETS — equipment facts needed by the rules
// ============================================================

export interface AssetInPlace {
  assetKey: string;
  propertyKey: string;
  label: string;
  equipmentType: string;
  /** null when the equipment has no install date on record */
  ageYears: number | null;
  overdueMaintenance: boolean;
}

export async function fetchAssetsInPlace(model: WorldModel): Promise<AssetInPlace[]> {
  const { data, error } = await supabase
    .from('equipment')
    .select('id, equipment_type, make, model, install_date, status, customer_id')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw error;

  const propertyByAsset = new Map<string, string>();
  const propertyByCustomer = new Map<string, string>();
  for (const e of model.edges) {
    if (e.relation === 'installed_at') propertyByAsset.set(e.source, e.target);
    if (e.relation === 'lives_at') propertyByCustomer.set(e.source, e.target);
  }

  const now = Date.now();
  const out: AssetInPlace[] = [];
  for (const row of (data ?? []) as {
    id: string; equipment_type: string; make: string | null; model: string | null;
    install_date: string | null; status: string; customer_id: string | null;
  }[]) {
    if (row.status !== 'active') continue;
    const assetKey = `asset:${row.id}`;
    const propertyKey =
      propertyByAsset.get(assetKey) ?? (row.customer_id ? propertyByCustomer.get(`customer:${row.customer_id}`) : undefined);
    if (!propertyKey) continue;
    const node = model.nodesByKey.get(assetKey);
    const installed = row.install_date ? new Date(row.install_date).getTime() : NaN;
    out.push({
      assetKey,
      propertyKey,
      label: [row.make, row.model].filter(Boolean).join(' ') || row.equipment_type,
      equipmentType: row.equipment_type,
      ageYears: Number.isFinite(installed) ? Math.max(0, (now - installed) / (365.25 * 86_400_000)) : null,
      overdueMaintenance: node?.flag === 'overdue_maintenance',
    });
  }
  return out;
}

// ============================================================
// DECISION INTELLIGENCE — fixed, documented rules
// ============================================================

export const RULE_CONSTANTS = {
  /** Annual degree-days in °C-days (base 18.3 °C). ×1.8 for °F-days. */
  CDD_HIGH_C: 1100,
  CDD_MODERATE_C: 600,
  HDD_HIGH_C: 2800,
  HDD_MODERATE_C: 1700,
  /** share of typical lifespan consumed */
  AGE_WATCH: 0.6,
  AGE_ACT: 0.8,
  /** Fixed reference, NOT live: approximate US residential average, ¢/kWh. */
  ENERGY_BENCHMARK_CENTS: 16,
  ENERGY_HIGH_RATIO: 1.2,
  HEAT_FORECAST_F: 95,
  COLD_FORECAST_F: 20,
} as const;

export type EquipClass =
  | 'cooling' | 'heating' | 'heat_pump' | 'water_heater' | 'roof' | 'plumbing' | 'electrical' | 'other';

export function classifyEquipment(type: string): EquipClass {
  const s = type.toLowerCase();
  if (/water\s*heater/.test(s)) return 'water_heater';
  if (/heat\s*pump/.test(s)) return 'heat_pump';
  if (/furnace|boiler|heating/.test(s)) return 'heating';
  if (/\bac\b|a\/c|air\s*condition|condens|cooling|mini[\s-]?split/.test(s)) return 'cooling';
  if (/roof|shingle/.test(s)) return 'roof';
  if (/plumb|pipe|sump|water\s*line/.test(s)) return 'plumbing';
  if (/electric|panel|generator|surge/.test(s)) return 'electrical';
  return 'other';
}

/** Typical service life in years. Classes not listed get no age rules. */
const LIFESPAN_YEARS: Partial<Record<EquipClass, number>> = {
  cooling: 15,
  heating: 18,
  heat_pump: 14,
  water_heater: 12,
  roof: 25,
};

/** Which FEMA National Risk Index hazards matter for which equipment class. */
const HAZARDS_BY_CLASS: Partial<Record<EquipClass, string[]>> = {
  cooling: ['HAIL', 'HRCN', 'IFLD', 'CFLD', 'HWAV'],
  heat_pump: ['HAIL', 'HRCN', 'IFLD', 'CFLD', 'HWAV', 'CWAV'],
  heating: ['IFLD', 'CFLD', 'CWAV', 'WNTW', 'ISTM'],
  water_heater: ['IFLD', 'CFLD'],
  roof: ['HAIL', 'HRCN', 'SWND', 'TRND', 'WFIR'],
  plumbing: ['CWAV', 'IFLD', 'CFLD'],
  electrical: ['LTNG', 'ISTM', 'HRCN', 'TRND'],
};

export const HAZARD_LABELS: Record<string, string> = {
  AVLN: 'Avalanche', CFLD: 'Coastal flooding', CWAV: 'Cold wave', DRGT: 'Drought', ERQK: 'Earthquake',
  HAIL: 'Hail', HWAV: 'Heat wave', HRCN: 'Hurricane', ISTM: 'Ice storm', IFLD: 'Inland flooding',
  LNDS: 'Landslide', LTNG: 'Lightning', SWND: 'Strong wind', TRND: 'Tornado', TSUN: 'Tsunami',
  VLCN: 'Volcanic activity', WFIR: 'Wildfire', WNTW: 'Winter weather',
};

const ALERT_CLASSES: { match: RegExp; classes: EquipClass[] }[] = [
  { match: /freeze|cold|ice|winter|frost/i, classes: ['heating', 'heat_pump', 'plumbing', 'water_heater'] },
  { match: /heat/i, classes: ['cooling', 'heat_pump'] },
  { match: /tornado|hurricane|tropical|wind|hail|thunderstorm/i, classes: ['roof', 'electrical', 'cooling'] },
  { match: /flood/i, classes: ['plumbing', 'water_heater', 'electrical'] },
];

export type InsightSeverity = 'info' | 'watch' | 'act';
const SEVERITY_ORDER: InsightSeverity[] = ['info', 'watch', 'act'];
const bump = (s: InsightSeverity): InsightSeverity => SEVERITY_ORDER[Math.min(2, SEVERITY_ORDER.indexOf(s) + 1)];

export interface InsightDriver { kind: 'internal' | 'external'; label: string; value: string }

export interface DecisionInsight {
  id: string;
  rule: 'climate_age' | 'energy_cost' | 'hazard' | 'alert' | 'forecast';
  severity: InsightSeverity;
  propertyKey: string;
  propertyLabel: string;
  assetKey: string;
  assetLabel: string;
  title: string;
  rationale: string;
  action: string;
  drivers: InsightDriver[];
  sources: string[];
}

const degF = (c: number) => Math.round(c * 1.8);

export function generateInsights(contexts: PropertyContext[], assets: AssetInPlace[]): DecisionInsight[] {
  const K = RULE_CONSTANTS;
  const ctxByKey = new Map(contexts.map((c) => [c.propertyKey, c]));
  const out: DecisionInsight[] = [];

  for (const a of assets) {
    const ctx = ctxByKey.get(a.propertyKey);
    if (!ctx) continue;
    const cls = classifyEquipment(a.equipmentType);
    if (cls === 'other') continue;

    const life = LIFESPAN_YEARS[cls];
    const frac = life && a.ageYears != null ? a.ageYears / life : null;
    const ageDriver: InsightDriver[] =
      a.ageYears != null && life
        ? [{ kind: 'internal', label: 'Equipment age', value: `${a.ageYears.toFixed(1)} yr of ~${life} yr typical (${Math.round((frac ?? 0) * 100)}%)` }]
        : [];
    const overdueDriver: InsightDriver[] = a.overdueMaintenance
      ? [{ kind: 'internal', label: 'Maintenance', value: 'Overdue' }]
      : [];
    const base = { propertyKey: a.propertyKey, propertyLabel: ctx.label, assetKey: a.assetKey, assetLabel: a.label };
    const push = (i: Omit<DecisionInsight, keyof typeof base | 'severity'> & { severity: InsightSeverity }) => {
      out.push({ ...base, ...i, severity: a.overdueMaintenance ? bump(i.severity) : i.severity });
    };

    // 1. Climate load x equipment age (x overdue maintenance)
    const cdd = ctx.climate?.cdd_c ?? null;
    const hdd = ctx.climate?.hdd_c ?? null;
    const coolLoad = cls === 'cooling' || cls === 'heat_pump' ? cdd : null;
    const heatLoad = cls === 'heating' || cls === 'heat_pump' ? hdd : null;
    const loads: { name: string; level: 'high' | 'moderate' | 'low'; value: number }[] = [];
    if (coolLoad != null) loads.push({ name: 'cooling', level: coolLoad >= K.CDD_HIGH_C ? 'high' : coolLoad >= K.CDD_MODERATE_C ? 'moderate' : 'low', value: coolLoad });
    if (heatLoad != null) loads.push({ name: 'heating', level: heatLoad >= K.HDD_HIGH_C ? 'high' : heatLoad >= K.HDD_MODERATE_C ? 'moderate' : 'low', value: heatLoad });
    const worst = loads.sort((x, y) => (y.level === 'high' ? 2 : y.level === 'moderate' ? 1 : 0) - (x.level === 'high' ? 2 : x.level === 'moderate' ? 1 : 0))[0];
    if (worst && worst.level !== 'low') {
      const aged = frac != null && frac >= K.AGE_WATCH;
      const veryAged = frac != null && frac >= K.AGE_ACT;
      const qualifies = worst.level === 'high' ? aged || a.overdueMaintenance : veryAged;
      if (qualifies) {
        push({
          id: `climate_age:${a.assetKey}`,
          rule: 'climate_age',
          severity: veryAged && worst.level === 'high' ? 'act' : 'watch',
          title: `${a.label}: aging under ${worst.level} ${worst.name} load`,
          rationale: `This property sees about ${degF(worst.value).toLocaleString()} ${worst.name} degree-days (°F) a year, a ${worst.level} load for ${a.equipmentType.toLowerCase()} equipment${frac != null ? `, and the unit has used ${Math.round(frac * 100)}% of its typical life` : ''}.`,
          action: 'Schedule a pre-season tune-up and put a repair-vs-replace comparison in the next estimate.',
          drivers: [
            ...ageDriver,
            ...overdueDriver,
            { kind: 'external', label: `${worst.name === 'cooling' ? 'Cooling' : 'Heating'} degree-days`, value: `${degF(worst.value).toLocaleString()} °F-days/yr (${worst.level})` },
          ],
          sources: ['NASA POWER climatology'],
        });
      }
    }

    // 2. Energy price x aging efficiency
    const cents = ctx.energy?.cents_per_kwh ?? null;
    if (cents != null && frac != null && frac >= K.AGE_WATCH && (cls === 'cooling' || cls === 'heating' || cls === 'heat_pump' || cls === 'water_heater') && cents >= K.ENERGY_BENCHMARK_CENTS * K.ENERGY_HIGH_RATIO) {
      push({
        id: `energy_cost:${a.assetKey}`,
        rule: 'energy_cost',
        severity: 'watch',
        title: `${a.label}: aging equipment on expensive power`,
        rationale: `Residential electricity here is ${cents.toFixed(1)} ¢/kWh, above the ${K.ENERGY_BENCHMARK_CENTS} ¢ reference. Older units run less efficiently, so each year of delay costs more than average.`,
        action: 'Offer an efficiency upgrade quote and check for local incentives (see External Facts).',
        drivers: [...ageDriver, { kind: 'external', label: 'Electricity price', value: `${cents.toFixed(1)} ¢/kWh (reference ${K.ENERGY_BENCHMARK_CENTS})` }],
        sources: ['EIA retail electricity prices'],
      });
    }

    // 3. Natural-hazard exposure relevant to this equipment class
    const codes = HAZARDS_BY_CLASS[cls] ?? [];
    const exposed = codes
      .map((c) => ({ code: c, rating: ctx.hazards?.hazards[c] ?? '' }))
      .filter((h) => h.rating === 'Relatively High' || h.rating === 'Very High');
    if (exposed.length > 0) {
      const veryHigh = exposed.some((h) => h.rating === 'Very High');
      push({
        id: `hazard:${a.assetKey}`,
        rule: 'hazard',
        severity: veryHigh ? 'act' : 'watch',
        title: `${a.label}: exposed to ${exposed.map((h) => HAZARD_LABELS[h.code] ?? h.code).join(', ').toLowerCase()}`,
        rationale: `FEMA rates this county ${veryHigh ? 'very high' : 'relatively high'} for hazards that damage ${a.equipmentType.toLowerCase()} equipment. County-level data is a planning signal, not a site assessment.`,
        action: 'Document condition with photos now (useful for insurance) and flag protective upgrades on the next visit.',
        drivers: [...overdueDriver, ...exposed.map<InsightDriver>((h) => ({ kind: 'external', label: HAZARD_LABELS[h.code] ?? h.code, value: h.rating }))],
        sources: ['FEMA National Risk Index'],
      });
    }

    // 4. Active NWS alert that matters for this equipment class
    const matched = ctx.alerts.filter((al) => ALERT_CLASSES.some((r) => r.match.test(al.event) && r.classes.includes(cls)));
    if (matched.length > 0) {
      const severe = matched.some((al) => al.severity === 'Extreme' || al.severity === 'Severe');
      push({
        id: `alert:${a.assetKey}`,
        rule: 'alert',
        severity: severe ? 'act' : 'watch',
        title: `${a.label}: ${matched[0].event} in effect`,
        rationale: `${matched[0].headline ?? matched[0].event}. This weather directly affects ${a.equipmentType.toLowerCase()} equipment.`,
        action: 'Contact the customer proactively and prepare for emergency calls from this address.',
        drivers: [...overdueDriver, ...matched.map<InsightDriver>((al) => ({ kind: 'external', label: 'NWS alert', value: `${al.event}${al.severity ? ` (${al.severity})` : ''}` }))],
        sources: ['NOAA / National Weather Service'],
      });
    }

    // 5. Forecast extremes in the next days
    const fc = ctx.forecast;
    if (fc) {
      const hot = fc.max_f != null && fc.max_f >= K.HEAT_FORECAST_F && (cls === 'cooling' || cls === 'heat_pump') && frac != null && frac >= 0.5;
      const cold = fc.min_f != null && fc.min_f <= K.COLD_FORECAST_F && (cls === 'plumbing' || ((cls === 'heating' || cls === 'heat_pump') && frac != null && frac >= 0.5));
      if (hot || cold) {
        push({
          id: `forecast:${a.assetKey}`,
          rule: 'forecast',
          severity: 'watch',
          title: `${a.label}: ${hot ? 'heat' : 'freeze'} in the 7-day forecast`,
          rationale: hot
            ? `Highs near ${fc.max_f}°F are forecast; mid-life and older cooling equipment fails most often during peak load.`
            : `Lows near ${fc.min_f}°F are forecast; heating equipment and exposed pipes are most at risk.`,
          action: hot ? 'Offer a quick pre-heatwave check to customers with older cooling equipment.' : 'Send freeze-protection guidance and open slots for no-heat calls.',
          drivers: [...ageDriver, { kind: 'external', label: hot ? 'Forecast high' : 'Forecast low', value: `${hot ? fc.max_f : fc.min_f}°F` }],
          sources: ['NOAA / National Weather Service'],
        });
      }
    }
  }

  return out.sort(
    (x, y) => SEVERITY_ORDER.indexOf(y.severity) - SEVERITY_ORDER.indexOf(x.severity) || x.propertyLabel.localeCompare(y.propertyLabel)
  );
}

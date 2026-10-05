import type { Equipment, EquipmentMaintenanceAlert, Job } from '@/lib/supabase';
import type { PropertyTwin } from '@/lib/propertyTwin';
import { CATEGORY_LABELS, HEALTH_CATEGORIES, classifyEquipment, monthsOverdue, type HealthCategoryKey } from '@/lib/homeHealthScore';
import { DEFAULT_COSTS } from '@/lib/homeBudget';
import { SYSTEM_MODEL, homeAgeFromYearBuilt, isValidYearBuilt } from '@/lib/lifetimeServicePlan';
import {
  analyzeEnergy,
  computeHomeIntelligenceGraph,
  type EnergyReading,
  type GraphBasis,
  type GraphNode,
  type GraphRiskLevel,
} from '@/lib/homeIntelligenceGraph';

/**
 * Vireek Home Genome — how one home has behaved over time, and what is likely to happen next.
 *
 *   Property → Construction → Systems → Equipment → Repairs → Failures → Maintenance
 *            → Replacement → Energy → Cost → Future risk
 *
 * The Property Digital Twin answers "what is this property?". The Home Genome answers
 * "how has it behaved, and what does that history predict?". It is a permanent, ordered
 * history graph per property that gets richer with every completed job.
 *
 * Pure, deterministic and explainable: no network, no randomness. The same twin, year built,
 * energy readings, recorded events and `now` always produce the same genome. It reads only
 * what the Digital Twin and the Home Intelligence Graph already know, plus optional
 * hand-recorded history (work done before the home was on Vireek), and reuses the graph's
 * hazard model for the forward-looking half so every surface tells the same story.
 *
 * Nothing here is a diagnosis. Signals are patterns in the record ("repairs are getting
 * closer together"); the forward-looking numbers are the graph's planning estimates.
 */

// ---------------------------------------------------------------------- config

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MONTH = 30.4375 * MS_PER_DAY;
const MS_PER_YEAR = 365.25 * MS_PER_DAY;
/** An install derived from the equipment record is the same event as a job/manual install this close to it. */
const INSTALL_DEDUPE_WINDOW_MS = 45 * MS_PER_DAY;
/** Repairs getting closer together: the latest gap is under this share of the earlier average gap. */
const ACCELERATION_RATIO = 0.6;
const SLOWING_RATIO = 1.5;
const MIN_INTERVENTIONS_FOR_TREND = 3;
const REPAIR_SPEND_WINDOW_MONTHS = 36;
/** Classic repair-vs-replace rule: repair spend over the window reaching half the price of a new unit. */
const REPLACE_SPEND_SHARE = 0.5;
const OVERDUE_WATCH_MONTHS = 6;
const OVERDUE_HIGH_MONTHS = 18;
/** How much a behaviour signal ages a unit, as a share of its expected life (capped in total). */
const PENALTY_HIGH = 0.1;
const PENALTY_WATCH = 0.05;
const PENALTY_CAP = 0.3;
const APPROACHING_AT = 0.6;
const IMMINENT_AT = 0.9;
const MAX_STORYLINE_STEPS = 8;
const MAX_INSIGHTS = 5;
const MAX_FORECAST = 6;
const MAX_REASONS = 4;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (p: number) => `${Math.round(p * 100)}%`;
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const yearOf = (at: number) => new Date(at).getUTCFullYear();

// ---------------------------------------------------------------------- public types

export type GenomeSystemKey = HealthCategoryKey | 'home';
export type GenomeEventKind = 'construction' | 'install' | 'maintenance' | 'inspection' | 'repair' | 'failure' | 'replacement' | 'upgrade' | 'warranty' | 'alert';
/** Kinds a person may record by hand (the rest are derived from existing records). */
export type ManualEventKind = 'install' | 'maintenance' | 'inspection' | 'repair' | 'failure' | 'replacement' | 'upgrade';
export type GenomeEventSource = 'site' | 'equipment' | 'job' | 'alert' | 'energy' | 'manual';
export type LifecyclePhase = 'unknown' | 'break_in' | 'prime' | 'mature' | 'wear_out' | 'past_life';
export type BehaviorStatus = 'normal' | 'watch' | 'abnormal';
export type EndOfLifeState = 'none' | 'approaching' | 'imminent' | 'past';
export type RepairTrend = 'insufficient' | 'accelerating' | 'steady' | 'slowing';
export type SignalSeverity = 'watch' | 'high';
export type InsightSeverity = 'medium' | 'high';
export type DepthTier = 'seed' | 'emerging' | 'rich' | 'deep';
export type LayerKey = 'property' | 'construction' | 'systems' | 'equipment' | 'repairs' | 'failures' | 'maintenance' | 'replacement' | 'energy' | 'cost' | 'future_risk';
export type LayerState = 'recorded' | 'partial' | 'empty';

export const MANUAL_EVENT_KINDS: readonly ManualEventKind[] = ['install', 'maintenance', 'inspection', 'repair', 'failure', 'replacement', 'upgrade'];

export const EVENT_KIND_LABELS: Record<GenomeEventKind, string> = {
  construction: 'Built',
  install: 'Installed',
  maintenance: 'Maintenance',
  inspection: 'Inspection',
  repair: 'Repair',
  failure: 'Failure',
  replacement: 'Replacement',
  upgrade: 'Upgrade',
  warranty: 'Warranty ended',
  alert: 'Warning sign',
};

export const SYSTEM_LABELS: Record<GenomeSystemKey, string> = { ...CATEGORY_LABELS, home: 'Whole home' };

export const PHASE_LABELS: Record<LifecyclePhase, string> = {
  unknown: 'Age unknown',
  break_in: 'Break-in',
  prime: 'Prime',
  mature: 'Mature',
  wear_out: 'Wear-out',
  past_life: 'Past expected life',
};

export const END_OF_LIFE_LABELS: Record<EndOfLifeState, string> = {
  none: 'Healthy lifecycle',
  approaching: 'Nearing end of lifecycle',
  imminent: 'End of lifecycle is close',
  past: 'Past expected life',
};

export const DEPTH_TIER_LABELS: Record<DepthTier, string> = { seed: 'Seed', emerging: 'Emerging', rich: 'Rich', deep: 'Deep' };

/** A home-level or system-level event recorded by hand, typically for work done before the home was on Vireek. */
export interface ManualGenomeEvent {
  id: string;
  system_key: GenomeSystemKey;
  equipment_id: string | null;
  event_kind: ManualEventKind;
  /** YYYY-MM-DD */
  occurred_on: string;
  title: string;
  note: string | null;
  cost_usd: number | null;
}

export interface GenomeEvent {
  id: string;
  /** Epoch ms. */
  at: number;
  /** YYYY-MM-DD */
  date: string;
  kind: GenomeEventKind;
  systemKey: GenomeSystemKey;
  equipmentId: string | null;
  title: string;
  detail: string | null;
  costUsd: number | null;
  source: GenomeEventSource;
  /** Set for warning signs and open alerts. */
  severity: 'low' | 'medium' | 'high' | null;
  /** Failing part named in the record, when one can be recognised (e.g. "capacitor"). */
  component: string | null;
  /** Set for hand-recorded events, so they can be removed. */
  manualId: string | null;
}

export interface BehaviorSignal {
  key: 'accelerating_repairs' | 'recent_cluster' | 'repeat_component' | 'overdue_service' | 'open_alerts' | 'energy' | 'past_life' | 'repair_vs_replace';
  severity: SignalSeverity;
  title: string;
  detail: string;
}

export interface StoryStep {
  /** null for the closing verdict step. */
  year: number | null;
  label: string;
  tone: 'neutral' | 'warn' | 'bad';
}

export interface SystemFuture {
  basis: GraphBasis;
  level: GraphRiskLevel;
  risk6m: number;
  risk12m: number;
  riskNextYear: number;
  baselineRisk12m: number;
  expectedLoss12m: number;
  replaceInMonths: number | null;
}

export interface GenomeSystem {
  key: HealthCategoryKey;
  label: string;
  activeUnits: number;
  /** ISO date the unit now in service was installed, when known. */
  installedOn: string | null;
  ageYears: number | null;
  ageAssumed: boolean;
  /** Why the age is what it is, when it was not read straight from the equipment record. */
  ageNote: string | null;
  lifespanYears: number;
  /** Calendar age ÷ expected life; null when the age is unknown or only assumed. */
  lifeUsed: number | null;
  /** Calendar age plus the ageing that the behaviour signals imply, as a share of expected life. */
  behaviorLifeUsed: number | null;
  /** The age the unit is behaving like, in years; null when the age is unknown. */
  effectiveAgeYears: number | null;
  phase: LifecyclePhase;
  events: GenomeEvent[];
  counts: Record<'install' | 'maintenance' | 'inspection' | 'repair' | 'failure' | 'replacement', number>;
  lifetimeCost: number;
  spend12m: number;
  repairSpend36m: number;
  meanMonthsBetweenRepairs: number | null;
  lastServiceOn: string | null;
  trend: RepairTrend;
  signals: BehaviorSignal[];
  status: BehaviorStatus;
  endOfLife: EndOfLifeState;
  headline: string;
  reasons: string[];
  storyline: StoryStep[];
  future: SystemFuture | null;
}

export interface GenomeLayer {
  key: LayerKey;
  label: string;
  value: string;
  state: LayerState;
}

export interface DepthPart {
  key: 'history' | 'install_dates' | 'service_events' | 'costs' | 'energy' | 'sources';
  label: string;
  score: number;
  max: number;
}

export interface GenomeDepth {
  score: number;
  tier: DepthTier;
  parts: DepthPart[];
  /** What to record next to deepen the genome, biggest gain first. */
  nextSteps: string[];
}

export interface GenomeInsight {
  id: string;
  systemKey: HealthCategoryKey;
  severity: InsightSeverity;
  title: string;
  body: string;
}

export interface ForecastItem {
  systemKey: HealthCategoryKey;
  label: string;
  kind: 'replacement_window' | 'warranty_end';
  inMonths: number;
}

export interface GenomeTotals {
  events: number;
  /** Events from completed jobs and hand-recorded history (not derived from equipment records). */
  serviceEvents: number;
  jobsContributing: number;
  spanYears: number | null;
  lifetimeCost: number;
  spend12m: number;
  systemsNearingEnd: number;
}

export interface HomeGenome {
  siteName: string;
  yearBuilt: number | null;
  homeAgeYears: number | null;
  /** Every event for the property, oldest first. */
  events: GenomeEvent[];
  systems: GenomeSystem[];
  /** Events not tied to one system (construction, general work). */
  homeEvents: GenomeEvent[];
  layers: GenomeLayer[];
  depth: GenomeDepth;
  totals: GenomeTotals;
  insights: GenomeInsight[];
  forecast: ForecastItem[];
  future: { level: GraphRiskLevel; risk6m: number; risk12m: number; expectedLoss12m: number } | null;
  assumptions: string[];
}

export interface GenomeOptions {
  now?: number;
  yearBuilt?: number | null;
  energyReadings?: EnergyReading[];
  manualEvents?: ManualGenomeEvent[];
}

// ---------------------------------------------------------------------- classification

const REPLACE = /replac|swap[\s-]?out|change[\s-]?out|changeout/i;
const INSTALL = /\binstall|commission|new\s+(system|unit)/i;
const PART_WORDS = /filter|battery|bulb|fuse|belt|hose|gasket|seal|cartridge|\bparts?\b|motor|board|sensor|valve|element|coil|switch|igniter|ignitor|capacitor|contactor|thermostat/i;
const REPAIR_WORDS = /repair|fix|troubleshoot|breakdown|emergency|no[\s-]?(heat|cool|ac|hot\s*water|power)|not\s+(working|heating|cooling)/i;
const MAINTENANCE = /maint|tune|clean|flush|check|seasonal|filter|annual|service\s*plan|preventi/i;
const INSPECTION = /inspect|assess|evaluat|survey/i;
const FAILURE =
  /fail|broke|break[\s-]?down|burst|dead|seiz|overheat|froze|frozen|flood|outage|no[\s-]?(heat|cool|ac|hot\s*water|power)|not\s+(working|heating|cooling)|won'?t\s+(start|turn)|leak|tripp|short(ed)?\b/i;

const COMPONENTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['capacitor', /capacitor/i],
  ['contactor', /contactor/i],
  ['compressor', /compressor/i],
  ['refrigerant', /refrigerant|freon|r-?410a|r-?22\b|low\s*charge/i],
  ['igniter', /igniter|ignitor/i],
  ['flame sensor', /flame\s*sensor/i],
  ['thermostat', /thermostat/i],
  ['blower motor', /blower/i],
  ['fan motor', /fan\s*motor|condenser\s*fan/i],
  ['control board', /control\s*board|circuit\s*board|\bpcb\b/i],
  ['heat exchanger', /heat\s*exchanger/i],
  ['gas valve', /gas\s*valve/i],
  ['thermocouple', /thermocouple/i],
  ['anode rod', /anode/i],
  ['heating element', /heating\s*element/i],
  ['condensate drain', /condensate|drain\s*line/i],
  ['breaker', /breaker/i],
  ['pump', /\bpump\b/i],
];

export function detectComponent(text: string): string | null {
  for (const [name, pattern] of COMPONENTS) if (pattern.test(text)) return name;
  return null;
}

/** Decides what a completed job means for the home's history. Order matters: first match wins. */
export function classifyJobKind(serviceText: string, problemText: string = ''): Extract<GenomeEventKind, 'replacement' | 'install' | 'upgrade' | 'failure' | 'repair' | 'maintenance' | 'inspection'> {
  // Swapping or adding a part is not a new unit: only a whole-unit replacement or install may reset a unit's age.
  const partLike = PART_WORDS.test(serviceText) || detectComponent(serviceText) !== null;
  if (REPLACE.test(serviceText) && !partLike) return 'replacement';
  if (INSTALL.test(serviceText)) return partLike ? 'upgrade' : 'install';
  if (REPAIR_WORDS.test(serviceText)) return FAILURE.test(`${serviceText} ${problemText}`) ? 'failure' : 'repair';
  if (MAINTENANCE.test(serviceText)) return 'maintenance';
  if (INSPECTION.test(serviceText)) return 'inspection';
  return FAILURE.test(`${serviceText} ${problemText}`) ? 'failure' : 'repair';
}

const isIntervention = (e: GenomeEvent) => e.kind === 'repair' || e.kind === 'failure';
const isServiceKind = (k: GenomeEventKind) => k === 'repair' || k === 'failure' || k === 'maintenance' || k === 'inspection' || k === 'replacement' || k === 'upgrade';
const KIND_ORDER: Record<GenomeEventKind, number> = { construction: 0, install: 1, warranty: 2, maintenance: 3, inspection: 4, upgrade: 5, alert: 6, repair: 7, failure: 8, replacement: 9 };

const equipmentLabel = (e: Pick<Equipment, 'make' | 'model' | 'equipment_type'>) => [e.make, e.model].filter(Boolean).join(' ') || e.equipment_type;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const firstSentence = (s: string | null | undefined) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? clip(t, 160) : null;
};

function parseDay(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const t = Date.parse(`${day}T12:00:00Z`);
  // Some engines roll 2026-02-30 over to March 2nd instead of rejecting it.
  return Number.isNaN(t) || isoDay(t) !== day ? null : t;
}

// ---------------------------------------------------------------------- event assembly

function buildEvents(twin: PropertyTwin, options: GenomeOptions, now: number, yearBuilt: number | null): GenomeEvent[] {
  const events: GenomeEvent[] = [];
  const horizon = now + MS_PER_DAY;
  const equipmentById = new Map<string, Equipment>(twin.equipment.map((e) => [e.id, e]));
  const keyOf = (equipmentId: string): HealthCategoryKey | null => {
    const item = equipmentById.get(equipmentId);
    return item ? classifyEquipment(item) : null;
  };
  const push = (e: Omit<GenomeEvent, 'date' | 'manualId'> & { manualId?: string | null }) => {
    if (!Number.isFinite(e.at) || e.at > horizon) return;
    events.push({ ...e, date: isoDay(e.at), manualId: e.manualId ?? null });
  };

  if (yearBuilt !== null) {
    push({
      id: 'site:construction',
      at: Date.UTC(yearBuilt, 0, 1, 12),
      kind: 'construction',
      systemKey: 'home',
      equipmentId: null,
      title: `Built in ${yearBuilt}`,
      detail: null,
      costUsd: null,
      source: 'site',
      severity: null,
      component: null,
    });
  }

  // ---- equipment records: install, warranty end ----
  for (const item of twin.equipment) {
    const key = classifyEquipment(item);
    if (!key) continue;
    const installAt = item.install_date ? new Date(item.install_date).getTime() : NaN;
    if (!Number.isNaN(installAt)) {
      push({
        id: `eq:${item.id}:install`,
        at: installAt,
        kind: 'install',
        systemKey: key,
        equipmentId: item.id,
        title: `${equipmentLabel(item)} installed`,
        detail: null,
        costUsd: null,
        source: 'equipment',
        severity: null,
        component: null,
      });
    }
    const warrantyAt = item.warranty_expires_at ? new Date(item.warranty_expires_at).getTime() : NaN;
    if (!Number.isNaN(warrantyAt)) {
      push({
        id: `eq:${item.id}:warranty`,
        at: warrantyAt,
        kind: 'warranty',
        systemKey: key,
        equipmentId: item.id,
        title: `${equipmentLabel(item)} manufacturer warranty ended`,
        detail: firstSentence(item.warranty_notes),
        costUsd: null,
        source: 'equipment',
        severity: null,
        component: null,
      });
    }
  }

  // ---- completed jobs ----
  const linksByJob = new Map<string, string[]>();
  for (const link of twin.jobEquipmentLinks) {
    const list = linksByJob.get(link.job_id) ?? [];
    list.push(link.equipment_id);
    linksByJob.set(link.job_id, list);
  }
  const linkServiceType = new Map<string, string>();
  for (const link of twin.jobEquipmentLinks) if (link.service_type) linkServiceType.set(`${link.job_id}:${link.equipment_id}`, link.service_type);

  for (const job of twin.jobs as Job[]) {
    if (job.job_status !== 'completed' || !job.scheduled_datetime) continue;
    const at = new Date(job.scheduled_datetime).getTime();
    if (Number.isNaN(at)) continue;
    const linked = linksByJob.get(job.id) ?? [];
    // One event per system the job touched; a job that touched nothing classifiable is a whole-home event.
    const groups = new Map<GenomeSystemKey, string | null>();
    for (const equipmentId of linked) {
      const key = keyOf(equipmentId);
      if (key && !groups.has(key)) groups.set(key, equipmentId);
    }
    const jobText = job.service_type ?? '';
    if (groups.size === 0) {
      const guessed = classifyEquipment({ equipment_type: jobText, make: null, model: null });
      groups.set(guessed ?? 'home', null);
    }
    const problem = `${job.diagnosis_notes ?? ''} ${job.work_performed_notes ?? ''}`;
    const share = job.invoice_amount != null && job.invoice_amount >= 0 ? r2(job.invoice_amount / groups.size) : null;
    for (const [systemKey, equipmentId] of groups) {
      const text = (equipmentId ? linkServiceType.get(`${job.id}:${equipmentId}`) : null) ?? jobText;
      const kind = classifyJobKind(text, problem);
      const unit = equipmentId ? equipmentById.get(equipmentId) : undefined;
      push({
        id: `job:${job.id}:${systemKey}`,
        at,
        kind,
        systemKey,
        equipmentId,
        title: clip(text.trim() || `${EVENT_KIND_LABELS[kind]}`, 90),
        detail: firstSentence(job.work_performed_notes) ?? firstSentence(job.diagnosis_notes) ?? (unit ? equipmentLabel(unit) : null),
        costUsd: share,
        source: 'job',
        severity: null,
        component: kind === 'maintenance' || kind === 'inspection' ? null : detectComponent(`${text} ${problem}`),
      });
    }
  }

  // ---- hand-recorded history ----
  for (const m of options.manualEvents ?? []) {
    const at = parseDay(m.occurred_on);
    if (at === null) continue;
    const key: GenomeSystemKey = m.equipment_id && keyOf(m.equipment_id) ? (keyOf(m.equipment_id) as HealthCategoryKey) : m.system_key;
    push({
      id: `manual:${m.id}`,
      at,
      kind: m.event_kind,
      systemKey: key,
      equipmentId: m.equipment_id,
      title: clip(m.title.trim(), 90),
      detail: firstSentence(m.note),
      costUsd: m.cost_usd,
      source: 'manual',
      severity: null,
      component: m.event_kind === 'maintenance' || m.event_kind === 'inspection' ? null : detectComponent(`${m.title} ${m.note ?? ''}`),
      manualId: m.id,
    });
  }

  // ---- open predictive alerts ----
  for (const alert of twin.maintenanceAlerts as EquipmentMaintenanceAlert[]) {
    if (alert.is_dismissed) continue;
    const key = keyOf(alert.equipment_id);
    const at = new Date(alert.created_at).getTime();
    if (!key || Number.isNaN(at)) continue;
    push({
      id: `alert:${alert.id}`,
      at,
      kind: 'alert',
      systemKey: key,
      equipmentId: alert.equipment_id,
      title: clip(alert.predicted_issue, 90),
      detail: firstSentence(alert.recommended_action),
      costUsd: null,
      source: 'alert',
      severity: alert.risk_level,
      component: null,
    });
  }

  // ---- energy: one warning sign when HVAC consumption is running well above last year ----
  const energy = analyzeEnergy(options.energyReadings ?? [], now);
  if ((energy.state === 'elevated' || energy.state === 'high') && energy.yoyChange !== null) {
    const latest = (options.energyReadings ?? [])
      .map((r) => r.period_start.slice(0, 7))
      .filter((m) => /^\d{4}-\d{2}$/.test(m))
      .sort()
      .filter((m) => Date.parse(`${m}-01T12:00:00Z`) <= now)
      .pop();
    if (latest) {
      push({
        id: 'energy:signal',
        at: Date.parse(`${latest}-01T12:00:00Z`),
        kind: 'alert',
        systemKey: 'hvac',
        equipmentId: null,
        title: `Energy use ${energy.yoyChange >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(energy.yoyChange * 100))}% on last year`,
        detail: 'Not weather-adjusted; a weak early-warning sign for the heating and cooling system.',
        costUsd: null,
        source: 'energy',
        severity: energy.state === 'high' ? 'high' : 'medium',
        component: null,
      });
    }
  }

  // ---- de-duplicate: a job/manual install or replacement wins over the equipment record of the same unit ----
  const moves = events.filter((e) => e.source !== 'equipment' && (e.kind === 'install' || e.kind === 'replacement'));
  const kept = events.filter(
    (e) => !(e.source === 'equipment' && e.kind === 'install' && moves.some((m) => m.systemKey === e.systemKey && Math.abs(m.at - e.at) <= INSTALL_DEDUPE_WINDOW_MS)),
  );

  return kept.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------- per-system analysis

function phaseFor(lifeUsed: number | null): LifecyclePhase {
  if (lifeUsed === null) return 'unknown';
  if (lifeUsed >= 1) return 'past_life';
  if (lifeUsed >= 0.85) return 'wear_out';
  if (lifeUsed >= 0.6) return 'mature';
  if (lifeUsed >= 0.1) return 'prime';
  return 'break_in';
}

function trendFor(interventions: GenomeEvent[]): { trend: RepairTrend; meanGap: number | null } {
  if (interventions.length < 2) return { trend: 'insufficient', meanGap: null };
  const gaps: number[] = [];
  for (let i = 1; i < interventions.length; i += 1) gaps.push((interventions[i].at - interventions[i - 1].at) / MS_PER_MONTH);
  const meanGap = sum(gaps) / gaps.length;
  if (interventions.length < MIN_INTERVENTIONS_FOR_TREND) return { trend: 'insufficient', meanGap: r1(meanGap) };
  const last = gaps[gaps.length - 1];
  const earlier = sum(gaps.slice(0, -1)) / (gaps.length - 1);
  if (earlier <= 0) return { trend: 'steady', meanGap: r1(meanGap) };
  const ratio = last / earlier;
  return { trend: ratio < ACCELERATION_RATIO ? 'accelerating' : ratio > SLOWING_RATIO ? 'slowing' : 'steady', meanGap: r1(meanGap) };
}

interface SystemInput {
  key: HealthCategoryKey;
  events: GenomeEvent[];
  units: Equipment[];
  alerts: EquipmentMaintenanceAlert[];
  node: GraphNode | undefined;
  energyHigh: boolean;
  energyElevated: boolean;
  now: number;
}

function analyzeSystem(input: SystemInput): GenomeSystem {
  const { key, events, units, alerts, node, now } = input;
  const label = CATEGORY_LABELS[key];
  const model = SYSTEM_MODEL[key];
  const active = units.filter((u) => u.status === 'active');
  const lifespan = node?.lifespanYears ?? (active.find((u) => u.expected_lifespan_years > 0)?.expected_lifespan_years ?? model.life);

  // ---- age: from the equipment graph, unless a later replacement/install event says otherwise ----
  let ageYears: number | null = node && node.basis === 'equipment' ? node.ageYears : null;
  let ageAssumed = node?.basis === 'equipment' ? node.ageAssumed : false;
  let ageNote: string | null = null;
  const lastMove = [...events].reverse().find((e) => e.source !== 'equipment' && (e.kind === 'replacement' || e.kind === 'install'));
  const moveAge = lastMove ? (now - lastMove.at) / MS_PER_YEAR : null;
  if (moveAge !== null && (ageYears === null || ageAssumed || moveAge < ageYears)) {
    ageYears = r1(Math.max(0, moveAge));
    ageAssumed = false;
    ageNote = `Counted from the ${lastMove?.kind === 'replacement' ? 'replacement' : 'installation'} recorded on ${lastMove?.date}.`;
  } else if (ageAssumed) {
    ageNote = 'No install date on record, so the age is not used for lifecycle judgements.';
  }
  const ageKnown = ageYears !== null && !ageAssumed;
  const lifeUsed = ageKnown ? r2((ageYears as number) / lifespan) : null;

  // ---- history counts and money ----
  const counts = { install: 0, maintenance: 0, inspection: 0, repair: 0, failure: 0, replacement: 0 };
  for (const e of events) if (e.kind in counts) counts[e.kind as keyof typeof counts] += 1;
  const interventions = events.filter(isIntervention);
  const lifetimeCost = r2(sum(events.map((e) => e.costUsd ?? 0)));
  const spend12m = r2(sum(events.filter((e) => e.at >= now - 12 * MS_PER_MONTH).map((e) => e.costUsd ?? 0)));
  const repairSpend36m = r2(sum(interventions.filter((e) => e.at >= now - REPAIR_SPEND_WINDOW_MONTHS * MS_PER_MONTH).map((e) => e.costUsd ?? 0)));
  const serviceEvents = events.filter((e) => isServiceKind(e.kind));
  const lastService = serviceEvents[serviceEvents.length - 1];
  const { trend, meanGap } = trendFor(interventions);

  // ---- behaviour signals ----
  const signals: BehaviorSignal[] = [];
  const recent12 = interventions.filter((e) => e.at >= now - 12 * MS_PER_MONTH);
  if (trend === 'accelerating') {
    const last = (interventions[interventions.length - 1].at - interventions[interventions.length - 2].at) / MS_PER_MONTH;
    signals.push({
      key: 'accelerating_repairs',
      severity: interventions.length >= 4 ? 'high' : 'watch',
      title: 'Repairs are getting closer together',
      detail: `${interventions.length} repairs or failures; the latest came ${Math.max(1, Math.round(last))} months after the one before, against about ${Math.round(meanGap ?? last)} months on average.`,
    });
  }
  if (recent12.length >= 2 && !(trend === 'accelerating' && recent12.length < 3)) {
    signals.push({
      key: 'recent_cluster',
      severity: recent12.length >= 3 ? 'high' : 'watch',
      title: `${recent12.length} repairs or failures in the last 12 months`,
      detail: 'A cluster of recent problems is a stronger warning than the same number spread over many years.',
    });
  }
  const byComponent = new Map<string, number>();
  for (const e of interventions) if (e.component) byComponent.set(e.component, (byComponent.get(e.component) ?? 0) + 1);
  const repeat = [...byComponent.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
  if (repeat) {
    signals.push({
      key: 'repeat_component',
      severity: repeat[1] >= 3 ? 'high' : 'watch',
      title: `Repeat problem: ${repeat[0]}`,
      detail: `The ${repeat[0]} appears in ${repeat[1]} separate repair records — a repeating part usually points at a deeper cause.`,
    });
  }
  const overdue = Math.max(0, ...active.map((u) => monthsOverdue(u, now) ?? 0));
  if (overdue >= OVERDUE_WATCH_MONTHS) {
    signals.push({
      key: 'overdue_service',
      severity: overdue >= OVERDUE_HIGH_MONTHS ? 'high' : 'watch',
      title: `Service is ${Math.round(overdue)} months overdue`,
      detail: 'Units that skip scheduled service age faster and fail sooner.',
    });
  }
  const openAlerts = alerts.filter((a) => !a.is_dismissed);
  if (openAlerts.length > 0) {
    const worst = [...openAlerts].sort((a, b) => ['low', 'medium', 'high'].indexOf(b.risk_level) - ['low', 'medium', 'high'].indexOf(a.risk_level))[0];
    signals.push({
      key: 'open_alerts',
      severity: worst.risk_level === 'high' ? 'high' : 'watch',
      title: `${openAlerts.length} open predictive alert${openAlerts.length === 1 ? '' : 's'}`,
      detail: clip(worst.predicted_issue, 120),
    });
  }
  if (key === 'hvac' && (input.energyHigh || input.energyElevated)) {
    const e = events.find((x) => x.source === 'energy');
    signals.push({
      key: 'energy',
      severity: input.energyHigh ? 'high' : 'watch',
      title: e?.title ?? 'Energy use is above last year',
      detail: 'Rising consumption often shows up before a heating or cooling system fails. Not weather-adjusted.',
    });
  }
  const replacementCost = DEFAULT_COSTS[key].replacement;
  const repairVsReplace = repairSpend36m >= REPLACE_SPEND_SHARE * replacementCost && (lifeUsed === null || lifeUsed >= 0.5);
  if (repairVsReplace) {
    signals.push({
      key: 'repair_vs_replace',
      severity: 'high',
      title: 'Repair spend is approaching the price of a new unit',
      detail: `${usd(repairSpend36m)} spent on repairs in 36 months against about ${usd(replacementCost)} for a replacement.`,
    });
  }
  if (lifeUsed !== null && lifeUsed >= 1) {
    signals.push({
      key: 'past_life',
      severity: 'high',
      title: 'Past its expected life',
      detail: `${r1(ageYears as number)} years old against an expected ${lifespan}.`,
    });
  }

  const highs = signals.filter((s) => s.severity === 'high').length;
  const watches = signals.length - highs;
  const status: BehaviorStatus = highs > 0 || watches >= 3 ? 'abnormal' : watches > 0 ? 'watch' : 'normal';

  // ---- lifecycle: calendar age, then behaviour-adjusted age ----
  // Past-life is a signal of its own; counting it again as "ageing" would double-count.
  const penalty = clamp(
    sum(signals.filter((s) => s.key !== 'past_life' && s.key !== 'repair_vs_replace').map((s) => (s.severity === 'high' ? PENALTY_HIGH : PENALTY_WATCH))),
    0,
    PENALTY_CAP,
  );
  const behaviorLifeUsed = lifeUsed === null ? null : r2(Math.min(1.2, lifeUsed + penalty));
  const effectiveAgeYears = behaviorLifeUsed === null ? null : r1(behaviorLifeUsed * lifespan);
  const replaceInMonths = node && node.replaceInMonths !== null ? node.replaceInMonths : null;

  let endOfLife: EndOfLifeState = 'none';
  if (lifeUsed !== null && lifeUsed >= 1) endOfLife = 'past';
  else if (behaviorLifeUsed !== null && (behaviorLifeUsed >= IMMINENT_AT || (replaceInMonths !== null && replaceInMonths <= 12 && (lifeUsed ?? 0) >= 0.6))) endOfLife = 'imminent';
  else if (
    (behaviorLifeUsed !== null && behaviorLifeUsed >= APPROACHING_AT) ||
    repairVsReplace ||
    (replaceInMonths !== null && replaceInMonths <= 36 && (lifeUsed ?? 0) >= 0.5) ||
    (lifeUsed === null && status === 'abnormal' && interventions.length >= 3)
  ) {
    endOfLife = 'approaching';
  }
  // A system that is not meant to be replaced (wiring, pipes) is judged on behaviour, never on a replacement date.
  if (model.kind === 'inspection' && endOfLife === 'imminent' && !repairVsReplace) endOfLife = 'approaching';

  const phase = phaseFor(lifeUsed);

  // ---- explanation ----
  const reasons: string[] = [];
  if (lifeUsed !== null) {
    reasons.push(
      `${r1(ageYears as number)} of ${lifespan} expected years used (${pct(lifeUsed)})${effectiveAgeYears !== null && effectiveAgeYears - (ageYears as number) >= 0.5 ? `; behaving like a ${r1(effectiveAgeYears)}-year-old unit` : ''}.`,
    );
  }
  for (const s of [...signals].sort((a, b) => Number(b.severity === 'high') - Number(a.severity === 'high'))) {
    if (s.key === 'past_life') continue;
    if (reasons.length >= MAX_REASONS) break;
    reasons.push(s.title + (s.key === 'accelerating_repairs' || s.key === 'repair_vs_replace' ? ` — ${s.detail}` : '.'));
  }

  const headline =
    endOfLife === 'past'
      ? `${label} is past its expected life`
      : endOfLife === 'imminent'
        ? `${label} is close to the end of its lifecycle`
        : endOfLife === 'approaching'
          ? `${label} is approaching the end of its lifecycle`
          : status === 'abnormal'
            ? `${label} is showing abnormal behaviour`
            : status === 'watch'
              ? `${label} has early warning signs`
              : `${label} is behaving normally`;

  // ---- storyline: the chain a person can read at a glance ----
  const notable = events.filter((e) => e.kind === 'install' || e.kind === 'replacement' || e.kind === 'failure' || e.kind === 'repair' || (e.kind === 'alert' && e.severity !== 'low'));
  let steps: StoryStep[] = notable.map((e) => ({
    year: yearOf(e.at),
    label: e.kind === 'alert' ? 'Abnormal behaviour' : `${EVENT_KIND_LABELS[e.kind]}${e.component && (e.kind === 'failure' || e.kind === 'repair') ? ` (${e.component})` : ''}`,
    tone: e.kind === 'failure' ? 'bad' : e.kind === 'repair' || e.kind === 'alert' ? 'warn' : 'neutral',
  }));
  if (steps.length > MAX_STORYLINE_STEPS - 1) steps = [steps[0], ...steps.slice(-(MAX_STORYLINE_STEPS - 2))];
  if (endOfLife !== 'none') steps.push({ year: null, label: END_OF_LIFE_LABELS[endOfLife], tone: 'bad' });
  else if (status !== 'normal') steps.push({ year: null, label: 'Under watch', tone: 'warn' });

  const installEvent = [...events].reverse().find((e) => e.kind === 'install' || e.kind === 'replacement');
  const future: SystemFuture | null = node
    ? {
        basis: node.basis,
        level: node.level,
        risk6m: node.risk6m,
        risk12m: node.risk12m,
        riskNextYear: node.riskNextYear,
        baselineRisk12m: node.baselineRisk12m,
        expectedLoss12m: node.expectedLoss12m,
        replaceInMonths,
      }
    : null;

  return {
    key,
    label,
    activeUnits: active.length,
    installedOn: ageKnown && ageYears !== null ? isoDay(now - ageYears * MS_PER_YEAR) : (installEvent?.date ?? null),
    ageYears,
    ageAssumed,
    ageNote,
    lifespanYears: lifespan,
    lifeUsed,
    behaviorLifeUsed,
    effectiveAgeYears,
    phase,
    events,
    counts,
    lifetimeCost,
    spend12m,
    repairSpend36m,
    meanMonthsBetweenRepairs: meanGap,
    lastServiceOn: lastService?.date ?? null,
    trend,
    signals,
    status,
    endOfLife,
    headline,
    reasons,
    storyline: steps,
    future,
  };
}

// ---------------------------------------------------------------------- depth, layers, insights

function buildDepth(args: {
  events: GenomeEvent[];
  serviceEvents: GenomeEvent[];
  spanYears: number | null;
  activeEquipment: Equipment[];
  energyReadingCount: number;
  hasYearBuilt: boolean;
  hasJobs: boolean;
  hasManual: boolean;
}): GenomeDepth {
  const { serviceEvents, spanYears, activeEquipment, energyReadingCount } = args;
  const withInstall = activeEquipment.filter((e) => e.install_date).length;
  const costed = serviceEvents.filter((e) => e.costUsd !== null).length;
  const sources = [args.hasYearBuilt, activeEquipment.length > 0, args.hasJobs, args.hasManual, energyReadingCount > 0].filter(Boolean).length;

  const parts: DepthPart[] = [
    { key: 'history', label: 'Years of history', max: 25, score: spanYears === null ? 0 : Math.round(Math.min(spanYears / 10, 1) * 25) },
    { key: 'install_dates', label: 'Install dates known', max: 25, score: activeEquipment.length === 0 ? 0 : Math.round((withInstall / activeEquipment.length) * 25) },
    { key: 'service_events', label: 'Service events recorded', max: 20, score: Math.round(Math.min(serviceEvents.length / 12, 1) * 20) },
    { key: 'costs', label: 'Costs documented', max: 10, score: serviceEvents.length === 0 ? 0 : Math.round((costed / serviceEvents.length) * 10) },
    { key: 'energy', label: 'Energy readings', max: 10, score: Math.round(Math.min(energyReadingCount / 12, 1) * 10) },
    { key: 'sources', label: 'Independent sources', max: 10, score: Math.round((sources / 5) * 10) },
  ];
  const score = clamp(sum(parts.map((p) => p.score)), 0, 100);
  const tier: DepthTier = score >= 75 ? 'deep' : score >= 50 ? 'rich' : score >= 25 ? 'emerging' : 'seed';

  const missingInstall = activeEquipment.length - withInstall;
  const advice: Record<DepthPart['key'], string> = {
    history: 'Add past installs, repairs and replacements from before the home was on Vireek to extend the documented history.',
    install_dates: `Add install dates for ${missingInstall} unit${missingInstall === 1 ? '' : 's'} so their age is measured, not assumed.`,
    service_events: 'Record earlier service visits; every completed job also adds to the genome automatically.',
    costs: 'Add costs to recorded events so lifetime spend and the repair-versus-replace view are accurate.',
    energy: 'Add monthly energy readings to unlock the early-warning signal for heating and cooling.',
    sources: 'Connect more independent inputs — each one cross-checks the others.',
  };
  const nextSteps = parts
    .filter((p) => p.max - p.score >= 3)
    .sort((a, b) => b.max - b.score - (a.max - a.score))
    .slice(0, 3)
    .map((p) => advice[p.key]);
  return { score, tier, parts, nextSteps };
}

const SEVERITY_RANK: Record<InsightSeverity, number> = { high: 0, medium: 1 };

function buildInsights(systems: GenomeSystem[]): GenomeInsight[] {
  const out: GenomeInsight[] = [];
  for (const s of systems) {
    if (s.endOfLife === 'none' && s.status !== 'abnormal') continue;
    const severity: InsightSeverity = s.endOfLife === 'past' || s.endOfLife === 'imminent' || (s.endOfLife === 'approaching' && s.status === 'abnormal') ? 'high' : 'medium';
    out.push({ id: `genome:${s.key}`, systemKey: s.key, severity, title: s.headline, body: s.reasons.slice(0, 3).join(' ') });
  }
  return out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, MAX_INSIGHTS);
}

// ---------------------------------------------------------------------- compute

export function computeHomeGenome(twin: PropertyTwin, options: GenomeOptions = {}): HomeGenome | null {
  if (!twin.site) return null;
  const now = options.now ?? Date.now();
  const yearBuilt = options.yearBuilt != null && isValidYearBuilt(options.yearBuilt, now) ? options.yearBuilt : null;
  const energyReadings = options.energyReadings ?? [];
  const energy = analyzeEnergy(energyReadings, now);

  const events = buildEvents(twin, { ...options, energyReadings }, now, yearBuilt);
  const graph = computeHomeIntelligenceGraph(twin, { now, yearBuilt, energyReadings });
  const nodeByKey = new Map<HealthCategoryKey, GraphNode>();
  for (const n of graph?.nodes ?? []) if (n.kind === 'system' && n.categoryKey) nodeByKey.set(n.categoryKey, n);

  const unitsByKey = new Map<HealthCategoryKey, Equipment[]>();
  for (const item of twin.equipment) {
    const key = classifyEquipment(item);
    if (!key) continue;
    unitsByKey.set(key, [...(unitsByKey.get(key) ?? []), item]);
  }
  const equipmentKey = new Map<string, HealthCategoryKey>();
  for (const [key, list] of unitsByKey) for (const u of list) equipmentKey.set(u.id, key);

  const systems: GenomeSystem[] = [];
  for (const key of HEALTH_CATEGORIES) {
    const sysEvents = events.filter((e) => e.systemKey === key);
    const units = unitsByKey.get(key) ?? [];
    if (units.length === 0 && sysEvents.length === 0) continue;
    const alerts = twin.maintenanceAlerts.filter((a) => equipmentKey.get(a.equipment_id) === key);
    systems.push(
      analyzeSystem({
        key,
        events: sysEvents,
        units,
        alerts,
        node: nodeByKey.get(key),
        energyHigh: energy.state === 'high',
        energyElevated: energy.state === 'elevated',
        now,
      }),
    );
  }

  const homeEvents = events.filter((e) => e.systemKey === 'home');
  const serviceEvents = events.filter((e) => (e.source === 'job' || e.source === 'manual') && isServiceKind(e.kind));
  const datedForSpan = events.filter((e) => e.kind !== 'construction' && e.kind !== 'alert');
  const spanYears = datedForSpan.length ? r1(Math.max(0, (now - datedForSpan[0].at) / MS_PER_YEAR)) : null;
  const activeEquipment = twin.equipment.filter((e) => e.status === 'active' && classifyEquipment(e) !== null);
  const jobIds = new Set(events.filter((e) => e.source === 'job').map((e) => e.id.split(':')[1]));
  const lifetimeCost = r2(sum(events.map((e) => e.costUsd ?? 0)));
  const spend12m = r2(sum(events.filter((e) => e.at >= now - 12 * MS_PER_MONTH).map((e) => e.costUsd ?? 0)));

  const depth = buildDepth({
    events,
    serviceEvents,
    spanYears,
    activeEquipment,
    energyReadingCount: energy.readingCount,
    hasYearBuilt: yearBuilt !== null,
    hasJobs: jobIds.size > 0,
    hasManual: events.some((e) => e.source === 'manual'),
  });

  const count = (kind: GenomeEventKind) => events.filter((e) => e.kind === kind).length;
  const nearing = systems.filter((s) => s.endOfLife !== 'none').length;
  const layerOf = (n: number, partialBelow = 0): LayerState => (n === 0 ? 'empty' : n < partialBelow ? 'partial' : 'recorded');
  const layers: GenomeLayer[] = [
    { key: 'property', label: 'Property', value: twin.site.name, state: 'recorded' },
    { key: 'construction', label: 'Construction', value: yearBuilt !== null ? String(yearBuilt) : 'Year unknown', state: yearBuilt !== null ? 'recorded' : 'empty' },
    { key: 'systems', label: 'Systems', value: String(systems.length), state: layerOf(systems.length) },
    {
      key: 'equipment',
      label: 'Equipment',
      value: String(activeEquipment.length),
      state: activeEquipment.length === 0 ? 'empty' : activeEquipment.every((e) => e.install_date) ? 'recorded' : 'partial',
    },
    { key: 'repairs', label: 'Repairs', value: String(count('repair')), state: layerOf(count('repair')) },
    { key: 'failures', label: 'Failures', value: String(count('failure')), state: layerOf(count('failure')) },
    { key: 'maintenance', label: 'Maintenance', value: String(count('maintenance') + count('inspection')), state: layerOf(count('maintenance') + count('inspection')) },
    { key: 'replacement', label: 'Replacement', value: String(count('replacement')), state: layerOf(count('replacement')) },
    {
      key: 'energy',
      label: 'Energy',
      value: energy.readingCount === 0 ? 'No readings' : `${energy.readingCount} reading${energy.readingCount === 1 ? '' : 's'}`,
      state: energy.state === 'none' ? 'empty' : energy.state === 'insufficient' ? 'partial' : 'recorded',
    },
    { key: 'cost', label: 'Cost', value: lifetimeCost > 0 ? usd(lifetimeCost) : 'None recorded', state: lifetimeCost > 0 ? 'recorded' : 'empty' },
    { key: 'future_risk', label: 'Future risk', value: graph ? `${pct(graph.risk12m)} in 12 mo` : 'Not enough data', state: graph ? 'recorded' : 'empty' },
  ];

  const forecast: ForecastItem[] = [];
  for (const s of systems) {
    if (s.future && s.future.replaceInMonths !== null && s.future.basis === 'equipment' && (s.endOfLife !== 'none' || s.future.replaceInMonths <= 60)) {
      forecast.push({ systemKey: s.key, label: s.label, kind: 'replacement_window', inMonths: s.future.replaceInMonths });
    }
  }
  for (const item of twin.equipment) {
    const key = equipmentKey.get(item.id);
    const t = item.warranty_expires_at ? new Date(item.warranty_expires_at).getTime() : NaN;
    if (!key || item.status !== 'active' || Number.isNaN(t) || t <= now) continue;
    const months = Math.round((t - now) / MS_PER_MONTH);
    if (months <= 24) forecast.push({ systemKey: key, label: `${CATEGORY_LABELS[key]} warranty`, kind: 'warranty_end', inMonths: months });
  }
  forecast.sort((a, b) => a.inMonths - b.inMonths);

  const assumptions: string[] = [
    'The genome records what is on file: completed jobs, equipment records and history you add by hand. A quiet history can mean a healthy home or one that was serviced elsewhere.',
    'Warning signs are patterns in the record, not diagnoses. “Behaving like an older unit” adds up to 30% of expected life for repeated problems, overdue service, open alerts and rising energy use.',
    'Future-risk figures come from the Home Intelligence Graph and are planning estimates in today’s dollars, not quotes.',
  ];
  if (systems.some((s) => s.ageAssumed)) assumptions.push('Units with no install date are not judged on age until one is recorded.');
  if (energy.state === 'none' || energy.state === 'insufficient') assumptions.push('No usable energy history, so energy behaviour is not part of any signal.');

  return {
    siteName: twin.site.name,
    yearBuilt,
    homeAgeYears: homeAgeFromYearBuilt(yearBuilt, now),
    events,
    systems,
    homeEvents,
    layers,
    depth,
    totals: { events: events.length, serviceEvents: serviceEvents.length, jobsContributing: jobIds.size, spanYears, lifetimeCost, spend12m, systemsNearingEnd: nearing },
    insights: buildInsights(systems),
    forecast: forecast.slice(0, MAX_FORECAST),
    future: graph ? { level: graph.level, risk6m: graph.risk6m, risk12m: graph.risk12m, expectedLoss12m: graph.expectedLoss12m } : null,
    assumptions,
  };
}

// ---------------------------------------------------------------------- form validation

export interface GenomeEventInput {
  /** `eq:<equipmentId>` or `sys:<key>`. */
  target: string;
  kind: string;
  date: string;
  title: string;
  note: string;
  cost: string;
}

export type GenomeEventField = 'target' | 'kind' | 'date' | 'title' | 'note' | 'cost';

export type GenomeEventResult =
  | { ok: true; value: { system_key: GenomeSystemKey; equipment_id: string | null; event_kind: ManualEventKind; occurred_on: string; title: string; note: string | null; cost_usd: number | null } }
  | { ok: false; field: GenomeEventField; error: string };

export const EVENT_TITLE_MAX = 120;
export const EVENT_NOTE_MAX = 1000;
const EARLIEST_YEAR = 1900;

/** Validates the “add history” form. A chosen unit must be one of this property’s own `equipment`. */
export function validateGenomeEventInput(input: GenomeEventInput, equipment: Array<Pick<Equipment, 'id' | 'equipment_type' | 'make' | 'model'>>, now: number = Date.now()): GenomeEventResult {
  let systemKey: GenomeSystemKey | null = null;
  let equipmentId: string | null = null;
  if (input.target.startsWith('eq:')) {
    const unit = equipment.find((e) => e.id === input.target.slice(3));
    const key = unit ? classifyEquipment(unit) : null;
    if (!unit || !key) return { ok: false, field: 'target', error: 'Choose a system or a unit at this property.' };
    systemKey = key;
    equipmentId = unit.id;
  } else if (input.target.startsWith('sys:')) {
    const key = input.target.slice(4);
    if (key === 'home' || (HEALTH_CATEGORIES as readonly string[]).includes(key)) systemKey = key as GenomeSystemKey;
  }
  if (systemKey === null) return { ok: false, field: 'target', error: 'Choose a system or a unit at this property.' };

  if (!(MANUAL_EVENT_KINDS as readonly string[]).includes(input.kind)) return { ok: false, field: 'kind', error: 'Choose what happened.' };

  const at = parseDay(input.date);
  if (at === null) return { ok: false, field: 'date', error: 'Enter the date this happened.' };
  if (at > now + MS_PER_DAY) return { ok: false, field: 'date', error: 'That date has not happened yet.' };
  if (new Date(at).getUTCFullYear() < EARLIEST_YEAR) return { ok: false, field: 'date', error: `Enter a date from ${EARLIEST_YEAR} onward.` };

  const title = input.title.trim().replace(/\s+/g, ' ');
  if (title.length < 3) return { ok: false, field: 'title', error: 'Describe it in a few words, e.g. “Capacitor replaced”.' };
  if (title.length > EVENT_TITLE_MAX) return { ok: false, field: 'title', error: `Keep the title under ${EVENT_TITLE_MAX} characters.` };

  const note = input.note.trim();
  if (note.length > EVENT_NOTE_MAX) return { ok: false, field: 'note', error: `Keep the note under ${EVENT_NOTE_MAX} characters.` };

  let cost: number | null = null;
  if (input.cost.trim() !== '') {
    const c = Number(input.cost.trim());
    if (!Number.isFinite(c) || c < 0 || c > 10_000_000) return { ok: false, field: 'cost', error: 'Enter the cost as a positive amount, or leave it blank.' };
    cost = r2(c);
  }

  return {
    ok: true,
    value: { system_key: systemKey, equipment_id: equipmentId, event_kind: input.kind as ManualEventKind, occurred_on: input.date, title, note: note === '' ? null : note, cost_usd: cost },
  };
}

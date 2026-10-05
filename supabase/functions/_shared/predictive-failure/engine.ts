// supabase/functions/_shared/predictive-failure/engine.ts
//
// VIREEK Predictive Failure Network - pure prediction engine (no I/O, no Deno APIs).
// Used by supabase/functions/predictive-failure and unit-tested from src/lib/predictiveFailure.test.ts.
//
// MODEL (deliberately explainable, never a black box)
//   per failure mode:  P(fail within horizon | survived to age a)
//                      = 1 - exp( - HR * [ (a+h)/eta )^beta - (a/eta)^beta ] )      (Weibull, conditional)
//     a    = age of the COMPONENT (resets when the part was replaced), else unit age
//     eta  = expert prior, blended with the network's observed age-at-failure (Global Failure Atlas)
//     HR   = product of explainable hazard ratios (overdue service, repair pattern, repeat part,
//            weather stress, usage/duty, learned per-account correction)
//   per unit:          1 - PRODUCT(1 - p_mode)         (independence assumption, stated in the UI)
//   then               calibration from THIS account's resolved forecasts (shrinkage-smoothed reliability map)
//
// HONESTY RULES
//   * No install date AND no component history -> that mode is skipped, never guessed.
//   * Probabilities are only labelled "calibrated" after MIN_CALIBRATION_N resolved outcomes.
//   * The uncertainty band is a heuristic (evidence tier), not a statistical confidence interval.

export const ENGINE_VERSION = "pfn-1.0.0";
export const MIN_CALIBRATION_N = 30;
export const CAL_BINS = 10;

export type Family =
  | "hvac_cooling" | "hvac_heating" | "water_heater" | "plumbing" | "electrical" | "appliance" | "generic";
export type Band = "critical" | "high" | "elevated" | "low";
export type Confidence = "high" | "moderate" | "low";
export type Seasonal = "none" | "cooling" | "heating";
export type InterventionKind = "preventive_repair" | "inspection" | "maintenance" | "replacement_planning";

export interface Intervention {
  key: string;
  label: string;
  kind: InterventionKind;
  parts: string[];
  estMinutes: number;
}

export interface ModeDef {
  key: string;
  label: string;
  families: Family[];
  shape: number;
  /** characteristic life in months; null = derive from the unit's expected lifespan (median == lifespan) */
  scaleMonths: number | null;
  aliases: string[];
  partKeywords: string[];
  maintenanceSensitive: boolean;
  runtimeDriven: boolean;
  seasonal: Seasonal;
  safetyCritical: boolean;
  typicalCostCents: number;
  intervention: Intervention;
}

export interface AtlasCell {
  failureMode: string;
  unitsObserved: number;
  failureRatePct: number;
  medianAgeMonths: number | null;
  p25AgeMonths: number | null;
  p75AgeMonths: number | null;
  contributorCount: number;
}

export interface UnitHistoryEvent {
  at: string;
  type: string | null;
  rootCause: string | null;
  parts: string[];
  callback: boolean;
  single: boolean;
}

export interface UnitInput {
  equipmentId: string;
  customerId: string | null;
  equipmentType: string;
  make: string | null;
  model: string | null;
  installDate: string | null;
  lastServiceDate: string | null;
  expectedLifespanYears: number;
  serviceIntervalMonths: number;
  customerType: "residential" | "commercial" | null;
  profile: { dutyClass: "light" | "normal" | "heavy"; environment: "normal" | "coastal" | "dusty" | "corrosive" | "humid" } | null;
  history: {
    events: UnitHistoryEvent[];
    repairs12m: number;
    repairs6m: number;
    repairsPrev6m: number;
    callbacks12m: number;
    companies24m: number;
    repeatPart: string | null;
    repeatPartCount: number;
    lastServiceAt: string | null;
    crossCompany: boolean;
  };
  atlas: AtlasCell[];
  weather: { heat30d: number; cold30d: number };
}

export interface ModeStat { expected: number; observed: number; n: number }
export interface Learning {
  modeStats: Record<string, ModeStat>;
  bins: { n: number; pos: number }[] | null;
  resolvedCount: number;
  costByMode: Record<string, { avgCents: number; n: number }>;
}

export interface Factor {
  key: string;
  label: string;
  ratio: number;
  detail: string;
  /** which Home Health driver bucket this maps to */
  driver: "age" | "service" | "repairs" | "data";
}

export interface ModeForecast {
  mode: string;
  label: string;
  probability: number;
  rawProbability: number;
  /** probability WITHOUT the learned per-account factor - the learning loop accumulates "expected" from this so corrections never compound */
  baseProbability: number;
  ageMonths: number;
  ageSource: "component_replaced" | "unit_age";
  etaMonths: number;
  etaSource: "expert_prior" | "blended_with_network" | "network";
  hazardRatio: number;
  factors: Factor[];
  safetyCritical: boolean;
  parts: string[];
  costCents: number;
  costBasis: "account_history" | "typical";
  network: { failureRatePct: number; medianAgeMonths: number | null; contributors: number } | null;
}

export interface UnitForecast {
  equipmentId: string;
  customerId: string | null;
  label: string;
  probability: number;
  rawProbability: number;
  ciLow: number;
  ciHigh: number;
  band: Band;
  confidence: Confidence;
  calibrated: boolean;
  horizonDays: number;
  topMode: string | null;
  topModeLabel: string | null;
  modes: ModeForecast[];
  factors: Factor[];
  recommended: {
    kind: InterventionKind;
    handoffAction: "maintenance" | "replacement_planning";
    label: string;
    parts: string[];
    estMinutes: number;
  } | null;
  exposureCents: number;
  dataGaps: string[];
  evidence: Record<string, unknown>;
  customerExplanation: string;
  engineVersion: string;
}

// ---------------------------------------------------------------------------
// small math helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const MONTH_DAYS = 30.4375;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));

export function monthsBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (DAY_MS * MONTH_DAYS);
}

/** Normalises free-text keys the same way pfn_resolve_forecasts() does in SQL. */
export function normKey(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** P(failure in (a, a+h]) for a Weibull hazard scaled by a hazard ratio. */
export function weibullConditionalProbability(
  ageMonths: number,
  horizonMonths: number,
  shape: number,
  scaleMonths: number,
  hazardRatio = 1,
): number {
  if (!(scaleMonths > 0) || !(shape > 0) || !(horizonMonths > 0)) return 0;
  const a = Math.max(0, ageMonths);
  const cum = (t: number) => Math.pow(t / scaleMonths, shape);
  const delta = Math.max(0, cum(a + horizonMonths) - cum(a));
  return clamp(1 - Math.exp(-Math.max(0, hazardRatio) * delta), 0, 0.999);
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

export function classifyFamily(equipmentType: string): Family {
  const t = (equipmentType ?? "").toLowerCase();
  if (/water\s*heater|hot\s*water|tankless|boiler\s*tank/.test(t)) return "water_heater";
  if (/furnace|boiler|heater|heating|unit\s*heater|radiant|air\s*handler.*gas/.test(t)) return "hvac_heating";
  if (/a\/?c\b|air\s*cond|heat\s*pump|condens|split|mini[-\s]?split|chiller|cooling|rooftop|rtu|hvac|compressor/.test(t)) return "hvac_cooling";
  if (/sump|well\s*pump|pump|prv|pressure\s*(reduc|regul)|backflow|plumb|pipe|faucet|toilet|disposal/.test(t)) return "plumbing";
  if (/generator|panel|breaker|transfer\s*switch|surge|ev\s*charger|electrical/.test(t)) return "electrical";
  if (/washer|dryer|dishwasher|refrigerator|fridge|oven|range|cooktop|microwave|freezer|ice\s*maker/.test(t)) return "appliance";
  return "generic";
}

const MAINTENANCE_JOB_RE = /(maint|tune.?up|inspect|clean|check.?up|seasonal|annual|filter|preventi|install|membership)/i;
export const isMaintenanceJobType = (t: string | null | undefined) => MAINTENANCE_JOB_RE.test(t ?? "");

function partMatches(part: string, keywords: string[]): boolean {
  const p = part.toLowerCase();
  return keywords.some((k) => k && p.includes(k.toLowerCase()));
}

// ---------------------------------------------------------------------------
// calibration + learning
// ---------------------------------------------------------------------------

/**
 * Maps a raw probability to an observed frequency using this account's resolved forecasts.
 * Per-decile estimates are shrunk toward the bin centre (K pseudo-observations), forced monotone,
 * then linearly interpolated. Returns null when there is not enough data to calibrate.
 */
export function calibrate(raw: number, bins: { n: number; pos: number }[] | null): number | null {
  if (!bins || bins.length !== CAL_BINS) return null;
  const total = bins.reduce((s, b) => s + b.n, 0);
  if (total < MIN_CALIBRATION_N) return null;
  const K = 20;
  const centres: number[] = [];
  const est: number[] = [];
  let running = 0;
  for (let b = 0; b < CAL_BINS; b++) {
    const c = (b + 0.5) / CAL_BINS;
    const shrunk = (bins[b].pos + K * c) / (bins[b].n + K);
    running = Math.max(running, shrunk); // monotone non-decreasing
    centres.push(c);
    est.push(running);
  }
  if (raw <= centres[0]) return clamp(est[0] * (raw / centres[0] || 0), 0.005, 0.97);
  if (raw >= centres[CAL_BINS - 1]) return clamp(est[CAL_BINS - 1], 0.005, 0.97);
  for (let i = 0; i < CAL_BINS - 1; i++) {
    if (raw <= centres[i + 1]) {
      const t = (raw - centres[i]) / (centres[i + 1] - centres[i]);
      return clamp(est[i] + t * (est[i + 1] - est[i]), 0.005, 0.97);
    }
  }
  return null;
}

/** Observed/Expected credibility factor for one mode, bounded so learning can never run away. */
export function learnedFactor(stat: ModeStat | undefined): number {
  if (!stat || stat.n < 8) return 1;
  const M = 5; // pseudo expected events: weak prior toward 1
  return clamp((stat.observed + M) / (stat.expected + M), 0.6, 1.8);
}

// ---------------------------------------------------------------------------
// hazard-ratio modifiers
// ---------------------------------------------------------------------------

function lastServiceDateOf(unit: UnitInput): Date | null {
  const c: number[] = [];
  for (const s of [unit.lastServiceDate, unit.installDate, unit.history.lastServiceAt]) {
    if (!s) continue;
    const t = new Date(s).getTime();
    if (!Number.isNaN(t)) c.push(t);
  }
  return c.length ? new Date(Math.max(...c)) : null;
}

function buildFactors(unit: UnitInput, mode: ModeDef, now: Date, stat: ModeStat | undefined): Factor[] {
  const out: Factor[] = [];
  const h = unit.history;

  if (mode.maintenanceSensitive) {
    const last = lastServiceDateOf(unit);
    if (last && unit.serviceIntervalMonths > 0) {
      const since = monthsBetween(last, now);
      const r = since / unit.serviceIntervalMonths;
      if (r > 1) {
        const ratio = 1 + 0.4 * Math.min(r - 1, 2);
        out.push({
          key: "overdue_service", driver: "service", ratio,
          label: "Service overdue",
          detail: `${Math.round(since)} months since last service (interval ${unit.serviceIntervalMonths}).`,
        });
      } else if (r <= 0.5) {
        out.push({
          key: "recently_serviced", driver: "service", ratio: 0.85,
          label: "Recently serviced",
          detail: `Serviced ${Math.max(0, Math.round(since))} months ago.`,
        });
      }
    }
  }

  if (h.repairs12m >= 3) {
    out.push({ key: "repair_frequency", driver: "repairs", ratio: 1.5, label: "Frequent repairs",
      detail: `${h.repairs12m} repair visits in 12 months${h.companies24m > 1 ? ` across ${h.companies24m} companies` : ""}.` });
  } else if (h.repairs12m === 2) {
    out.push({ key: "repair_frequency", driver: "repairs", ratio: 1.25, label: "Repeat repairs", detail: "2 repair visits in 12 months." });
  }
  if (h.callbacks12m >= 2) {
    out.push({ key: "callbacks", driver: "repairs", ratio: 1.4, label: "Repairs not holding",
      detail: `${h.callbacks12m} failures after repair in 12 months.` });
  }
  if (h.repairs6m >= 2 && h.repairs6m > h.repairsPrev6m) {
    out.push({ key: "accelerating", driver: "repairs", ratio: 1.2, label: "Repairs accelerating",
      detail: `${h.repairs6m} repairs in the last 6 months vs ${h.repairsPrev6m} in the 6 before.` });
  }
  if (h.repeatPart && h.repeatPartCount >= 2 && partMatches(h.repeatPart, mode.partKeywords)) {
    out.push({ key: "repeat_part", driver: "repairs", ratio: 1.5, label: "Same part replaced repeatedly",
      detail: `"${h.repeatPart}" replaced ${h.repeatPartCount} times in 24 months - something upstream is destroying it.` });
  }

  const wx = mode.seasonal === "cooling" ? unit.weather.heat30d : mode.seasonal === "heating" ? unit.weather.cold30d : 0;
  if (wx > 0) {
    out.push({ key: "weather_stress", driver: "data", ratio: 1 + 0.15 * Math.min(wx, 3),
      label: mode.seasonal === "cooling" ? "Recent extreme heat" : "Recent extreme cold",
      detail: `${wx} severe-weather alert${wx > 1 ? "s" : ""} in your service area in the last 30 days (account-level signal).` });
  }

  const prof = unit.profile;
  if (prof) {
    if (prof.dutyClass === "heavy") {
      out.push({ key: "duty", driver: "data", ratio: mode.runtimeDriven ? 1.3 : 1.1, label: "Heavy duty cycle", detail: "Marked as heavy-use equipment." });
    } else if (prof.dutyClass === "light" && mode.runtimeDriven) {
      out.push({ key: "duty", driver: "data", ratio: 0.85, label: "Light duty cycle", detail: "Marked as light-use equipment." });
    }
    if (prof.environment !== "normal") {
      out.push({ key: "environment", driver: "data", ratio: 1.15, label: `${prof.environment[0].toUpperCase()}${prof.environment.slice(1)} environment`,
        detail: "Harsh surroundings shorten component life." });
    }
  } else if (unit.customerType === "commercial" && mode.runtimeDriven) {
    out.push({ key: "duty", driver: "data", ratio: 1.2, label: "Commercial duty", detail: "Commercial sites typically run equipment longer each day." });
  }

  const lf = learnedFactor(stat);
  if (Math.abs(lf - 1) >= 0.05 && stat) {
    out.push({ key: "learned", driver: "data", ratio: lf, label: "Learned from your outcomes",
      detail: `Across ${stat.n} resolved forecasts this failure type occurred ${stat.observed} times vs ${stat.expected.toFixed(1)} expected.` });
  }
  return out;
}

const hrOf = (f: Factor[]) => clamp(f.reduce((p, x) => p * x.ratio, 1), 0.5, 4);

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

export interface PredictOptions {
  now: Date;
  horizonDays: number;
}

function dynamicModeFromAtlas(cell: AtlasCell, family: Family): ModeDef {
  const key = normKey(cell.failureMode);
  const label = key.split("_").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Network failure mode";
  return {
    key, label, families: [family], shape: 2.2, scaleMonths: null, aliases: [], partKeywords: [],
    maintenanceSensitive: false, runtimeDriven: false, seasonal: "none", safetyCritical: false, typicalCostCents: 0,
    intervention: { key: `inspect_${key}`, label: `Inspect for ${label.toLowerCase()}`, kind: "inspection", parts: [], estMinutes: 45 },
  };
}

function unitLabel(u: UnitInput): string {
  return [u.make, u.model].filter(Boolean).join(" ").trim() || u.equipmentType;
}

export function predictUnit(
  unit: UnitInput,
  catalog: ModeDef[],
  learning: Learning,
  opts: PredictOptions,
): UnitForecast | null {
  const { now, horizonDays } = opts;
  const horizonMonths = horizonDays / MONTH_DAYS;
  const family = classifyFamily(unit.equipmentType);
  const installed = unit.installDate ? new Date(unit.installDate) : null;
  const unitAgeMonths = installed && !Number.isNaN(installed.getTime()) && installed <= now ? monthsBetween(installed, now) : null;
  const lifespanMonths = Math.max(12, (unit.expectedLifespanYears || 15) * 12);
  const dataGaps: string[] = [];
  if (unitAgeMonths === null) dataGaps.push("Add the install date - age is the strongest predictor.");
  if (unit.atlas.length === 0) dataGaps.push("No network data yet for this make/model (needs the Global Failure Atlas).");
  if (!unit.profile) dataGaps.push("Add duty cycle and environment for sharper usage-based risk.");

  // Candidate modes: catalog modes for this family + network modes the catalog doesn't know.
  const known = new Set<string>();
  for (const m of catalog) { known.add(m.key); for (const a of m.aliases) known.add(normKey(a)); }
  const candidates: ModeDef[] = catalog.filter((m) => m.families.includes(family));
  for (const cell of unit.atlas) {
    const k = normKey(cell.failureMode);
    if (k && !known.has(k) && cell.contributorCount >= 5 && (cell.medianAgeMonths ?? 0) > 0) {
      candidates.push(dynamicModeFromAtlas(cell, family));
      known.add(k);
    }
  }

  const events = unit.history.events;
  const modes: ModeForecast[] = [];

  for (const mode of candidates) {
    const isEol = mode.scaleMonths === null && mode.key === "end_of_life_wearout";
    // age of the component: reset by a documented part replacement
    let ageMonths: number | null = unitAgeMonths;
    let ageSource: ModeForecast["ageSource"] = "unit_age";
    if (mode.partKeywords.length > 0 && !isEol) {
      let latest: number | null = null;
      for (const ev of events) {
        if (!ev.parts?.some((p) => partMatches(p, mode.partKeywords))) continue;
        const t = new Date(ev.at).getTime();
        if (!Number.isNaN(t) && t <= now.getTime() && (latest === null || t > latest)) latest = t;
      }
      if (latest !== null) {
        ageMonths = monthsBetween(new Date(latest), now);
        ageSource = "component_replaced";
      }
    }
    if (ageMonths === null) continue; // honesty: no age evidence -> no forecast for this mode

    // characteristic life: prior, then blended with the network's observed age at failure
    const atlasCell = unit.atlas.find((c) => normKey(c.failureMode) === mode.key || mode.aliases.some((a) => normKey(a) === normKey(c.failureMode)));
    const priorEta = mode.scaleMonths ?? lifespanMonths / Math.pow(Math.LN2, 1 / mode.shape);
    let eta = priorEta;
    let etaSource: ModeForecast["etaSource"] = "expert_prior";
    if (atlasCell && atlasCell.medianAgeMonths && atlasCell.medianAgeMonths > 0 && atlasCell.contributorCount >= 5) {
      const etaNet = atlasCell.medianAgeMonths / Math.pow(Math.LN2, 1 / mode.shape);
      const w = Math.min(0.6, atlasCell.contributorCount / (atlasCell.contributorCount + 12));
      const isDynamic = !catalog.some((m) => m.key === mode.key);
      if (isDynamic) { eta = etaNet; etaSource = "network"; }
      else { eta = Math.exp(w * Math.log(etaNet) + (1 - w) * Math.log(priorEta)); etaSource = "blended_with_network"; }
      // age-at-failure from a component reset is not comparable to a unit-age median; keep blend but only for unit-age modes
      if (ageSource === "component_replaced" && !isDynamic) { eta = priorEta; etaSource = "expert_prior"; }
    }

    const stat = learning.modeStats[mode.key];
    const factors = buildFactors(unit, mode, now, stat);
    const hr = hrOf(factors);
    const raw = weibullConditionalProbability(ageMonths, horizonMonths, mode.shape, eta, hr);
    if (raw < 0.003) continue;
    const base = weibullConditionalProbability(ageMonths, horizonMonths, mode.shape, eta, hrOf(factors.filter((f) => f.key !== "learned")));

    const acct = learning.costByMode[mode.key];
    const costCents = acct && acct.n >= 3 ? Math.round(acct.avgCents) : mode.typicalCostCents;
    modes.push({
      mode: mode.key, label: mode.label, probability: raw, rawProbability: raw, baseProbability: r4(base),
      ageMonths: Math.round(ageMonths * 10) / 10, ageSource, etaMonths: Math.round(eta * 10) / 10, etaSource,
      hazardRatio: Math.round(hr * 1000) / 1000, factors, safetyCritical: mode.safetyCritical,
      parts: mode.intervention.parts, costCents, costBasis: acct && acct.n >= 3 ? "account_history" : "typical",
      network: atlasCell ? { failureRatePct: atlasCell.failureRatePct, medianAgeMonths: atlasCell.medianAgeMonths, contributors: atlasCell.contributorCount } : null,
    });
  }

  if (modes.length === 0) return null;
  modes.sort((a, b) => b.rawProbability - a.rawProbability);

  // unit level (independent modes), then account calibration
  const rawUnit = clamp(1 - modes.reduce((p, m) => p * (1 - m.rawProbability), 1), 0, 0.97);
  const cal = calibrate(rawUnit, learning.bins);
  const calibrated = cal !== null;
  const probability = calibrated ? (cal as number) : rawUnit;
  const scale = rawUnit > 0 ? probability / rawUnit : 1;
  for (const m of modes) m.probability = r4(clamp(m.rawProbability * scale, 0, 0.97));

  // confidence tier = how much real evidence backs this number
  const atlasUsed = modes.some((m) => m.network !== null);
  const hasHistory = unit.history.events.length > 0 || unit.history.repairs12m > 0;
  const ageKnown = unitAgeMonths !== null || modes.some((m) => m.ageSource === "component_replaced");
  const score = (ageKnown ? 1 : 0) + (atlasUsed ? 1 : 0) + (hasHistory ? 1 : 0) + (calibrated ? 1 : 0);
  const confidence: Confidence = score >= 3 ? "high" : score === 2 ? "moderate" : "low";
  const se = confidence === "high" ? 0.35 : confidence === "moderate" ? 0.6 : 0.9;
  const pc = clamp(probability, 0.005, 0.97);
  const ciLow = r4(sigmoid(logit(pc) - 1.2816 * se));
  const ciHigh = r4(sigmoid(logit(pc) + 1.2816 * se));

  const band: Band = probability >= 0.6 ? "critical" : probability >= 0.35 ? "high" : probability >= 0.15 ? "elevated" : "low";

  const top = modes[0];
  const topDef = candidates.find((c) => c.key === top.mode) ?? null;

  // recommendation: replacement planning only when end-of-life AND risk is real
  const lifespanUsed = unitAgeMonths !== null ? unitAgeMonths / lifespanMonths : 0;
  const replaceNow = lifespanUsed >= 1 && (probability >= 0.35 || unit.history.repairs12m >= 3);
  const iv = topDef?.intervention ?? null;
  const recommended = replaceNow
    ? { kind: "replacement_planning" as const, handoffAction: "replacement_planning" as const,
        label: "Plan a replacement before the next breakdown", parts: [] as string[], estMinutes: 240 }
    : iv
      ? { kind: iv.kind, handoffAction: "maintenance" as const, label: iv.label, parts: iv.parts, estMinutes: iv.estMinutes }
      : null;

  const exposureCents = Math.round(modes.reduce((s, m) => s + m.probability * m.costCents, 0));

  // unit-level factors: the top mode's drivers (what the technician/customer can act on)
  const factors = [...top.factors].sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));
  if (unitAgeMonths !== null) {
    const yrs = unitAgeMonths / 12;
    factors.unshift({
      key: "age", driver: "age", ratio: 1,
      label: lifespanUsed >= 1 ? "Past expected lifespan" : "Age",
      detail: `${yrs.toFixed(1)} years in service of an expected ${unit.expectedLifespanYears} (${Math.round(lifespanUsed * 100)}% of lifespan).`,
    });
  }
  if (top.ageSource === "component_replaced") {
    factors.unshift({ key: "component_age", driver: "age", ratio: 1, label: "Component age",
      detail: `${top.label.toLowerCase()} component replaced ${(top.ageMonths / 12).toFixed(1)} years ago - forecast uses the part's age, not the unit's.` });
  }
  if (top.network) {
    factors.push({ key: "network", driver: "data", ratio: 1, label: "Similar equipment",
      detail: `${top.network.failureRatePct.toFixed(1)}% of comparable units in the network had this failure${top.network.medianAgeMonths ? `, typically around ${(top.network.medianAgeMonths / 12).toFixed(1)} years old` : ""}.` });
  }

  const plain = factors
    .filter((f) => f.ratio > 1.05 || f.key === "age" || f.key === "component_age")
    .slice(0, 3)
    .map((f) => f.label.toLowerCase());
  const customerExplanation =
    `Our predictive maintenance system flagged your ${unitLabel(unit)} for attention` +
    (plain.length ? ` because of ${plain.join(", ")}` : "") +
    `. A planned visit now is usually cheaper and less disruptive than an emergency repair.`;

  return {
    equipmentId: unit.equipmentId, customerId: unit.customerId, label: unitLabel(unit),
    probability: r4(probability), rawProbability: r4(rawUnit), ciLow, ciHigh, band, confidence, calibrated,
    horizonDays, topMode: top.mode, topModeLabel: top.label,
    modes: modes.slice(0, 8).map((m) => ({ ...m, probability: r4(m.probability), rawProbability: r4(m.rawProbability) })),
    factors: factors.slice(0, 8), recommended, exposureCents, dataGaps, customerExplanation,
    evidence: {
      family, unitAgeMonths: unitAgeMonths === null ? null : Math.round(unitAgeMonths * 10) / 10, lifespanUsedPct: Math.round(lifespanUsed * 100),
      repairs12m: unit.history.repairs12m, callbacks12m: unit.history.callbacks12m, companies24m: unit.history.companies24m,
      crossCompanyHistory: unit.history.crossCompany, atlasCells: unit.atlas.length, resolvedForecasts: learning.resolvedCount,
      evidenceScore: score,
    },
    engineVersion: ENGINE_VERSION,
  };
}

/** Whether a fresh forecast should replace the stored one (keeps the scored history clean). */
export function shouldIssue(
  prev: { probability: number; band: Band; issued_at: string } | null,
  next: { probability: number; band: Band },
  now: Date,
): boolean {
  if (!prev) return true;
  const ageDays = (now.getTime() - new Date(prev.issued_at).getTime()) / DAY_MS;
  return ageDays >= 30 || Math.abs(next.probability - prev.probability) >= 0.15 || next.band !== prev.band;
}

/** Hand-off drivers in the shape Home Health actions already store. */
export function toHomeHealthDrivers(f: UnitForecast): { key: Factor["driver"]; label: string; impact: "negative" | "positive" | "neutral"; detail: string }[] {
  return f.factors.slice(0, 5).map((x) => ({
    key: x.driver, label: x.label, detail: x.detail,
    impact: x.ratio > 1.05 ? "negative" : x.ratio < 0.95 ? "positive" : "neutral",
  }));
}

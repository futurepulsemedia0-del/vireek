// Property Intelligence — pure scoring, signals, graph and voice-briefing logic.
// No I/O, no Deno/npm imports: runs unchanged in Deno edge functions AND in Vitest.
//
// The HVAC replacement model is a transparent HEURISTIC, not a statistical model:
// every constant below is named and tunable, every score carries its evidence and a
// confidence, and nothing is invented when evidence is missing. Calibrate the constants
// against your own quote-conversion data once enough replacement outcomes exist.

import type {
  AgeBasis,
  ClimateFacts,
  ClimateProfile,
  EquipmentLite,
  GraphEdge,
  GraphNode,
  HvacAssessment,
  JobLite,
  LikelihoodLevel,
  PermitSummary,
  ProfileFacts,
  PropertyGraph,
  PropertySignal,
  ProviderReports,
  ServiceStats,
  WorkCategory,
} from "./types.ts";

// ---------------------------------------------------------------- tunables

export const DEFAULT_HVAC_LIFE_YEARS = 15;
export const MAX_CLIMATE_LIFE_REDUCTION = 0.15;
const CDD_STRESS_START = 1500;
const HDD_STRESS_START = 5000;
const RECENT_REPLACEMENT_YEARS = 3;
const REPAIR_BUMP_PER_VISIT = 6;
const REPAIR_BUMP_MAX = 18;
const REPAIR_WINDOW_MONTHS = 24;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

const CONFIDENCE: Record<AgeBasis, number> = {
  equipment_record: 0.9,
  service_history: 0.8,
  permit: 0.65,
  year_built: 0.4,
  unknown: 0,
};

// ---------------------------------------------------------------- text classifiers

const HVAC_RE =
  /hvac|furnace|air.?condition|\ba\/?c\b|heat.?pump|boiler|condens|split|rooftop|package.?unit|air.?handler|mini.?split|mechanical|\bmech\b|ductwork|heating|cooling|thermostat/i;
const INSTALL_RE = /install|replac|new system|change.?out|changeout/i;

export function isHvacText(text: string | null | undefined): boolean {
  return !!text && HVAC_RE.test(text);
}

export function classifyPermit(texts: Array<string | null | undefined>): WorkCategory {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (!t) return "other";
  if (/solar|photovoltaic|\bpv\b/.test(t)) return "solar";
  if (/water.?heater/.test(t)) return "water_heater";
  if (HVAC_RE.test(t)) return "hvac";
  if (/plumb|sewer|drain|repipe|re-pipe|water.?line|backflow/.test(t)) return "plumbing";
  if (/electr|\belec\b|panel|rewire|service.?upgrade|meter/.test(t)) return "electrical";
  if (/roof/.test(t)) return "roofing";
  if (/\bgas\b|gas.?line|gas.?piping/.test(t)) return "gas";
  if (/structur|foundation|framing|addition|remodel/.test(t)) return "structural";
  return "other";
}

// ---------------------------------------------------------------- climate

const DAYS_IN_MONTH = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function celsiusToFahrenheit(c: number): number {
  return c * 1.8 + 32;
}

/** Mean-temperature degree-day estimate (understates real HDD/CDD slightly; labelled "est" everywhere). */
export function climateFromMonthly(monthlyMeanC: number[], annualMeanC: number | null = null): ClimateFacts {
  let hdd = 0;
  let cdd = 0;
  monthlyMeanC.forEach((c, i) => {
    const f = celsiusToFahrenheit(c);
    const days = DAYS_IN_MONTH[i] ?? 30;
    if (f < 65) hdd += (65 - f) * days;
    if (f > 65) cdd += (f - 65) * days;
  });
  hdd = Math.round(hdd);
  cdd = Math.round(cdd);
  const share = cdd / (hdd + cdd + 1);
  const profile: ClimateProfile = share > 0.6 ? "cooling_dominated" : share < 0.35 ? "heating_dominated" : "mixed";
  const mean = annualMeanC ?? monthlyMeanC.reduce((a, b) => a + b, 0) / (monthlyMeanC.length || 1);
  return {
    source: "nasa_power",
    monthly_mean_c: monthlyMeanC.map((v) => Math.round(v * 10) / 10),
    annual_mean_c: Math.round(mean * 10) / 10,
    hdd65f_est: hdd,
    cdd65f_est: cdd,
    profile,
  };
}

/** 1.0 = no climate stress; down to 1 - MAX_CLIMATE_LIFE_REDUCTION in harsh climates. */
export function climateLifeFactor(climate: ClimateFacts | null): number {
  if (!climate) return 1;
  const cooling = Math.max(0, (climate.cdd65f_est - CDD_STRESS_START) / 1500) * 0.1;
  const heating = Math.max(0, (climate.hdd65f_est - HDD_STRESS_START) / 3000) * 0.05;
  return 1 - Math.min(MAX_CLIMATE_LIFE_REDUCTION, cooling + heating);
}

// ---------------------------------------------------------------- HVAC assessment

export interface AssessInput {
  yearBuilt: number | null;
  equipment: EquipmentLite[];
  jobs: JobLite[];
  permits: Array<Pick<PermitSummary, "work_category" | "issued_date">>;
  climate: ClimateFacts | null;
  nowMs: number;
}

interface AgeEvidence {
  basis: AgeBasis;
  installedMs: number;
  expectedLife: number | null;
}

export function scoreFromAgeRatio(ratio: number): number {
  if (ratio <= 0) return 0;
  if (ratio < 0.5) return ratio * 40;
  if (ratio < 0.8) return 20 + ((ratio - 0.5) / 0.3) * 30;
  if (ratio <= 1) return 50 + ((ratio - 0.8) / 0.2) * 25;
  return Math.min(95, 75 + (ratio - 1) * 40);
}

function levelOf(score: number | null): LikelihoodLevel {
  if (score === null) return "unknown";
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function parseMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isHvacEquipment(e: EquipmentLite): boolean {
  return isHvacText(`${e.equipment_type} ${e.make ?? ""} ${e.model ?? ""}`);
}

export function countHvacRepairs(jobs: JobLite[], nowMs: number): number {
  const since = nowMs - REPAIR_WINDOW_MONTHS * 30.4375 * 24 * 60 * 60 * 1000;
  return jobs.filter((j) => {
    if (j.job_status !== "completed") return false;
    const t = parseMs(j.scheduled_datetime);
    if (t === null || t < since || t > nowMs) return false;
    const type = j.service_type ?? "";
    return isHvacText(type) && !INSTALL_RE.test(type);
  }).length;
}

function collectEvidence(input: AssessInput): AgeEvidence[] {
  const out: AgeEvidence[] = [];

  for (const e of input.equipment) {
    if (e.status !== "active" || !isHvacEquipment(e)) continue;
    const t = parseMs(e.install_date);
    if (t !== null && t <= input.nowMs) out.push({ basis: "equipment_record", installedMs: t, expectedLife: e.expected_lifespan_years });
  }
  for (const j of input.jobs) {
    if (j.job_status !== "completed" || !isHvacText(j.service_type) || !INSTALL_RE.test(j.service_type ?? "")) continue;
    const t = parseMs(j.scheduled_datetime);
    if (t !== null && t <= input.nowMs) out.push({ basis: "service_history", installedMs: t, expectedLife: null });
  }
  for (const p of input.permits) {
    if (p.work_category !== "hvac") continue;
    const t = parseMs(p.issued_date);
    if (t !== null && t <= input.nowMs) out.push({ basis: "permit", installedMs: t, expectedLife: null });
  }
  return out;
}

const BASIS_LABEL: Record<AgeBasis, string> = {
  equipment_record: "a tracked equipment record",
  service_history: "a completed install/replace job",
  permit: "an HVAC permit (may be a repair rather than a full replacement)",
  year_built: "the year the home was built",
  unknown: "no usable evidence",
};

export function assessHvac(input: AssessInput): HvacAssessment {
  const nowYear = new Date(input.nowMs).getUTCFullYear();
  const factor = climateLifeFactor(input.climate);
  const repairs = countHvacRepairs(input.jobs, input.nowMs);
  const evidence = collectEvidence(input);

  const reasons: string[] = [];
  const repairBump = Math.min(REPAIR_BUMP_MAX, repairs * REPAIR_BUMP_PER_VISIT);

  // --- Best evidence. Records the business keeps itself (tracked equipment, completed install jobs) outrank
  // permits: a permit may cover a different system or a repair. A permit NEWER than the best own record is
  // not allowed to silently override it — it is kept as a conflict that lowers confidence and prompts a question.
  const own = evidence.filter((e) => e.basis !== "permit");
  const permitEvidence = evidence.filter((e) => e.basis === "permit");
  const pool = own.length > 0 ? own : permitEvidence;
  if (pool.length > 0) {
    const best = pool.reduce((a, b) => (b.installedMs > a.installedMs ? b : a));
    const newerPermit = own.length > 0 ? permitEvidence.find((e) => e.installedMs > best.installedMs) : undefined;
    const ageYears = Math.max(0, (input.nowMs - best.installedMs) / MS_PER_YEAR);
    const baseLife = best.expectedLife && best.expectedLife > 0 ? best.expectedLife : DEFAULT_HVAC_LIFE_YEARS;
    const life = Math.round(baseLife * factor * 10) / 10;
    let score = scoreFromAgeRatio(ageYears / life) + repairBump;
    if (ageYears < RECENT_REPLACEMENT_YEARS) score = Math.min(score, 12);
    score = Math.round(Math.min(95, score));

    reasons.push(
      `System is about ${ageYears.toFixed(1)} years old (from ${BASIS_LABEL[best.basis]}) against an expected life of ~${life} years.`,
    );
    if (factor < 0.97) reasons.push("Expected life is shortened slightly by this location's heating/cooling load.");
    if (repairs > 0) reasons.push(`${repairs} HVAC repair visit${repairs === 1 ? "" : "s"} in the last ${REPAIR_WINDOW_MONTHS} months.`);
    if (ageYears < RECENT_REPLACEMENT_YEARS) reasons.push("Recently replaced — a replacement conversation is unlikely.");
    if (newerPermit) {
      reasons.push(`A newer HVAC permit (${new Date(newerPermit.installedMs).getUTCFullYear()}) exists that your own records do not reflect — the system may have been replaced.`);
    }

    return {
      level: levelOf(score),
      score,
      ceiling_score: null,
      confidence: newerPermit ? Math.min(CONFIDENCE[best.basis], 0.5) : CONFIDENCE[best.basis],
      basis: best.basis,
      estimated_install_year: new Date(best.installedMs).getUTCFullYear(),
      estimated_age_years: Math.round(ageYears * 10) / 10,
      expected_life_years: life,
      hvac_repairs_24m: repairs,
      reasons,
      ask_caller: best.basis === "permit" || newerPermit ? "Ask whether the permitted HVAC work was a full replacement." : null,
    };
  }

  // --- Fallback: only the year built is known.
  const life = Math.round(DEFAULT_HVAC_LIFE_YEARS * factor * 10) / 10;
  if (input.yearBuilt !== null && input.yearBuilt <= nowYear) {
    const houseAge = nowYear - input.yearBuilt;
    const originalLikely = houseAge <= life * 0.9;
    // If the home is older than one system life, assume ~1+ replacement cycles happened at an unknown date.
    const likelyAge = originalLikely ? houseAge : houseAge % life;
    const likelyScore = Math.round(Math.min(95, scoreFromAgeRatio(likelyAge / life) + repairBump));
    const ceiling = Math.round(Math.min(95, scoreFromAgeRatio(houseAge / life) + repairBump));

    reasons.push(`No install date, permit or equipment record on file — estimated from the year built (${input.yearBuilt}).`);
    reasons.push(
      originalLikely
        ? `The home is ${houseAge} years old, so the original system may still be in place.`
        : `The home is ${houseAge} years old — past one system life (~${life} years), so a replacement has probably happened at an unknown date.`,
    );
    if (repairs > 0) reasons.push(`${repairs} HVAC repair visit${repairs === 1 ? "" : "s"} in the last ${REPAIR_WINDOW_MONTHS} months.`);

    return {
      level: levelOf(likelyScore),
      score: likelyScore,
      ceiling_score: ceiling > likelyScore ? ceiling : null,
      confidence: originalLikely ? CONFIDENCE.year_built : 0.25,
      basis: "year_built",
      estimated_install_year: nowYear - Math.round(likelyAge),
      estimated_age_years: Math.round(likelyAge * 10) / 10,
      expected_life_years: life,
      hvac_repairs_24m: repairs,
      reasons,
      ask_caller: "Ask when the AC/furnace was last replaced and the age shown on the unit's data plate.",
    };
  }

  return {
    level: "unknown",
    score: null,
    ceiling_score: null,
    confidence: 0,
    basis: "unknown",
    estimated_install_year: null,
    estimated_age_years: null,
    expected_life_years: life,
    hvac_repairs_24m: repairs,
    reasons: ["Nothing on file yet: no install date, permit, year built or equipment record."],
    ask_caller: "Ask the age of the system and when it was last replaced.",
  };
}

// ---------------------------------------------------------------- signals

export interface SignalInput {
  yearBuilt: number | null;
  hvac: HvacAssessment;
  climate: ClimateFacts | null;
  permits: Array<Pick<PermitSummary, "work_category" | "issued_date">>;
  nowMs: number;
}

export function deriveSignals(input: SignalInput): PropertySignal[] {
  const out: PropertySignal[] = [];
  const y = input.yearBuilt;

  if (y !== null && y < 1978) {
    out.push({
      id: "lead_paint_era",
      label: "Built before 1978",
      detail: "EPA lead-safe (RRP) rules may apply to work that disturbs painted surfaces. Confirm requirements before quoting.",
      severity: "watch",
      trades: ["hvac", "plumbing", "electrical", "roofing"],
    });
  }
  if (y !== null && y >= 1965 && y <= 1973) {
    out.push({
      id: "aluminum_wiring_era",
      label: "Aluminum-wiring era (1965–1973)",
      detail: "Aluminum branch wiring was common in this period. Inspect device connections before electrical work.",
      severity: "watch",
      trades: ["electrical"],
    });
  }
  if (y !== null && y >= 1978 && y <= 1995) {
    out.push({
      id: "polybutylene_era",
      label: "Polybutylene-piping era (1978–1995)",
      detail: "Polybutylene supply piping was widely used in this period. Check for gray/blue plastic supply lines.",
      severity: "watch",
      trades: ["plumbing"],
    });
  }
  if (input.hvac.hvac_repairs_24m >= 3) {
    out.push({
      id: "repeat_hvac_repairs",
      label: `${input.hvac.hvac_repairs_24m} HVAC repairs in 24 months`,
      detail: "Repeat failures usually justify a repair-versus-replace conversation.",
      severity: "alert",
      trades: ["hvac"],
    });
  }
  const recentHvacPermit = input.permits.find((p) => {
    if (p.work_category !== "hvac") return false;
    const t = parseMs(p.issued_date);
    return t !== null && input.nowMs - t < 5 * MS_PER_YEAR;
  });
  if (recentHvacPermit) {
    out.push({
      id: "recent_hvac_permit",
      label: "HVAC work permitted in the last 5 years",
      detail: "Recent permitted HVAC work lowers the likelihood the system is original.",
      severity: "info",
      trades: ["hvac"],
    });
  }
  if (input.climate && input.climate.cdd65f_est >= 2500) {
    out.push({
      id: "high_cooling_load",
      label: "High cooling load",
      detail: `About ${input.climate.cdd65f_est.toLocaleString("en-US")} cooling degree-days per year (estimate). AC runs hard; upkeep matters.`,
      severity: "info",
      trades: ["hvac"],
    });
  }
  if (input.climate && input.climate.hdd65f_est >= 6000) {
    out.push({
      id: "high_heating_load",
      label: "High heating load",
      detail: `About ${input.climate.hdd65f_est.toLocaleString("en-US")} heating degree-days per year (estimate). Heating reliability is critical in winter.`,
      severity: "info",
      trades: ["hvac", "plumbing"],
    });
  }
  return out;
}

// ---------------------------------------------------------------- service stats

export function summarizeService(jobs: JobLite[], hvacRepairs24m: number): ServiceStats {
  const dated = jobs.map((j) => j.scheduled_datetime).filter((v): v is string => !!v);
  return {
    visits: jobs.length,
    completed_visits: jobs.filter((j) => j.job_status === "completed").length,
    last_visit: dated.length ? dated.reduce((a, b) => (a > b ? a : b)) : null,
    hvac_repairs_24m: hvacRepairs24m,
  };
}

// ---------------------------------------------------------------- graph

export interface GraphInput {
  addressLine: string | null;
  profile: ProfileFacts | null;
  providers: ProviderReports;
  equipment: EquipmentLite[];
  permits: PermitSummary[];
  service: ServiceStats;
  hvac: HvacAssessment;
  nowMs: number;
}

const GRAPH_ORDER: GraphNode["kind"][] = [
  "address", "parcel", "characteristics", "building_age", "square_footage",
  "permits", "equipment", "climate", "utility", "energy", "service_history",
];

const SOURCE_NAMES: Record<string, string> = {
  census: "US Census",
  rentcast: "RentCast",
  attom_permits: "ATTOM",
  nasa_power: "NASA POWER",
  eia: "EIA",
};

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function buildGraph(input: GraphInput): PropertyGraph {
  const p = input.profile;
  const nowYear = new Date(input.nowMs).getUTCFullYear();
  const nodes: GraphNode[] = [];
  const add = (n: GraphNode) => nodes.push(n);

  add({
    id: "address", kind: "address", label: "Address",
    value: p?.formatted_address ?? input.addressLine ?? "Not on file",
    state: p?.formatted_address || input.addressLine ? "known" : "missing",
    source: p?.formatted_address ? SOURCE_NAMES.census : "Vireek", detail: p?.census_tract ? `Census tract ${p.census_tract}` : null,
  });

  add({
    id: "parcel", kind: "parcel", label: "Parcel / APN",
    value: p?.apn ?? "Unknown",
    state: p?.apn ? "known" : "missing",
    source: p?.apn ? SOURCE_NAMES.rentcast : null,
    detail: p?.apn ? null : input.providers.rentcast?.message ?? "Parcel data not retrieved yet.",
  });

  const charParts = [
    p?.property_type,
    p?.bedrooms != null ? `${p.bedrooms} bd` : null,
    p?.bathrooms != null ? `${p.bathrooms} ba` : null,
    p?.stories != null ? `${p.stories} stor${p.stories === 1 ? "y" : "ies"}` : null,
    p?.lot_sqft != null ? `${p.lot_sqft.toLocaleString("en-US")} sq ft lot` : null,
  ].filter(Boolean);
  add({
    id: "characteristics", kind: "characteristics", label: "Property characteristics",
    value: charParts.length ? charParts.join(" · ") : "Unknown",
    state: charParts.length ? "known" : "missing",
    source: charParts.length ? SOURCE_NAMES.rentcast : null, detail: null,
  });

  const yb = p?.year_built ?? null;
  add({
    id: "building_age", kind: "building_age", label: "Building age",
    value: yb !== null ? `Built ${yb} (${Math.max(0, nowYear - yb)} yrs)` : "Unknown",
    state: yb !== null ? "known" : "missing",
    source: yb === null ? null : p?.year_built_source === "manual" ? "Vireek (entered by your team)" : SOURCE_NAMES.rentcast,
    detail: null,
  });

  add({
    id: "square_footage", kind: "square_footage", label: "Living area",
    value: p?.living_sqft != null ? `${p.living_sqft.toLocaleString("en-US")} sq ft` : "Unknown",
    state: p?.living_sqft != null ? "known" : "missing",
    source: p?.living_sqft != null ? SOURCE_NAMES.rentcast : null, detail: null,
  });

  const permitProvider = input.providers.attom_permits;
  const permitsKnown = permitProvider?.state === "ok";
  const lastPermit = input.permits.find((x) => x.issued_date);
  add({
    id: "permits", kind: "permits", label: "Permits",
    value: permitsKnown
      ? input.permits.length ? `${input.permits.length} on record` : "None on record"
      : "Not retrieved",
    state: permitsKnown ? "known" : "missing",
    source: permitsKnown ? SOURCE_NAMES.attom_permits : null,
    detail: permitsKnown
      ? lastPermit ? `Latest: ${lastPermit.issued_date}` : null
      : permitProvider?.message ?? "Permit provider not connected or no coverage for this county.",
  });

  const hvacTracked = input.equipment.filter((e) => e.status === "active" && isHvacText(`${e.equipment_type} ${e.make ?? ""} ${e.model ?? ""}`));
  const activeEquip = input.equipment.filter((e) => e.status === "active");
  add({
    id: "equipment", kind: "equipment", label: "Equipment history",
    value: activeEquip.length ? `${activeEquip.length} tracked${hvacTracked.length ? ` (${hvacTracked.length} HVAC)` : ""}` : "None tracked",
    state: activeEquip.length ? "known" : input.hvac.basis === "unknown" ? "missing" : "estimated",
    source: activeEquip.length ? "Vireek" : null,
    detail: input.hvac.estimated_age_years !== null ? `HVAC ≈ ${input.hvac.estimated_age_years} yrs (${titleCase(input.hvac.basis)})` : null,
  });

  const climate = p?.climate ?? null;
  add({
    id: "climate", kind: "climate", label: "Climate",
    value: climate ? `${titleCase(climate.profile)} · ~${climate.hdd65f_est.toLocaleString("en-US")} HDD / ${climate.cdd65f_est.toLocaleString("en-US")} CDD` : "Not retrieved",
    state: climate ? "estimated" : "missing",
    source: climate ? SOURCE_NAMES.nasa_power : null,
    detail: climate ? "Degree days estimated from 30-year monthly means." : input.providers.nasa_power?.message ?? null,
  });

  const energy = p?.energy ?? null;
  add({
    id: "utility", kind: "utility", label: "Utility",
    value: energy ? `${energy.state} residential electricity: ${energy.residential_cents_per_kwh}¢/kWh` : "Not retrieved",
    state: energy ? "estimated" : "missing",
    source: energy ? SOURCE_NAMES.eia : null,
    detail: energy ? "State average — not this customer's tariff." : input.providers.eia?.message ?? null,
  });

  const systems = [
    p?.cooling_type ? `Cooling: ${p.cooling_type}` : p?.has_cooling === true ? "Has cooling" : null,
    p?.heating_type ? `Heating: ${p.heating_type}` : p?.has_heating === true ? "Has heating" : null,
  ].filter(Boolean);
  add({
    id: "energy", kind: "energy", label: "Energy systems",
    value: systems.length ? systems.join(" · ") : "Unknown",
    state: systems.length ? "known" : "missing",
    source: systems.length ? SOURCE_NAMES.rentcast : null, detail: null,
  });

  add({
    id: "service_history", kind: "service_history", label: "Service history",
    value: input.service.visits ? `${input.service.visits} visit${input.service.visits === 1 ? "" : "s"}` : "No visits yet",
    state: "known",
    source: "Vireek",
    detail: input.service.last_visit ? `Last: ${input.service.last_visit.slice(0, 10)}` : null,
  });

  const ordered = GRAPH_ORDER.map((kind) => nodes.find((n) => n.kind === kind)).filter((n): n is GraphNode => !!n);
  const edges: GraphEdge[] = [];
  for (let i = 0; i < ordered.length - 1; i++) edges.push({ from: ordered[i].id, to: ordered[i + 1].id, label: null });
  edges.push({ from: "building_age", to: "equipment", label: "ages" });
  edges.push({ from: "climate", to: "equipment", label: "stresses" });
  edges.push({ from: "permits", to: "equipment", label: "documents" });

  const weight = ordered.reduce((sum, n) => sum + (n.state === "known" ? 1 : n.state === "estimated" ? 0.5 : 0), 0);
  return { nodes: ordered, edges, coverage: Math.round((weight / ordered.length) * 100) / 100 };
}

// ---------------------------------------------------------------- voice briefing (allowlist)

const VOICE_RULES =
  "INTERNAL property context — never read records aloud, never mention where the data came from, and never state owner, price or permit details. " +
  "Use it only to ask better questions and prepare. Treat every fact as unverified until the caller confirms it.";

/**
 * Builds the context injected into the voice agent. ALLOWLIST ONLY: physical facts, age estimates and
 * signals. It never includes the address, APN, permit numbers/descriptions, owner or sale data.
 */
export function buildVoiceContext(args: {
  profile: ProfileFacts | null;
  hvac: HvacAssessment;
  signals: PropertySignal[];
  service: ServiceStats;
  nowMs: number;
}): string {
  const { profile: p, hvac, signals, service } = args;
  const nowYear = new Date(args.nowMs).getUTCFullYear();
  const parts: string[] = [VOICE_RULES];

  const facts: string[] = [];
  if (p?.year_built != null) facts.push(`built ${p.year_built} (~${Math.max(0, nowYear - p.year_built)} yrs old)`);
  if (p?.living_sqft != null) facts.push(`~${p.living_sqft.toLocaleString("en-US")} sq ft`);
  if (p?.property_type) facts.push(p.property_type.toLowerCase());
  if (p?.cooling_type) facts.push(`${p.cooling_type.toLowerCase()} cooling`);
  if (p?.heating_type) facts.push(`${p.heating_type.toLowerCase()} heating`);
  if (facts.length) parts.push(`Property: ${facts.join(", ")}.`);

  if (p?.climate) parts.push(`Climate: ${titleCase(p.climate.profile).toLowerCase()} (est. ${p.climate.hdd65f_est.toLocaleString("en-US")} HDD / ${p.climate.cdd65f_est.toLocaleString("en-US")} CDD per year).`);

  if (hvac.level !== "unknown" && hvac.score !== null) {
    const age = hvac.estimated_age_years !== null ? `, est. age ${hvac.estimated_age_years} yrs of ~${hvac.expected_life_years}` : "";
    const range = hvac.ceiling_score !== null ? `, up to ${hvac.ceiling_score} if the original system is still in place` : "";
    parts.push(`HVAC replacement likelihood: ${hvac.level.toUpperCase()} (${hvac.score}/100${range}${age}; confidence ${Math.round(hvac.confidence * 100)}%).`);
  } else {
    parts.push("HVAC age is unknown.");
  }
  if (hvac.ask_caller) parts.push(hvac.ask_caller);

  const notable = signals.filter((s) => s.severity !== "info").map((s) => s.label);
  if (notable.length) parts.push(`Flags for the technician: ${notable.join("; ")}.`);

  if (service.visits > 0) {
    parts.push(`Prior service here: ${service.visits} visit${service.visits === 1 ? "" : "s"}${service.last_visit ? `, last ${service.last_visit.slice(0, 10)}` : ""}.`);
  }

  const text = parts.join(" ");
  if (text.length <= 1400) return text;
  const cut = text.slice(0, 1400);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(". "), 600) + 1)}`;
}

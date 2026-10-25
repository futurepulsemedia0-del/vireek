// supabase/functions/_shared/permit-rules/engine.ts
//
// Deterministic backbone of the AI Permit / Code / Compliance Engine.
// Pure TypeScript, zero I/O - identical input always yields identical output,
// runs unchanged in Deno (Edge Functions) and Node (Vitest).
//
//   facts -> jurisdiction + work-type classification -> curated rules -> sorted items
//
// The AI layer (ai.ts) may only ADD items on top of this result.

import { parseJurisdiction } from "./jurisdiction.ts";
import { RULES, stateRulesFor, type RuleContext } from "./rules.ts";
import type {
  EngineResult, JobFacts, JurisdictionInfo, PermitLikelihood, RequirementCategory, RequirementItem, Severity, WorkType,
} from "./types.ts";

// ---------------------------------------------------------------------------
// 1) Work-type classification
// ---------------------------------------------------------------------------

/** Canonical order - keeps classifyWorkTypes output stable. */
const WORK_ORDER: WorkType[] = [
  "electrical_service", "electrical_new", "ev_charger", "generator", "electrical_repair",
  "water_heater", "plumbing_repipe", "plumbing_drain", "plumbing_fixture", "gas_work",
  "hvac_replace", "hvac_new", "ductwork", "refrigerant", "appliance_repair", "maintenance",
];

const REPLACE_VERB = /\b(replac\w*|swap\w*|change[- ]?out|changeout|upgrad\w*|retrofit\w*|conversion)\b/;
const INSTALL_VERB = /\b(install\w*|new (system|unit|install\w*)|add(ing|ition)?|build[- ]?out)\b/;
const HVAC_NOUN = /\b(furnace|boiler|combi|heat pump|air handler|condenser|ac unit|a\/c unit|air conditioner(?:s)?|central air|mini-?split|package unit|rtu|hvac|heating system|cooling system|air conditioning)\b/;

const PATTERNS: Array<[WorkType, RegExp]> = [
  ["electrical_service", /\b(panel|breaker box|load center|sub-?panel|meter (base|socket)|service (upgrade|entrance|mast|drop)|electrical service|\d{2,3}\s?-?amp service)\b/],
  ["ev_charger", /\b(ev\s*(charger|charging|station|outlet)|evse|electric vehicle (charger|charging)|wall connector|level 2 charger)\b/],
  ["generator", /\b(generator|transfer switch|standby generator|generac)\b/],
  ["electrical_new", /\b(new (circuit|outlet|receptacle|wiring)|add(ed|ing)? (an? )?(outlet|circuit|receptacle|light|fixture)|dedicated circuit|rewir\w*|recessed (light|lighting)|ceiling fan install\w*|240\s?v|install\w* (an? )?(outlet|receptacle|circuit|fixture))\b/],
  ["electrical_repair", /\b(electrical|outlet|receptacle|gfci|afci|wiring|light switch|breaker|short circuit|tripping|no power|light fixture)\b/],
  ["water_heater", /\b(water heater|hot water (heater|tank|system)|tankless)\b/],
  ["plumbing_repipe", /\b(repip\w*|re-pip\w*|water service|main water line|water main|supply line replacement|whole[- ]house (plumbing|repipe))\b/],
  ["plumbing_drain", /\b(sewer|main drain|drain line|drain pipe|lateral line|septic|cleanout install\w*)\b/],
  ["plumbing_fixture", /\b(faucet|toilet|sink|garbage disposal|disposal|shower|bathtub|tub|fixture|clog\w*|snake|hose bib|spigot|supply valve|angle stop|plumbing leak|leaking pipe)\b/],
  ["gas_work", /\b(gas (line|pipe|piping|leak|valve|meter|connection|service|appliance|stove|range|dryer|fireplace|log|manifold|shut-?off)|natural gas|propane|lp gas)\b/],
  ["ductwork", /\b(duct|ducts|ductwork|ducting|plenum)\b/],
  ["refrigerant", /\b(refrigerant|freon|recharge|low charge|r-?410a|r-?22|r-?32|r-?454b|line set|lineset|sealed system|compressor|condenser coil|evaporator coil|evaporator|leak (check|detect\w*))\b/],
  ["appliance_repair", /\b(appliance|refrigerator|fridge|washer|washing machine|dryer|dishwasher|oven|range|stove|cooktop|microwave|freezer|ice maker)\b/],
  ["maintenance", /\b(tune-?up|maintenance|inspection|inspect|check-?up|seasonal|preventive|preventative|annual (service|visit)|filter (change|replacement)|cleaning|flush|descal\w*|diagnostic|diagnose|pm visit|service call)\b/],
];

/** A larger scope makes the listed smaller scopes redundant ("replace panel" is not also "electrical repair"). */
const SUPERSEDES: Partial<Record<WorkType, WorkType[]>> = {
  electrical_service: ["electrical_new", "electrical_repair"],
  ev_charger: ["electrical_new", "electrical_repair"],
  generator: ["electrical_new", "electrical_repair"],
  electrical_new: ["electrical_repair"],
  water_heater: ["plumbing_fixture"],
  plumbing_repipe: ["plumbing_fixture"],
  plumbing_drain: ["plumbing_fixture"],
  hvac_replace: ["hvac_new"],
};

const BIG_SCOPE: WorkType[] = [
  "electrical_service", "electrical_new", "ev_charger", "generator", "water_heater", "plumbing_repipe",
  "plumbing_drain", "gas_work", "hvac_replace", "hvac_new", "ductwork",
];

export function classifyWorkTypes(rawText: string): WorkType[] {
  const text = (rawText ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return [];

  const found = new Set<WorkType>();
  for (const [type, re] of PATTERNS) if (re.test(text)) found.add(type);

  // HVAC equipment + verb => replacement or new install.
  if (HVAC_NOUN.test(text)) {
    if (REPLACE_VERB.test(text)) found.add("hvac_replace");
    else if (INSTALL_VERB.test(text)) found.add("hvac_new");
  }

  for (const [big, smalls] of Object.entries(SUPERSEDES) as Array<[WorkType, WorkType[]]>) {
    if (found.has(big)) for (const s of smalls) found.delete(s);
  }
  // Routine-maintenance wording must not sit next to a permitted scope of work.
  if (BIG_SCOPE.some((w) => found.has(w))) found.delete("maintenance");

  return WORK_ORDER.filter((w) => found.has(w));
}

// ---------------------------------------------------------------------------
// 2) Permit likelihood - strictest work type wins
// ---------------------------------------------------------------------------

const LIKELIHOOD_RANK: Record<PermitLikelihood, number> = { unknown: 0, unlikely: 1, possibly_required: 2, likely_required: 3 };

const LIKELIHOOD_BY_WORK: Record<WorkType, PermitLikelihood> = {
  electrical_service: "likely_required",
  electrical_new: "likely_required",
  ev_charger: "likely_required",
  generator: "likely_required",
  water_heater: "likely_required",
  plumbing_repipe: "likely_required",
  plumbing_drain: "likely_required",
  gas_work: "likely_required",
  hvac_replace: "likely_required",
  hvac_new: "likely_required",
  ductwork: "possibly_required",
  refrigerant: "possibly_required",
  electrical_repair: "possibly_required",
  plumbing_fixture: "possibly_required",
  appliance_repair: "unlikely",
  maintenance: "unlikely",
};

/** The stricter (higher-rank) of two likelihoods. Used by ai.ts when merging the AI verdict. */
export function higherLikelihood(a: PermitLikelihood, b: PermitLikelihood): PermitLikelihood {
  return LIKELIHOOD_RANK[b] > LIKELIHOOD_RANK[a] ? b : a;
}

export function permitLikelihoodFor(workTypes: WorkType[]): PermitLikelihood {
  let best: PermitLikelihood = "unknown";
  for (const w of workTypes) {
    const l = LIKELIHOOD_BY_WORK[w];
    if (l && LIKELIHOOD_RANK[l] > LIKELIHOOD_RANK[best]) best = l;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 3) Sorting - blockers first, then by category, then key (stable + deterministic)
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<Severity, number> = { blocker: 0, warning: 1, info: 2 };
const CATEGORY_ORDER: Record<RequirementCategory, number> = {
  permit: 0, inspection: 1, licensing: 2, safety: 3, regulation: 4, documentation: 5,
};

export function sortItems<T extends RequirementItem>(items: T[]): T[] {
  return [...items].sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
    (CATEGORY_ORDER[a.category] ?? 9) - (CATEGORY_ORDER[b.category] ?? 9) ||
    (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// 4) Evaluation
// ---------------------------------------------------------------------------

function scopeApplies(scope: "us" | "gb" | "ca" | "any", j: JurisdictionInfo): boolean {
  if (scope === "any") return true;
  if (scope === "us") return j.country === "US";
  if (scope === "gb") return j.country === "GB";
  return j.country === "CA";
}

const REGULATED: WorkType[] = BIG_SCOPE;

export function evaluateJob(facts: JobFacts): EngineResult {
  const jurisdiction = parseJurisdiction(facts.address, facts.countryHint);

  const text = [facts.serviceType, facts.dispatchNote, facts.diagnosisNote, facts.equipmentType, ...(facts.tags ?? [])]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" ")
    .toLowerCase();

  const workTypes = classifyWorkTypes(text);
  const ctx: RuleContext = {
    text,
    customerType: facts.customerType,
    isEmergency: facts.isEmergency,
    state: jurisdiction.state,
    workTypes,
  };

  const byKey = new Map<string, RequirementItem>();
  const add = (item: RequirementItem) => { if (!byKey.has(item.key)) byKey.set(item.key, item); };

  for (const rule of RULES) {
    if (!scopeApplies(rule.scope, jurisdiction)) continue;
    if (rule.workTypes !== "*" && !rule.workTypes.some((w) => workTypes.includes(w))) continue;
    if (rule.when && !rule.when(ctx)) continue;
    const d = typeof rule.item === "function" ? rule.item(ctx) : rule.item;
    add({
      key: d.key, category: d.category, severity: d.severity, title: d.title, detail: d.detail,
      authority: d.authority ?? null, reference: d.reference ?? null, confidence: d.confidence, source: "rule",
    });
  }

  if (jurisdiction.country === "US") for (const item of stateRulesFor(jurisdiction.state, workTypes)) add(item);

  // Never report "all clear" where we have no curated rules for regulated work.
  if (jurisdiction.coverage === "generic" && workTypes.some((w) => REGULATED.includes(w))) {
    add({
      key: "generic.verify_local",
      category: "regulation",
      severity: "warning",
      title: "Verify local permit, licensing and code requirements",
      detail: "Detailed rules are not curated for this jurisdiction yet. Confirm permit, licensing and inspection requirements with the local authority before starting regulated work.",
      authority: "Local authority having jurisdiction",
      reference: null,
      confidence: "low",
      source: "rule",
    });
  }

  return { jurisdiction, workTypes, permitLikelihood: permitLikelihoodFor(workTypes), items: sortItems([...byKey.values()]) };
}

// supabase/functions/_shared/rebate-intelligence/engine.ts
//
// Vireek Energy + Rebate Intelligence: pure, deterministic engine.
// No I/O, no LLM, no clock reads (the caller passes `now`), so every result is
// reproducible and unit-testable. The Edge Function only gathers data.
//
// Honesty rules baked in:
//   - An incentive exists only if it is a row in the catalog. Nothing is invented.
//   - Missing facts (income, efficiency rating, utility...) produce `needs_info`
//     with the exact question to ask, never a silent zero or a silent yes.
//   - Confidence = catalog freshness x funding status x learned realization rate.
//   - Expired programs are excluded WITH the reason (e.g. 25C for 2026 installs).

export const ENGINE_VERSION = "rebate-intel-1.0.0";

export const MEASURE_TYPES = [
  "heat_pump_hvac",
  "central_ac",
  "furnace",
  "boiler",
  "heat_pump_water_heater",
  "water_heater",
  "panel_upgrade",
  "insulation_air_sealing",
  "smart_thermostat",
  "windows_doors",
  "duct_sealing",
  "home_energy_audit",
] as const;
export type MeasureType = (typeof MEASURE_TYPES)[number];

export type IncentiveLevel = "federal" | "state" | "local" | "utility" | "manufacturer";
export type IncentiveKind = "rebate" | "tax_credit" | "loan" | "instant_discount";
export type PayoutTiming = "point_of_sale" | "post_install" | "tax_filing";
export type AmountType = "flat" | "percent_of_cost" | "per_ton" | "per_unit";
export type FundingStatus = "open" | "limited" | "waitlist" | "closed" | "unknown";
export type EvalStatus = "eligible" | "likely" | "needs_info" | "ineligible";
export type ReplacementStage = "unknown" | "early" | "mid" | "late" | "past_life";

export interface Efficiency {
  seer2?: number;
  eer2?: number;
  hspf2?: number;
  afue?: number;
  uef?: number;
}
const EFFICIENCY_KEYS = ["seer2", "eer2", "hspf2", "afue", "uef"] as const;
const EFFICIENCY_LABEL: Record<(typeof EFFICIENCY_KEYS)[number], string> = {
  seer2: "SEER2",
  eer2: "EER2",
  hspf2: "HSPF2",
  afue: "AFUE",
  uef: "UEF",
};

export interface IncomeTier {
  max_ami_pct: number;
  share_pct: number;
}

export interface IncentiveProgram {
  id: string;
  slug: string;
  name: string;
  level: IncentiveLevel;
  administrator: string | null;
  jurisdiction_state: string | null;
  utility_name: string | null;
  postal_prefixes: string[];
  measure_types: string[];
  incentive_kind: IncentiveKind;
  payout_timing: PayoutTiming;
  amount_type: AmountType;
  amount_value: number;
  max_amount_cents: number | null;
  min_efficiency: Record<string, number>;
  income_tiers: IncomeTier[];
  requires_owner_occupied: boolean;
  requires_pre_approval: boolean;
  requires_participating_contractor: boolean;
  exclusive_group: string | null;
  start_date: string | null;
  end_date: string | null;
  funding_status: FundingStatus;
  source_url: string | null;
  last_verified_at: string | null;
  notes: string | null;
  is_private: boolean;
}

export interface UtilityTerritory {
  postal_code: string;
  utility_name: string;
  utility_type: "electric" | "gas" | "both";
}

export interface EquipmentSignal {
  id: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  install_date: string | null;
  expected_lifespan_years: number | null;
  last_service_date: string | null;
}

export interface ReplacementOption {
  key: string;
  label: string;
  measure: MeasureType;
  installed_cost_cents: number;
  efficiency: Efficiency;
  energy_star?: boolean;
  tons?: number | null;
  units?: number | null;
  manufacturer_rebate_cents?: number | null;
  annual_energy_savings_cents?: number | null;
}

export interface PropertyContext {
  state: string | null;
  postal_code: string | null;
  utility_name: string | null;
  household_ami_pct: number | null;
  owner_occupied: boolean | null;
  install_target_date: string | null;
}

export interface OutcomeStat {
  decided: number;
  successes: number;
  scope: "network" | "account";
}

export interface FinancingTerms {
  apr_bps: number;
  term_months: number;
}

export interface RebateInput {
  now: string;
  property: PropertyContext;
  equipment: EquipmentSignal | null;
  options: ReplacementOption[];
  programs: IncentiveProgram[];
  territories: UtilityTerritory[];
  outcomes: Record<string, OutcomeStat>;
  financing: FinancingTerms | null;
}

export interface IncentiveEvaluation {
  program_id: string;
  slug: string;
  name: string;
  level: IncentiveLevel;
  kind: IncentiveKind;
  payout_timing: PayoutTiming;
  status: EvalStatus;
  /** Face value if everything checks out. */
  amount_cents: number;
  /** amount x confidence; only for eligible / likely. */
  expected_cents: number;
  /** amount x confidence for needs_info (not counted in totals). */
  upside_cents: number;
  confidence: number;
  realization: { rate: number; decided: number; scope: "network" | "account" | "prior" };
  reasons: string[];
  missing: string[];
  warnings: string[];
  requires_pre_approval: boolean;
  requires_participating_contractor: boolean;
  end_date: string | null;
  funding_status: FundingStatus;
  source_url: string | null;
  last_verified_at: string | null;
  is_private: boolean;
}

export interface FinancingResult {
  apr_bps: number;
  term_months: number;
  monthly_no_incentives_cents: number;
  monthly_after_point_of_sale_cents: number;
  monthly_if_rebates_paid_down_cents: number;
}

export interface OptionResult {
  key: string;
  label: string;
  measure: MeasureType;
  gross_cost_cents: number;
  point_of_sale_cents: number;
  post_install_cents: number;
  tax_filing_cents: number;
  upfront_cash_cents: number;
  net_cost_conservative_cents: number;
  net_cost_expected_cents: number;
  net_cost_best_case_cents: number;
  total_potential_cents: number;
  total_expected_cents: number;
  upside_cents: number;
  annual_energy_savings_cents: number | null;
  payback_years: number | null;
  ten_year_net_cost_cents: number | null;
  financing: FinancingResult | null;
  incentives: IncentiveEvaluation[];
  excluded: { name: string; slug: string; reason: string }[];
  rank: number;
}

export interface DeadlineAlert {
  program: string;
  end_date: string;
  days_left: number;
}

export interface RebateReport {
  engine_version: string;
  generated_at: string;
  property: PropertyContext;
  utilities_resolved: string[];
  equipment: {
    id: string;
    label: string;
    age_years: number | null;
    expected_lifespan_years: number | null;
    life_used_pct: number | null;
    stage: ReplacementStage;
  } | null;
  replacement_signal: { stage: ReplacementStage; headline: string };
  options: OptionResult[];
  best_option_key: string | null;
  rank_basis: "ten_year_net_cost" | "net_cost_expected";
  total_potential_cents: number;
  total_expected_cents: number;
  deadline_alerts: DeadlineAlert[];
  actions: string[];
  data_quality: {
    programs_evaluated: number;
    stale_programs: number;
    local_coverage: boolean;
    warnings: string[];
  };
  disclaimer: string;
}

export const DISCLAIMER =
  "Estimates only. Incentive rules, funding and deadlines change often; verify each program with its administrator before promising an amount to a customer. Vireek is not a tax advisor.";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const money = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;

function parseDate(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00.000Z` : s);
  return Number.isFinite(t) ? t : null;
}

export function monthlyPayment(principalCents: number, aprBps: number, termMonths: number): number {
  if (!(principalCents > 0) || !(termMonths > 0)) return 0;
  const r = aprBps / 10_000 / 12;
  if (r === 0) return Math.round(principalCents / termMonths);
  const f = Math.pow(1 + r, termMonths);
  return Math.round((principalCents * r * f) / (f - 1));
}

// ---------------------------------------------------------------------------
// Property intelligence: equipment age -> replacement stage
// ---------------------------------------------------------------------------

export function assessEquipment(eq: EquipmentSignal | null, nowMs: number) {
  if (!eq) return null;
  const installMs = parseDate(eq.install_date);
  const life = num(eq.expected_lifespan_years) && eq.expected_lifespan_years! > 0 ? eq.expected_lifespan_years! : null;
  const age = installMs === null ? null : Math.max(0, (nowMs - installMs) / (365.25 * DAY_MS));
  const used = age !== null && life !== null ? age / life : null;
  let stage: ReplacementStage = "unknown";
  if (used !== null) stage = used >= 1 ? "past_life" : used >= 0.8 ? "late" : used >= 0.5 ? "mid" : "early";
  const label = [eq.make, eq.model].filter(Boolean).join(" ").trim() || eq.equipment_type;
  return {
    id: eq.id,
    label,
    age_years: age === null ? null : Math.round(age * 10) / 10,
    expected_lifespan_years: life,
    life_used_pct: used === null ? null : Math.round(used * 100),
    stage,
  };
}

const STAGE_HEADLINE: Record<ReplacementStage, string> = {
  unknown: "Equipment age is unknown. Add the install date to sharpen the replace-now vs. wait call.",
  early: "Equipment is early in its life. Replacement is optional; incentives alone rarely justify it yet.",
  mid: "Equipment is mid-life. Watch for programs that end soon, but there is no urgency.",
  late: "Equipment is in the last 20% of its expected life. This is the right time to plan a replacement around the best incentives.",
  past_life: "Equipment is past its expected life. Failure risk is high; lock in incentives before an emergency forces a rushed purchase.",
};

// ---------------------------------------------------------------------------
// Utility territory resolution
// ---------------------------------------------------------------------------

export function resolveUtilities(property: PropertyContext, territories: UtilityTerritory[]): string[] {
  const names = new Map<string, string>();
  if (property.utility_name?.trim()) names.set(normName(property.utility_name), property.utility_name.trim());
  if (property.postal_code) {
    for (const t of territories) {
      if (t.postal_code === property.postal_code) names.set(normName(t.utility_name), t.utility_name);
    }
  }
  return [...names.values()];
}

// ---------------------------------------------------------------------------
// Confidence model
// ---------------------------------------------------------------------------

export function freshnessFactor(lastVerifiedAt: string | null, nowMs: number): number {
  const t = parseDate(lastVerifiedAt);
  if (t === null) return 0.4;
  const days = (nowMs - t) / DAY_MS;
  if (days <= 30) return 1;
  if (days <= 90) return 0.85;
  if (days <= 180) return 0.65;
  return 0.4;
}

const FUNDING_FACTOR: Record<FundingStatus, number> = { open: 1, limited: 0.7, waitlist: 0.35, unknown: 0.6, closed: 0 };

/** Beta(4,1) prior (mean 0.8, weight 5) shrinks small samples toward the prior. */
export function realizationRate(stat: OutcomeStat | undefined): { rate: number; decided: number; scope: "network" | "account" | "prior" } {
  if (!stat || stat.decided <= 0) return { rate: 0.8, decided: 0, scope: "prior" };
  const successes = clamp(stat.successes, 0, stat.decided);
  return { rate: (successes + 4) / (stat.decided + 5), decided: stat.decided, scope: stat.scope };
}

// ---------------------------------------------------------------------------
// Program x option evaluation
// ---------------------------------------------------------------------------

interface EvalContext {
  nowMs: number;
  targetMs: number;
  property: PropertyContext;
  utilities: string[];
  outcomes: Record<string, OutcomeStat>;
}

function baseEvaluation(p: IncentiveProgram): IncentiveEvaluation {
  return {
    program_id: p.id,
    slug: p.slug,
    name: p.name,
    level: p.level,
    kind: p.incentive_kind,
    payout_timing: p.payout_timing,
    status: "eligible",
    amount_cents: 0,
    expected_cents: 0,
    upside_cents: 0,
    confidence: 0,
    realization: { rate: 0.8, decided: 0, scope: "prior" },
    reasons: [],
    missing: [],
    warnings: [],
    requires_pre_approval: p.requires_pre_approval,
    requires_participating_contractor: p.requires_participating_contractor,
    end_date: p.end_date,
    funding_status: p.funding_status,
    source_url: p.source_url,
    last_verified_at: p.last_verified_at,
    is_private: p.is_private,
  };
}

export function evaluateProgram(p: IncentiveProgram, o: ReplacementOption, ctx: EvalContext): IncentiveEvaluation {
  const ev = baseEvaluation(p);
  const fail = (reason: string): IncentiveEvaluation => {
    ev.status = "ineligible";
    ev.reasons = [reason];
    ev.amount_cents = 0;
    ev.expected_cents = 0;
    ev.upside_cents = 0;
    return ev;
  };

  // 1. Dates ("placed in service" on the target install date)
  const start = parseDate(p.start_date);
  const end = parseDate(p.end_date);
  if (end !== null && ctx.targetMs > end) {
    return fail(`Program ended ${p.end_date}; an install dated ${new Date(ctx.targetMs).toISOString().slice(0, 10)} no longer qualifies.`);
  }
  if (start !== null && ctx.targetMs < start) return fail(`Program does not start until ${p.start_date}.`);
  if (p.funding_status === "closed") return fail("Program funding is closed.");

  // 2. Measure
  if (!p.measure_types.includes(o.measure)) return fail("Program does not cover this equipment type.");

  // 3. Geography
  const st = ctx.property.state;
  if (p.jurisdiction_state) {
    if (!st) ev.missing.push("Property state");
    else if (st !== p.jurisdiction_state) return fail(`Program is limited to ${p.jurisdiction_state}.`);
  }
  if (p.postal_prefixes.length > 0) {
    const zip = ctx.property.postal_code;
    if (!zip) ev.missing.push("Property ZIP code");
    else if (!p.postal_prefixes.some((pre) => zip.startsWith(pre))) return fail("Property ZIP code is outside the program area.");
  }
  if (p.utility_name) {
    if (ctx.utilities.length === 0) ev.missing.push("Customer's utility company");
    else if (!ctx.utilities.some((u) => normName(u) === normName(p.utility_name!))) {
      return fail(`Program is for ${p.utility_name} customers.`);
    }
  }

  // 4. Efficiency
  for (const [key, required] of Object.entries(p.min_efficiency)) {
    if (key === "energy_star") {
      if (required >= 1) {
        if (o.energy_star === undefined) ev.missing.push("Whether the unit is ENERGY STAR certified");
        else if (!o.energy_star) return fail("Unit must be ENERGY STAR certified.");
      }
      continue;
    }
    if (!(EFFICIENCY_KEYS as readonly string[]).includes(key)) continue;
    const k = key as (typeof EFFICIENCY_KEYS)[number];
    const have = num(o.efficiency[k]);
    if (have === null) ev.missing.push(`${EFFICIENCY_LABEL[k]} rating of the new unit`);
    else if (have < required) return fail(`${EFFICIENCY_LABEL[k]} ${have} is below the required ${required}.`);
  }

  // 5. Occupancy
  if (p.requires_owner_occupied) {
    if (ctx.property.owner_occupied === null) ev.missing.push("Whether the home is owner-occupied");
    else if (!ctx.property.owner_occupied) return fail("Program requires an owner-occupied home.");
  }

  // 6. Income tiers
  let sharePct = 100;
  const tiers = [...p.income_tiers].sort((a, b) => a.max_ami_pct - b.max_ami_pct);
  if (tiers.length > 0) {
    const ami = ctx.property.household_ami_pct;
    if (ami === null) {
      ev.missing.push("Household income as % of area median income (AMI)");
      sharePct = Math.max(...tiers.map((t) => t.share_pct)); // best case until known
    } else {
      const tier = tiers.find((t) => ami <= t.max_ami_pct);
      if (!tier) return fail(`Household income (${ami}% of AMI) is above the program limit of ${tiers[tiers.length - 1].max_ami_pct}%.`);
      sharePct = tier.share_pct;
      ev.reasons.push(`Income tier: up to ${tier.max_ami_pct}% of AMI -> ${tier.share_pct}% of the benefit.`);
    }
  }

  // 7. Amount
  const cost = Math.max(0, o.installed_cost_cents);
  let amount = 0;
  switch (p.amount_type) {
    case "flat":
      amount = p.amount_value;
      break;
    case "percent_of_cost":
      amount = (cost * p.amount_value) / 100;
      break;
    case "per_ton": {
      const tons = num(o.tons);
      if (tons === null || tons <= 0) ev.missing.push("System size in tons");
      amount = p.amount_value * (tons ?? 0);
      break;
    }
    case "per_unit":
      amount = p.amount_value * Math.max(1, num(o.units) ?? 1);
      break;
  }
  amount = (amount * sharePct) / 100;
  if (p.max_amount_cents !== null) amount = Math.min(amount, p.max_amount_cents);
  amount = Math.round(Math.min(amount, cost));
  ev.amount_cents = amount;
  if (amount <= 0 && ev.missing.length === 0) return fail("Computed incentive is $0 for this option.");

  // 8. Confidence
  const fresh = freshnessFactor(p.last_verified_at, ctx.nowMs);
  const fund = FUNDING_FACTOR[p.funding_status];
  const real = p.incentive_kind === "tax_credit" ? { rate: 1, decided: 0, scope: "prior" as const } : realizationRate(ctx.outcomes[p.id]);
  ev.realization = real;
  ev.confidence = Math.round(fresh * fund * real.rate * 100) / 100;

  if (fresh < 0.65) ev.warnings.push("Catalog entry is stale or never verified. Re-check the source before quoting this amount.");
  if (p.funding_status === "unknown") ev.warnings.push("Funding availability is unconfirmed. Verify with the administrator.");
  if (p.funding_status === "waitlist") ev.warnings.push("Program is on a waitlist; timing is uncertain.");
  if (p.funding_status === "limited") ev.warnings.push("Funding is limited and may run out before this job closes.");
  if (p.incentive_kind === "tax_credit") ev.warnings.push("Tax credit: value depends on the customer's tax liability. Not a cash rebate.");
  if (p.incentive_kind === "loan") ev.warnings.push("Loan product: reduces financing cost, not the sticker price.");
  if (p.requires_pre_approval) ev.warnings.push("Pre-approval required BEFORE installation.");
  if (p.requires_participating_contractor) ev.warnings.push("Installer must be enrolled in the program.");

  if (ev.missing.length > 0) {
    ev.status = "needs_info";
    ev.upside_cents = Math.round(amount * ev.confidence);
    return ev;
  }
  ev.status = ev.confidence >= 0.6 ? "eligible" : "likely";
  ev.expected_cents = Math.round(amount * ev.confidence);
  return ev;
}

// ---------------------------------------------------------------------------
// Stacking: one winner per exclusive group
// ---------------------------------------------------------------------------

function applyExclusiveGroups(
  evals: { p: IncentiveProgram; ev: IncentiveEvaluation }[],
): { ev: IncentiveEvaluation; reason: string }[] {
  const dropped: { ev: IncentiveEvaluation; reason: string }[] = [];
  const groups = new Map<string, { p: IncentiveProgram; ev: IncentiveEvaluation }[]>();
  for (const e of evals) {
    if (e.ev.status === "ineligible" || !e.p.exclusive_group) continue;
    const arr = groups.get(e.p.exclusive_group) ?? [];
    arr.push(e);
    groups.set(e.p.exclusive_group, arr);
  }
  const value = (ev: IncentiveEvaluation) => (ev.status === "needs_info" ? ev.upside_cents : ev.expected_cents);
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => value(b.ev) - value(a.ev) || a.p.slug.localeCompare(b.p.slug));
    const winner = members[0];
    for (const loser of members.slice(1)) {
      loser.ev.status = "ineligible";
      loser.ev.amount_cents = 0;
      loser.ev.expected_cents = 0;
      loser.ev.upside_cents = 0;
      const reason = `Cannot be combined with "${winner.p.name}"; the higher-value program was kept.`;
      loser.ev.reasons = [reason];
      dropped.push({ ev: loser.ev, reason });
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function analyzeRebates(input: RebateInput): RebateReport {
  const nowMs = parseDate(input.now) ?? Date.now();
  const targetMs = parseDate(input.property.install_target_date) ?? nowMs;
  const utilities = resolveUtilities(input.property, input.territories);
  const ctx: EvalContext = { nowMs, targetMs, property: input.property, utilities, outcomes: input.outcomes };
  const equipment = assessEquipment(input.equipment, nowMs);
  const stage: ReplacementStage = equipment?.stage ?? "unknown";

  const options: OptionResult[] = input.options.map((o) => {
    const evals = input.programs.map((p) => ({ p, ev: evaluateProgram(p, o, ctx) }));
    const stackDropped = applyExclusiveGroups(evals);

    const counted = evals.map((e) => e.ev).filter((e) => e.status === "eligible" || e.status === "likely");
    const needs = evals.map((e) => e.ev).filter((e) => e.status === "needs_info");

    // Manufacturer rebate typed in by the user: a fact, not a prediction.
    const mfr = Math.max(0, Math.min(num(o.manufacturer_rebate_cents) ?? 0, o.installed_cost_cents));
    const sumBy = (t: PayoutTiming, f: (e: IncentiveEvaluation) => number) =>
      counted.filter((e) => e.payout_timing === t).reduce((s, e) => s + f(e), 0);

    const pos = sumBy("point_of_sale", (e) => e.expected_cents);
    const post = sumBy("post_install", (e) => e.expected_cents) + mfr;
    const tax = sumBy("tax_filing", (e) => e.expected_cents);
    const totalExpected = pos + post + tax;
    const totalPotential = counted.reduce((s, e) => s + e.amount_cents, 0) + needs.reduce((s, e) => s + e.amount_cents, 0) + mfr;
    const upside = needs.reduce((s, e) => s + e.upside_cents, 0);
    const confirmed = counted.filter((e) => e.status === "eligible").reduce((s, e) => s + e.expected_cents, 0) + mfr;

    const gross = o.installed_cost_cents;
    const floor0 = (v: number) => Math.max(0, v);
    const netExpected = floor0(gross - totalExpected);
    const savings = num(o.annual_energy_savings_cents);
    const fin = input.financing;

    return {
      key: o.key,
      label: o.label,
      measure: o.measure,
      gross_cost_cents: gross,
      point_of_sale_cents: pos,
      post_install_cents: post,
      tax_filing_cents: tax,
      upfront_cash_cents: floor0(gross - pos),
      net_cost_conservative_cents: floor0(gross - confirmed),
      net_cost_expected_cents: netExpected,
      net_cost_best_case_cents: floor0(gross - totalPotential),
      total_potential_cents: totalPotential,
      total_expected_cents: totalExpected,
      upside_cents: upside,
      annual_energy_savings_cents: savings,
      payback_years: savings !== null && savings > 0 ? Math.round((netExpected / savings) * 10) / 10 : null,
      ten_year_net_cost_cents: savings !== null ? Math.round(netExpected - savings * 10) : null,
      financing: fin
        ? {
            apr_bps: fin.apr_bps,
            term_months: fin.term_months,
            monthly_no_incentives_cents: monthlyPayment(gross, fin.apr_bps, fin.term_months),
            monthly_after_point_of_sale_cents: monthlyPayment(floor0(gross - pos), fin.apr_bps, fin.term_months),
            monthly_if_rebates_paid_down_cents: monthlyPayment(netExpected, fin.apr_bps, fin.term_months),
          }
        : null,
      incentives: [...counted, ...needs].sort((a, b) => b.amount_cents - a.amount_cents || a.slug.localeCompare(b.slug)),
      excluded: [
        ...evals
          .filter((e) => e.ev.status === "ineligible" && !stackDropped.some((d) => d.ev === e.ev))
          .map((e) => ({ name: e.p.name, slug: e.p.slug, reason: e.ev.reasons[0] ?? "Not eligible." })),
        ...stackDropped.map((d) => ({ name: d.ev.name, slug: d.ev.slug, reason: d.reason })),
      ],
      rank: 0,
    };
  });

  // Rank: 10-year net cost when every option has an energy-savings figure, else expected net cost.
  const allHaveSavings = options.length > 0 && options.every((o) => o.ten_year_net_cost_cents !== null);
  const basis: RebateReport["rank_basis"] = allHaveSavings ? "ten_year_net_cost" : "net_cost_expected";
  const score = (o: OptionResult) => (allHaveSavings ? o.ten_year_net_cost_cents! : o.net_cost_expected_cents);
  [...options]
    .sort((a, b) => score(a) - score(b) || a.net_cost_expected_cents - b.net_cost_expected_cents || a.key.localeCompare(b.key))
    .forEach((o, i) => {
      o.rank = i + 1;
    });
  const best = options.find((o) => o.rank === 1) ?? null;

  // Deadlines for programs actually counted on the best option
  const deadline_alerts: DeadlineAlert[] = [];
  for (const e of best?.incentives ?? []) {
    const endMs = parseDate(e.end_date);
    if (endMs === null) continue;
    const days = Math.ceil((endMs - nowMs) / DAY_MS);
    if (days >= 0 && days <= 180) deadline_alerts.push({ program: e.name, end_date: e.end_date!, days_left: days });
  }
  deadline_alerts.sort((a, b) => a.days_left - b.days_left);

  // Ordered action checklist
  const actions: string[] = [];
  const bestEvals = best?.incentives ?? [];
  if (bestEvals.some((e) => e.requires_pre_approval)) actions.push("Get program pre-approval BEFORE any equipment is ordered or installed. Many programs void the rebate otherwise.");
  if (bestEvals.some((e) => e.requires_participating_contractor)) actions.push("Confirm the installer is enrolled in each program that requires a participating contractor.");
  const missingAll = [...new Set(bestEvals.flatMap((e) => e.missing))];
  for (const m of missingAll) actions.push(`Collect: ${m}.`);
  if (bestEvals.some((e) => e.payout_timing === "point_of_sale")) actions.push("Show the point-of-sale discount as its own line on the proposal so the customer sees the real out-of-pocket price.");
  if (bestEvals.some((e) => e.payout_timing === "post_install")) actions.push("Record model + serial numbers and keep the AHRI certificate and invoice; post-install rebates are denied without them.");
  if (bestEvals.some((e) => e.kind === "tax_credit")) actions.push("Advise the customer to confirm tax-credit eligibility with a tax professional.");
  if (best && best.incentives.length > 0) actions.push("Log each application in the Rebate Pipeline so approval and payment outcomes improve future estimates.");

  // Data quality / honesty
  const warnings: string[] = [];
  const stale = input.programs.filter((p) => freshnessFactor(p.last_verified_at, nowMs) < 0.65).length;
  const st = input.property.state;
  const local_coverage = input.programs.some((p) => p.level !== "federal" && (p.jurisdiction_state === st || p.utility_name !== null || p.postal_prefixes.length > 0) && st !== null);
  if (!st) warnings.push("Property state is missing; state and utility programs could not be matched.");
  else if (!local_coverage) warnings.push(`No state, utility or local programs for ${st} are in your catalog yet. Results show federal programs only. Add or import local programs to see the full picture.`);
  if (!input.property.postal_code) warnings.push("Property ZIP code is missing; utility territory could not be resolved.");
  else if (utilities.length === 0) warnings.push("Utility company could not be resolved for this ZIP code. Enter it manually to unlock utility rebates.");
  if (stale > 0) warnings.push(`${stale} catalog program${stale === 1 ? " is" : "s are"} stale or never verified; amounts may have changed.`);
  if (input.property.household_ami_pct === null) warnings.push("Household income vs. area median income was not provided; income-qualified programs show best-case values only.");

  // Headline
  const dead = deadline_alerts[0];
  let headline = STAGE_HEADLINE[stage];
  if (dead) headline += ` ${dead.program} ends in ${dead.days_left} day${dead.days_left === 1 ? "" : "s"}.`;
  if (best && best.total_expected_cents > 0) headline += ` Best option "${best.label}" is expected to cut the cost by ${money(best.total_expected_cents)}.`;

  return {
    engine_version: ENGINE_VERSION,
    generated_at: new Date(nowMs).toISOString(),
    property: input.property,
    utilities_resolved: utilities,
    equipment,
    replacement_signal: { stage, headline },
    options,
    best_option_key: best?.key ?? null,
    rank_basis: basis,
    total_potential_cents: best?.total_potential_cents ?? 0,
    total_expected_cents: best?.total_expected_cents ?? 0,
    deadline_alerts,
    actions,
    data_quality: { programs_evaluated: input.programs.length, stale_programs: stale, local_coverage, warnings },
    disclaimer: DISCLAIMER,
  };
}

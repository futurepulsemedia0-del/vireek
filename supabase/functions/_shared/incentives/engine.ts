// supabase/functions/_shared/incentives/engine.ts
//
// Vireek Incentive Decision Engine: pure, deterministic, no I/O.
//
//   Property + Equipment + Location + Project + Customer eligibility
//   + Utility + Program + Effective date
//        -> eligible incentives
//        -> net project economics (price, incentives, net cost, payback)
//
// Integrity rules (this module is the single source of truth for them):
//   1. The engine NEVER invents a program, an amount or a rate. It only
//      evaluates the programs the account has in its own catalog.
//   2. A rule whose input is unknown never passes silently: the program becomes
//      "conditional" and the missing fact is listed under `verify`.
//   3. Only programs with every rule verified AND a recently re-verified catalog
//      entry count as "confirmed". Everything else is shown as a range upside.
//   4. Mutually exclusive programs (same stack_group) are never double counted.
//   5. Incentives can never exceed the project total.

export const INCENTIVE_ENGINE_VERSION = '1.0.0';
export const STALE_AFTER_DAYS = 180;
export const EXPIRING_SOON_DAYS = 30;

export const DISCLAIMER =
  'Estimates only. Program availability, eligibility and amounts are set by the administering organization and must be verified before anything is promised to a customer.';

export type ProgramType =
  | 'utility_rebate'
  | 'manufacturer_rebate'
  | 'government_rebate'
  | 'tax_credit'
  | 'financing'
  | 'grant'
  | 'other';
export type BenefitKind = 'fixed' | 'percent' | 'per_unit';
export type Delivery = 'instant' | 'mail_in' | 'tax_credit';
export type FundingStatus = 'available' | 'waitlist' | 'exhausted' | 'unknown';
export type CustomerKind = 'any' | 'residential' | 'commercial';
export type PercentBasis = 'project' | 'equipment';
export type EligibilityStatus = 'eligible' | 'conditional' | 'ineligible';
export type Severity = 'info' | 'warning' | 'critical';

export interface IncentiveProgram {
  id: string;
  name: string;
  program_type: ProgramType;
  administrator: string | null;
  country: string;
  states: string[];
  postal_prefixes: string[];
  utility_names: string[];
  equipment_types: string[];
  customer_kind: CustomerKind;
  requires_owner_occupied: boolean;
  requires_income_qualified: boolean;
  min_building_age_years: number | null;
  max_building_age_years: number | null;
  efficiency_metric: string | null;
  min_efficiency_value: number | null;
  min_project_cents: number | null;
  /** fixed / per_unit: cents. percent: 0-100. */
  benefit_kind: BenefitKind;
  benefit_value: number;
  cap_cents: number | null;
  percent_basis: PercentBasis;
  delivery: Delivery;
  stack_group: string | null;
  funding_status: FundingStatus;
  effective_start: string | null; // YYYY-MM-DD
  effective_end: string | null; // YYYY-MM-DD, inclusive
  verified_at: string | null; // ISO timestamp
  source_url: string | null;
  notes: string | null;
}

export interface IncentiveLineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface IncentiveProject {
  /** YYYY-MM-DD: the date the work is performed / the equipment is installed. */
  effective_date: string;
  country: string | null;
  state: string | null;
  postal_code: string | null;
  utility_name: string | null;
  customer_kind: 'residential' | 'commercial' | null;
  owner_occupied: boolean | null;
  income_qualified: boolean | null;
  building_year_built: number | null;
  equipment_type: string | null;
  equipment_units: number;
  efficiency_metric: string | null;
  efficiency_value: number | null;
  equipment_cost_cents: number | null;
  annual_kwh_saved: number | null;
  annual_therms_saved: number | null;
  annual_savings_direct_cents: number | null;
  electric_rate_cents_per_kwh: number | null;
  gas_rate_cents_per_therm: number | null;
}

export interface IncentiveInput {
  now: string; // ISO timestamp
  quote: {
    line_items: IncentiveLineItem[];
    tax_percent: number;
    discount_type: 'percent' | 'flat' | null;
    discount_value: number | null; // percent: 0-100; flat: DOLLARS (same as the Quote Builder)
  };
  project: IncentiveProject;
  programs: IncentiveProgram[];
}

export interface ProgramEvaluation {
  program_id: string;
  name: string;
  program_type: ProgramType;
  administrator: string | null;
  delivery: Delivery;
  status: EligibilityStatus;
  /** Calculated benefit if the program applies (0 when ineligible). */
  amount_cents: number;
  /** True when this amount is part of the confirmed total. */
  counts_confirmed: boolean;
  /** True when this amount is part of the potential (best-case) total. */
  counts_potential: boolean;
  met: string[];
  failed: string[];
  verify: string[];
  warnings: string[];
  stacking_note: string | null;
  source_url: string | null;
}

export interface Economics {
  price_cents: number; // after discount, before tax
  tax_cents: number;
  total_cents: number; // what the customer is quoted
  confirmed_cents: number;
  conditional_cents: number;
  potential_cents: number; // confirmed + conditional
  net_cost_confirmed_cents: number; // worst case: confirmed incentives only
  net_cost_best_cents: number; // best case: every conditional incentive is approved
  due_at_signing_cents: number; // total minus confirmed instant incentives
  delayed_cents: number; // confirmed incentives paid after the sale (mail-in / tax credit)
  by_delivery_cents: Record<Delivery, number>; // potential, per delivery method
  capped: boolean;
}

export interface EnergyImpact {
  known: boolean;
  annual_savings_cents: number | null;
  payback_months_best: number | null;
  payback_months_confirmed: number | null;
  payback_months_without_incentives: number | null;
  months_saved_by_incentives: number | null;
  ten_year_net_benefit_cents: number | null; // simple, undiscounted, best case
  notes: string[];
}

export interface ActionItem {
  severity: Severity;
  title: string;
  detail: string;
}

export interface IncentiveReport {
  engine_version: string;
  effective_date: string;
  programs_considered: number;
  economics: Economics;
  energy: EnergyImpact;
  evaluations: ProgramEvaluation[];
  action_items: ActionItem[];
  missing_inputs: string[];
  disclaimer: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const round = (n: number): number => Math.round(n);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const norm = (s: string | null | undefined): string => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const usd = (cents: number): string => `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** Whole days from a to b (both YYYY-MM-DD or ISO); NaN when either is invalid. */
function dayDiff(a: string, b: string): number {
  const ta = Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a);
  const tb = Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b);
  return Math.round((tb - ta) / 86_400_000);
}

const fuzzyMatch = (a: string, b: string): boolean => {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || (x.length >= 3 && y.includes(x)) || (y.length >= 3 && x.includes(y));
};

export function computePrice(quote: IncentiveInput['quote']): { price: number; tax: number; total: number } {
  const gross = quote.line_items.reduce((s, l) => s + round(num(l.quantity) * num(l.unit_price_cents)), 0);
  let discount = 0;
  if (quote.discount_type === 'percent' && num(quote.discount_value) > 0) {
    discount = round(gross * (clamp(num(quote.discount_value), 0, 100) / 100));
  } else if (quote.discount_type === 'flat' && num(quote.discount_value) > 0) {
    discount = round(num(quote.discount_value) * 100);
  }
  const price = Math.max(0, gross - discount);
  const tax = round((price * clamp(num(quote.tax_percent), 0, 100)) / 100);
  return { price, tax, total: price + tax };
}

// ---------------------------------------------------------------------------
// Program evaluation
// ---------------------------------------------------------------------------

function evaluateProgram(
  p: IncentiveProgram,
  project: IncentiveProject,
  priceCents: number,
  quoteText: string,
  nowIso: string,
): ProgramEvaluation {
  const met: string[] = [];
  const failed: string[] = [];
  const verify: string[] = [];
  const warnings: string[] = [];
  const date = project.effective_date;

  // Funding
  if (p.funding_status === 'exhausted') failed.push('Program funding is exhausted.');
  else if (p.funding_status === 'waitlist') verify.push('Funding is waitlisted: confirm it is open before promising it.');
  else if (p.funding_status === 'unknown') verify.push('Funding status is unknown: confirm it is open.');
  else met.push('Funding is open.');

  // Effective dates
  if (p.effective_start && date < p.effective_start) failed.push(`Not effective until ${p.effective_start}.`);
  else if (p.effective_end && date > p.effective_end) failed.push(`Program ended ${p.effective_end}.`);
  else if (p.effective_start || p.effective_end) {
    met.push(`Active on the project date (${date}).`);
    if (p.effective_end) {
      const left = dayDiff(date, p.effective_end);
      if (Number.isFinite(left) && left <= EXPIRING_SOON_DAYS) warnings.push(`Ends ${p.effective_end} (${left} day${left === 1 ? '' : 's'} after the project date).`);
    }
  }

  // Region
  if (p.country) {
    if (!project.country) verify.push('Project country is unknown.');
    else if (norm(project.country) !== norm(p.country)) failed.push(`Only available in ${p.country}.`);
    else met.push(`Country matches (${p.country}).`);
  }
  if (p.states.length > 0) {
    if (!project.state) verify.push('Project state / region is unknown.');
    else if (!p.states.some((s) => norm(s) === norm(project.state))) failed.push(`Only available in: ${p.states.join(', ')}.`);
    else met.push(`State matches (${project.state}).`);
  }
  if (p.postal_prefixes.length > 0) {
    if (!project.postal_code) verify.push('Project postal code is unknown.');
    else if (!p.postal_prefixes.some((x) => norm(project.postal_code).startsWith(norm(x)))) failed.push('Postal code is outside the program area.');
    else met.push('Postal code is inside the program area.');
  }
  if (p.utility_names.length > 0) {
    if (!project.utility_name) verify.push('Utility provider is unknown.');
    else if (!p.utility_names.some((u) => fuzzyMatch(u, project.utility_name as string))) failed.push(`Only for customers of: ${p.utility_names.join(', ')}.`);
    else met.push(`Utility matches (${project.utility_name}).`);
  }

  // Equipment
  if (p.equipment_types.length > 0) {
    if (project.equipment_type) {
      if (p.equipment_types.some((t) => fuzzyMatch(t, project.equipment_type as string))) met.push(`Equipment type qualifies (${project.equipment_type}).`);
      else failed.push(`Qualifying equipment: ${p.equipment_types.join(', ')}.`);
    } else if (p.equipment_types.some((t) => norm(t).length >= 3 && quoteText.includes(norm(t)))) {
      verify.push('Equipment type was inferred from the quote text: confirm it.');
    } else {
      failed.push('No qualifying equipment found on this quote.');
    }
  }
  if (p.min_efficiency_value !== null) {
    const metric = p.efficiency_metric ?? 'efficiency';
    if (project.efficiency_value === null) verify.push(`Confirm ${metric} is at least ${p.min_efficiency_value}.`);
    else if (p.efficiency_metric && project.efficiency_metric && norm(p.efficiency_metric) !== norm(project.efficiency_metric)) {
      verify.push(`Program uses ${p.efficiency_metric}; the project supplies ${project.efficiency_metric}.`);
    } else if (project.efficiency_value >= p.min_efficiency_value) met.push(`${metric} ${project.efficiency_value} meets the ${p.min_efficiency_value} minimum.`);
    else failed.push(`${metric} ${project.efficiency_value} is below the ${p.min_efficiency_value} minimum.`);
  }

  // Customer
  if (p.customer_kind !== 'any') {
    if (!project.customer_kind) verify.push('Customer type is unknown.');
    else if (project.customer_kind !== p.customer_kind) failed.push(`Only for ${p.customer_kind} customers.`);
    else met.push(`Customer type qualifies (${p.customer_kind}).`);
  }
  if (p.requires_owner_occupied) {
    if (project.owner_occupied === null) verify.push('Confirm the property is owner-occupied.');
    else if (!project.owner_occupied) failed.push('Requires an owner-occupied property.');
    else met.push('Owner-occupied.');
  }
  if (p.requires_income_qualified) {
    if (project.income_qualified === null) verify.push('Confirm the household is income-qualified.');
    else if (!project.income_qualified) failed.push('Requires an income-qualified household.');
    else met.push('Income-qualified.');
  }

  // Property age
  if (p.min_building_age_years !== null || p.max_building_age_years !== null) {
    if (project.building_year_built === null) verify.push('Building age is unknown.');
    else {
      const age = Number(date.slice(0, 4)) - project.building_year_built;
      if (p.min_building_age_years !== null && age < p.min_building_age_years) failed.push(`Building must be at least ${p.min_building_age_years} years old (it is ${age}).`);
      else if (p.max_building_age_years !== null && age > p.max_building_age_years) failed.push(`Building must be at most ${p.max_building_age_years} years old (it is ${age}).`);
      else met.push(`Building age (${age} years) qualifies.`);
    }
  }

  // Project size
  if (p.min_project_cents !== null) {
    if (priceCents < p.min_project_cents) failed.push(`Project must be at least ${usd(p.min_project_cents)}.`);
    else met.push(`Project meets the ${usd(p.min_project_cents)} minimum.`);
  }

  // Catalog freshness
  if (!p.verified_at) verify.push('This program has never been verified in your catalog.');
  else {
    const age = dayDiff(p.verified_at, nowIso);
    if (Number.isFinite(age) && age > STALE_AFTER_DAYS) verify.push(`Program details were last verified ${age} days ago: re-verify.`);
  }

  // Amount
  let amount = 0;
  if (failed.length === 0) {
    if (p.benefit_kind === 'fixed') amount = round(num(p.benefit_value));
    else if (p.benefit_kind === 'per_unit') amount = round(num(p.benefit_value) * Math.max(1, num(project.equipment_units, 1)));
    else {
      let base = priceCents;
      if (p.percent_basis === 'equipment') {
        if (project.equipment_cost_cents !== null) base = Math.min(priceCents, project.equipment_cost_cents);
        else verify.push('Equipment cost not entered: the percentage was applied to the full project price.');
      }
      amount = round((base * clamp(num(p.benefit_value), 0, 100)) / 100);
    }
    if (p.cap_cents !== null) amount = Math.min(amount, p.cap_cents);
    amount = Math.max(0, amount);
  }

  const status: EligibilityStatus = failed.length > 0 ? 'ineligible' : verify.length > 0 ? 'conditional' : 'eligible';
  return {
    program_id: p.id,
    name: p.name,
    program_type: p.program_type,
    administrator: p.administrator,
    delivery: p.delivery,
    status,
    amount_cents: amount,
    counts_confirmed: false,
    counts_potential: false,
    met,
    failed,
    verify,
    warnings,
    stacking_note: null,
    source_url: p.source_url,
  };
}

/** Resolves mutually exclusive programs and sets counts_confirmed / counts_potential. */
function resolveStacking(evals: ProgramEvaluation[], programs: IncentiveProgram[]): void {
  const groupOf = new Map(programs.map((p) => [p.id, p.stack_group ? norm(p.stack_group) : null]));
  const groups = new Map<string, ProgramEvaluation[]>();

  for (const e of evals) {
    if (e.status === 'ineligible') continue;
    const g = groupOf.get(e.program_id) ?? null;
    if (!g) {
      e.counts_potential = true;
      e.counts_confirmed = e.status === 'eligible';
    } else {
      groups.set(g, [...(groups.get(g) ?? []), e]);
    }
  }

  const best = (list: ProgramEvaluation[]): ProgramEvaluation | null =>
    [...list].sort((a, b) => b.amount_cents - a.amount_cents || a.name.localeCompare(b.name))[0] ?? null;

  for (const members of groups.values()) {
    const potentialWinner = best(members);
    const confirmedWinner = best(members.filter((m) => m.status === 'eligible'));
    if (potentialWinner) potentialWinner.counts_potential = true;
    if (confirmedWinner) confirmedWinner.counts_confirmed = true;
    if (members.length > 1 && potentialWinner) {
      for (const m of members) {
        if (m === potentialWinner && m === confirmedWinner) continue;
        if (m === potentialWinner) m.stacking_note = 'Counted as the best option in its group. Only one program in the group can be claimed.';
        else if (m === confirmedWinner) m.stacking_note = `Counted as the confirmed fallback. Mutually exclusive with ${potentialWinner.name}.`;
        else m.stacking_note = `Not counted: mutually exclusive with ${potentialWinner.name}, which pays more.`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Energy impact
// ---------------------------------------------------------------------------

function computeEnergy(project: IncentiveProject, econ: Economics): EnergyImpact {
  const notes: string[] = [];
  let annual: number | null = null;

  if (project.annual_savings_direct_cents !== null && project.annual_savings_direct_cents > 0) {
    annual = round(project.annual_savings_direct_cents);
  } else {
    let sum = 0;
    let any = false;
    if (project.annual_kwh_saved !== null && project.annual_kwh_saved > 0) {
      if (project.electric_rate_cents_per_kwh !== null && project.electric_rate_cents_per_kwh > 0) {
        sum += project.annual_kwh_saved * project.electric_rate_cents_per_kwh;
        any = true;
      } else notes.push('Electric rate is missing, so kWh savings could not be valued.');
    }
    if (project.annual_therms_saved !== null && project.annual_therms_saved > 0) {
      if (project.gas_rate_cents_per_therm !== null && project.gas_rate_cents_per_therm > 0) {
        sum += project.annual_therms_saved * project.gas_rate_cents_per_therm;
        any = true;
      } else notes.push('Gas rate is missing, so therm savings could not be valued.');
    }
    if (any) annual = round(sum);
  }

  if (annual === null || annual <= 0) {
    return {
      known: false,
      annual_savings_cents: null,
      payback_months_best: null,
      payback_months_confirmed: null,
      payback_months_without_incentives: null,
      months_saved_by_incentives: null,
      ten_year_net_benefit_cents: null,
      notes: notes.length > 0 ? notes : ['Add the expected annual energy savings to see payback.'],
    };
  }

  const monthly = annual / 12;
  const months = (cost: number): number => Math.round((cost / monthly) * 10) / 10;
  const best = months(econ.net_cost_best_cents);
  const without = months(econ.total_cents);
  return {
    known: true,
    annual_savings_cents: annual,
    payback_months_best: best,
    payback_months_confirmed: months(econ.net_cost_confirmed_cents),
    payback_months_without_incentives: without,
    months_saved_by_incentives: Math.max(0, Math.round((without - best) * 10) / 10),
    ten_year_net_benefit_cents: annual * 10 - econ.net_cost_best_cents,
    notes: [...notes, 'Payback is simple (undiscounted) and uses the savings you entered.'],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function assessIncentives(input: IncentiveInput): IncentiveReport {
  const { project } = input;
  const { price, tax, total } = computePrice(input.quote);
  if (!(price > 0)) throw new Error('Quote total must be greater than zero to assess incentives.');

  const quoteText = norm(input.quote.line_items.map((l) => l.description).join(' '));
  const evaluations = input.programs.map((p) => evaluateProgram(p, project, price, quoteText, input.now));
  resolveStacking(evaluations, input.programs);

  evaluations.sort((a, b) => {
    const rank = { eligible: 0, conditional: 1, ineligible: 2 } as const;
    return rank[a.status] - rank[b.status] || b.amount_cents - a.amount_cents || a.name.localeCompare(b.name);
  });

  const sum = (f: (e: ProgramEvaluation) => boolean): number => evaluations.filter(f).reduce((s, e) => s + e.amount_cents, 0);
  const confirmedRaw = sum((e) => e.counts_confirmed);
  const potentialRaw = sum((e) => e.counts_potential);
  const confirmed = Math.min(confirmedRaw, total);
  const potential = Math.min(Math.max(potentialRaw, confirmed), total);
  const instantConfirmed = Math.min(sum((e) => e.counts_confirmed && e.delivery === 'instant'), confirmed);

  const byDelivery: Record<Delivery, number> = { instant: 0, mail_in: 0, tax_credit: 0 };
  for (const e of evaluations) if (e.counts_potential) byDelivery[e.delivery] += e.amount_cents;

  const economics: Economics = {
    price_cents: price,
    tax_cents: tax,
    total_cents: total,
    confirmed_cents: confirmed,
    conditional_cents: potential - confirmed,
    potential_cents: potential,
    net_cost_confirmed_cents: total - confirmed,
    net_cost_best_cents: total - potential,
    due_at_signing_cents: total - instantConfirmed,
    delayed_cents: confirmed - instantConfirmed,
    by_delivery_cents: byDelivery,
    capped: potentialRaw > total || confirmedRaw > total,
  };

  const energy = computeEnergy(project, economics);

  // Missing inputs: facts that would make the answer more certain.
  const missing: string[] = [];
  if (!project.country) missing.push('Country');
  if (!project.state) missing.push('State / region');
  if (!project.postal_code) missing.push('Postal code');
  if (!project.utility_name) missing.push('Utility provider');
  if (!project.equipment_type) missing.push('Equipment type');
  if (project.efficiency_value === null) missing.push('Equipment efficiency rating');
  if (project.owner_occupied === null) missing.push('Owner-occupied (yes/no)');
  if (project.income_qualified === null) missing.push('Income-qualified (yes/no)');
  if (project.building_year_built === null) missing.push('Year the building was built');
  if (!energy.known) missing.push('Expected annual energy savings');

  // Action items
  const actions: ActionItem[] = [];
  if (input.programs.length === 0) {
    actions.push({
      severity: 'info',
      title: 'No incentive programs in your catalog yet',
      detail: 'Add the rebates and credits that apply in your service area. The engine only evaluates programs you have entered and verified.',
    });
  }
  for (const e of evaluations) {
    if (e.status === 'ineligible') continue;
    for (const w of e.warnings) actions.push({ severity: 'warning', title: `${e.name}: deadline`, detail: w });
    if (e.status === 'conditional' && e.verify.length > 0) {
      actions.push({ severity: 'warning', title: `Verify before promising ${e.name}`, detail: e.verify.join(' ') });
    }
  }
  if (economics.capped) {
    actions.push({ severity: 'info', title: 'Incentives capped at the project total', detail: 'Stacked incentives exceeded the amount the customer pays, so the total was capped.' });
  }
  if (missing.length > 0 && input.programs.length > 0) {
    actions.push({ severity: 'info', title: 'Improve accuracy', detail: `Adding these would firm up the result: ${missing.join(', ')}.` });
  }
  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  actions.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    engine_version: INCENTIVE_ENGINE_VERSION,
    effective_date: project.effective_date,
    programs_considered: input.programs.length,
    economics,
    energy,
    evaluations,
    action_items: actions,
    missing_inputs: missing,
    disclaimer: DISCLAIMER,
  };
}

/**
 * Pool & spa water chemistry — evaluation, dosing recommendations and trends.
 *
 * Pure functions only (no I/O), fully unit-tested in poolChemistry.test.ts.
 * Builds on the Pool Service pack (poolService.ts) and never duplicates it:
 * pool ranges, `langelierIndex` and `saturation` are reused as-is.
 *
 * How doses are calculated
 *   - Chlorine, stabilizer, calcium and salt: straight mass balance
 *     (1 ppm = 1 mg/L; 1 US gal = 3.785 L) divided by the product strength.
 *   - pH / alkalinity: a carbonate-equilibrium model (closed system, 25 °C,
 *     pK1 6.35, pK2 10.33). Carbonate alkalinity = TA − CYA/3, the same
 *     convention the Langelier index already uses. Acid / base amounts are
 *     solved numerically to land on the target pH. Aeration moves pH back up
 *     over the following hours, so every pH dose asks for a re-test.
 *   - Bromine: status flags and guidance only. Bromine products are not dosed
 *     numerically because their "available bromine" differs by brand.
 *
 * Recommendations are guidance for a trained technician, never a substitute for
 * the product label, the SDS or local health-code rules for public pools.
 */

import {
  CHEM_RANGES,
  langelierIndex,
  saturation,
  type ChemKey,
  type ChemRange,
  type ChemReadings,
  type ChemStatus,
  type Saturation,
} from './poolService';
import type { ProductKind, ProductUnit } from './types';

/* ------------------------------------------------------------------ */
/* Basics                                                               */
/* ------------------------------------------------------------------ */

export type WaterBody = 'pool' | 'spa';
export const WATER_BODY_LABELS: Record<WaterBody, string> = { pool: 'Pool', spa: 'Spa / hot tub' };

export type SanitizerFamily = 'chlorine' | 'salt' | 'bromine';
/** Same wording as the pack's `pool_sanitizer` customer field. */
export const SANITIZER_OPTIONS = [
  'Liquid chlorine',
  'Trichlor tablets',
  'Salt (SWG)',
  'Bromine',
  'Mineral / ozone',
  'Other',
] as const;

export function waterBodyFromLabel(label: unknown): WaterBody | null {
  return label === WATER_BODY_LABELS.spa ? 'spa' : label === WATER_BODY_LABELS.pool ? 'pool' : null;
}

export function sanitizerFamily(label: string | null | undefined): SanitizerFamily {
  if (label === 'Salt (SWG)') return 'salt';
  if (label === 'Bromine') return 'bromine';
  return 'chlorine';
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Three significant digits — enough for a measuring cup, and stable for tests. */
export const roundDose = (n: number) => Number(n.toPrecision(3));

export const L_PER_GAL = 3.785411784;
export const ML_PER_FL_OZ = 29.5735295625;
export const G_PER_OZ = 28.349523125;
/** Doses smaller than this (base unit) are treated as "nothing to add". */
const MIN_DOSE = 0.001;

/* ------------------------------------------------------------------ */
/* Ranges                                                               */
/* ------------------------------------------------------------------ */

export type ChemKeyX = ChemKey | 'br';
export type ChemReadingsX = ChemReadings & { br?: number };

export const POOL_BROMINE: ChemRange = {
  label: 'Bromine',
  unit: 'ppm',
  min: 2,
  max: 4,
  critMin: 1,
  critMax: 10,
};

/** Pool targets = the pack's existing ranges (kept as the single source) + bromine. */
export const POOL_RANGES: Record<ChemKeyX, ChemRange> = { ...CHEM_RANGES, br: POOL_BROMINE };

/** Typical spa / hot-tub targets. Manufacturer and local health-code limits override these. */
export const SPA_RANGES: Record<ChemKeyX, ChemRange> = {
  fc: { label: 'Free chlorine', unit: 'ppm', min: 3, max: 5, critMin: 1, critMax: 10 },
  tc: { label: 'Total chlorine', unit: 'ppm', min: 3, max: 6 },
  br: { label: 'Bromine', unit: 'ppm', min: 4, max: 6, critMin: 2, critMax: 10 },
  ph: { label: 'pH', unit: '', min: 7.2, max: 7.8, critMin: 6.8, critMax: 8.2 },
  ta: { label: 'Total alkalinity', unit: 'ppm', min: 80, max: 120, critMin: 50, critMax: 200 },
  cya: { label: 'Stabilizer (CYA)', unit: 'ppm', min: 0, max: 30, critMax: 100 },
  ch: { label: 'Calcium hardness', unit: 'ppm', min: 150, max: 250, critMin: 100, critMax: 500 },
  salt: { label: 'Salt', unit: 'ppm', min: 1500, max: 3400, critMin: 1000, critMax: 4500 },
};

/** CPSC / industry maximum for spa water. */
export const SPA_MAX_TEMP_F = 104;

export const rangesFor = (body: WaterBody): Record<ChemKeyX, ChemRange> =>
  body === 'spa' ? SPA_RANGES : POOL_RANGES;

export function statusFor(key: ChemKeyX, value: number, body: WaterBody = 'pool'): ChemStatus {
  const r = rangesFor(body)[key];
  if (r.critMin !== undefined && value < r.critMin) return 'critical_low';
  if (r.critMax !== undefined && value > r.critMax) return 'critical_high';
  if (value < r.min) return 'low';
  if (value > r.max) return 'high';
  return 'ok';
}

/** Order readings are shown / entered in. */
export const READING_KEYS: ChemKeyX[] = ['fc', 'tc', 'br', 'ph', 'ta', 'cya', 'ch', 'salt'];

export interface WaterEvaluation {
  statuses: Partial<Record<ChemKeyX, ChemStatus>>;
  flagged: ChemKeyX[];
  /** Total − free chlorine; > 0.4 ppm = chloramines. Null for bromine systems or missing readings. */
  combinedChlorine: number | null;
  lsi: number | null;
  saturation: Saturation | null;
  /** Spa water above 104 °F. */
  heatAlert: boolean;
  overall: 'ok' | 'attention' | 'critical';
}

export function evaluateWater(
  r: ChemReadingsX,
  body: WaterBody = 'pool',
  sanitizer: SanitizerFamily = 'chlorine',
): WaterEvaluation {
  const statuses: Partial<Record<ChemKeyX, ChemStatus>> = {};
  for (const k of READING_KEYS) {
    const v = r[k];
    if (isNum(v)) statuses[k] = statusFor(k, v, body);
  }
  const flagged = (Object.keys(statuses) as ChemKeyX[]).filter((k) => statuses[k] !== 'ok');
  const combinedChlorine =
    sanitizer !== 'bromine' && isNum(r.tc) && isNum(r.fc) ? Math.max(0, round2(r.tc - r.fc)) : null;
  const lsi = langelierIndex(r);
  const sat = lsi === null ? null : saturation(lsi);
  const heatAlert = body === 'spa' && isNum(r.temp_f) && r.temp_f > SPA_MAX_TEMP_F;
  const critical = heatAlert || flagged.some((k) => statuses[k]!.startsWith('critical'));
  const attention =
    flagged.length > 0 ||
    (combinedChlorine !== null && combinedChlorine > 0.4) ||
    (sat !== null && sat !== 'balanced');
  return {
    statuses,
    flagged,
    combinedChlorine,
    lsi,
    saturation: sat,
    heatAlert,
    overall: critical ? 'critical' : attention ? 'attention' : 'ok',
  };
}

/* ------------------------------------------------------------------ */
/* Carbonate model                                                      */
/* ------------------------------------------------------------------ */

const K1 = 10 ** -6.35;
const K2 = 10 ** -10.33;
const KW = 1e-14;
/** mg/L as CaCO3 → equivalents per litre. */
const EQ_PER_PPM = 1 / 50000;

/** Average negative charge per carbonate species at [H+] = h (0 … 2). */
const alpha = (h: number) => (K1 * h + 2 * K1 * K2) / (h * h + K1 * h + K1 * K2);

/** Carbonate alkalinity (ppm as CaCO3): total alkalinity less the stabilizer's share. */
export const carbonateAlkPpm = (ta: number, cya = 0) => Math.max(0, ta - cya / 3);

/** pH of water with carbonate alkalinity `alk` (eq/L) and total carbonate `dic` (mol/L). Monotonic in pH → bisection. */
export function solvePh(alk: number, dic: number): number {
  let lo = 2;
  let hi = 13;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const h = 10 ** -mid;
    const f = dic * alpha(h) + KW / h - h - alk;
    if (f > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** Total carbonate (mol/L) implied by a measured pH and carbonate alkalinity (eq/L). */
export function dicFrom(ph: number, alk: number): number {
  const h = 10 ** -ph;
  return (alk - KW / h + h) / alpha(h);
}

/** Acid (eq/L removed from alkalinity) needed to bring `ph` down to `target`. null if impossible. */
export function acidEqToReachPh(ph: number, alk: number, target: number): number | null {
  if (!(alk > 0) || target >= ph) return null;
  const dic = dicFrom(ph, alk);
  if (!(dic > 0)) return null;
  let lo = 0;
  let hi = alk * 0.999;
  if (solvePh(alk - hi, dic) > target) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (solvePh(alk - mid, dic) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Soda ash (mol/L of Na2CO3: +2 eq alkalinity, +1 mol carbonate) needed to raise `ph` to `target`. */
export function sodaAshMolToReachPh(ph: number, alk: number, target: number): number | null {
  if (!(alk > 0) || target <= ph) return null;
  const dic = dicFrom(ph, alk);
  if (!(dic > 0)) return null;
  let lo = 0;
  let hi = 0.01;
  if (solvePh(alk + 2 * hi, dic + hi) < target) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (solvePh(alk + 2 * mid, dic + mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ------------------------------------------------------------------ */
/* Chemical catalogue                                                   */
/* ------------------------------------------------------------------ */

export type ChemId =
  | 'liquid_chlorine'
  | 'calcium_hypochlorite'
  | 'dichlor'
  | 'trichlor'
  | 'muriatic_acid'
  | 'sodium_bisulfate'
  | 'soda_ash'
  | 'baking_soda'
  | 'cyanuric_acid'
  | 'calcium_chloride'
  | 'pool_salt';

export type DoseRole = 'chlorine' | 'ph_down' | 'ph_up' | 'ta_up' | 'cya_up' | 'ch_up' | 'salt';
export type DoseUnit = 'fl_oz' | 'oz';

export interface ChemDef {
  id: ChemId;
  label: string;
  role: DoseRole;
  form: 'liquid' | 'solid';
  /** Product-register type this chemical belongs to (used to pre-fill the product form). */
  kind: ProductKind;
  defaultStrengthPct: number;
  minStrengthPct: number;
  maxStrengthPct: number;
  /** What the strength figure means, shown beside the input. */
  strengthHelp: string;
}

export const CHEMICALS: Record<ChemId, ChemDef> = {
  liquid_chlorine: {
    id: 'liquid_chlorine',
    label: 'Liquid chlorine (sodium hypochlorite)',
    role: 'chlorine',
    form: 'liquid',
    kind: 'sanitizer',
    defaultStrengthPct: 12.5,
    minStrengthPct: 5,
    maxStrengthPct: 15,
    strengthHelp: '% available chlorine (10 or 12.5 on most jugs)',
  },
  calcium_hypochlorite: {
    id: 'calcium_hypochlorite',
    label: 'Calcium hypochlorite (cal-hypo shock)',
    role: 'chlorine',
    form: 'solid',
    kind: 'sanitizer',
    defaultStrengthPct: 67,
    minStrengthPct: 50,
    maxStrengthPct: 75,
    strengthHelp: '% available chlorine (65–73 typical)',
  },
  dichlor: {
    id: 'dichlor',
    label: 'Dichlor (granular stabilised chlorine)',
    role: 'chlorine',
    form: 'solid',
    kind: 'sanitizer',
    defaultStrengthPct: 56,
    minStrengthPct: 50,
    maxStrengthPct: 65,
    strengthHelp: '% available chlorine (56 or 62 typical)',
  },
  trichlor: {
    id: 'trichlor',
    label: 'Trichlor (tablets / granules)',
    role: 'chlorine',
    form: 'solid',
    kind: 'sanitizer',
    defaultStrengthPct: 90,
    minStrengthPct: 85,
    maxStrengthPct: 95,
    strengthHelp: '% available chlorine (about 90)',
  },
  muriatic_acid: {
    id: 'muriatic_acid',
    label: 'Muriatic acid (hydrochloric)',
    role: 'ph_down',
    form: 'liquid',
    kind: 'ph_adjuster',
    defaultStrengthPct: 31.45,
    minStrengthPct: 10,
    maxStrengthPct: 37,
    strengthHelp: '% HCl (31.45 = 20° Baumé, 14–15 for diluted "pH down")',
  },
  sodium_bisulfate: {
    id: 'sodium_bisulfate',
    label: 'Dry acid (sodium bisulfate)',
    role: 'ph_down',
    form: 'solid',
    kind: 'ph_adjuster',
    defaultStrengthPct: 93.5,
    minStrengthPct: 80,
    maxStrengthPct: 100,
    strengthHelp: '% sodium bisulfate',
  },
  soda_ash: {
    id: 'soda_ash',
    label: 'Soda ash (sodium carbonate)',
    role: 'ph_up',
    form: 'solid',
    kind: 'ph_adjuster',
    defaultStrengthPct: 99,
    minStrengthPct: 90,
    maxStrengthPct: 100,
    strengthHelp: '% sodium carbonate',
  },
  baking_soda: {
    id: 'baking_soda',
    label: 'Baking soda (sodium bicarbonate)',
    role: 'ta_up',
    form: 'solid',
    kind: 'alkalinity',
    defaultStrengthPct: 100,
    minStrengthPct: 90,
    maxStrengthPct: 100,
    strengthHelp: '% sodium bicarbonate',
  },
  cyanuric_acid: {
    id: 'cyanuric_acid',
    label: 'Stabilizer (cyanuric acid)',
    role: 'cya_up',
    form: 'solid',
    kind: 'stabilizer',
    defaultStrengthPct: 100,
    minStrengthPct: 90,
    maxStrengthPct: 100,
    strengthHelp: '% cyanuric acid',
  },
  calcium_chloride: {
    id: 'calcium_chloride',
    label: 'Calcium hardness increaser (calcium chloride)',
    role: 'ch_up',
    form: 'solid',
    kind: 'other',
    defaultStrengthPct: 77,
    minStrengthPct: 70,
    maxStrengthPct: 100,
    strengthHelp: '% calcium chloride (77 flake, 94–100 anhydrous)',
  },
  pool_salt: {
    id: 'pool_salt',
    label: 'Pool salt (sodium chloride)',
    role: 'salt',
    form: 'solid',
    kind: 'salt',
    defaultStrengthPct: 99,
    minStrengthPct: 90,
    maxStrengthPct: 100,
    strengthHelp: '% sodium chloride',
  },
};

export const CHEM_IDS = Object.keys(CHEMICALS) as ChemId[];
export const isChemId = (v: unknown): v is ChemId => typeof v === 'string' && v in CHEMICALS;

export interface ChemChoice {
  chem: ChemId;
  strengthPct: number;
}
export type ChemChoices = Partial<Record<DoseRole, ChemChoice>>;

/** What is assumed when the business has not registered a matching product. */
export const DEFAULT_CHOICES: Record<DoseRole, ChemChoice> = {
  chlorine: { chem: 'liquid_chlorine', strengthPct: 12.5 },
  ph_down: { chem: 'muriatic_acid', strengthPct: 31.45 },
  ph_up: { chem: 'soda_ash', strengthPct: 99 },
  ta_up: { chem: 'baking_soda', strengthPct: 100 },
  cya_up: { chem: 'cyanuric_acid', strengthPct: 100 },
  ch_up: { chem: 'calcium_chloride', strengthPct: 77 },
  salt: { chem: 'pool_salt', strengthPct: 99 },
};

/** A strength inside the chemical's plausible band, else the chemical's default. */
export function sanitizeStrength(chem: ChemId, pct: number | null | undefined): number {
  const d = CHEMICALS[chem];
  return isNum(pct) && pct >= d.minStrengthPct && pct <= d.maxStrengthPct
    ? pct
    : d.defaultStrengthPct;
}

/* ------------------------------------------------------------------ */
/* Dose arithmetic                                                      */
/* ------------------------------------------------------------------ */

/** Grams of a pure substance for `ppm` mg/L in `gallons` of water. */
const gramsFor = (ppm: number, gallons: number) => (ppm * gallons * L_PER_GAL) / 1000;

interface Dose {
  amount: number;
  unit: DoseUnit;
}

function chlorineDose(c: ChemChoice, ppm: number, gallons: number): Dose {
  const grams = gramsFor(ppm, gallons) / (c.strengthPct / 100);
  return CHEMICALS[c.chem].form === 'liquid'
    ? { amount: grams / ML_PER_FL_OZ, unit: 'fl_oz' }
    : { amount: grams / G_PER_OZ, unit: 'oz' };
}

/** Acid or base expressed in equivalents → product amount. */
function acidDose(c: ChemChoice, eqPerL: number, gallons: number): Dose {
  const meq = eqPerL * 1000 * gallons * L_PER_GAL;
  if (c.chem === 'sodium_bisulfate') {
    const meqPerG = ((c.strengthPct / 100) * 1000) / 120.06;
    return { amount: meq / meqPerG / G_PER_OZ, unit: 'oz' };
  }
  // Hydrochloric acid: density ≈ 1 + 0.00509 × % (1.16 g/mL at 31.45 %).
  const density = 1 + 0.00509 * c.strengthPct;
  const meqPerMl = ((c.strengthPct / 100) * density * 1000) / 36.461;
  return { amount: meq / meqPerMl / ML_PER_FL_OZ, unit: 'fl_oz' };
}

const solidGrams = (grams: number, c: ChemChoice): Dose => ({
  amount: grams / (c.strengthPct / 100) / G_PER_OZ,
  unit: 'oz',
});

/** Convert a base dose to the unit a registered product is logged in. Null when the unit can't hold it. */
export function convertDose(amount: number, from: DoseUnit, to: ProductUnit): number | null {
  if (!isNum(amount) || amount < 0) return null;
  if (from === 'fl_oz') {
    switch (to) {
      case 'fl_oz':
        return amount;
      case 'qt':
        return amount / 32;
      case 'gal':
        return amount / 128;
      case 'ml':
        return amount * ML_PER_FL_OZ;
      case 'l':
        return (amount * ML_PER_FL_OZ) / 1000;
      default:
        return null;
    }
  }
  switch (to) {
    case 'oz':
      return amount;
    case 'lb':
      return amount / 16;
    case 'g':
      return amount * G_PER_OZ;
    case 'kg':
      return (amount * G_PER_OZ) / 1000;
    default:
      return null;
  }
}

/** "10.2 fl oz (303 mL)" / "2.4 lb (38.4 oz · 1.09 kg)" — both measuring systems, for a technician on a pool deck. */
export function describeDose(amount: number, unit: DoseUnit): string {
  if (unit === 'fl_oz') {
    const ml = amount * ML_PER_FL_OZ;
    if (amount < 1) return `${Math.max(1, Math.round(ml))} mL`;
    const us = amount >= 128 ? `${roundDose(amount / 128)} gal` : `${roundDose(amount)} fl oz`;
    return `${us} (${ml >= 1000 ? `${roundDose(ml / 1000)} L` : `${Math.round(ml)} mL`})`;
  }
  const g = amount * G_PER_OZ;
  if (amount < 1) return `${Math.max(1, Math.round(g))} g`;
  const us = amount >= 16 ? `${roundDose(amount / 16)} lb` : `${roundDose(amount)} oz`;
  return `${us} (${g >= 1000 ? `${roundDose(g / 1000)} kg` : `${Math.round(g)} g`})`;
}

/* ------------------------------------------------------------------ */
/* Recommendations                                                      */
/* ------------------------------------------------------------------ */

export type StepKind =
  | 'raise_sanitizer'
  | 'shock'
  | 'slam'
  | 'lower_ph'
  | 'raise_ph'
  | 'raise_ta'
  | 'lower_ta'
  | 'raise_cya'
  | 'raise_ch'
  | 'raise_salt'
  | 'dilute'
  | 'info';

/** Exactly the options of the pack's `dosing.target` field. */
export type DosingTarget =
  | 'Raise chlorine'
  | 'Lower pH'
  | 'Raise pH'
  | 'Raise alkalinity'
  | 'Lower alkalinity'
  | 'Raise stabilizer'
  | 'Raise calcium'
  | 'Add salt'
  | 'Shock / oxidize'
  | 'Algae treatment'
  | 'Raise bromine'
  | 'Clarify'
  | 'Other';

export type Severity = 'info' | 'attention' | 'critical';

export interface DoseStep {
  /** Stable key — used for React keys and "already logged" tracking. */
  id: string;
  kind: StepKind;
  /** 1 = add first. Info steps without a chemical get order 0. */
  order: number;
  severity: Severity;
  title: string;
  detail: string;
  role: DoseRole | null;
  choice: ChemChoice | null;
  /** True when no registered product was selected, so a default strength is assumed. */
  assumed: boolean;
  amount: number | null;
  baseUnit: DoseUnit | null;
  logTarget: DosingTarget | null;
  /** Hours of circulation before re-testing this parameter. */
  retestHours: number | null;
  /** Dose was capped for safety — re-test and repeat. */
  partial: boolean;
  /** Share of the water to replace (dilute step only). */
  drainPercent: number | null;
  /** pH expected right after this dose, when the model can tell. */
  expectedPh: number | null;
  notes: string[];
}

export interface DosingInput {
  readings: ChemReadingsX;
  body: WaterBody;
  sanitizer: SanitizerFamily;
  volumeGal: number | null | undefined;
  clarity?: string | null;
}

export const SAFETY_NOTES: readonly string[] = [
  'Add one chemical at a time with the pump running, and never mix chemicals together — especially chlorine with acid.',
  'Always add chemical to water, never water to chemical. Pre-dissolve solids in a clean plastic bucket where the label allows it.',
  'Wear gloves and eye protection and keep swimmers out until levels are back in range.',
  'Doses are guidance only. Follow the product label and SDS; public and commercial pools must also meet local health-code limits.',
];

const TARGET_PH = 7.5;
/** Largest single correction before we split the work across visits. */
const CAPS = {
  taPpm: 20,
  cyaPpm: 30,
  chPpm: 50,
  saltPpm: 1000,
  fcPpm: 20,
  acidTaPpm: 10,
  drainPercent: 33,
};

const LOG_TARGET: Record<Exclude<StepKind, 'dilute' | 'info'>, DosingTarget> = {
  raise_sanitizer: 'Raise chlorine',
  shock: 'Shock / oxidize',
  slam: 'Algae treatment',
  lower_ph: 'Lower pH',
  raise_ph: 'Raise pH',
  raise_ta: 'Raise alkalinity',
  lower_ta: 'Lower alkalinity',
  raise_cya: 'Raise stabilizer',
  raise_ch: 'Raise calcium',
  raise_salt: 'Add salt',
};

/** Free-chlorine level to restore to. Higher stabilizer needs more free chlorine to stay effective. */
export function targetFc(body: WaterBody, cya?: number): number {
  if (body === 'spa') return 4;
  return Math.max(3, round1((isNum(cya) ? cya : 0) * 0.08));
}

/** Free chlorine to hold while clearing algae ("SLAM"): 40 % of CYA, never under 10 ppm. */
export const slamLevel = (cya?: number): number =>
  Math.max(10, round1((isNum(cya) ? cya : 0) * 0.4));

/** Breakpoint chlorination: free chlorine of 10 × the combined chlorine (minimum 5 ppm). */
export const breakpointLevel = (combined: number): number => Math.max(5, round1(combined * 10));

const mid = (r: ChemRange) => (r.min + r.max) / 2;

export function recommendDosing(input: DosingInput, choices: ChemChoices = {}): DoseStep[] {
  const { readings: r, body, sanitizer, clarity } = input;
  const gallons = isNum(input.volumeGal) && input.volumeGal > 0 ? input.volumeGal : null;
  const ranges = rangesFor(body);
  const ev = evaluateWater(r, body, sanitizer);
  const st = ev.statuses;
  const cyaPpm = isNum(r.cya) ? r.cya : 0;
  const steps: DoseStep[] = [];
  let needsVolume = false;
  let slamFirst = false;

  const pick = (role: DoseRole): { choice: ChemChoice; assumed: boolean } => {
    const given = choices[role];
    if (given && CHEMICALS[given.chem]?.role === role)
      return {
        choice: { chem: given.chem, strengthPct: sanitizeStrength(given.chem, given.strengthPct) },
        assumed: false,
      };
    return { choice: DEFAULT_CHOICES[role], assumed: true };
  };

  const phaseOf = new Map<string, number>();
  const add = (
    s: Partial<DoseStep> & Pick<DoseStep, 'id' | 'kind' | 'title' | 'detail'>,
    phase: number,
  ) => {
    steps.push({
      order: 0,
      severity: 'attention',
      role: null,
      choice: null,
      assumed: false,
      amount: null,
      baseUnit: null,
      logTarget: null,
      retestHours: null,
      partial: false,
      drainPercent: null,
      expectedPh: null,
      notes: [],
      ...s,
    });
    phaseOf.set(s.id, phase);
  };

  /** Adds a chemical step when the dose is meaningful; records a missing volume otherwise. */
  const dosed = (
    base: Pick<DoseStep, 'id' | 'kind' | 'title' | 'detail' | 'severity'>,
    role: DoseRole,
    calc: (choice: ChemChoice, gal: number) => Dose | null,
    opts: {
      phase: number;
      retestHours: number;
      partial?: boolean;
      notes?: string[];
      expectedPh?: number | null;
      extraNotes?: (c: ChemChoice, d: Dose) => string[];
    },
  ) => {
    if (gallons === null) {
      needsVolume = true;
      return;
    }
    const { choice, assumed } = pick(role);
    const dose = calc(choice, gallons);
    if (!dose || !(dose.amount >= MIN_DOSE)) return;
    const amount = roundDose(dose.amount);
    add(
      {
        ...base,
        role,
        choice,
        assumed,
        amount,
        baseUnit: dose.unit,
        logTarget: LOG_TARGET[base.kind as Exclude<StepKind, 'dilute' | 'info'>],
        retestHours: opts.retestHours,
        partial: !!opts.partial,
        expectedPh: opts.expectedPh ?? null,
        notes: [...(opts.notes ?? []), ...(opts.extraNotes ? opts.extraNotes(choice, dose) : [])],
      },
      opts.phase,
    );
  };

  const taPpm = isNum(r.ta) ? r.ta : null;
  const phVal = isNum(r.ph) ? r.ph : null;
  const carbEq = taPpm === null ? null : carbonateAlkPpm(taPpm, cyaPpm) * EQ_PER_PPM;
  const phStatus = st.ph;
  const taStatus = st.ta;
  const phCritical = phStatus === 'critical_low' || phStatus === 'critical_high';

  /* ---- heat (spa) ---- */
  if (ev.heatAlert) {
    add(
      {
        id: 'heat',
        kind: 'info',
        severity: 'critical',
        title: `Water is above ${SPA_MAX_TEMP_F} °F (40 °C)`,
        detail:
          'Spa water over 104 °F is unsafe, especially for children, pregnant people and anyone on medication. Lower the set-point and keep people out until it cools.',
      },
      0,
    );
  }

  /* ---- total alkalinity ---- */
  let taStepDone = false; // alkalinity is being corrected, so a non-critical pH waits
  if (taPpm !== null && (taStatus === 'low' || taStatus === 'critical_low')) {
    const full = 100 - taPpm;
    const delta = Math.min(full, CAPS.taPpm);
    if (delta > 0) {
      let expected: number | null = null;
      if (phVal !== null && carbEq !== null && carbEq > 0) {
        const dic = dicFrom(phVal, carbEq);
        if (dic > 0)
          expected = round2(solvePh(carbEq + delta * EQ_PER_PPM, dic + delta * EQ_PER_PPM));
      }
      taStepDone = true;
      dosed(
        {
          id: 'ta_up',
          kind: 'raise_ta',
          severity: taStatus === 'critical_low' ? 'critical' : 'attention',
          title: `Raise total alkalinity by ${round1(delta)} ppm`,
          detail: `Alkalinity is ${taPpm} ppm (target ${ranges.ta.min}–${ranges.ta.max}). Low alkalinity lets pH swing and corrodes surfaces.`,
        },
        'ta_up',
        (c, gal) => solidGrams(gramsFor(delta, gal), c),
        {
          phase: 1,
          retestHours: 4,
          partial: full > delta + 0.01,
          expectedPh: expected,
          notes: [
            'Broadcast across the deep end with the pump running; do not brush for an hour.',
            ...(full > delta + 0.01
              ? [`Capped at ${CAPS.taPpm} ppm per visit — re-test and repeat to reach ~100 ppm.`]
              : []),
          ],
        },
      );
    }
  } else if (taPpm !== null && (taStatus === 'high' || taStatus === 'critical_high')) {
    if (phVal !== null && phVal < ranges.ph.min) {
      add(
        {
          id: 'ta_hold',
          kind: 'info',
          severity: 'attention',
          title: 'Alkalinity is high but pH is already low',
          detail:
            'Do not add acid yet — it would push pH lower. Aerate (water features, returns pointed up) to raise pH first, then lower alkalinity.',
        },
        1,
      );
    } else if (phVal !== null && phVal > ranges.ph.max) {
      // One acid dose fixes both; handled in the pH step below.
      add(
        {
          id: 'ta_note',
          kind: 'info',
          severity: 'info',
          title: 'Alkalinity is high',
          detail: `Alkalinity is ${taPpm} ppm (target ${ranges.ta.min}–${ranges.ta.max}). The acid for pH will bring it down too; re-test alkalinity afterwards.`,
        },
        1,
      );
    } else {
      const full = taPpm - 100;
      const delta = Math.min(full, CAPS.acidTaPpm);
      taStepDone = true;
      let expected: number | null = null;
      if (phVal !== null && carbEq !== null && carbEq > 0) {
        const dic = dicFrom(phVal, carbEq);
        if (dic > 0 && carbEq > delta * EQ_PER_PPM)
          expected = round2(solvePh(carbEq - delta * EQ_PER_PPM, dic));
      }
      dosed(
        {
          id: 'ta_down',
          kind: 'lower_ta',
          severity: taStatus === 'critical_high' ? 'critical' : 'attention',
          title: `Lower total alkalinity by ${round1(delta)} ppm`,
          detail: `Alkalinity is ${taPpm} ppm (target ${ranges.ta.min}–${ranges.ta.max}). High alkalinity drives pH up and causes scale and cloudy water.`,
        },
        'ph_down',
        (c, gal) => acidDose(c, delta * EQ_PER_PPM, gal),
        {
          phase: 1,
          retestHours: 4,
          partial: full > delta + 0.01,
          expectedPh: expected,
          notes: [
            'Pour acid slowly in front of a return jet in the deep end — never into the skimmer.',
            'pH will drop for a while. Aerate to bring it back up, then re-test pH and alkalinity.',
            ...(full > delta + 0.01
              ? [`Capped at ${CAPS.acidTaPpm} ppm per application — repeat after re-testing.`]
              : []),
          ],
        },
      );
    }
  }

  /* ---- pH ---- */
  if (
    phVal !== null &&
    (phStatus === 'low' ||
      phStatus === 'high' ||
      phStatus === 'critical_low' ||
      phStatus === 'critical_high')
  ) {
    const high = phVal > ranges.ph.max;
    if (taStepDone && !phCritical) {
      add(
        {
          id: 'ph_wait',
          kind: 'info',
          severity: 'attention',
          title: 'Re-test pH after alkalinity settles',
          detail:
            'Alkalinity is being corrected first — it changes pH, so a pH dose now would be a guess.',
        },
        2,
      );
    } else if (carbEq === null) {
      add(
        {
          id: 'needs_ta',
          kind: 'info',
          severity: 'attention',
          title: 'Test total alkalinity to calculate a pH dose',
          detail:
            'The pH dose depends on alkalinity (and stabilizer, if used). Enter total alkalinity and re-check.',
        },
        2,
      );
    } else if (carbEq * 50000 < 10) {
      add(
        {
          id: 'ta_too_low',
          kind: 'info',
          severity: 'attention',
          title: 'Alkalinity is too low to dose pH safely',
          detail: 'Raise total alkalinity first, then re-test pH.',
        },
        2,
      );
    } else if (high) {
      const eq = acidEqToReachPh(phVal, carbEq, TARGET_PH);
      dosed(
        {
          id: 'ph_down',
          kind: 'lower_ph',
          severity: phStatus === 'critical_high' ? 'critical' : 'attention',
          title: `Lower pH from ${phVal} to ${TARGET_PH}`,
          detail: `pH is ${phVal} (target ${ranges.ph.min}–${ranges.ph.max}). High pH makes chlorine far less effective and causes scale.`,
        },
        'ph_down',
        (c, gal) => (eq === null ? null : acidDose(c, eq, gal)),
        {
          phase: 2,
          retestHours: 1,
          expectedPh: TARGET_PH,
          notes: [
            'Pour slowly in front of a return jet in the deep end; keep the pump running.',
            'Aeration pushes pH back up over the next hours — re-test before adding more.',
          ],
        },
      );
    } else {
      const mol = sodaAshMolToReachPh(phVal, carbEq, TARGET_PH);
      const taRise = mol === null ? 0 : Math.round(mol * 2 * 50000);
      dosed(
        {
          id: 'ph_up',
          kind: 'raise_ph',
          severity: phStatus === 'critical_low' ? 'critical' : 'attention',
          title: `Raise pH from ${phVal} to ${TARGET_PH}`,
          detail: `pH is ${phVal} (target ${ranges.ph.min}–${ranges.ph.max}). Low pH is corrosive and irritates eyes and skin.`,
        },
        'ph_up',
        (c, gal) => (mol === null ? null : solidGrams(mol * L_PER_GAL * gal * 105.99, c)),
        {
          phase: 2,
          retestHours: 1,
          expectedPh: TARGET_PH,
          notes: [
            'Pre-dissolve in a bucket of pool water and pour across the deep end with the pump running.',
            `Soda ash also raises total alkalinity by about ${taRise} ppm.`,
          ],
        },
      );
    }
  }

  /* ---- stabilizer (pools outdoors) ---- */
  if (isNum(r.cya) && body === 'pool' && sanitizer !== 'bromine' && st.cya === 'low') {
    const full = 40 - r.cya;
    const delta = Math.min(full, CAPS.cyaPpm);
    dosed(
      {
        id: 'cya_up',
        kind: 'raise_cya',
        severity: 'attention',
        title: `Raise stabilizer by ${round1(delta)} ppm`,
        detail: `Stabilizer is ${r.cya} ppm (target ${ranges.cya.min}–${ranges.cya.max}). Without it sunlight burns off chlorine within hours. Skip for indoor pools.`,
      },
      'cya_up',
      (c, gal) => solidGrams(gramsFor(delta, gal), c),
      {
        phase: 3,
        retestHours: 24,
        partial: full > delta + 0.01,
        notes: [
          'Dissolves slowly: put it in a sock in the skimmer basket or pre-dissolve in warm water. Do not backwash for 48 h.',
          ...(full > delta + 0.01 ? [`Capped at ${CAPS.cyaPpm} ppm per visit.`] : []),
        ],
      },
    );
  }

  /* ---- calcium hardness ---- */
  if (isNum(r.ch) && (st.ch === 'low' || st.ch === 'critical_low')) {
    const target = Math.round(mid(ranges.ch) / 10) * 10;
    const full = target - r.ch;
    const delta = Math.min(full, CAPS.chPpm);
    dosed(
      {
        id: 'ch_up',
        kind: 'raise_ch',
        severity: st.ch === 'critical_low' ? 'critical' : 'attention',
        title: `Raise calcium hardness by ${round1(delta)} ppm`,
        detail: `Calcium hardness is ${r.ch} ppm (target ${ranges.ch.min}–${ranges.ch.max}). Soft water pulls calcium out of plaster, grout and heater exchangers.`,
      },
      'ch_up',
      (c, gal) => ({
        amount: (gramsFor(delta, gal) * 110.98) / 100.09 / (c.strengthPct / 100) / G_PER_OZ,
        unit: 'oz',
      }),
      {
        phase: 3,
        retestHours: 8,
        partial: full > delta + 0.01,
        notes: [
          'Add slowly, pre-dissolved — it releases heat and can cloud the water.',
          ...(full > delta + 0.01 ? [`Capped at ${CAPS.chPpm} ppm per visit.`] : []),
        ],
      },
    );
  }

  /* ---- salt (salt-water systems) ---- */
  if (sanitizer === 'salt' && isNum(r.salt) && (st.salt === 'low' || st.salt === 'critical_low')) {
    const target = Math.round(mid(ranges.salt) / 50) * 50;
    const full = target - r.salt;
    const delta = Math.min(full, CAPS.saltPpm);
    dosed(
      {
        id: 'salt_up',
        kind: 'raise_salt',
        severity: st.salt === 'critical_low' ? 'critical' : 'attention',
        title: `Add salt: +${Math.round(delta)} ppm`,
        detail: `Salt is ${r.salt} ppm (cell target ${ranges.salt.min}–${ranges.salt.max}; check the manufacturer's range). Low salt cuts chlorine output and can damage the cell.`,
      },
      'salt',
      (c, gal) => solidGrams(gramsFor(delta, gal), c),
      {
        phase: 3,
        retestHours: 24,
        partial: full > delta + 0.01,
        notes: [
          'Turn the cell off while adding; broadcast and brush until dissolved, then re-test after 24 h of circulation.',
        ],
      },
    );
  }

  /* ---- dilution (too much stabilizer, calcium or salt) ---- */
  {
    const parts: Array<{ label: string; need: number }> = [];
    if (isNum(r.cya) && st.cya && st.cya.endsWith('high'))
      parts.push({ label: 'stabilizer', need: 1 - mid(ranges.cya) / r.cya });
    if (isNum(r.ch) && st.ch && st.ch.endsWith('high'))
      parts.push({ label: 'calcium hardness', need: 1 - mid(ranges.ch) / r.ch });
    if (sanitizer === 'salt' && isNum(r.salt) && st.salt && st.salt.endsWith('high'))
      parts.push({ label: 'salt', need: 1 - mid(ranges.salt) / r.salt });
    const worst = parts.sort((a, b) => b.need - a.need)[0];
    if (worst && worst.need > 0.02) {
      const full = Math.ceil(worst.need * 100);
      const pct = Math.min(full, CAPS.drainPercent);
      add(
        {
          id: 'dilute',
          kind: 'dilute',
          severity: 'attention',
          title: `Replace about ${pct}% of the water`,
          detail: `${parts.map((p) => p.label).join(', ')} can only be lowered by draining and refilling with fresh water.`,
          drainPercent: pct,
          partial: full > pct,
          retestHours: 24,
          notes: [
            ...(gallons
              ? [
                  `About ${Math.round((gallons * pct) / 100).toLocaleString()} gal (${Math.round((gallons * L_PER_GAL * pct) / 100).toLocaleString()} L).`,
                ]
              : []),
            'Check ground-water and local rules before draining an in-ground pool.',
            ...(full > pct ? [`The full correction needs about ${full}% — repeat in stages.`] : []),
          ],
        },
        3,
      );
    }
  }

  /* ---- sanitizer ---- */
  const fc = isNum(r.fc) ? r.fc : null;
  const badClarity = clarity === 'Green' || clarity === 'Black spot / mustard';
  if (sanitizer === 'bromine') {
    if (isNum(r.br) && (st.br === 'low' || st.br === 'critical_low')) {
      add(
        {
          id: 'br_low',
          kind: 'info',
          severity: st.br === 'critical_low' ? 'critical' : 'attention',
          title: 'Raise bromine',
          detail: `Bromine is ${r.br} ppm (target ${ranges.br.min}–${ranges.br.max}). Dose your bromine product by its label — strengths differ by brand, so no amount is calculated. Re-test after an hour.`,
          logTarget: 'Raise bromine',
          retestHours: 1,
        },
        4,
      );
    } else if (isNum(r.br) && (st.br === 'high' || st.br === 'critical_high')) {
      add(
        {
          id: 'br_high',
          kind: 'info',
          severity: st.br === 'critical_high' ? 'critical' : 'attention',
          title: 'Bromine is high',
          detail:
            'Stop feeding bromine and leave the cover off; let it fall below the target maximum before use.',
        },
        4,
      );
    }
    if (badClarity) {
      add(
        {
          id: 'br_algae',
          kind: 'info',
          severity: 'attention',
          title: 'Algae suspected',
          detail:
            'Brush, then shock with the product your label specifies for bromine systems and run the filter continuously. Re-test after 8 hours.',
        },
        4,
      );
    }
  } else {
    const cc = ev.combinedChlorine;
    const slam = badClarity;
    const shock = !slam && cc !== null && cc > 0.4;
    // Free chlorine must also keep up with the stabilizer: below 7.5% of CYA it is mostly bound up.
    const minFc = Math.max(
      ranges.fc.min,
      body === 'pool' && isNum(r.cya) ? round2(r.cya * 0.075) : 0,
    );
    const low =
      !slam && !shock && fc !== null && (st.fc === 'low' || st.fc === 'critical_low' || fc < minFc);
    const target = slam
      ? slamLevel(r.cya)
      : shock
        ? breakpointLevel(cc as number)
        : targetFc(body, r.cya);
    if ((slam || shock || low) && (slam || fc !== null)) {
      const have = fc ?? 0;
      const full = target - have;
      const delta = Math.min(full, CAPS.fcPpm);
      if (delta > 0.05) {
        slamFirst = slam || st.fc === 'critical_low';
        const kind: StepKind = slam ? 'slam' : shock ? 'shock' : 'raise_sanitizer';
        dosed(
          {
            id: slam ? 'slam' : shock ? 'shock' : 'fc_up',
            kind,
            severity: st.fc === 'critical_low' || slam ? 'critical' : 'attention',
            title: slam
              ? `Clear the algae: hold free chlorine at ${target} ppm`
              : shock
                ? `Shock to ${target} ppm free chlorine`
                : `Raise free chlorine to ${target} ppm`,
            detail: slam
              ? `Water is ${String(clarity).toLowerCase()}. Hold free chlorine at ${target} ppm (40% of stabilizer, minimum 10) until it stays there overnight, the water is clear and combined chlorine is under 0.5 ppm. Brush constantly and keep the filter running.`
              : shock
                ? `Combined chlorine is ${cc} ppm (chloramines). Raise free chlorine to 10 × combined (${target} ppm) to break them down.`
                : `Free chlorine is ${have} ppm (target ${ranges.fc.min}–${ranges.fc.max}${minFc > ranges.fc.min ? `; with ${cyaPpm} ppm stabilizer it should stay at or above ${minFc} ppm` : ''}).`,
          },
          'chlorine',
          (c, gal) => chlorineDose(c, delta, gal),
          {
            phase: slamFirst ? 0 : 4,
            retestHours: slam || shock ? 8 : 1,
            partial: full > delta + 0.01,
            notes: [
              ...(fc === null
                ? ['Free chlorine was not entered — this dose assumes none is left.']
                : []),
              ...(full > delta + 0.01
                ? [`Capped at ${CAPS.fcPpm} ppm per addition. Re-test, then add the rest.`]
                : []),
              ...(shock || slam
                ? ['Do not swim until free chlorine is back under 4 ppm (under 5 for spas).']
                : []),
              ...(st.fc === 'critical_low'
                ? [
                    'Free chlorine this low is unsafe: public and commercial pools should follow local closure rules until it is restored.',
                  ]
                : []),
            ],
            extraNotes: (c) => {
              const side: string[] = [];
              if (c.chem === 'calcium_hypochlorite')
                side.push(`Adds about ${round1(0.7 * delta)} ppm calcium hardness.`);
              if (c.chem === 'dichlor')
                side.push(`Adds about ${round1(0.9 * delta)} ppm stabilizer — avoid repeated use.`);
              if (c.chem === 'trichlor')
                side.push(
                  `Adds about ${round1(0.6 * delta)} ppm stabilizer and lowers pH — prefer liquid chlorine or cal-hypo for corrections.`,
                );
              if (c.chem === 'liquid_chlorine') side.push('Liquid chlorine raises pH slightly.');
              return side;
            },
          },
        );
      }
    } else if (st.fc === 'high' || st.fc === 'critical_high') {
      add(
        {
          id: 'fc_high',
          kind: 'info',
          severity: st.fc === 'critical_high' ? 'critical' : 'attention',
          title: 'Free chlorine is high',
          detail: `Free chlorine is ${fc} ppm. Add no chlorine, leave the cover off and keep swimmers out until it falls under ${ranges.fc.max} ppm.`,
        },
        4,
      );
    }
  }

  /* ---- clarity advice that needs no chemical calculation ---- */
  if (clarity === 'Cloudy' && sanitizer !== 'bromine') {
    add(
      {
        id: 'cloudy',
        kind: 'info',
        severity: 'info',
        title: 'Cloudy water',
        detail:
          'Check filter pressure, backwash or clean the filter, confirm free chlorine and pH first, and consider a clarifier per its label.',
      },
      5,
    );
  }

  /* ---- saturation ---- */
  if (ev.saturation && ev.saturation !== 'balanced' && ev.lsi !== null) {
    add(
      {
        id: 'lsi',
        kind: 'info',
        severity: 'info',
        title:
          ev.saturation === 'scaling'
            ? `Scale-forming water (LSI ${ev.lsi})`
            : `Corrosive water (LSI ${ev.lsi})`,
        detail:
          ev.saturation === 'scaling'
            ? 'Lower pH or alkalinity, or reduce calcium, to avoid scale on surfaces and in the heater.'
            : 'Raise pH, alkalinity or calcium hardness to protect plaster, metal and the heater.',
      },
      5,
    );
  }

  if (needsVolume) {
    add(
      {
        id: 'needs_volume',
        kind: 'info',
        severity: 'attention',
        title: 'Enter the water volume to calculate amounts',
        detail: 'Doses scale with the number of gallons (or litres) in the pool or spa.',
      },
      5,
    );
  }

  // Chemical steps first (in the order to add them), advisories after.
  const sorted = [...steps].sort((a, b) => (phaseOf.get(a.id) ?? 9) - (phaseOf.get(b.id) ?? 9));
  let n = 0;
  return sorted.map((s) => (s.amount !== null || s.kind === 'dilute' ? { ...s, order: ++n } : s));
}

/* ------------------------------------------------------------------ */
/* Products                                                             */
/* ------------------------------------------------------------------ */

/** The slice of a register product the engine needs. */
export interface ChemProductLike {
  id: string;
  name: string;
  unit: ProductUnit;
  chem_key?: string | null;
  strength_pct?: number | null;
  archived_at?: string | null;
}

export interface RoleProduct<P extends ChemProductLike = ChemProductLike> {
  product: P;
  choice: ChemChoice;
}

/** Register products able to fill a role (right chemical, not archived). */
export function productsForRole<P extends ChemProductLike>(
  role: DoseRole,
  products: P[],
): Array<RoleProduct<P>> {
  const out: Array<RoleProduct<P>> = [];
  for (const product of products) {
    if (
      product.archived_at ||
      !isChemId(product.chem_key) ||
      CHEMICALS[product.chem_key].role !== role
    )
      continue;
    out.push({
      product,
      choice: {
        chem: product.chem_key,
        strengthPct: sanitizeStrength(product.chem_key, product.strength_pct),
      },
    });
  }
  return out;
}

/** Amount of a step expressed in the product's own logging unit, or null when the unit can't hold it. */
export function doseForProduct(
  step: Pick<DoseStep, 'amount' | 'baseUnit'>,
  product: Pick<ChemProductLike, 'unit'>,
): number | null {
  if (step.amount === null || step.baseUnit === null) return null;
  const v = convertDose(step.amount, step.baseUnit, product.unit);
  return v === null || !(v > 0) ? null : roundDose(v);
}

/** The `data` object for a `dosing` log entry made from a recommendation. */
export function dosingEntryData(
  step: DoseStep,
  product: Pick<ChemProductLike, 'unit'>,
): Record<string, unknown> | null {
  const amount = doseForProduct(step, product);
  if (amount === null || !step.logTarget) return null;
  return { amount, amount_unit: product.unit, target: step.logTarget, from_recommendation: true };
}

/* ------------------------------------------------------------------ */
/* History + trends                                                     */
/* ------------------------------------------------------------------ */

export interface LogRowLike {
  entry_type: string;
  performed_at: string;
  data: Record<string, unknown>;
  voided_at?: string | null;
}

/** Non-voided chemistry readings, oldest first. */
export function readingHistory<R extends LogRowLike>(rows: R[]): R[] {
  return rows
    .filter((e) => e.entry_type === 'chemistry_reading' && !e.voided_at)
    .sort((a, b) => Date.parse(a.performed_at) - Date.parse(b.performed_at));
}

export interface SeriesPoint {
  at: string;
  value: number;
}

export function seriesFor(rows: LogRowLike[], key: ChemKeyX | 'temp_f'): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const e of readingHistory(rows)) {
    const v = e.data[key];
    if (isNum(v)) out.push({ at: e.performed_at, value: v });
  }
  return out;
}

/** Direction of the latest value against the average of the earlier ones (`null` with fewer than 2 points). */
export function trendDirection(values: number[], tolerance = 0): 'up' | 'down' | 'flat' | null {
  if (values.length < 2) return null;
  const last = values[values.length - 1];
  const prev = values.slice(0, -1);
  const avg = prev.reduce((s, v) => s + v, 0) / prev.length;
  return last - avg > tolerance ? 'up' : avg - last > tolerance ? 'down' : 'flat';
}

export interface ReadingDefaults {
  body?: WaterBody;
  volumeGal?: number;
  sanitizer?: string;
}

/** Carry the pool's profile over from the most recent reading that recorded it. */
export function defaultsFromHistory(rows: LogRowLike[]): ReadingDefaults {
  const out: ReadingDefaults = {};
  for (const e of [...readingHistory(rows)].reverse()) {
    const body = waterBodyFromLabel(e.data.water_body);
    if (out.body === undefined && body) out.body = body;
    if (out.volumeGal === undefined && isNum(e.data.volume_gal) && e.data.volume_gal > 0)
      out.volumeGal = e.data.volume_gal;
    if (out.sanitizer === undefined && typeof e.data.sanitizer === 'string')
      out.sanitizer = e.data.sanitizer;
  }
  return out;
}

export interface Sparkline {
  path: string;
  last: { x: number; y: number } | null;
  /** Target band in SVG coordinates, when a range was given. */
  band: { y1: number; y2: number } | null;
}

/** SVG path for a small trend chart. The y-domain always includes the target band. */
export function sparkline(
  values: number[],
  width: number,
  height: number,
  band?: { min: number; max: number },
  pad = 3,
): Sparkline {
  if (values.length === 0) return { path: '', last: null, band: null };
  const lo0 = Math.min(...values, band ? band.min : Infinity);
  const hi0 = Math.max(...values, band ? band.max : -Infinity);
  const span = hi0 - lo0 || 1;
  const lo = lo0 - span * 0.1;
  const hi = hi0 + span * 0.1;
  const x = (i: number) =>
    values.length === 1 ? width / 2 : pad + (i * (width - pad * 2)) / (values.length - 1);
  const y = (v: number) => pad + ((hi - v) / (hi - lo)) * (height - pad * 2);
  const pts = values.map((v, i) => ({ x: round1(x(i)), y: round1(y(v)) }));
  return {
    path: pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' '),
    last: pts[pts.length - 1],
    band: band ? { y1: round1(y(band.max)), y2: round1(y(band.min)) } : null,
  };
}

/* ------------------------------------------------------------------ */
/* Entry data                                                           */
/* ------------------------------------------------------------------ */

export interface ReadingForm {
  body: WaterBody;
  sanitizer: string;
  volumeGal: number | null;
  readings: Partial<Record<ChemKeyX | 'temp_f' | 'filter_psi', number>>;
  clarity?: string | null;
}

/** The `data` object for a `chemistry_reading` log entry (blank values dropped; the server re-validates). */
export function readingEntryData(f: ReadingForm): Record<string, unknown> {
  const data: Record<string, unknown> = {
    water_body: WATER_BODY_LABELS[f.body],
    sanitizer: f.sanitizer,
  };
  if (isNum(f.volumeGal) && f.volumeGal > 0) data.volume_gal = Math.round(f.volumeGal);
  for (const [k, v] of Object.entries(f.readings)) if (isNum(v)) data[k] = v;
  if (f.clarity) data.clarity = f.clarity;
  return data;
}

/** Record types the dedicated water-chemistry panel handles (the generic ledger form hides them for the pool pack). */
export const POOL_CHEMISTRY_LOG_TYPES: readonly string[] = ['chemistry_reading', 'dosing'];

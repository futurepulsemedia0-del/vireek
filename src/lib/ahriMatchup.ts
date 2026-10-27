/**
 * AHRI equipment matchups: catalog types, CSV import, and Manual S-style sizing.
 *
 * The catalog is the contractor's OWN list of AHRI-certified combinations
 * (copied from the AHRI Directory certificate). Vireek never invents AHRI data:
 * every row is "unverified" until a person confirms it against the directory.
 * Pure functions only. No I/O.
 */

import type { LoadResult } from '@/lib/hvacSizing';

// ============================================================
// TYPES — mirror 20271215000000_hvac_sizing_matchups.sql
// ============================================================

export type SystemType = 'split_ac' | 'split_hp' | 'packaged_ac' | 'packaged_hp' | 'ac_furnace';
export type Staging = 'single' | 'two_stage' | 'variable';
export type AhriStatus = 'unverified' | 'verified';
export type DoeRegion = 'north' | 'south' | 'southwest';

export const SYSTEM_TYPES: SystemType[] = ['split_ac', 'split_hp', 'packaged_ac', 'packaged_hp', 'ac_furnace'];
export const STAGINGS: Staging[] = ['single', 'two_stage', 'variable'];

export const SYSTEM_TYPE_LABELS: Record<SystemType, string> = {
  split_ac: 'Split air conditioner',
  split_hp: 'Split heat pump',
  packaged_ac: 'Packaged air conditioner',
  packaged_hp: 'Packaged heat pump',
  ac_furnace: 'AC + furnace',
};
export const STAGING_LABELS: Record<Staging, string> = {
  single: 'Single-stage',
  two_stage: 'Two-stage',
  variable: 'Variable-speed',
};
export const REGION_LABELS: Record<DoeRegion, string> = {
  north: 'North',
  south: 'South',
  southwest: 'Southwest',
};

export interface AhriMatchup {
  id: string;
  ahri_ref_number: string;
  manufacturer: string;
  brand: string | null;
  system_type: SystemType;
  staging: Staging;
  outdoor_model: string;
  indoor_model: string | null;
  furnace_model: string | null;
  cooling_btuh: number;
  seer2: number;
  eer2: number | null;
  hspf2: number | null;
  heating_47_btuh: number | null;
  heating_17_btuh: number | null;
  furnace_output_btuh: number | null;
  shr: number | null;
  airflow_cfm: number | null;
  refrigerant: string | null;
  sell_price_cents: number | null;
  ahri_status: AhriStatus;
  verified_at: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** The writable subset sent to hvac_upsert_matchups(). */
export type MatchupInput = Pick<
  AhriMatchup,
  | 'ahri_ref_number' | 'manufacturer' | 'brand' | 'system_type' | 'staging' | 'outdoor_model' | 'indoor_model'
  | 'furnace_model' | 'cooling_btuh' | 'seer2' | 'eer2' | 'hspf2' | 'heating_47_btuh' | 'heating_17_btuh'
  | 'furnace_output_btuh' | 'shr' | 'airflow_cfm' | 'refrigerant' | 'sell_price_cents' | 'notes'
>;

// ============================================================
// CONSTANTS (named so they can be reviewed in one place)
// ============================================================

/** Rated cooling capacity is at AHRI A conditions (95 degF outdoor). */
export const RATING_OUTDOOR_F = 95;
/** Approximate loss of cooling capacity per degF above the rating point. Use manufacturer expanded data for final sign-off. */
export const CAPACITY_DERATE_PER_F = 0.006;
export const ASSUMED_SHR = 0.75;
export const IDEAL_COOLING_RATIO = { min: 0.95, max: 1.1 } as const;
/** ACCA Manual S-style limits on total cooling capacity as a fraction of the load, by compressor staging. */
export const COOLING_RATIO_LIMITS: Record<Staging, { min: number; max: number }> = {
  single: { min: 0.9, max: 1.15 },
  two_stage: { min: 0.9, max: 1.2 },
  variable: { min: 0.9, max: 1.3 },
};
export const FURNACE_RATIO_LIMITS = { min: 1.0, max: 1.4 } as const;
export const BTUH_PER_KW = 3412;

export interface RegionalMinimum {
  seer2: number;
  eer2: number | null;
  hspf2: number | null;
}

/**
 * U.S. DOE minimums effective 2023 (reference data: confirm the current federal
 * and state rules before relying on it for a sale).
 */
export function regionalMinimums(type: SystemType, region: DoeRegion, coolingBtuh: number): RegionalMinimum {
  const small = coolingBtuh < 45000;
  switch (type) {
    case 'split_hp':
      return { seer2: 14.3, eer2: null, hspf2: 7.5 };
    case 'packaged_hp':
      return { seer2: 13.4, eer2: null, hspf2: 6.7 };
    case 'packaged_ac':
      return { seer2: 13.4, eer2: region === 'southwest' ? 10.6 : null, hspf2: null };
    case 'split_ac':
    case 'ac_furnace':
    default: {
      if (region === 'north') return { seer2: 13.4, eer2: null, hspf2: null };
      return {
        seer2: small ? 14.3 : 13.8,
        eer2: region === 'southwest' ? (small ? 11.7 : 11.2) : null,
        hspf2: null,
      };
    }
  }
}

// ============================================================
// EVALUATION (Manual S-style)
// ============================================================

export type CoolingStatus = 'ideal' | 'acceptable' | 'undersized' | 'oversized';
export type HeatingStatus = 'ok' | 'needs_backup' | 'undersized' | 'oversized' | 'unknown' | 'not_applicable';

export interface MatchupContext {
  load: Pick<LoadResult, 'cooling' | 'heating'>;
  outdoorSummerDb: number;
  outdoorWinterDb: number;
  region: DoeRegion;
}

export interface MatchupFit {
  matchup: AhriMatchup;
  capacityAtDesignBtuh: number;
  coolingRatio: number;
  coolingStatus: CoolingStatus;
  sensibleCapacityBtuh: number;
  sensibleOk: boolean;
  latentOk: boolean;
  heating: {
    kind: 'heat_pump' | 'furnace' | 'none';
    capacityAtDesignBtuh: number | null;
    ratio: number | null;
    status: HeatingStatus;
    backupBtuh: number;
    backupKw: number;
  };
  efficiency: {
    required: RegionalMinimum;
    meetsSeer2: boolean;
    meetsEer2: boolean | null;
    meetsHspf2: boolean | null;
    meets: boolean;
  };
  verified: boolean;
  passes: boolean;
  score: number;
  issues: string[];
}

/** Cooling capacity at the design outdoor temperature (never above the rated value). */
export function coolingCapacityAtDesign(ratedBtuh: number, outdoorSummerDb: number): number {
  const delta = Math.max(0, outdoorSummerDb - RATING_OUTDOOR_F);
  return ratedBtuh * Math.max(0.5, 1 - CAPACITY_DERATE_PER_F * delta);
}

/** Heat-pump heating capacity at an outdoor temperature, interpolated / extrapolated from the 47 and 17 degF ratings. */
export function heatPumpCapacityAt(cap47: number, cap17: number, outdoorF: number): number {
  const slope = (cap47 - cap17) / 30;
  return Math.max(0, cap17 + slope * (outdoorF - 17));
}

export function tonsOf(btuh: number): number {
  return Math.round((btuh / 12000) * 10) / 10;
}

function classifyCooling(ratio: number, staging: Staging): CoolingStatus {
  const limit = COOLING_RATIO_LIMITS[staging];
  if (ratio < limit.min) return 'undersized';
  if (ratio > limit.max) return 'oversized';
  return ratio >= IDEAL_COOLING_RATIO.min && ratio <= IDEAL_COOLING_RATIO.max ? 'ideal' : 'acceptable';
}

export function evaluateMatchup(m: AhriMatchup, ctx: MatchupContext): MatchupFit {
  const issues: string[] = [];
  const coolingLoad = ctx.load.cooling.totalBtuh;
  const sensibleLoad = ctx.load.cooling.sensibleBtuh;
  const latentLoad = ctx.load.cooling.latentBtuh;
  const heatingLoad = ctx.load.heating.totalBtuh;

  // ----- cooling -----
  const capacityAtDesign = coolingCapacityAtDesign(m.cooling_btuh, ctx.outdoorSummerDb);
  const ratio = coolingLoad > 0 ? capacityAtDesign / coolingLoad : 0;
  const coolingStatus = classifyCooling(ratio, m.staging);
  const shr = m.shr ?? ASSUMED_SHR;
  if (m.shr === null) issues.push(`Sensible heat ratio not on file, so ${ASSUMED_SHR} was assumed.`);
  const sensibleCapacity = capacityAtDesign * shr;
  const sensibleOk = sensibleCapacity >= sensibleLoad * 0.95;
  const latentOk = capacityAtDesign - sensibleCapacity >= latentLoad * 0.9;
  if (!sensibleOk) issues.push('Sensible cooling capacity at the design temperature is below the sensible load.');
  if (!latentOk) issues.push('Latent capacity looks short, so humidity control may be weak in this climate.');
  if (coolingStatus === 'undersized') issues.push('Cooling capacity at the design temperature is below the Manual S range.');
  if (coolingStatus === 'oversized') issues.push('Cooling capacity is above the Manual S range, which risks short cycling and poor humidity control.');

  // ----- heating -----
  const isHp = m.system_type === 'split_hp' || m.system_type === 'packaged_hp';
  const isFurnace = m.system_type === 'ac_furnace';
  const heating: MatchupFit['heating'] = {
    kind: isHp ? 'heat_pump' : isFurnace ? 'furnace' : 'none',
    capacityAtDesignBtuh: null,
    ratio: null,
    status: 'not_applicable',
    backupBtuh: 0,
    backupKw: 0,
  };
  if (isHp) {
    if (m.heating_47_btuh === null || m.heating_17_btuh === null) {
      heating.status = 'unknown';
      issues.push('Add the 47 degF and 17 degF heating capacities to check heating.');
    } else {
      const cap = heatPumpCapacityAt(m.heating_47_btuh, m.heating_17_btuh, ctx.outdoorWinterDb);
      heating.capacityAtDesignBtuh = Math.round(cap);
      heating.ratio = heatingLoad > 0 ? Math.round((cap / heatingLoad) * 100) / 100 : null;
      if (heatingLoad > 0 && cap < heatingLoad) {
        heating.status = 'needs_backup';
        heating.backupBtuh = Math.round(heatingLoad - cap);
        heating.backupKw = Math.round(((heatingLoad - cap) / BTUH_PER_KW) * 10) / 10;
        issues.push(`Heat pump covers ${Math.round((cap / heatingLoad) * 100)}% of the design heating load, so plan for about ${heating.backupKw} kW of backup heat.`);
      } else {
        heating.status = 'ok';
      }
    }
  } else if (isFurnace) {
    if (m.furnace_output_btuh === null) {
      heating.status = 'unknown';
      issues.push('Add the furnace output to check heating.');
    } else {
      heating.capacityAtDesignBtuh = m.furnace_output_btuh;
      const r = heatingLoad > 0 ? m.furnace_output_btuh / heatingLoad : null;
      heating.ratio = r === null ? null : Math.round(r * 100) / 100;
      if (r !== null && r < FURNACE_RATIO_LIMITS.min) {
        heating.status = 'undersized';
        issues.push('Furnace output is below the design heating load.');
      } else if (r !== null && r > FURNACE_RATIO_LIMITS.max) {
        heating.status = 'oversized';
        issues.push('Furnace output is above 140% of the design heating load.');
      } else {
        heating.status = 'ok';
      }
    }
  }

  // ----- efficiency -----
  const required = regionalMinimums(m.system_type, ctx.region, m.cooling_btuh);
  const meetsSeer2 = m.seer2 >= required.seer2;
  const meetsEer2 = required.eer2 === null ? null : m.eer2 === null ? null : m.eer2 >= required.eer2;
  const meetsHspf2 = required.hspf2 === null ? null : m.hspf2 === null ? null : m.hspf2 >= required.hspf2;
  if (!meetsSeer2) issues.push(`SEER2 ${m.seer2} is below the ${required.seer2} minimum for this region.`);
  if (required.eer2 !== null && m.eer2 === null) issues.push(`Add the EER2 to confirm the ${required.eer2} Southwest minimum.`);
  if (meetsEer2 === false) issues.push(`EER2 ${m.eer2} is below the ${required.eer2} Southwest minimum.`);
  if (meetsHspf2 === false) issues.push(`HSPF2 ${m.hspf2} is below the ${required.hspf2} minimum.`);
  const meets = meetsSeer2 && meetsEer2 !== false && meetsHspf2 !== false;

  const verified = m.ahri_status === 'verified';
  if (!verified) issues.push('Not yet verified against the AHRI Directory.');

  const passes =
    (coolingStatus === 'ideal' || coolingStatus === 'acceptable') &&
    sensibleOk &&
    meets &&
    heating.status !== 'undersized';

  // ----- score (0-100) -----
  let score = 100 - Math.abs(ratio - 1.05) * 120;
  if (coolingStatus === 'undersized') score -= 60;
  if (coolingStatus === 'oversized') score -= 25;
  if (!sensibleOk) score -= 20;
  if (!latentOk) score -= 5;
  if (!meets) score -= 40;
  score += Math.min(12, Math.max(0, (m.seer2 - required.seer2) * 1.5));
  if (verified) score += 6;
  if (heating.status === 'needs_backup' && heatingLoad > 0) score -= Math.min(20, (heating.backupBtuh / heatingLoad) * 20);
  if (heating.status === 'undersized') score -= 40;
  if (heating.status === 'oversized') score -= 8;
  if (heating.status === 'unknown') score -= 5;

  return {
    matchup: m,
    capacityAtDesignBtuh: Math.round(capacityAtDesign),
    coolingRatio: Math.round(ratio * 100) / 100,
    coolingStatus,
    sensibleCapacityBtuh: Math.round(sensibleCapacity),
    sensibleOk,
    latentOk,
    heating,
    efficiency: { required, meetsSeer2, meetsEer2, meetsHspf2, meets },
    verified,
    passes,
    score: Math.max(0, Math.min(100, Math.round(score))),
    issues,
  };
}

/** Active matchups only: passing first, then score, then price (unknown last), then SEER2. */
export function rankMatchups(matchups: AhriMatchup[], ctx: MatchupContext): MatchupFit[] {
  return matchups
    .filter((m) => m.active)
    .map((m) => evaluateMatchup(m, ctx))
    .sort((a, b) => {
      if (a.passes !== b.passes) return a.passes ? -1 : 1;
      if (a.score !== b.score) return b.score - a.score;
      const pa = a.matchup.sell_price_cents ?? Number.POSITIVE_INFINITY;
      const pb = b.matchup.sell_price_cents ?? Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      if (a.matchup.seer2 !== b.matchup.seer2) return b.matchup.seer2 - a.matchup.seer2;
      return a.matchup.ahri_ref_number.localeCompare(b.matchup.ahri_ref_number);
    });
}

// ============================================================
// ROW VALIDATION (client mirror of the table CHECKs)
// ============================================================

export type RowResult = { ok: true; row: MatchupInput } | { ok: false; reason: string };

const REF_RE = /^[A-Za-z0-9-]{1,20}$/;

function text(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '') return null;
  return s.length > max ? s.slice(0, max) : s;
}

function numOrNull(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined; // undefined = present but not a number
}

export function normalizeSystemType(v: unknown): SystemType | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/[^a-z]+/g, '');
  if (['splitac', 'ac', 'airconditioner', 'splitairconditioner', 'cooling'].includes(s)) return 'split_ac';
  if (['splithp', 'hp', 'heatpump', 'splitheatpump'].includes(s)) return 'split_hp';
  if (['packagedac', 'packageac', 'packagedairconditioner', 'rooftopac'].includes(s)) return 'packaged_ac';
  if (['packagedhp', 'packagehp', 'packagedheatpump'].includes(s)) return 'packaged_hp';
  if (['acfurnace', 'acandfurnace', 'furnaceac', 'gasfurnace', 'splitacfurnace'].includes(s)) return 'ac_furnace';
  return null;
}

export function normalizeStaging(v: unknown): Staging | null {
  const s = String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (s === '' || ['single', 'singlestage', '1', '1stage', 'onestage'].includes(s)) return 'single';
  if (['two', 'twostage', '2', '2stage', 'dualstage'].includes(s)) return 'two_stage';
  if (['variable', 'variablespeed', 'inverter', 'modulating', 'vs', 'multistage'].includes(s)) return 'variable';
  return null;
}

/** Validates one raw record (CSV row or form) into a MatchupInput. */
export function parseMatchupRecord(raw: Record<string, unknown>): RowResult {
  const ref = text(raw.ahri_ref_number, 20);
  if (!ref || !REF_RE.test(ref)) return { ok: false, reason: 'AHRI reference number is missing or has invalid characters.' };
  const manufacturer = text(raw.manufacturer, 80);
  if (!manufacturer) return { ok: false, reason: 'Manufacturer is required.' };
  const outdoor = text(raw.outdoor_model, 80);
  if (!outdoor) return { ok: false, reason: 'Outdoor model is required.' };
  const type = normalizeSystemType(raw.system_type);
  if (!type) return { ok: false, reason: 'System type is not recognised (use split_ac, split_hp, packaged_ac, packaged_hp or ac_furnace).' };
  const staging = normalizeStaging(raw.staging);
  if (!staging) return { ok: false, reason: 'Staging is not recognised (use single, two_stage or variable).' };

  const fields = {
    cooling_btuh: numOrNull(raw.cooling_btuh),
    seer2: numOrNull(raw.seer2),
    eer2: numOrNull(raw.eer2),
    hspf2: numOrNull(raw.hspf2),
    heating_47_btuh: numOrNull(raw.heating_47_btuh),
    heating_17_btuh: numOrNull(raw.heating_17_btuh),
    furnace_output_btuh: numOrNull(raw.furnace_output_btuh),
    shr: numOrNull(raw.shr),
    airflow_cfm: numOrNull(raw.airflow_cfm),
    sell_price_cents: numOrNull(raw.sell_price_cents),
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) return { ok: false, reason: `${k} is not a number.` };
  }
  const f = fields as Record<keyof typeof fields, number | null>;

  if (f.cooling_btuh === null || f.cooling_btuh < 6000 || f.cooling_btuh > 120000) {
    return { ok: false, reason: 'Cooling capacity must be between 6,000 and 120,000 Btu/h.' };
  }
  if (f.seer2 === null || f.seer2 < 8 || f.seer2 > 40) return { ok: false, reason: 'SEER2 must be between 8 and 40.' };
  if (f.eer2 !== null && (f.eer2 < 5 || f.eer2 > 30)) return { ok: false, reason: 'EER2 must be between 5 and 30.' };
  if ((type === 'split_hp' || type === 'packaged_hp') && (f.hspf2 === null || f.hspf2 < 4 || f.hspf2 > 15)) {
    return { ok: false, reason: 'Heat pumps need an HSPF2 between 4 and 15.' };
  }
  if (f.hspf2 !== null && (f.hspf2 < 4 || f.hspf2 > 15)) return { ok: false, reason: 'HSPF2 must be between 4 and 15.' };
  for (const k of ['heating_47_btuh', 'heating_17_btuh', 'furnace_output_btuh'] as const) {
    const v = f[k];
    if (v !== null && (v < 3000 || v > 200000)) return { ok: false, reason: `${k} must be between 3,000 and 200,000 Btu/h.` };
  }
  if (f.shr !== null && (f.shr < 0.5 || f.shr > 1)) return { ok: false, reason: 'Sensible heat ratio must be between 0.50 and 1.00.' };
  if (f.airflow_cfm !== null && (f.airflow_cfm < 200 || f.airflow_cfm > 6000)) return { ok: false, reason: 'Airflow must be between 200 and 6,000 cfm.' };
  if (f.sell_price_cents !== null && (f.sell_price_cents < 0 || f.sell_price_cents > 100000000)) {
    return { ok: false, reason: 'Sell price is out of range.' };
  }

  return {
    ok: true,
    row: {
      ahri_ref_number: ref,
      manufacturer,
      brand: text(raw.brand, 80),
      system_type: type,
      staging,
      outdoor_model: outdoor,
      indoor_model: text(raw.indoor_model, 80),
      furnace_model: text(raw.furnace_model, 80),
      cooling_btuh: Math.round(f.cooling_btuh),
      seer2: f.seer2,
      eer2: f.eer2,
      hspf2: f.hspf2,
      heating_47_btuh: f.heating_47_btuh === null ? null : Math.round(f.heating_47_btuh),
      heating_17_btuh: f.heating_17_btuh === null ? null : Math.round(f.heating_17_btuh),
      furnace_output_btuh: f.furnace_output_btuh === null ? null : Math.round(f.furnace_output_btuh),
      shr: f.shr,
      airflow_cfm: f.airflow_cfm === null ? null : Math.round(f.airflow_cfm),
      refrigerant: text(raw.refrigerant, 20),
      sell_price_cents: f.sell_price_cents === null ? null : Math.round(f.sell_price_cents),
      notes: text(raw.notes, 500),
    },
  };
}

// ============================================================
// CSV IMPORT
// ============================================================

export const MAX_IMPORT_ROWS = 500;

/** RFC 4180-style parser: quoted fields, escaped quotes, CRLF, BOM. */
export function parseCsv(input: string): string[][] {
  const src = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',' || c === '\t') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

const HEADER_ALIASES: Record<string, string> = {
  ahrirefnumber: 'ahri_ref_number', ahrinumber: 'ahri_ref_number', ahriref: 'ahri_ref_number', ahri: 'ahri_ref_number',
  ahricertifiedreferencenumber: 'ahri_ref_number', certificatenumber: 'ahri_ref_number', referencenumber: 'ahri_ref_number',
  manufacturer: 'manufacturer', mfr: 'manufacturer', brand: 'brand',
  systemtype: 'system_type', type: 'system_type',
  staging: 'staging', stages: 'staging', compressor: 'staging',
  outdoormodel: 'outdoor_model', outdoorunit: 'outdoor_model', condenser: 'outdoor_model', condensermodel: 'outdoor_model', outdoor: 'outdoor_model',
  indoormodel: 'indoor_model', indoorunit: 'indoor_model', coil: 'indoor_model', coilmodel: 'indoor_model', airhandler: 'indoor_model', indoor: 'indoor_model',
  furnacemodel: 'furnace_model', furnace: 'furnace_model',
  coolingbtuh: 'cooling_btuh', coolingcapacity: 'cooling_btuh', coolingcapacitybtuh: 'cooling_btuh', capacity: 'cooling_btuh', btuh: 'cooling_btuh',
  tons: 'tons', tonnage: 'tons',
  seer2: 'seer2', eer2: 'eer2', hspf2: 'hspf2',
  heating47: 'heating_47_btuh', heating47btuh: 'heating_47_btuh', heatingcapacity47: 'heating_47_btuh', heating47f: 'heating_47_btuh',
  heating17: 'heating_17_btuh', heating17btuh: 'heating_17_btuh', heatingcapacity17: 'heating_17_btuh', heating17f: 'heating_17_btuh',
  furnaceoutput: 'furnace_output_btuh', furnaceoutputbtuh: 'furnace_output_btuh', furnacebtuh: 'furnace_output_btuh',
  shr: 'shr', sensibleheatratio: 'shr',
  airflow: 'airflow_cfm', cfm: 'airflow_cfm', airflowcfm: 'airflow_cfm',
  refrigerant: 'refrigerant',
  sellprice: 'sell_price', price: 'sell_price', unitprice: 'sell_price', sellpriceusd: 'sell_price',
  notes: 'notes', note: 'notes',
};

export interface CsvImportPreview {
  rows: MatchupInput[];
  rejected: { line: number; reason: string }[];
  fatal: string | null;
}

/** Line numbers are 1-based and count the header as line 1. */
export function parseMatchupCsv(input: string): CsvImportPreview {
  const table = parseCsv(input);
  if (table.length < 2) return { rows: [], rejected: [], fatal: 'Paste a header row and at least one data row.' };
  const headers = table[0].map((h) => HEADER_ALIASES[h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '')] ?? null);
  for (const need of ['ahri_ref_number', 'manufacturer', 'outdoor_model', 'seer2']) {
    if (!headers.includes(need)) return { rows: [], rejected: [], fatal: `Missing a column for ${need.replace(/_/g, ' ')}.` };
  }
  if (!headers.includes('cooling_btuh') && !headers.includes('tons')) {
    return { rows: [], rejected: [], fatal: 'Missing a cooling capacity column (cooling_btuh or tons).' };
  }
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    return { rows: [], rejected: [], fatal: `Import ${MAX_IMPORT_ROWS} rows or fewer at a time.` };
  }

  const rows: MatchupInput[] = [];
  const rejected: { line: number; reason: string }[] = [];
  const seen = new Set<string>();
  for (let r = 1; r < table.length; r += 1) {
    const rec: Record<string, unknown> = {};
    headers.forEach((key, c) => {
      if (key) rec[key] = table[r][c] ?? '';
    });
    if (rec.cooling_btuh === undefined || String(rec.cooling_btuh).trim() === '') {
      const tons = numOrNull(rec.tons);
      if (typeof tons === 'number') rec.cooling_btuh = tons * 12000;
    }
    const price = numOrNull(rec.sell_price);
    if (price === undefined) {
      rejected.push({ line: r + 1, reason: 'Sell price is not a number.' });
      continue;
    }
    rec.sell_price_cents = price === null ? null : Math.round(price * 100);
    const res = parseMatchupRecord(rec);
    if (!res.ok) {
      rejected.push({ line: r + 1, reason: res.reason });
      continue;
    }
    const key = res.row.ahri_ref_number.toLowerCase();
    if (seen.has(key)) {
      rejected.push({ line: r + 1, reason: `Duplicate AHRI number ${res.row.ahri_ref_number} in this file.` });
      continue;
    }
    seen.add(key);
    rows.push(res.row);
  }
  return { rows, rejected, fatal: null };
}

export const CSV_TEMPLATE =
  'ahri_ref_number,manufacturer,brand,system_type,staging,outdoor_model,indoor_model,cooling_btuh,seer2,eer2,hspf2,heating_47_btuh,heating_17_btuh,shr,sell_price\n' +
  '"(from your AHRI certificate)","Maker","Brand",split_hp,variable,"outdoor model","indoor model",36000,17.5,12.0,8.8,36000,22000,0.75,9800';

// ============================================================
// DEFENSIVE PARSING OF DB ROWS / SNAPSHOTS
// ============================================================

function nn(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
}
function ns(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Null when the row is not a usable matchup (so one bad row never breaks the list). */
export function parseMatchupRow(raw: unknown): AhriMatchup | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const type = normalizeSystemType(r.system_type);
  const staging = normalizeStaging(r.staging);
  const cooling = nn(r.cooling_btuh);
  const seer2 = nn(r.seer2);
  const ref = ns(r.ahri_ref_number);
  const manufacturer = ns(r.manufacturer);
  const outdoor = ns(r.outdoor_model);
  if (!type || !staging || cooling === null || seer2 === null || !ref || !manufacturer || !outdoor) return null;
  return {
    id: typeof r.id === 'string' ? r.id : '',
    ahri_ref_number: ref,
    manufacturer,
    brand: ns(r.brand),
    system_type: type,
    staging,
    outdoor_model: outdoor,
    indoor_model: ns(r.indoor_model),
    furnace_model: ns(r.furnace_model),
    cooling_btuh: cooling,
    seer2,
    eer2: nn(r.eer2),
    hspf2: nn(r.hspf2),
    heating_47_btuh: nn(r.heating_47_btuh),
    heating_17_btuh: nn(r.heating_17_btuh),
    furnace_output_btuh: nn(r.furnace_output_btuh),
    shr: nn(r.shr),
    airflow_cfm: nn(r.airflow_cfm),
    refrigerant: ns(r.refrigerant),
    sell_price_cents: nn(r.sell_price_cents),
    ahri_status: r.ahri_status === 'verified' ? 'verified' : 'unverified',
    verified_at: ns(r.verified_at),
    active: r.active !== false,
    notes: ns(r.notes),
    created_at: typeof r.created_at === 'string' ? r.created_at : '',
    updated_at: typeof r.updated_at === 'string' ? r.updated_at : '',
  };
}

/** Short human label, e.g. "Acme 3.0-ton split heat pump". */
export function matchupTitle(m: Pick<AhriMatchup, 'manufacturer' | 'cooling_btuh' | 'system_type'>): string {
  return `${m.manufacturer} ${(m.cooling_btuh / 12000).toFixed(1)}-ton ${SYSTEM_TYPE_LABELS[m.system_type].toLowerCase()}`;
}

// Recreated: verify against original intent
// src/lib/operationalEntropy.ts
//
// Operational Entropy Detector: standards ("what on-standard looks like" per metric), readings logged against
// them, and the excess drift beyond tolerance priced in dollars.
//
// Model (only the EXCESS beyond the declared tolerance ever counts; normal noise is free):
//   deviationPct = |observed - target| / |target| * 100
//   in tolerance when deviationPct <= tolerance_pct, or when the move is in the "good" direction
//   (below target when higher_is_worse, above target when it is not)
//   excessPct    = deviationPct - tolerance_pct
//   excessUnits  = excessPct / 100 * |target|
//   financialImpact = excessUnits * dollar_impact_per_unit
//   entropyScore    = clamp(round(excessPct), 0, 100)   (one point per percent beyond tolerance)
//
// TODO(vireek): the formulas above are reconstructed from the page's description; the original score scaling is
// unknown, so verify `entropyScore` against the original intent.
// TODO(vireek): backend missing. No standards/readings tables exist in supabase/migrations, so the data functions
// below refuse with EntropyBackendMissingError instead of guessing table names or pretending to save.

export type EntityType = 'branch' | 'technician' | 'process';

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  branch: 'Branch',
  technician: 'Technician',
  process: 'Process',
};

export interface EntropyStandard {
  id: string;
  user_id?: string;
  entity_type: EntityType;
  metric_name: string;
  unit: string;
  target_value: number;
  tolerance_pct: number;
  dollar_impact_per_unit: number;
  higher_is_worse: boolean;
  notes: string | null;
  active: boolean;
  created_at?: string;
}

export interface EntropyReading {
  id: string;
  standard_id: string;
  entity_label: string;
  observed_value: number;
  observed_at: string;
  note: string | null;
}

export interface NewStandardInput {
  entity_type: EntityType;
  metric_name: string;
  unit: string;
  target_value: number;
  tolerance_pct: number;
  dollar_impact_per_unit: number;
  higher_is_worse: boolean;
  notes?: string;
}

export interface NewReadingInput {
  standard_id: string;
  entity_label: string;
  observed_value: number;
  note?: string;
}

export interface Deviation {
  deviationPct: number;
  excessPct: number;
  excessUnits: number;
  financialImpact: number;
  entropyScore: number;
  inDrift: boolean;
}

export interface EntityEntropyRow {
  entityLabel: string;
  standard: EntropyStandard;
  latestReading: EntropyReading;
  deviation: Deviation;
}

export interface EntropySummary {
  totalFinancialImpact: number;
  averageEntropyScore: number;
  entitiesInDrift: number;
  entitiesTracked: number;
}

export class EntropyBackendMissingError extends Error {
  constructor() {
    super('Operational Entropy storage is not available in this deployment.');
    this.name = 'EntropyBackendMissingError';
  }
}

const finite = (n: number): number => (Number.isFinite(n) ? n : 0);

/** Pure: how far a reading is from its standard, and what the excess costs. */
export function computeDeviation(standard: Pick<EntropyStandard, 'target_value' | 'tolerance_pct' | 'dollar_impact_per_unit' | 'higher_is_worse'>, observed: number): Deviation {
  const target = finite(standard.target_value);
  const tolerance = Math.max(0, finite(standard.tolerance_pct));
  const base = Math.abs(target);
  const diff = observed - target;
  const none: Deviation = { deviationPct: 0, excessPct: 0, excessUnits: 0, financialImpact: 0, entropyScore: 0, inDrift: false };
  if (!Number.isFinite(observed) || diff === 0) return none;

  // Moving in the "good" direction is never entropy.
  const worse = standard.higher_is_worse ? diff > 0 : diff < 0;
  // A target of 0 has no percentage scale: any move in the bad direction is measured in raw units against 0% tolerance.
  const deviationPct = base === 0 ? 100 : (Math.abs(diff) / base) * 100;
  if (!worse || deviationPct <= tolerance) return { ...none, deviationPct };

  const excessPct = deviationPct - tolerance;
  const excessUnits = base === 0 ? Math.abs(diff) : (excessPct / 100) * base;
  const financialImpact = excessUnits * Math.max(0, finite(standard.dollar_impact_per_unit));
  return {
    deviationPct,
    excessPct,
    excessUnits,
    financialImpact,
    entropyScore: Math.min(100, Math.max(0, Math.round(excessPct))),
    inDrift: true,
  };
}

/** Pure: newest reading per (standard, entity) pair, for active standards only. Unknown standards are ignored. */
export function latestReadingPerEntity(standards: EntropyStandard[], readings: EntropyReading[]): EntityEntropyRow[] {
  const byId = new Map(standards.filter((s) => s.active).map((s) => [s.id, s]));
  const latest = new Map<string, EntropyReading>();
  for (const r of readings) {
    if (!byId.has(r.standard_id)) continue;
    const key = `${r.standard_id}::${r.entity_label}`;
    const cur = latest.get(key);
    if (!cur || Date.parse(r.observed_at) > Date.parse(cur.observed_at)) latest.set(key, r);
  }
  const rows: EntityEntropyRow[] = [];
  for (const r of latest.values()) {
    const standard = byId.get(r.standard_id);
    if (!standard) continue;
    rows.push({ entityLabel: r.entity_label, standard, latestReading: r, deviation: computeDeviation(standard, r.observed_value) });
  }
  return rows;
}

export function summarizeEntropy(rows: EntityEntropyRow[]): EntropySummary {
  const n = rows.length;
  return {
    totalFinancialImpact: rows.reduce((s, r) => s + r.deviation.financialImpact, 0),
    averageEntropyScore: n === 0 ? 0 : rows.reduce((s, r) => s + r.deviation.entropyScore, 0) / n,
    entitiesInDrift: rows.filter((r) => r.deviation.inDrift).length,
    entitiesTracked: n,
  };
}

export function formatDollars(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 1000 ? 0 : 2 }).format(Number.isFinite(n) ? n : 0);
}

// ---- data access (backend missing: see the TODO at the top) -------------------------------------------------------

export async function fetchStandards(): Promise<EntropyStandard[]> {
  throw new EntropyBackendMissingError();
}
export async function fetchReadings(): Promise<EntropyReading[]> {
  throw new EntropyBackendMissingError();
}
export async function createStandard(_input: NewStandardInput, _userId: string): Promise<void> {
  throw new EntropyBackendMissingError();
}
export async function logReading(_input: NewReadingInput, _userId: string): Promise<void> {
  throw new EntropyBackendMissingError();
}
export async function toggleStandardActive(_id: string, _active: boolean): Promise<void> {
  throw new EntropyBackendMissingError();
}
export async function deleteStandard(_id: string): Promise<void> {
  throw new EntropyBackendMissingError();
}

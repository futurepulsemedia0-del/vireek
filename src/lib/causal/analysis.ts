/**
 * One-call causal network analysis: rows -> AIPW cell effects -> hierarchical shrinkage -> graded, reportable cells.
 * Advisory only. Nothing here changes dispatch, ranks people, or touches a rule.
 */

import { buildCausalRows, OUTCOME_KEYS, type BuildInput, type CausalRow, type ExtractDiagnostics, type OutcomeKey, type RawOutcomeJob } from '../causalDispatch';
import { estimateRawCells, type EstimationDiagnostics, type EstimatorMethod, type EstimatorOptions, type EstRow } from './estimators';
import { gradeEffect, benjaminiHochberg, type EffectDirection, type EvidenceGrade } from './evidence';
import { shrinkCells, type JobTypePrior, type ShrinkageModel } from './shrinkage';

export interface NetworkCell {
  technicianId: string;
  jobType: string;
  outcome: OutcomeKey;
  nSet: number;
  nChosen: number;
  ess: number;
  clippedShare: number;
  raw: number;
  rawSe: number | null;
  shrunk: number;
  shrunkSe: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  bootLow: number | null;
  bootHigh: number | null;
  fdrQ: number | null;
  grade: EvidenceGrade;
  reportable: boolean;
  direction: EffectDirection;
  favourable: boolean | null;
  reasons: string[];
}

export interface NetworkAnalysis {
  diagnostics: ExtractDiagnostics;
  estimation: Record<OutcomeKey, EstimationDiagnostics>;
  model: Record<OutcomeKey, ShrinkageModel>;
  effects: Record<OutcomeKey, NetworkCell[]>;
  rows: EstRow[];
}

const WEEK_MS = 7 * 86_400_000;
const MONDAY_EPOCH = Date.UTC(1970, 0, 5);

/** Technician-week cluster: outcomes of one technician's jobs in one week share conditions (fatigue, parts, weather). */
export function attachClusters(rows: CausalRow[], jobs: RawOutcomeJob[]): EstRow[] {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  return rows.map((r) => {
    const j = byId.get(r.jobId);
    const t = Date.parse(j?.completed_at ?? j?.scheduled_datetime ?? j?.created_at ?? '');
    const week = Number.isFinite(t) ? Math.floor((t - MONDAY_EPOCH) / WEEK_MS) : 'na';
    return { ...r, clusterId: `${r.chosenId}|${week}` };
  });
}

export function analyzeRows(
  rows: EstRow[],
  opts: { method?: EstimatorMethod; estimator?: Partial<EstimatorOptions>; priors?: Record<string, JobTypePrior> } = {},
): Omit<NetworkAnalysis, 'diagnostics'> {
  const effects = {} as Record<OutcomeKey, NetworkCell[]>;
  const estimation = {} as Record<OutcomeKey, EstimationDiagnostics>;
  const model = {} as Record<OutcomeKey, ShrinkageModel>;
  for (const outcome of OUTCOME_KEYS) {
    const { cells, diagnostics } = estimateRawCells(rows, outcome, opts.method ?? 'aipw', opts.estimator);
    const shrunk = shrinkCells(cells.map((c) => ({ technicianId: c.technicianId, jobType: c.jobType, est: c.est, se: c.se, n: c.nSet })), opts.priors);
    const q = benjaminiHochberg(shrunk.cells.map((c) => c.rawP));
    effects[outcome] = cells.map((c, i) => {
      const s = shrunk.cells[i];
      const ev = gradeEffect({ outcome, nSet: c.nSet, ess: c.ess, shrunk: s.shrunk, ciLow: s.ciLow, ciHigh: s.ciHigh, fdrQ: q[i], rawCiLow: c.se === null ? null : c.est - 1.959963984540054 * c.se, rawCiHigh: c.se === null ? null : c.est + 1.959963984540054 * c.se });
      return {
        technicianId: c.technicianId, jobType: c.jobType, outcome, nSet: c.nSet, nChosen: c.nChosen, ess: c.ess, clippedShare: c.clippedShare,
        raw: c.est, rawSe: c.se, shrunk: s.shrunk, shrunkSe: s.shrunkSe, ciLow: s.ciLow, ciHigh: s.ciHigh, bootLow: c.bootLow, bootHigh: c.bootHigh,
        fdrQ: q[i], grade: ev.grade, reportable: ev.reportable, direction: ev.direction, favourable: ev.favourable, reasons: ev.reasons,
      };
    });
    estimation[outcome] = diagnostics;
    model[outcome] = shrunk.model;
  }
  return { estimation, model, effects, rows };
}

export function analyzeCausalNetwork(
  input: BuildInput & { method?: EstimatorMethod; estimator?: Partial<EstimatorOptions>; priors?: Record<string, JobTypePrior> },
): NetworkAnalysis {
  const { rows, diagnostics } = buildCausalRows(input);
  const clustered = attachClusters(rows, input.jobs);
  return { diagnostics, ...analyzeRows(clustered, { method: input.method, estimator: input.estimator, priors: input.priors }) };
}

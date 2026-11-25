/** Monte-Carlo study over many seeds: bias, error, interval coverage and shrinkage benefit against known truth. */

import { analyzeRows, estimateRawCells, shrinkCells, Z95, type EstimatorMethod } from '../../src/lib/causal';
import { simulateTenant, type SimConfig } from './simulate';

export interface StudyResult {
  seeds: number;
  cells: number;
  qualifyingShare: number;
  /** Mean over seeds of the mean signed error (estimate − truth) across cells. */
  biasAipw: number;
  biasIpw: number;
  biasNaive: number;
  /** Signed bias of the NAIVE contrast for the most senior technician(s) (confounding steers them hard jobs). */
  biasNaiveSenior: number;
  biasAipwSenior: number;
  rmseAipw: number;
  rmseIpw: number;
  rmseNaive: number;
  rmseShrunk: number;
  /** Share of cells whose 95% interval contains the truth. */
  coverageRaw: number;
  coverageShrunk: number;
  /** Share of cells where the shrunk interval excludes zero but the truth has the OPPOSITE sign. */
  wrongSignReportable: number;
  reportableShare: number;
}

export function runStudy(cfg: Partial<SimConfig>, seeds: number, firstSeed = 1, method: EstimatorMethod = 'aipw'): StudyResult {
  let cells = 0, qual = 0;
  const acc = { bA: 0, bI: 0, bN: 0, nA: 0, nI: 0, nN: 0, sN: 0, sNn: 0, sA: 0, sAn: 0, eA: 0, eI: 0, eN: 0, eS: 0, covR: 0, covS: 0, nCov: 0, wrong: 0, rep: 0 };
  for (let s = 0; s < seeds; s++) {
    const sim = simulateTenant({ ...cfg, seed: firstSeed + s });
    qual += sim.qualifyingShare;
    const seniorTier = Math.max(...sim.tiers);
    const isSenior = (id: string) => sim.tiers[Number(id.slice(1))] === seniorTier;
    const aipw = estimateRawCells(sim.rows, 'ftf', method).cells;
    const ipw = estimateRawCells(sim.rows, 'ftf', 'ipw').cells;
    const shr = shrinkCells(aipw.map((c) => ({ technicianId: c.technicianId, jobType: c.jobType, est: c.est, se: c.se, n: c.nSet }))).cells;
    const full = analyzeRows(sim.rows, { method });
    const rep = new Map(full.effects.ftf.map((e) => [`${e.technicianId}|${e.jobType}`, e]));
    aipw.forEach((c, i) => {
      const key = `${c.technicianId}|${c.jobType}`;
      const truth = sim.truth.get(key);
      if (truth === undefined) return;
      cells++;
      const eA = c.est - truth;
      acc.bA += eA; acc.nA++; acc.eA += eA * eA;
      if (isSenior(c.technicianId)) { acc.sA += eA; acc.sAn++; }
      const i2 = ipw.find((x) => x.technicianId === c.technicianId && x.jobType === c.jobType);
      if (i2) { acc.bI += i2.est - truth; acc.nI++; acc.eI += (i2.est - truth) ** 2; }
      const nv = sim.naive.get(key);
      if (nv !== undefined) { const e = nv - truth; acc.bN += e; acc.nN++; acc.eN += e * e; if (isSenior(c.technicianId)) { acc.sN += e; acc.sNn++; } }
      const eS = shr[i].shrunk - truth;
      acc.eS += eS * eS;
      if (c.se !== null) { acc.nCov++; if (Math.abs(c.est - truth) <= Z95 * c.se) acc.covR++; }
      const s = shr[i];
      if (s.ciLow !== null && s.ciHigh !== null && s.shrunkSe !== null) {
        if (truth >= s.ciLow && truth <= s.ciHigh) acc.covS++;
      }
      const r = rep.get(key);
      if (r?.reportable) { acc.rep++; if ((r.shrunk > 0) !== (truth > 0)) acc.wrong++; }
    });
  }
  return {
    seeds, cells, qualifyingShare: qual / seeds,
    biasAipw: acc.bA / acc.nA, biasIpw: acc.bI / Math.max(1, acc.nI), biasNaive: acc.bN / Math.max(1, acc.nN),
    biasNaiveSenior: acc.sN / Math.max(1, acc.sNn), biasAipwSenior: acc.sA / Math.max(1, acc.sAn),
    rmseAipw: Math.sqrt(acc.eA / acc.nA), rmseIpw: Math.sqrt(acc.eI / Math.max(1, acc.nI)), rmseNaive: Math.sqrt(acc.eN / Math.max(1, acc.nN)), rmseShrunk: Math.sqrt(acc.eS / acc.nA),
    coverageRaw: acc.covR / Math.max(1, acc.nCov), coverageShrunk: acc.covS / acc.nA,
    wrongSignReportable: acc.rep ? acc.wrong / acc.rep : 0, reportableShare: acc.rep / acc.nA,
  };
}

/**
 * scripts/rrCertify/simulate.ts — synthetic validation of the rrCertify layer. Deterministic (seeded).
 *
 *   node --experimental-strip-types --no-warnings scripts/rrCertify/simulate.ts [--seeds 500] [--json out.json]
 *
 * The synthetic world has KNOWN false-resolution probabilities, so the true risk of any threshold is exact.
 * What this proves: the code implements the stated procedures correctly on data that satisfy the assumptions.
 * What it does NOT prove: that real Vireek data are exchangeable, that failures are fully detected, or that
 * the LLM-driven score stays stable. Those are the real risks and no simulation can retire them.
 *
 * Criteria are fixed BEFORE running (see CRITERIA) and failures are reported, never hidden.
 */
import { writeFileSync } from 'node:fs';
import { buildSnapshot } from '../../src/lib/rrCertify/calibrate.ts';
import { DEFAULT_DRIFT_CONFIG, driftReference, evaluateDrift, type DriftObservation } from '../../src/lib/rrCertify/drift.ts';
import { gateDecision } from '../../src/lib/rrCertify/gate.ts';
import { selectThreshold } from '../../src/lib/rrCertify/ltt.ts';
import { crcSelectLambda } from '../../src/lib/rrCertify/crc.ts';
import { mulberry32 } from '../../src/lib/rrCertify/rng.ts';
import { wilson } from '../../src/lib/rrCertify/stats.ts';
import { DEFAULT_CERTIFY_SETTINGS, LAMBDA_NEVER, type CaseOutcomeRow } from '../../src/lib/rrCertify/types.ts';

const args = process.argv.slice(2);
const argVal = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const SEEDS = Math.max(500, Number(argVal('--seeds') ?? 500));
const ALPHA = 0.05;
const DELTA = 0.1;
const T0 = 55;

/** Fixed before running. */
const CRITERIA = {
  lttViolationLowerWilsonMax: DELTA, // observed violation rate must be statistically consistent with <= delta
  crcMeanRiskSlackSE: 3, // mean true per-attempt risk <= alpha + 3 standard errors
  abstainAtN50: 1.0, // with 50 closed cases, 100% of seeds must abstain
  shiftDetection: 0.9, // x3 risk shift detected within 100 allowed post-shift cases in >= 90% of seeds
  falseAlarmMax: 0.1, // no-shift stream of 300 allowed cases: sequential false-alarm rate <= 10%
};

// ---- synthetic world (known truth) -------------------------------------------------------------
const SCORES = Array.from({ length: 101 - T0 }, (_, i) => T0 + i); // attempted cases have score >= T0
const pScore = SCORES.map((s) => 1 + (s - T0) / 15); // more mass at higher scores
const Z = pScore.reduce((a, b) => a + b, 0);
const pS = pScore.map((x) => x / Z);
const pf = (s: number, mult = 1) => Math.min(0.95, mult * (0.3 * Math.exp(-(s - T0) / 12) + 0.004));

function drawScore(rnd: () => number): number {
  let u = rnd();
  for (let i = 0; i < SCORES.length; i++) { u -= pS[i]; if (u <= 0) return SCORES[i]; }
  return 100;
}
const drawCase = (rnd: () => number, mult = 1) => { const score = drawScore(rnd); return { score, loss: (rnd() < pf(score, mult) ? 1 : 0) as 0 | 1 }; };

/** Exact true quantities at threshold lambda. */
function truth(lambda: number, mult = 1) {
  let allowedMass = 0; let riskMass = 0;
  SCORES.forEach((s, i) => { if (s >= lambda) { allowedMass += pS[i]; riskMass += pS[i] * pf(s, mult); } });
  return { perAttempt: riskMass, allowed: allowedMass, conditional: allowedMass > 0 ? riskMass / allowedMass : 0 };
}

// ---- experiment 1+2: guarantees and abstention across calibration sizes -------------------------
const NS = [50, 200, 1000, 5000];
const guarantee = NS.map((n) => {
  let certified = 0; let violations = 0; let crcRiskSum = 0; let crcRiskSq = 0; let crcAbove = 0; let allowedShareSum = 0; let condSum = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rnd = mulberry32(seed * 7919 + n);
    const cases = Array.from({ length: n }, () => drawCase(rnd));
    const t = selectThreshold(cases, ALPHA, DELTA, T0);
    if (!t.abstain) {
      certified++;
      const tr = truth(t.lambda);
      if (tr.conditional > ALPHA) violations++;
      allowedShareSum += tr.allowed; condSum += tr.conditional;
    }
    // CRC on its own (unconditional): true expected per-attempt loss at ITS lambda_hat.
    const c = crcSelectLambda(cases, ALPHA, T0);
    const risk = c.abstain ? 0 : truth(c.lambda).perAttempt;
    crcRiskSum += risk; crcRiskSq += risk * risk; if (risk > ALPHA) crcAbove++;
  }
  const mean = crcRiskSum / SEEDS;
  const sd = Math.sqrt(Math.max(0, crcRiskSq / SEEDS - mean * mean));
  const viol = wilson(violations, SEEDS);
  return {
    n, seeds: SEEDS,
    certifiedShare: certified / SEEDS,
    lttViolationRate: violations / SEEDS, lttViolationWilson95: [viol.low, viol.high],
    meanAllowedShareWhenCertified: certified ? allowedShareSum / certified : null,
    meanTrueConditionalRateWhenCertified: certified ? condSum / certified : null,
    crcMeanTruePerAttemptRisk: mean, crcStdErr: sd / Math.sqrt(SEEDS),
    crcShareOfSeedsWithRiskAboveAlpha: crcAbove / SEEDS,
  };
});

// ---- experiment 3: full pipeline abstention ladder (buildSnapshot) -------------------------------
const OLD = '2020-01-01T00:00:00Z';
const NOW = new Date('2027-06-30T12:00:00Z');
function rowsFor(n: number, rnd: () => number, segs: { key: string; share: number; mult: number }[]): CaseOutcomeRow[] {
  return Array.from({ length: n }, (_, i) => {
    let u = rnd(); let seg = segs[segs.length - 1];
    for (const s of segs) { u -= s.share; if (u <= 0) { seg = s; break; } }
    const c = drawCase(rnd, seg.mult);
    return {
      case_id: `c${i}`, segment: seg.key, score: c.score, threshold: T0, thresholdSource: 'logged' as const,
      status: c.loss ? 'reopened' : 'resolved_remotely', resolvedAt: OLD, reopenedAt: c.loss ? '2020-01-05T00:00:00Z' : null, repeatJobAt: null,
    };
  });
}
const SEGS = [{ key: 'hvac:hvac_cooling', share: 0.6, mult: 0.6 }, { key: 'plumbing:plumbing_leak', share: 0.3, mult: 1 }, { key: 'electrical:electrical_power', share: 0.1, mult: 1.8 }];
const ladder = [60, 100, 400, 3000, 12000].map((n) => {
  const rnd = mulberry32(n * 31 + 5);
  const snap = buildSnapshot({ rows: rowsFor(n, rnd, SEGS), settings: DEFAULT_CERTIFY_SETTINGS, now: NOW, fallbackThreshold: T0 });
  const st = Object.values(snap.segments).map((s) => `${s.segment}=${s.status}@${s.lambda}`);
  return { n, pooled: `${snap.pooled.status}@${snap.pooled.lambda}`, segments: st };
});

// ---- experiment 4: drift under shift -------------------------------------------------------------
let falseAlarms = 0; let detected = 0; const delays: number[] = []; let revertedOk = 0; let revertChecks = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  const rnd = mulberry32(seed * 104729 + 17);
  const snap = buildSnapshot({ rows: rowsFor(3000, rnd, [{ key: 'hvac:hvac_cooling', share: 1, mult: 1 }]), settings: DEFAULT_CERTIFY_SETTINGS, now: NOW, fallbackThreshold: T0 });
  const cal = snap.segments['hvac:hvac_cooling'];
  if (!cal || cal.status === 'abstain') continue;
  const ref = driftReference(snap);
  const stream = (mult: number, count: number, obs: DriftObservation[]): number | null => {
    let allowed = 0;
    while (allowed < count) {
      const c = drawCase(rnd, mult);
      if (c.score < cal.lambda) continue; // gate blocks: not observed in live mode
      allowed++;
      obs.unshift({ caseId: `l${obs.length}`, failureSeen: c.loss === 1 });
      if (evaluateDrift(obs, ref, DEFAULT_DRIFT_CONFIG).status === 'alarm') return allowed;
    }
    return null;
  };
  // control: no shift, 300 allowed cases
  if (stream(1, 300, []) !== null) falseAlarms++;
  // shift: 100 stationary allowed cases first, then x3 risk
  const obs: DriftObservation[] = [];
  if (stream(1, 100, obs) !== null) continue; // alarmed before the shift: not a detection of the shift
  const d = stream(3, 300, obs);
  if (d !== null) {
    if (d <= 100) detected++;
    delays.push(d);
    revertChecks++;
    const g = gateDecision({ existingAllowsRemote: true, safetyHold: false, safetyReasons: [], score: 100, segment: 'hvac:hvac_cooling', snapshot: snap, driftAlarm: true });
    if (g.action === 'dispatch' && g.reason === 'drift_alarm') revertedOk++;
  }
}
delays.sort((a, b) => a - b);
const driftResult = {
  seeds: SEEDS,
  falseAlarmRateNoShift300: falseAlarms / SEEDS,
  shiftX3DetectionWithin100: detected / SEEDS,
  shiftX3DetectionWithin200: delays.filter((x) => x <= 200).length / SEEDS,
  shiftX3DetectionWithin300: delays.length / SEEDS,
  medianAllowedCasesToAlarm: delays.length ? delays[Math.floor(delays.length / 2)] : null,
  revertToDispatchOnAlarm: `${revertedOk}/${revertChecks}`,
};

// ---- criteria ------------------------------------------------------------------------------------
const checks: { name: string; pass: boolean; detail: string }[] = [];
for (const g of guarantee) {
  checks.push({ name: `LTT conditional bound, n=${g.n}`, pass: g.lttViolationWilson95[0] <= CRITERIA.lttViolationLowerWilsonMax, detail: `violations ${(g.lttViolationRate * 100).toFixed(2)}% (Wilson95 ${(g.lttViolationWilson95[0] * 100).toFixed(2)}-${(g.lttViolationWilson95[1] * 100).toFixed(2)}%), must be consistent with <= ${DELTA * 100}%` });
  checks.push({ name: `CRC per-attempt mean risk, n=${g.n}`, pass: g.crcMeanTruePerAttemptRisk <= ALPHA + CRITERIA.crcMeanRiskSlackSE * g.crcStdErr, detail: `mean ${(g.crcMeanTruePerAttemptRisk * 100).toFixed(3)}% vs alpha ${ALPHA * 100}% (+${CRITERIA.crcMeanRiskSlackSE} SE = ${(g.crcStdErr * 100 * CRITERIA.crcMeanRiskSlackSE).toFixed(3)}%)` });
}
checks.push({ name: 'abstain at n=50', pass: guarantee[0].certifiedShare <= 1 - CRITERIA.abstainAtN50, detail: `certified in ${(guarantee[0].certifiedShare * 100).toFixed(1)}% of seeds` });
checks.push({ name: 'shift x3 detected within 100 allowed cases', pass: driftResult.shiftX3DetectionWithin100 >= CRITERIA.shiftDetection, detail: `${(driftResult.shiftX3DetectionWithin100 * 100).toFixed(1)}%` });
checks.push({ name: 'no-shift false-alarm rate', pass: driftResult.falseAlarmRateNoShift300 <= CRITERIA.falseAlarmMax, detail: `${(driftResult.falseAlarmRateNoShift300 * 100).toFixed(1)}% over 300 sequential allowed cases` });
checks.push({ name: 'alarm reverts the gate to dispatch', pass: revertChecks > 0 && revertedOk === revertChecks, detail: driftResult.revertToDispatchOnAlarm });
checks.push({ name: 'no lambda below the data floor', pass: ladder.every((l) => l.segments.every((s) => !/@(\d+)/.test(s) || Number(/@(\d+)/.exec(s)![1]) >= T0)), detail: `all lambdas >= ${T0}` });
void LAMBDA_NEVER;

const report = { seeds: SEEDS, alpha: ALPHA, delta: DELTA, criteria: CRITERIA, guarantee, ladder, drift: driftResult, checks };
const out = argVal('--json');
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
const failed = checks.filter((c) => !c.pass);
console.error(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ' — FAILED: ' + failed.map((f) => f.name).join('; ') : ''}`);
process.exit(failed.length ? 1 : 0);

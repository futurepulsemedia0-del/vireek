// A/B assignment + statistics (pure). Fixed-horizon only: never evaluate before minPerArm.
export interface Arm { key: string; weight: number }

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

export function validateArms(arms: Arm[]): boolean {
  return Array.isArray(arms) && arms.length >= 2 && arms.length <= 3 &&
    new Set(arms.map((a) => a.key)).size === arms.length &&
    arms.every((a) => typeof a.key === "string" && a.key.length > 0 && Number.isFinite(a.weight) && a.weight > 0);
}

/** Deterministic and sticky: same (experiment, subject) always lands in the same arm. */
export function assignArm(experimentId: string, subjectId: string, arms: Arm[]): string {
  if (!validateArms(arms)) throw new Error("invalid_arms");
  const total = arms.reduce((s, a) => s + a.weight, 0);
  const u = (fnv1a(`${experimentId}:${subjectId}`) / 0x100000000) * total;
  let acc = 0;
  for (const a of arms) { acc += a.weight; if (u < acc) return a.key; }
  return arms[arms.length - 1].key;
}

function erf(x: number): number {
  const s = Math.sign(x), t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

export function twoProportion(x1: number, n1: number, x2: number, n2: number): { diff: number; z: number; p: number } {
  if (n1 <= 0 || n2 <= 0) return { diff: 0, z: 0, p: 1 };
  const p1 = x1 / n1, p2 = x2 / n2, pool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  if (se === 0) return { diff: p2 - p1, z: 0, p: 1 };
  const z = (p2 - p1) / se;
  return { diff: p2 - p1, z, p: 2 * (1 - normCdf(Math.abs(z))) };
}

export interface ArmStats { key: string; calls: number; bookings: number; hangups: number }
export interface EvalConfig { minPerArm: number; alpha: number; maxHangupIncrease: number }
export const DEFAULT_EVAL: EvalConfig = { minPerArm: 200, alpha: 0.05, maxHangupIncrease: 0.02 };
export type Decision =
  | { status: "insufficient_data" }
  | { status: "stop_guardrail"; arm: string }
  | { status: "winner"; arm: string }
  | { status: "no_difference" };

/** arms[0] is the control. Bonferroni-corrected alpha across challengers. */
export function evaluateExperiment(arms: ArmStats[], cfg: EvalConfig = DEFAULT_EVAL): Decision {
  if (arms.length < 2 || arms.some((a) => a.calls < cfg.minPerArm)) return { status: "insufficient_data" };
  const [ctl, ...chs] = arms;
  const alpha = cfg.alpha / chs.length;
  for (const c of chs) {
    const h = twoProportion(ctl.hangups, ctl.calls, c.hangups, c.calls);
    if (h.diff > cfg.maxHangupIncrease && h.p < alpha) return { status: "stop_guardrail", arm: c.key };
  }
  let best: { arm: string; diff: number } | null = null;
  for (const c of chs) {
    const b = twoProportion(ctl.bookings, ctl.calls, c.bookings, c.calls);
    const h = twoProportion(ctl.hangups, ctl.calls, c.hangups, c.calls);
    if (b.diff > 0 && b.p < alpha && h.diff <= cfg.maxHangupIncrease && (!best || b.diff > best.diff)) best = { arm: c.key, diff: b.diff };
  }
  return best ? { status: "winner", arm: best.arm } : { status: "no_difference" };
}

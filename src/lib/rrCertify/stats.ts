/** Small exact-binomial helpers (no dependencies). Accurate for n up to a few thousand. */

const logFactCache: number[] = [0];
function logFact(n: number): number {
  for (let i = logFactCache.length; i <= n; i++) logFactCache.push(logFactCache[i - 1] + Math.log(i));
  return logFactCache[n];
}

function logPmf(j: number, n: number, p: number): number {
  if (p <= 0) return j === 0 ? 0 : -Infinity;
  if (p >= 1) return j === n ? 0 : -Infinity;
  return logFact(n) - logFact(j) - logFact(n - j) + j * Math.log(p) + (n - j) * Math.log(1 - p);
}

/** P(X >= k) for X ~ Binomial(n, p). */
export function binomUpperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  let s = 0;
  for (let j = k; j <= n; j++) s += Math.exp(logPmf(j, n, p));
  return Math.min(1, s);
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let s = 0;
  for (let j = 0; j <= k; j++) s += Math.exp(logPmf(j, n, p));
  return Math.min(1, s);
}

/** Clopper-Pearson one-sided upper confidence bound for a binomial proportion. */
export function clopperPearsonUpper(k: number, n: number, confidence = 0.95): number {
  if (n <= 0) return 1;
  if (k >= n) return 1;
  const target = 1 - confidence;
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > target) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Wilson score interval (two-sided, default 95%). */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

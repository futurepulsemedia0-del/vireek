/**
 * Pure scale helpers for count charts. Counts always start at zero (honest bars);
 * the top of the axis is a "nice" number so gridlines land on round values.
 */
export function niceCeil(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  if (max <= 5) return Math.ceil(max);
  const pow = 10 ** Math.floor(Math.log10(max));
  const f = max / pow;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return step * pow;
}

/** Evenly spaced integer ticks from 0 to niceCeil(max); the step always divides the top exactly. */
export function countTicks(max: number, maxTicks = 4): number[] {
  const top = niceCeil(max);
  let divisions = top <= maxTicks ? top : 1;
  if (top > maxTicks) {
    for (let d = maxTicks; d >= 1; d -= 1) {
      if (top % d === 0) {
        divisions = d;
        break;
      }
    }
  }
  const step = top / divisions;
  return Array.from({ length: divisions + 1 }, (_, i) => i * step);
}

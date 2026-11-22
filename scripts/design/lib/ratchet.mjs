// scripts/design/lib/ratchet.mjs
// Pure helpers for the design-system ratchet: violations are counted per (rule, file); line numbers are ignored so
// unrelated edits that shift lines never cause a failure.

export const keyOf = (v) => `${v.rule}|${v.file}`;

/** @param {{rule:string,file:string}[]} violations @returns {Record<string, number>} */
export function countViolations(violations) {
  const out = {};
  for (const v of violations) out[keyOf(v)] = (out[keyOf(v)] ?? 0) + 1;
  return out;
}

/** Entries where current > baseline (a missing baseline entry counts as 0 => any new violation fails). */
export function regressions(current, baseline) {
  const bad = [];
  for (const [k, n] of Object.entries(current)) {
    const allowed = baseline[k] ?? 0;
    if (n > allowed) bad.push({ key: k, allowed, actual: n });
  }
  return bad.sort((a, b) => a.key.localeCompare(b.key));
}

/** Baseline lowered to what the tree now has; never raised, entries at 0 are dropped. */
export function ratcheted(current, baseline) {
  const out = {};
  for (const [k, allowed] of Object.entries(baseline)) {
    const n = Math.min(allowed, current[k] ?? 0);
    if (n > 0) out[k] = n;
  }
  return out;
}

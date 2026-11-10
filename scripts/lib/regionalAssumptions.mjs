// Pure scanner for hard-coded US-region assumptions (USD / imperial / US formats).
// Used by scripts/check-regional-assumptions.mjs and unit-tested in regionalAssumptions.test.mjs.

/** id → { re, fix }. Patterns are intentionally narrow to keep false positives low. */
export const RULES = {
  'usd-dollar-template': { re: /\$\$\{/g, fix: 'format with formatCentsIn()/formatMoney() from @/lib/regional (uses the account currency + locale)' },
  'usd-currency-literal': { re: /currency\s*:\s*['"]USD['"]/g, fix: 'use the account currency: getActiveRegional().currency or useRegional()' },
  'en-us-locale-literal': { re: /['"]en-US['"]/g, fix: 'use getActiveLocale() / the region profile locale' },
  'imperial-unit-literal': { re: /°F|\bsq\.? ?ft\b|\bmiles\b/g, fix: 'use formatDistance/formatTemperature/formatArea from @/lib/regional' },
  'us-date-format-literal': { re: /\bMM\/DD\/YYYY\b|\bMM\/dd\/yyyy\b/g, fix: 'use the date helpers in @/lib/format (locale-aware)' },
};

export const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** @returns {Record<string, number>} rule id → hit count (only non-zero) */
export function scanText(text) {
  const clean = stripComments(text);
  const out = {};
  for (const [id, { re }] of Object.entries(RULES)) {
    re.lastIndex = 0;
    const n = (clean.match(re) ?? []).length;
    if (n > 0) out[id] = n;
  }
  return out;
}

/** Files that ARE the formatting/region layer (or hold locale data) may contain these literals. */
export const isExempt = (rel) =>
  /(^|\/)(locales|__fixtures__|test)\//.test(rel) ||
  /\.test\.tsx?$/.test(rel) ||
  /^src\/lib\/(regional|format|currency|timezone|i18n|portalI18n)\.ts$/.test(rel) ||
  /^src\/lib\/(regionConfig|regionalPacks|documents)\//.test(rel) ||
  /^src\/i18n\//.test(rel);

/** Compare current vs baseline. Returns offending [file, rule, now, allowed]. */
export function findRegressions(current, baseline) {
  const bad = [];
  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, n] of Object.entries(rules)) {
      const allowed = baseline[file]?.[rule] ?? 0;
      if (n > allowed) bad.push([file, rule, n, allowed]);
    }
  }
  return bad;
}

/** Baseline may only shrink: refuse to write one that is worse than the existing file. */
export function mergeShrinkOnly(current, baseline) {
  const out = {};
  for (const [file, rules] of Object.entries(current)) {
    for (const [rule, n] of Object.entries(rules)) {
      const prev = baseline?.[file]?.[rule];
      (out[file] ??= {})[rule] = prev === undefined ? n : Math.min(prev, n);
    }
  }
  return out;
}

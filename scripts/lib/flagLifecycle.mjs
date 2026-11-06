// Flag lifecycle rules. Registry: config/flags.registry.json (the reviewed source of truth for flag metadata).
const KEY_RE = /^[a-z][a-z0-9_]{1,62}[a-z0-9]$/;
const KINDS = new Set(['release', 'ops', 'experiment', 'permission']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_TEMPORARY_DAYS = 180;
export const USAGE_RE = /\b(?:useFeatureFlag|isEnabled|isFlagOn|flagEnabled)\(\s*['"]([a-z][a-z0-9_]*)['"]|\brpc\(\s*['"]flag_evaluate['"]\s*,\s*\{[^}]*?\bp_key\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g;

const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

/** @returns {{errors: string[], warnings: string[]}} */
export function checkRegistry(registry, today) {
  const errors = [];
  const warnings = [];
  const seen = new Set();
  for (const f of registry.flags ?? []) {
    const id = f?.key ?? '(missing key)';
    if (!KEY_RE.test(f?.key ?? '')) { errors.push(`${id}: invalid key`); continue; }
    if (seen.has(f.key)) errors.push(`${id}: duplicate registry entry`);
    seen.add(f.key);
    if (!KINDS.has(f.kind)) errors.push(`${id}: kind must be one of ${[...KINDS].join(', ')}`);
    if (typeof f.owner !== 'string' || f.owner.trim().length < 2) errors.push(`${id}: owner is required`);
    if (!DATE_RE.test(f.created ?? '')) errors.push(`${id}: created must be YYYY-MM-DD`);
    if (typeof f.cleanup !== 'string' || f.cleanup.trim().length < 5) errors.push(`${id}: cleanup plan is required (what to delete when the flag is retired)`);
    const temporary = f.kind === 'release' || f.kind === 'experiment';
    if (temporary && !f.expires) errors.push(`${id}: ${f.kind} flags must have an expiry date`);
    if (f.expires) {
      if (!DATE_RE.test(f.expires)) { errors.push(`${id}: expires must be YYYY-MM-DD`); continue; }
      if (DATE_RE.test(f.created ?? '') && days(f.created, f.expires) > MAX_TEMPORARY_DAYS && temporary) {
        errors.push(`${id}: expiry is more than ${MAX_TEMPORARY_DAYS} days after creation`);
      }
      if (f.expires < today) errors.push(`${id}: STALE since ${f.expires}. Remove the flag and its code paths, or extend the expiry with a justification in review.`);
      else if (days(today, f.expires) <= 14) warnings.push(`${id}: expires ${f.expires} (within 14 days)`);
    }
  }
  return { errors, warnings };
}

export function usedKeys(files) {
  const keys = new Map();
  for (const { path, text } of files) {
    for (const m of text.matchAll(USAGE_RE)) {
      const k = m[1] ?? m[2];
      if (!keys.has(k)) keys.set(k, path);
    }
  }
  return keys;
}

export function crossCheck(registry, used) {
  const errors = [];
  const warnings = [];
  const known = new Set((registry.flags ?? []).map((f) => f.key));
  for (const [k, path] of used) if (!known.has(k)) errors.push(`${k}: used in ${path} but missing from config/flags.registry.json`);
  for (const f of registry.flags ?? []) {
    if (!used.has(f.key) && (f.kind === 'release' || f.kind === 'experiment')) warnings.push(`${f.key}: in registry but no literal usage found; remove it if retired`);
  }
  return { errors, warnings };
}

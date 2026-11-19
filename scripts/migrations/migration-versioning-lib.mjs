// scripts/migrations/migration-versioning-lib.mjs
// Pure logic (no I/O, zero dependencies) behind check-migration-versioning.mjs. See docs/runbooks/migration-versioning.md.

export const STRICT_NAME = /^(\d{14})_[a-z0-9][a-z0-9_]*\.sql$/;
export const KINDS = {
  "irregular-name": "name is not `<14-digit UTC timestamp>_<snake_case>.sql` (or is a directory / stray file)",
  "duplicate-version": "another migration file has the same 14-digit version",
  "future-dated": "version is later than the current UTC time",
  "out-of-order": "new migration sorts BEFORE a migration that already exists on the base branch",
  "future-jump": "new migration is more than one day beyond max(latest existing version, now)",
  "edited-applied": "an existing (applied) migration was edited",
  "renamed-applied": "an existing (applied) migration was renamed",
  "deleted-applied": "an existing (applied) migration was deleted",
};
export const INVENTORY_KINDS = ["irregular-name", "duplicate-version", "future-dated"];

export const formatVersion = (d) => d.toISOString().replace(/\D/g, "").slice(0, 14);
export function parseVersion(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return formatVersion(d) === v ? d : null; // rejects 20261340…, 20260230…
}
const addMs = (v, ms) => formatVersion(new Date(parseVersion(v).getTime() + ms));
const bytewise = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // == Supabase CLI (Go) directory order

export const versionOf = (name) => STRICT_NAME.exec(name)?.[1] ?? null;
const isStrict = (name) => versionOf(name) !== null && parseVersion(versionOf(name)) !== null;

/** Whole-directory inventory: every file/dir name -> list of {file, kind}. Deterministic order. */
export function inventoryViolations(names, nowVersion) {
  const out = [];
  const byVersion = new Map();
  for (const name of [...names].sort(bytewise)) {
    if (!isStrict(name)) { out.push({ file: name, kind: "irregular-name" }); continue; }
    const v = versionOf(name);
    byVersion.set(v, [...(byVersion.get(v) ?? []), name]);
    if (v > nowVersion) out.push({ file: name, kind: "future-dated" });
  }
  for (const files of byVersion.values()) if (files.length > 1) for (const f of files) out.push({ file: f, kind: "duplicate-version" });
  return out.sort((a, b) => bytewise(a.kind, b.kind) || bytewise(a.file, b.file));
}

export const maxStrictVersion = (names) => names.filter(isStrict).map(versionOf).sort().at(-1) ?? "0".repeat(14);

export function buildBaseline(names, now) {
  const nowV = formatVersion(now);
  const violations = Object.fromEntries(INVENTORY_KINDS.map((k) => [k, []]));
  for (const v of inventoryViolations(names, nowV)) violations[v.kind].push(v.file);
  return { schema: 1, asOfVersion: nowV, maxVersion: maxStrictVersion(names), files: [...names].sort(bytewise), violations };
}

/**
 * Decide which violations are NEW.
 *  names     current directory entries            baseline  parsed versioning-baseline.json
 *  baseNames entries on the base branch (git) — if null, baseline.files is used
 *  changes   [{status:'M'|'D'|'R', path, oldPath?}] working tree vs base (git)   repairPr  allow renames/deletes of baselined files
 */
export function evaluate({ names, now, baseline, baseNames = null, changes = [], repairPr = false }) {
  const nowV = formatVersion(now);
  const inventory = inventoryViolations(names, nowV);
  const baseSet = new Set(baseNames ?? baseline.files);
  const added = new Set(names.filter((n) => !baseSet.has(n)));
  const baselineKeys = new Set(Object.entries(baseline.violations ?? {}).flatMap(([k, files]) => files.map((f) => `${k}:${f}`)));
  const violations = [];

  for (const v of inventory) {
    if (baselineKeys.has(`${v.kind}:${v.file}`)) continue;
    // Files past the legacy maximum are the compliant "frontier": judged by the ordering rules below, not as legacy debt.
    if (v.kind === "future-dated" && (added.has(v.file) || versionOf(v.file) > baseline.maxVersion)) continue;
    violations.push(v);
  }

  const baseMax = maxStrictVersion([...baseSet]);
  const ceiling = addMs(baseMax > nowV ? baseMax : nowV, 24 * 3600 * 1000);
  for (const name of [...added].sort(bytewise)) {
    if (!isStrict(name)) continue;
    const v = versionOf(name);
    if (v <= baseMax) violations.push({ file: name, kind: "out-of-order", detail: `version ${v} <= latest existing ${baseMax}` });
    else if (v > ceiling) violations.push({ file: name, kind: "future-jump", detail: `version ${v} > allowed ceiling ${ceiling}` });
  }

  const allowed = new Set(baseline.allowEdits ?? []);
  const kind = { M: "edited-applied", D: "deleted-applied", R: "renamed-applied" };
  for (const c of changes) {
    const file = (c.oldPath ?? c.path).split("/")[0];
    const k = kind[c.status[0]];
    if (!k || allowed.has(file) || !baseSet.has(file)) continue;
    if (repairPr && k !== "edited-applied" && baseline.files.includes(file)) continue;
    violations.push({ file, kind: k });
  }

  const present = new Set(inventory.map((v) => `${v.kind}:${v.file}`));
  const stale = [...baselineKeys].filter((k) => !present.has(k)).sort();
  violations.sort((a, b) => bytewise(a.kind, b.kind) || bytewise(a.file, b.file));
  return { violations, stale, inventory };
}

/** Next safe version: strictly after every existing version AND not in the past. */
export function nextVersion(names, now) {
  const max = maxStrictVersion(names);
  const bumped = max === "0".repeat(14) ? null : addMs(max, 1000);
  const nowV = formatVersion(now);
  return bumped && bumped > nowV ? bumped : nowV;
}

/**
 * Compress future-dated migrations into the past, preserving execution order (documented repair plan; prints only).
 * New versions are max(non-future version)+1s, +2s, … and must all be <= now.
 */
export function planFutureRepair(names, now) {
  const nowV = formatVersion(now);
  const strict = names.filter(isStrict).sort(bytewise);
  const dup = inventoryViolations(strict, nowV).filter((v) => v.kind === "duplicate-version");
  if (dup.length) return { error: "Duplicate versions exist. Resolve them first (scripts/migrations-dedupe.mjs plan/apply), then re-run." };
  const future = strict.filter((n) => versionOf(n) > nowV);
  const base = maxStrictVersion(strict.filter((n) => versionOf(n) <= nowV));
  if (!future.length) return { renames: [], base };
  const baseMs = base === "0".repeat(14) ? 0 : parseVersion(base).getTime();
  const lastMs = baseMs + future.length * 1000;
  if (lastMs > parseVersion(nowV).getTime()) {
    return { error: `Not enough room before now: need ${future.length}s after ${base} but now is ${nowV}.` };
  }
  const renames = future.map((name, i) => {
    const to = formatVersion(new Date(baseMs + (i + 1) * 1000));
    return { oldName: name, oldVersion: versionOf(name), newVersion: to, newName: `${to}_${name.slice(15)}` };
  });
  return { renames, base };
}

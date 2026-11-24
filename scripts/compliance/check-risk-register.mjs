#!/usr/bin/env node
// scripts/compliance/check-risk-register.mjs
//
// Validates docs/compliance/risk-register.json and flags reviews that are missing or stale.
//
//   node scripts/compliance/check-risk-register.mjs                 # default: structure errors fail, process findings warn
//   node scripts/compliance/check-risk-register.mjs --strict        # any finding fails (use on release branches once owners and a first review exist)
//   node scripts/compliance/check-risk-register.mjs --today 2027-01-31 --file path/to/register.json --json
//
// Two classes of problem:
//   ERRORS    (always exit 1): invalid JSON/structure, duplicate ids, a source file or anchor that does not exist
//             (a risk must be traceable to a document in the repo), a control `ref` that does not exist, bad scores or dates.
//   FINDINGS  (warn; exit 1 only with --strict): never_reviewed, stale_review, unowned, unscored.
// Exit codes: 0 ok · 1 errors (or findings with --strict) · 2 bad usage.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_FILE = 'docs/compliance/risk-register.json';
export const ID_RE = /^RR-\d{3,4}$/;
export const AREAS = Object.freeze(['security', 'voice', 'billing', 'integrations', 'support', 'compliance']); // docs/OWNERS.md
const CATEGORIES = ['security', 'compliance', 'billing', 'availability', 'operational'];
const STATUSES = ['open', 'mitigating', 'accepted', 'closed'];
const CONTROL_STATUSES = ['documented', 'partial', 'gap'];
const DAY = 86_400_000;

const isRec = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v, min = 1) => typeof v === 'string' && v.trim().length >= min;

/** Strict YYYY-MM-DD -> UTC midnight Date, or null (rejects 2027-02-30 style overflow). */
export function parseDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
}
const fmt = (d) => d.toISOString().slice(0, 10);

function pathInRepo(root, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  return resolve(root, rel);
}

/** Returns { errors, findings, risks } for a parsed register. Pure apart from reading cited repo files. */
export function evaluate(reg, { today, root = ROOT } = {}) {
  const errors = [];
  const findings = [];
  const err = (id, msg) => errors.push({ id, msg });
  const add = (id, kind, msg) => findings.push({ id, kind, msg });
  if (!(today instanceof Date) || Number.isNaN(today.getTime())) throw new Error('today must be a valid Date');

  if (!isRec(reg)) return { errors: [{ id: '-', msg: 'register must be a JSON object' }], findings, risks: 0 };
  if (reg.schema !== 'vireek.risk-register/v1') err('-', `schema must be "vireek.risk-register/v1", got ${JSON.stringify(reg.schema)}`);
  const defInterval = reg.review?.default_interval_days;
  if (!Number.isInteger(defInterval) || defInterval < 1 || defInterval > 400) err('-', 'review.default_interval_days must be an integer 1..400');
  if (!Array.isArray(reg.risks) || reg.risks.length === 0) {
    err('-', 'risks must be a non-empty array');
    return { errors, findings, risks: 0 };
  }

  const seen = new Set();
  const checkSource = (id, src, label) => {
    if (!isRec(src) || !nonEmpty(src.path) || !nonEmpty(src.anchor)) return err(id, `${label} needs { path, anchor }`);
    const abs = pathInRepo(root, src.path);
    if (!abs || !existsSync(abs)) return err(id, `${label}.path does not exist in the repo: ${src.path}`);
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch { return err(id, `${label}.path is not a readable file: ${src.path}`); }
    if (!text.includes(src.anchor)) err(id, `${label}.anchor not found in ${src.path}: ${JSON.stringify(src.anchor)}`);
  };

  for (const [i, r] of reg.risks.entries()) {
    const id = isRec(r) && typeof r.id === 'string' ? r.id : `#${i + 1}`;
    if (!isRec(r)) { err(id, 'risk must be an object'); continue; }
    if (!ID_RE.test(String(r.id))) err(id, 'id must look like RR-001');
    else if (seen.has(r.id)) err(id, 'duplicate id');
    seen.add(r.id);
    if (!nonEmpty(r.title, 5)) err(id, 'title is required');
    if (!nonEmpty(r.description, 15)) err(id, 'description is required');
    if (!CATEGORIES.includes(r.category)) err(id, `category must be one of ${CATEGORIES.join(', ')}`);
    if (!STATUSES.includes(r.status)) err(id, `status must be one of ${STATUSES.join(', ')}`);

    checkSource(id, r.source, 'source');
    if (r.related_sources !== undefined) {
      if (!Array.isArray(r.related_sources)) err(id, 'related_sources must be an array');
      else r.related_sources.forEach((s, k) => checkSource(id, s, `related_sources[${k}]`));
    }

    // owner: the area must exist in docs/OWNERS.md vocabulary; person may be null (reported as a finding)
    const owner = r.owner;
    if (!isRec(owner) || !AREAS.includes(owner.area)) err(id, `owner.area must be one of ${AREAS.join(', ')}`);
    else if (owner.person !== null && !nonEmpty(owner.person, 2)) err(id, 'owner.person must be null or a name');

    for (const k of ['likelihood', 'impact']) {
      if (r[k] !== null && !(Number.isInteger(r[k]) && r[k] >= 1 && r[k] <= 5)) err(id, `${k} must be null or an integer 1..5`);
    }

    if (!Array.isArray(r.controls)) err(id, 'controls must be an array');
    else r.controls.forEach((c, k) => {
      if (!isRec(c) || !nonEmpty(c.description, 5)) return err(id, `controls[${k}].description is required`);
      if (!CONTROL_STATUSES.includes(c.status)) err(id, `controls[${k}].status must be one of ${CONTROL_STATUSES.join(', ')}`);
      if (c.ref !== undefined) {
        const abs = pathInRepo(root, c.ref);
        if (!abs || !existsSync(abs)) err(id, `controls[${k}].ref does not exist in the repo: ${String(c.ref)}`);
      }
    });

    let interval = defInterval;
    if (r.review_interval_days !== undefined) {
      if (!Number.isInteger(r.review_interval_days) || r.review_interval_days < 1 || r.review_interval_days > 400) err(id, 'review_interval_days must be an integer 1..400');
      else interval = r.review_interval_days;
    }

    const last = r.last_reviewed === null ? null : parseDay(r.last_reviewed);
    if (r.last_reviewed !== null && last === null) err(id, 'last_reviewed must be null or YYYY-MM-DD');
    if (last && last.getTime() > today.getTime()) err(id, `last_reviewed ${r.last_reviewed} is in the future`);

    // Findings are only meaningful for risks that are still being managed.
    if (r.status === 'closed') continue;
    if (r.last_reviewed === null) add(id, 'never_reviewed', `${r.title}: never reviewed`);
    else if (last && Number.isInteger(interval)) {
      const due = new Date(last.getTime() + interval * DAY);
      if (today.getTime() > due.getTime()) add(id, 'stale_review', `${r.title}: review was due ${fmt(due)} (${Math.floor((today.getTime() - due.getTime()) / DAY)} days overdue)`);
    }
    if (isRec(owner) && owner.person === null) add(id, 'unowned', `${r.title}: no named owner (area ${owner.area})`);
    if (r.likelihood === null || r.impact === null) add(id, 'unscored', `${r.title}: likelihood/impact not set`);
  }
  return { errors, findings, risks: reg.risks.length };
}

export function summary(findings) {
  const by = {};
  for (const f of findings) by[f.kind] = (by[f.kind] ?? 0) + 1;
  return by;
}

function main(argv) {
  const args = argv.slice(2);
  const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const strict = args.includes('--strict');
  const asJson = args.includes('--json');
  const file = val('--file') ?? DEFAULT_FILE;
  const todayArg = val('--today');
  const unknown = args.filter((a, i) => a.startsWith('--') && !['--strict', '--json', '--verbose', '--file', '--today'].includes(a));
  const today = todayArg ? parseDay(todayArg) : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  if (unknown.length || !today || (args.includes('--file') && !file) || (args.includes('--today') && !todayArg)) {
    console.error('usage: check-risk-register.mjs [--strict] [--json] [--verbose] [--file path] [--today YYYY-MM-DD]');
    return 2;
  }
  const abs = resolve(ROOT, file);
  let reg;
  try { reg = JSON.parse(readFileSync(abs, 'utf8')); } catch (e) {
    console.error(`::error file=${file}::cannot read or parse ${file}: ${e.message}`);
    return 1;
  }
  const { errors, findings, risks } = evaluate(reg, { today });
  const by = summary(findings);
  if (asJson) {
    console.log(JSON.stringify({ file, today: fmt(today), risks, errors, findings, summary: by }, null, 2));
  } else {
    for (const e of errors) console.log(`::error file=${file}::${e.id}: ${e.msg}`);
    const level = strict ? '::error' : '::warning';
    const verbose = args.includes('--verbose');
    for (const f of findings.filter((x) => verbose || x.kind === 'stale_review')) console.log(`${level} file=${file}::${f.id} ${f.kind}: ${f.msg}`);
    if (!verbose) {
      // One annotation per kind keeps CI readable when many risks share the same open question.
      for (const kind of Object.keys(by).filter((k) => k !== 'stale_review')) {
        const ids = findings.filter((x) => x.kind === kind).map((x) => x.id);
        console.log(`${level} file=${file}::${kind}: ${ids.length} risk(s) [${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', ...' : ''}] (use --verbose for details)`);
      }
    }
    const parts = Object.entries(by).map(([k, n]) => `${k}=${n}`).join(' ');
    console.log(`risk register: ${risks} risks, ${errors.length} errors, ${findings.length} findings${parts ? ` (${parts})` : ''} as of ${fmt(today)}`);
  }
  return errors.length > 0 || (strict && findings.length > 0) ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv));

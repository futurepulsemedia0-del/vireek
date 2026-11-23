#!/usr/bin/env node
// scripts/pricing/pricing-change-check.mjs
//
//   npm run pricing:change-check                      static check (local)
//   npm run pricing:change-check -- --base origin/main --require-base     CI (pull requests)
//   npm run pricing:change-check -- --fingerprint     print the current fingerprints (to fill a ledger entry)
//
// Pricing change control (docs/pricing/change-control.md):
//   Every change to a guarded pricing file needs a matching entry in docs/pricing/pricing-changes.json,
//   in the SAME pull request, carrying an approver and an effective date.
//
// What this check PROVES:   a well-formed, append-only ledger entry exists for the exact current content
//                           of each guarded file, naming an approver from the ledger's approvers list who is
//                           not the requester, with an effective date that respects the stated notice days.
// What it can NOT prove:    that the named person really approved. That is enforced by the pricing_changes
//                           approval workflow in the database and by Code Owners review on docs/pricing/**.
//
// Pure functions are exported for tests; the CLI at the bottom only does I/O. No dependencies.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEDGER_PATH = 'docs/pricing/pricing-changes.json';

/** `required: false` files are skipped when they do not exist in the checkout. */
export const GUARDED_FILES = [
  { path: 'src/lib/pricing.ts', required: true },
  { path: 'supabase/functions/_shared/billing/pricingCatalog.ts', required: false },
];

export const GRANDFATHERING = ['not_applicable', 'grandfathered', 'migrate_at_renewal', 'immediate'];
export const KINDS = ['baseline', 'change'];

const CHANGE_REF = /^PC-\d{4}-\d{4}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PLACEHOLDER = /replace|fill_me|todo|tbd|example\.(com|org)/i;

// ---------------------------------------------------------------------------
// Fingerprint: sha256 of the source with comments and insignificant whitespace removed, so reformatting and
// comment edits never need a ledger entry but any change to a value, string or code path does.
// ---------------------------------------------------------------------------

const isWord = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/** Removes comments and collapses whitespace outside string, template and regex literals. */
export function normalizeSource(src) {
  const s = String(src).replace(/\r\n?/g, '\n');
  let out = '';
  let pendingSpace = false;
  let i = 0;
  const lastOut = () => out[out.length - 1];
  const emit = (text) => {
    if (pendingSpace && isWord(lastOut()) && isWord(text[0])) out += ' ';
    pendingSpace = false;
    out += text;
  };

  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];

    if (c === '/' && n === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      pendingSpace = true;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      pendingSpace = true;
      continue;
    }
    if (/\s/.test(c)) {
      pendingSpace = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c && s[j] !== '\n') j += s[j] === '\\' ? 2 : 1;
      emit(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (depth === 0 && s[j] === '`') break;
        if (s[j] === '$' && s[j + 1] === '{') { depth++; j += 2; continue; }
        if (depth > 0 && s[j] === '}') depth--;
        j++;
      }
      emit(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '/') {
      const prev = lastOut();
      const prevWord = out.match(/[A-Za-z_$][\w$]*$/)?.[0];
      const startsRegex = prev === undefined || REGEX_PREV.has(prev) || prevWord === 'return' || prevWord === 'typeof';
      if (startsRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < s.length && s[j] !== '\n') {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === '[') inClass = true;
          else if (s[j] === ']') inClass = false;
          else if (s[j] === '/' && !inClass) break;
          j++;
        }
        j++;
        while (j < s.length && /[a-z]/i.test(s[j])) j++;
        emit(s.slice(i, j));
        i = j;
        continue;
      }
    }
    if (isWord(c)) {
      let j = i;
      while (j < s.length && isWord(s[j])) j++;
      emit(s.slice(i, j));
      i = j;
      continue;
    }
    emit(c);
    i++;
  }
  return out;
}

export const fingerprint = (src) => createHash('sha256').update(normalizeSource(src), 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Ledger validation
// ---------------------------------------------------------------------------

const isIsoDate = (v) => {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const dayNumber = (v) => Math.floor(Date.parse(`${v}T00:00:00Z`) / 86_400_000);
const isRealEmail = (v) => typeof v === 'string' && EMAIL.test(v) && !PLACEHOLDER.test(v);
const norm = (v) => String(v).trim().toLowerCase();

/** Structural + policy checks on a ledger object. Returns a list of error strings. */
export function validateLedger(ledger, guardedPaths = GUARDED_FILES.map((g) => g.path)) {
  const errors = [];
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return ['ledger: must be a JSON object'];
  if (ledger.schema_version !== 1) errors.push('ledger: schema_version must be 1');

  const approvers = Array.isArray(ledger.approvers) ? ledger.approvers : null;
  if (!approvers || approvers.length === 0) errors.push('ledger: "approvers" must be a non-empty array of emails');
  const approverSet = new Set();
  for (const a of approvers ?? []) {
    if (!isRealEmail(a)) errors.push(`ledger: approvers contains an invalid or placeholder email: ${JSON.stringify(a)}`);
    else approverSet.add(norm(a));
  }
  if (!Array.isArray(ledger.entries) || ledger.entries.length === 0) {
    errors.push('ledger: "entries" must be a non-empty array');
    return errors;
  }

  const seen = new Set();
  ledger.entries.forEach((e, idx) => {
    const id = e && typeof e.change_ref === 'string' ? e.change_ref : `entries[${idx}]`;
    const err = (m) => errors.push(`${id}: ${m}`);
    if (!e || typeof e !== 'object') return err('entry must be an object');
    if (!CHANGE_REF.test(String(e.change_ref ?? ''))) err('change_ref must look like PC-2026-0001');
    if (seen.has(e.change_ref)) err('duplicate change_ref');
    seen.add(e.change_ref);
    if (!KINDS.includes(e.kind)) err(`kind must be one of ${KINDS.join(', ')}`);
    if (typeof e.title !== 'string' || e.title.trim().length < 3) err('title is required (min 3 chars)');
    if (typeof e.summary !== 'string' || e.summary.trim().length < 10) err('summary is required (min 10 chars)');
    if (!GRANDFATHERING.includes(e.grandfathering)) err(`grandfathering must be one of ${GRANDFATHERING.join(', ')}`);

    if (!isRealEmail(e.approved_by)) err('approved_by must be a real email (placeholders are rejected)');
    else if (approverSet.size && !approverSet.has(norm(e.approved_by))) err('approved_by is not listed in ledger.approvers');
    if (e.kind === 'change') {
      if (!isRealEmail(e.requested_by)) err('requested_by must be a real email');
      else if (isRealEmail(e.approved_by) && norm(e.requested_by) === norm(e.approved_by)) err('requester and approver must be different people');
    }

    if (!isIsoDate(e.approved_at)) err('approved_at must be a valid YYYY-MM-DD date');
    if (!isIsoDate(e.effective_date)) err('effective_date must be a valid YYYY-MM-DD date');
    if (e.kind === 'change' && isIsoDate(e.approved_at) && isIsoDate(e.effective_date) && e.effective_date < e.approved_at) {
      err('effective_date cannot be earlier than approved_at');
    }

    const notice = e.notice;
    if (e.kind === 'change') {
      if (!notice || typeof notice.required !== 'boolean') err('notice.required (true/false) is required');
      else if (notice.required) {
        if (!Number.isInteger(notice.days) || notice.days < 0 || notice.days > 365) err('notice.days must be an integer 0-365 when notice.required is true');
        else if (isIsoDate(e.approved_at) && isIsoDate(e.effective_date) && dayNumber(e.effective_date) - dayNumber(e.approved_at) < notice.days) {
          err(`effective_date is less than notice.days (${notice.days}) after approved_at`);
        }
        if (notice.counsel_reviewed !== true) err('notice.counsel_reviewed must be true before a notice-requiring change can be approved [COUNSEL]');
      } else if (notice.days != null) err('notice.days must be omitted or null when notice.required is false');
    }

    const files = e.files;
    if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length === 0) err('files must map at least one guarded file to its fingerprint');
    else {
      for (const [p, fp] of Object.entries(files)) {
        if (!guardedPaths.includes(p)) err(`files: "${p}" is not a guarded file`);
        if (!SHA256.test(String(fp))) err(`files: fingerprint for "${p}" must be 64 lowercase hex characters`);
      }
    }
  });
  return errors;
}

// ---------------------------------------------------------------------------
// Full evaluation (pure): ledger vs current files, and head vs base for append-only + "changed => new entry"
// ---------------------------------------------------------------------------

/**
 * @param {object} i
 * @param {object|null} i.ledger          parsed head ledger (null = missing)
 * @param {Record<string,string|null>} i.current   path -> current content (null = file absent)
 * @param {object|null} [i.baseLedger]    parsed ledger at the base ref (null = did not exist there)
 * @param {Record<string,string|null>|null} [i.base]  path -> content at base (null entry = absent), or null when no base
 * @param {{path:string,required:boolean}[]} [i.guarded]
 */
export function evaluate({ ledger, current, baseLedger = null, base = null, guarded = GUARDED_FILES }) {
  const errors = [];
  const notes = [];
  if (!ledger) return { errors: [`${LEDGER_PATH} is missing - create it (see docs/pricing/change-control.md)`], notes };

  errors.push(...validateLedger(ledger, guarded.map((g) => g.path)));
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];

  for (const g of guarded) {
    const content = current[g.path];
    if (content == null) {
      if (g.required) errors.push(`${g.path}: guarded file not found`);
      else notes.push(`${g.path}: not present, skipped`);
      continue;
    }
    const fp = fingerprint(content);
    const last = [...entries].reverse().find((e) => e && e.files && e.files[g.path]);
    if (!last) errors.push(`${g.path}: no ledger entry covers this file. Current fingerprint ${fp}`);
    else if (last.files[g.path] !== fp) {
      errors.push(`${g.path}: changed without a matching ledger entry. Current fingerprint ${fp}, last recorded ${last.files[g.path]} (${last.change_ref}). Add a new entry to ${LEDGER_PATH}`);
    }
  }

  if (base) {
    const baseEntries = Array.isArray(baseLedger?.entries) ? baseLedger.entries : [];
    baseEntries.forEach((be, idx) => {
      const he = entries[idx];
      if (!he || JSON.stringify(he) !== JSON.stringify(be)) errors.push(`${be.change_ref ?? `entries[${idx}]`}: existing ledger entries are append-only; this one was edited or removed`);
    });
    const baseCount = baseEntries.length;
    for (const g of guarded) {
      const now = current[g.path];
      if (now == null) continue;
      const before = base[g.path];
      const changed = before == null ? true : fingerprint(before) !== fingerprint(now);
      if (!changed) continue;
      const fp = fingerprint(now);
      const added = entries.slice(baseCount).some((e) => e && e.files && e.files[g.path] === fp);
      if (!added) errors.push(`${g.path}: changed in this pull request but no NEW ledger entry (added after the base) records fingerprint ${fp}`);
    }
  }
  return { errors, notes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readIfExists(rel) {
  const p = path.join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function gitShow(ref, rel) {
  try {
    return execFileSync('git', ['show', `${ref}:${rel}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function refExists(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function parseJson(text, label, errors) {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    errors.push(`${label}: invalid JSON (${e.message})`);
    return null;
  }
}

function main(argv) {
  const args = new Set(argv);
  const baseIdx = argv.indexOf('--base');
  const baseRef = baseIdx >= 0 ? argv[baseIdx + 1] : process.env.PRICING_CHECK_BASE || null;
  const requireBase = args.has('--require-base');

  const current = {};
  for (const g of GUARDED_FILES) current[g.path] = readIfExists(g.path);

  if (args.has('--fingerprint')) {
    for (const g of GUARDED_FILES) console.log(`${g.path}  ${current[g.path] == null ? '(absent)' : fingerprint(current[g.path])}`);
    return 0;
  }

  const parseErrors = [];
  const ledger = parseJson(readIfExists(LEDGER_PATH), LEDGER_PATH, parseErrors);

  let base = null;
  let baseLedger = null;
  if (baseRef) {
    if (!refExists(baseRef)) {
      if (requireBase) {
        console.error(`pricing change check: FAILED - base ref "${baseRef}" is not available (checkout with fetch-depth: 0).`);
        return 1;
      }
      console.warn(`pricing change check: base ref "${baseRef}" not found, running the static check only.`);
    } else {
      base = {};
      for (const g of GUARDED_FILES) base[g.path] = gitShow(baseRef, g.path);
      baseLedger = parseJson(gitShow(baseRef, LEDGER_PATH), `${LEDGER_PATH}@${baseRef}`, parseErrors);
    }
  } else if (requireBase) {
    console.error('pricing change check: FAILED - --require-base was set but no --base ref was given.');
    return 1;
  }

  const { errors, notes } = evaluate({ ledger, current, baseLedger, base });
  const all = [...parseErrors, ...errors];
  for (const n of notes) console.log(`note: ${n}`);
  if (all.length) {
    console.error(`pricing change check: FAILED (${all.length})`);
    for (const e of all) console.error(`  - ${e}`);
    console.error('\nSee docs/pricing/change-control.md. `npm run pricing:change-check -- --fingerprint` prints the values to record.');
    return 1;
  }
  console.log(`pricing change check: PASSED${base ? ` (compared with ${baseRef})` : ' (static; no base ref)'}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

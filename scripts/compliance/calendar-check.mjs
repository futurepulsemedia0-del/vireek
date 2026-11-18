#!/usr/bin/env node
// scripts/compliance/calendar-check.mjs
//
// Validates docs/compliance/regulatory-calendar.json, keeps its readable
// rendering (docs/compliance/regulatory-calendar.md) in sync, and reports
// reviews that are overdue or due soon.
//
//   node scripts/compliance/calendar-check.mjs                 validate + md in sync + overdue check (= --check)
//   node scripts/compliance/calendar-check.mjs --write         regenerate the .md, then check
//   node scripts/compliance/calendar-check.mjs --today 2027-03-01   pretend today is that UTC date
//   node scripts/compliance/calendar-check.mjs --warn-days 30       "due soon" window (default 14)
//   node scripts/compliance/calendar-check.mjs --allow-overdue      overdue is reported but is not a failure (PR validation)
//   node scripts/compliance/calendar-check.mjs --strict             owner placeholders (@OWNER_*) become errors
//   node scripts/compliance/calendar-check.mjs --report-file out.md write a GitHub-issue body when anything is overdue
//   node scripts/compliance/calendar-check.mjs --json               machine-readable result on stdout
//
// Exit codes: 0 ok | 1 invalid registry / stale .md / bad usage | 3 at least one review overdue.
//
// What this proves: the registry is well formed, every entry cites text that
// really exists in a repo doc, and no review date has passed. What it does NOT
// prove: that any legal statement is correct. Every entry is [COUNSEL]; this
// file is a reminder system, not legal advice.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const CALENDAR_PATH = 'docs/compliance/regulatory-calendar.json';
export const CALENDAR_MD_PATH = 'docs/compliance/regulatory-calendar.md';
export const CALENDAR_SCHEMA = 'vireek.regulatory-calendar/v1';

export const CATEGORIES = Object.freeze(['privacy', 'ai', 'accessibility', 'telecom', 'labor', 'financing']);
export const CATEGORY_TITLES = Object.freeze({
  privacy: 'Privacy',
  ai: 'AI',
  accessibility: 'Accessibility',
  telecom: 'Telecom',
  labor: 'Labor',
  financing: 'Financing',
});

export const EXIT_OK = 0;
export const EXIT_INVALID = 1;
export const EXIT_OVERDUE = 3;
export const DEFAULT_WARN_DAYS = 14;

const ID_RE = /^[a-z][a-z0-9-]{2,60}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FLAGS = Object.freeze(['[COUNSEL]', '[VERIFY]']);
const ENTRY_KEYS = new Set([
  'id', 'regulation', 'category', 'jurisdiction', 'applies_to_features', 'owner', 'flags',
  'last_reviewed', 'last_reviewed_by', 'next_review', 'review_interval_days', 'sources', 'notes',
]);

// ---------------------------------------------------------------- dates (UTC, day precision)

/** 'YYYY-MM-DD' -> days since epoch, or null if it is not a real calendar date. */
export function dayNumber(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / 86_400_000);
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- validation

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/** Repo-relative path, no traversal, no absolute path. */
export function isSafeRelativePath(p) {
  if (!isNonEmptyString(p) || isAbsolute(p) || p.includes('\\') || p.includes('\0')) return false;
  return !p.split('/').some((seg) => seg === '..' || seg === '');
}

/**
 * @param {any} cal parsed regulatory-calendar.json
 * @param {{ readText?: (relPath: string) => string | null, today?: string, strict?: boolean }} [opts]
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateCalendar(cal, { readText = defaultReadText, today = todayUtc(), strict = false } = {}) {
  const errors = [];
  const warnings = [];
  const todayN = dayNumber(today);

  if (cal === null || typeof cal !== 'object' || Array.isArray(cal)) {
    return { errors: ['calendar: root must be an object'], warnings };
  }
  if (cal.schema !== CALENDAR_SCHEMA) errors.push(`calendar: schema must be "${CALENDAR_SCHEMA}"`);
  if (!isNonEmptyString(cal.disclaimer)) errors.push('calendar: disclaimer is required');
  if (!Array.isArray(cal.entries) || cal.entries.length === 0) {
    errors.push('calendar: entries must be a non-empty array');
    return { errors, warnings };
  }

  const seen = new Set();
  const perCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  const placeholderOwners = [];

  cal.entries.forEach((e, i) => {
    const at = `entries[${i}]${e && typeof e.id === 'string' ? ` (${e.id})` : ''}`;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) errors.push(`${at}: unknown field "${k}"`);

    if (!ID_RE.test(e.id ?? '')) errors.push(`${at}: id must match ${ID_RE}`);
    else if (seen.has(e.id)) errors.push(`${at}: duplicate id`);
    else seen.add(e.id);

    if (!isNonEmptyString(e.regulation)) errors.push(`${at}: regulation is required`);
    if (!CATEGORIES.includes(e.category)) errors.push(`${at}: category must be one of ${CATEGORIES.join(', ')}`);
    else perCategory[e.category] += 1;
    if (!isNonEmptyString(e.jurisdiction)) errors.push(`${at}: jurisdiction is required`);

    if (!Array.isArray(e.applies_to_features) || e.applies_to_features.length === 0 || !e.applies_to_features.every(isNonEmptyString)) {
      errors.push(`${at}: applies_to_features must be a non-empty array of non-empty strings`);
    }

    if (!isNonEmptyString(e.owner)) errors.push(`${at}: owner is required`);
    else if (/@OWNER_/.test(e.owner)) placeholderOwners.push(e.owner);

    if (!Array.isArray(e.flags) || !e.flags.every((f) => FLAGS.includes(f)) || !e.flags.includes('[COUNSEL]')) {
      errors.push(`${at}: flags must contain "[COUNSEL]" and only ${FLAGS.join(' / ')}`);
    }

    const lastN = e.last_reviewed === null ? null : dayNumber(e.last_reviewed);
    if (e.last_reviewed !== null && lastN === null) errors.push(`${at}: last_reviewed must be null or a real YYYY-MM-DD date`);
    if (e.last_reviewed === undefined) errors.push(`${at}: last_reviewed is required (use null if never reviewed)`);
    if (lastN !== null) {
      if (!isNonEmptyString(e.last_reviewed_by)) errors.push(`${at}: last_reviewed_by is required when last_reviewed is set`);
      if (todayN !== null && lastN > todayN) errors.push(`${at}: last_reviewed is in the future`);
    } else if (e.last_reviewed_by !== undefined && e.last_reviewed_by !== null) {
      errors.push(`${at}: last_reviewed_by must be absent/null when last_reviewed is null`);
    }

    const nextN = dayNumber(e.next_review);
    if (nextN === null) errors.push(`${at}: next_review must be a real YYYY-MM-DD date`);
    else if (lastN !== null && nextN < lastN) errors.push(`${at}: next_review is before last_reviewed`);

    if (e.review_interval_days !== undefined && !(Number.isInteger(e.review_interval_days) && e.review_interval_days >= 7 && e.review_interval_days <= 730)) {
      errors.push(`${at}: review_interval_days must be an integer between 7 and 730`);
    }

    if (!Array.isArray(e.sources) || e.sources.length === 0) {
      errors.push(`${at}: sources must be a non-empty array (the registry is seeded only from laws already referenced in repo docs)`);
    } else {
      e.sources.forEach((s, j) => {
        const sat = `${at}.sources[${j}]`;
        if (s === null || typeof s !== 'object') return errors.push(`${sat}: must be an object`);
        if (!isSafeRelativePath(s.path)) return errors.push(`${sat}: path must be a safe repo-relative path`);
        if (!isNonEmptyString(s.quote)) return errors.push(`${sat}: quote is required`);
        const text = readText(s.path);
        if (text === null) errors.push(`${sat}: ${s.path} does not exist`);
        else if (!text.includes(s.quote)) errors.push(`${sat}: text "${s.quote}" not found in ${s.path} (doc changed? update the entry or the quote)`);
      });
    }

    if (e.notes !== undefined && typeof e.notes !== 'string') errors.push(`${at}: notes must be a string`);
  });

  if (placeholderOwners.length > 0) {
    (strict ? errors : warnings).push(`${placeholderOwners.length} entr${placeholderOwners.length === 1 ? 'y has' : 'ies have'} a placeholder owner (@OWNER_*); replace it together with CODEOWNERS (${[...new Set(placeholderOwners)].join(', ')})`);
  }
  for (const c of CATEGORIES) if (perCategory[c] === 0) errors.push(`calendar: no entry for category "${c}"`);
  return { errors, warnings };
}

// ---------------------------------------------------------------- overdue logic

/**
 * An entry is overdue when next_review is strictly before today (a review
 * due today is still on time).
 * @returns {{ overdue: any[], dueSoon: any[] }} each sorted by next_review then id
 */
export function evaluateReviews(entries, today, warnDays = DEFAULT_WARN_DAYS) {
  const todayN = dayNumber(today);
  if (todayN === null) throw new Error(`evaluateReviews: invalid today "${today}"`);
  const overdue = [];
  const dueSoon = [];
  for (const e of entries) {
    const n = dayNumber(e.next_review);
    if (n === null) continue; // reported by validateCalendar
    if (n < todayN) overdue.push({ ...e, daysOverdue: todayN - n });
    else if (n - todayN <= warnDays) dueSoon.push({ ...e, daysLeft: n - todayN });
  }
  const byDue = (a, b) => (a.next_review < b.next_review ? -1 : a.next_review > b.next_review ? 1 : a.id < b.id ? -1 : 1);
  overdue.sort(byDue);
  dueSoon.sort(byDue);
  return { overdue, dueSoon };
}

// ---------------------------------------------------------------- rendering

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Deterministic markdown (no timestamps, nothing relative to "today"). */
export function renderMarkdown(cal) {
  const out = [];
  out.push('# Regulatory calendar');
  out.push('');
  out.push('<!-- GENERATED from docs/compliance/regulatory-calendar.json. Do not edit by hand: run `npm run compliance:calendar:write`. -->');
  out.push('');
  out.push(`> ${cal.disclaimer}`);
  out.push('');
  out.push('Every entry is **[COUNSEL]**: nothing here has been confirmed by a lawyer. Entries are seeded only from laws that are already referenced in repo docs (see *Sources*). `[VERIFY]` marks a fact that still needs checking. A review is overdue when `next_review` is before today; `scripts/compliance/calendar-check.mjs` and `.github/workflows/regulatory-calendar.yml` enforce that.');
  out.push('');
  out.push(`Entries: ${cal.entries.length}. Owners that are still \`@OWNER_*\` placeholders must be replaced together with CODEOWNERS.`);
  out.push('');
  for (const cat of CATEGORIES) {
    const rows = cal.entries.filter((e) => e.category === cat);
    if (rows.length === 0) continue;
    out.push(`## ${CATEGORY_TITLES[cat]}`);
    out.push('');
    out.push('| ID | Regulation | Jurisdiction | Applies to feature | Owner | Last reviewed | Next review | Flags |');
    out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const e of rows) {
      const last = e.last_reviewed ? `${e.last_reviewed} (${e.last_reviewed_by})` : 'never';
      out.push(
        `| \`${e.id}\` | ${esc(e.regulation)} | ${esc(e.jurisdiction)} | ${esc(e.applies_to_features.join('; '))} | ${esc(e.owner)} | ${esc(last)} | ${e.next_review} | ${e.flags.join(' ')} |`,
      );
    }
    out.push('');
  }
  out.push('## Sources and notes');
  out.push('');
  for (const e of cal.entries) {
    out.push(`### \`${e.id}\``);
    out.push('');
    for (const s of e.sources) out.push(`- Source: \`${s.path}\` — "${s.quote.replace(/\r?\n/g, ' ')}"`);
    if (e.notes) out.push(`- Note: ${e.notes.replace(/\r?\n/g, ' ')}`);
    out.push('');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/** GitHub issue body for the scheduled workflow. */
export function renderIssueBody({ overdue, dueSoon }, today) {
  const line = (e, tail) => `- \`${e.id}\` — ${e.regulation} (${e.jurisdiction}) · owner ${e.owner} · next review ${e.next_review} · ${tail}`;
  const out = [];
  out.push(`Regulatory calendar check on ${today} (UTC).`);
  out.push('');
  out.push(`**${overdue.length} review(s) overdue.** Each is [COUNSEL]: have counsel review it, then update \`last_reviewed\`, \`last_reviewed_by\` and \`next_review\` in \`docs/compliance/regulatory-calendar.json\` and run \`npm run compliance:calendar:write\`.`);
  out.push('');
  for (const e of overdue) out.push(line(e, `${e.daysOverdue} day(s) overdue`));
  if (dueSoon.length > 0) {
    out.push('');
    out.push('Due soon:');
    for (const e of dueSoon) out.push(line(e, `due in ${e.daysLeft} day(s)`));
  }
  out.push('');
  out.push('_Opened by `.github/workflows/regulatory-calendar.yml`. This is a reminder, not legal advice._');
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------- IO helpers

function defaultReadText(relPath) {
  if (!isSafeRelativePath(relPath)) return null;
  const abs = join(REPO_ROOT, relPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

export function loadCalendar(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, CALENDAR_PATH), 'utf8'));
}

// ---------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const o = { write: false, allowOverdue: false, strict: false, json: false, today: null, warnDays: DEFAULT_WARN_DAYS, reportFile: null, errors: [] };
  const takeValue = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      o.errors.push(`${name} needs a value`);
      return null;
    }
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') continue;
    else if (a === '--write') o.write = true;
    else if (a === '--allow-overdue') o.allowOverdue = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--json') o.json = true;
    else if (a === '--today') {
      o.today = takeValue(i, a);
      i += 1;
    } else if (a === '--warn-days') {
      const v = takeValue(i, a);
      i += 1;
      const n = Number(v);
      if (v !== null && (!Number.isInteger(n) || n < 0 || n > 365)) o.errors.push('--warn-days must be an integer 0-365');
      else if (v !== null) o.warnDays = n;
    } else if (a === '--report-file') {
      o.reportFile = takeValue(i, a);
      i += 1;
    } else o.errors.push(`unknown argument ${a}`);
  }
  if (o.today !== null && dayNumber(o.today) === null) o.errors.push('--today must be a real YYYY-MM-DD date');
  return o;
}

export function run(argv, { root = REPO_ROOT, log = console.log, err = console.error } = {}) {
  const args = parseArgs(argv);
  if (args.errors.length > 0) {
    for (const m of args.errors) err(`calendar-check: ${m}`);
    return EXIT_INVALID;
  }
  const today = args.today ?? todayUtc();
  const readText = (p) => {
    if (!isSafeRelativePath(p)) return null;
    const abs = join(root, p);
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  };

  let cal;
  try {
    cal = loadCalendar(root);
  } catch (e) {
    err(`calendar-check: cannot read ${CALENDAR_PATH}: ${e.message}`);
    return EXIT_INVALID;
  }

  const { errors, warnings } = validateCalendar(cal, { readText, today, strict: args.strict });
  for (const w of warnings) err(`warning: ${w}`);
  if (errors.length > 0) {
    for (const m of errors) err(`error: ${m}`);
    err(`calendar-check: ${errors.length} error(s) in ${CALENDAR_PATH}`);
    return EXIT_INVALID;
  }

  const md = renderMarkdown(cal);
  const mdAbs = join(root, CALENDAR_MD_PATH);
  if (args.write) writeFileSync(mdAbs, md);
  else {
    const current = existsSync(mdAbs) ? readFileSync(mdAbs, 'utf8') : null;
    if (current !== md) {
      err(`error: ${CALENDAR_MD_PATH} is ${current === null ? 'missing' : 'stale'}; run: npm run compliance:calendar:write`);
      return EXIT_INVALID;
    }
  }

  const result = evaluateReviews(cal.entries, today, args.warnDays);
  if (args.json) {
    log(JSON.stringify({
      today,
      entries: cal.entries.length,
      overdue: result.overdue.map((e) => ({ id: e.id, next_review: e.next_review, daysOverdue: e.daysOverdue, owner: e.owner })),
      dueSoon: result.dueSoon.map((e) => ({ id: e.id, next_review: e.next_review, daysLeft: e.daysLeft, owner: e.owner })),
    }));
  } else {
    for (const e of result.dueSoon) log(`due soon: ${e.id} (${e.next_review}, in ${e.daysLeft} day(s)) owner ${e.owner}`);
    for (const e of result.overdue) log(`OVERDUE: ${e.id} (${e.next_review}, ${e.daysOverdue} day(s) late) owner ${e.owner}`);
    log(`calendar-check: ${cal.entries.length} entries, ${result.overdue.length} overdue, ${result.dueSoon.length} due within ${args.warnDays} day(s) (today ${today}).`);
  }

  if (result.overdue.length > 0 && args.reportFile) writeFileSync(args.reportFile, renderIssueBody(result, today));
  if (result.overdue.length > 0 && !args.allowOverdue) return EXIT_OVERDUE;
  return EXIT_OK;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}

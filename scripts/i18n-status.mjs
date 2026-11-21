#!/usr/bin/env node
/**
 * Language launch status: runs the i18n coverage + freshness gates, adds the facts they do not print, and renders
 * docs/i18n/status.md. Deterministic (no timestamps) so `--check` can detect a stale document.
 *
 *   node scripts/i18n-status.mjs --write   regenerate docs/i18n/status.md
 *   node scripts/i18n-status.mjs --check   CI gate. Fails when
 *                                            - docs/i18n/status.md is stale,
 *                                            - a language shows no Beta label although automated launch facts are unmet,
 *                                            - a language is listed in OUTBOUND_COMPLIANCE_LANGUAGES without its reviewed keys,
 *                                            - reviewed-keys.json is malformed or references keys that do not exist.
 *   node scripts/i18n-status.mjs --json    machine-readable status on stdout
 *
 * What is automated vs. manual
 *  - Automated (this script): coverage, placeholder integrity, stale/untracked keys, reviewed-key sign-off.
 *  - Manual (never inferred here): counsel approval [COUNSEL], native reviewer name/date, pseudo-localization,
 *    PDF fonts, support macros. They stay "NOT VERIFIED" in the document; the Beta label can only be dropped by a
 *    person setting `beta: false` in src/i18n/locales.config.ts AFTER those are done AND the automated facts hold.
 *
 * Node >= 18. Needs the project's `typescript` (same as the other i18n scripts).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTs } from './lib/load-ts.mjs';

const STATUS_FILE = 'docs/i18n/status.md';
const CONSENT_NS = 'consent';

// ----------------------------------------------------------------------------- pure helpers
export const flat = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));

export const hash = (v) => crypto.createHash('sha1').update(String(v)).digest('hex').slice(0, 8);

/** Same buckets as HUMAN_REVIEW_REQUIRED_KEYS in locales.config.ts, split so the status can be read by topic. */
export function categoryOf(id) {
  if (/^consent\./.test(id)) return 'consent';
  if (/(^|\.)aiDisclosure(\.|$)/.test(id)) return 'ai-disclosure';
  if (/(^|\.)(recording|recordingConsent)(\.|$)/i.test(id)) return 'recording';
  if (/(^|\.)(emergency|safety)(\.|$)/i.test(id)) return 'emergency';
  if (/(^|\.)(optOut|smsStop|smsHelp)(\.|$)/i.test(id)) return 'opt-out';
  if (/(^|\.)(terms|privacy|legalNotice|disclaimer)(\.|$)/i.test(id)) return 'legal';
  if (/(^|\.)(nte|commitment|guarantee|warranty|priceQuote)(\.|$)/i.test(id)) return 'commitments';
  return 'other';
}
export const CATEGORY_ORDER = ['consent', 'ai-disclosure', 'recording', 'emergency', 'opt-out', 'legal', 'commitments', 'other'];

const pct = (n, d) => (d === 0 ? 100 : Math.floor((n / d) * 1000) / 10); // floor: never round a gap up to a pass
const fmtPct = (x) => `${x.toFixed(1)}%`;

// ----------------------------------------------------------------------------- facts collection (I/O)
function nsFile(root, lang, ns) {
  return ns === CONSENT_NS ? path.join(root, 'src/locales', CONSENT_NS, `${lang}.json`) : path.join(root, 'src/locales', lang, `${ns}.json`);
}
function readNs(root, lang, ns) {
  const f = nsFile(root, lang, ns);
  return fs.existsSync(f) ? new Map(flat(JSON.parse(fs.readFileSync(f, 'utf8')))) : null;
}

function runScript(root, script, args) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { exit: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Gathers plain-data facts from the repository. No judgement here: that is `evaluate`. */
export async function collect(root) {
  const cfg = await loadTs(path.join(root, 'src/i18n/locales.config.ts'));
  const outbound = await loadTs(path.join(root, 'supabase/functions/_shared/i18n/outboundCompliance.ts'));
  const { LOCALES, LOCALE_CODES } = cfg;
  const enDir = path.join(root, 'src/locales/en');
  const fileNs = fs.readdirSync(enDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  const hasConsent = fs.existsSync(nsFile(root, 'en', CONSENT_NS));
  const nsNames = hasConsent ? [...fileNs, CONSENT_NS] : fileNs;

  const en = {};
  for (const ns of nsNames) en[ns] = [...readNs(root, 'en', ns).keys()];
  const reviewIds = [];
  for (const ns of nsNames) for (const k of en[ns]) if (cfg.isHumanReviewRequired(`${ns}.${k}`)) reviewIds.push(`${ns}.${k}`);

  const reviewedFile = path.join(root, 'docs/i18n/reviewed-keys.json');
  let manifest = {};
  let manifestError = null;
  try { manifest = JSON.parse(fs.readFileSync(reviewedFile, 'utf8')); } catch (e) { manifestError = `docs/i18n/reviewed-keys.json: ${e.message}`; }

  const stateFile = path.join(root, 'docs/i18n/translation-state.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};

  const tr = {};
  const freshness = {};
  for (const code of LOCALE_CODES) {
    if (code === 'en') continue;
    tr[code] = {};
    const stale = [];
    const untrackedByNs = {};
    let untracked = 0;
    for (const ns of nsNames) {
      const m = readNs(root, code, ns);
      if (!m) { tr[code][ns] = null; continue; }
      const enMap = readNs(root, 'en', ns);
      const present = [];
      for (const k of enMap.keys()) {
        if (!m.has(k)) continue;
        present.push(k);
        const rec = state[code]?.[`${ns}:${k}`];
        if (rec === undefined) { untracked++; untrackedByNs[ns] = (untrackedByNs[ns] ?? 0) + 1; }
        else if (rec !== hash(enMap.get(k))) stale.push(`${ns}:${k}`);
      }
      tr[code][ns] = present;
    }
    freshness[code] = { stale, untracked, untrackedByNs };
  }

  const cov = runScript(root, 'i18n-coverage.mjs', ['--json']);
  let coverageGate;
  try { const j = JSON.parse(cov.stdout); coverageGate = { exit: cov.exit, report: j.report, problems: j.problems, pending: j.pending }; }
  catch { throw new Error(`i18n-coverage.mjs --json did not return JSON (exit ${cov.exit}): ${cov.stderr.slice(0, 400)}`); }

  const fr = runScript(root, 'i18n-freshness.mjs', []);
  const scriptFresh = {};
  for (const line of fr.stdout.split('\n')) {
    const m = /^(\w+) \(tier (\w+)\): stale=(\d+) untracked=(\d+)/.exec(line);
    if (m) scriptFresh[m[1]] = { stale: Number(m[3]), untracked: Number(m[4]) };
  }
  const freshnessGate = { exit: fr.exit, scriptFresh };

  const locales = {};
  const requiredNs = {};
  const surfaces = {};
  for (const code of LOCALE_CODES) {
    locales[code] = { ...LOCALES[code] };
    requiredNs[code] = nsNames.filter((ns) => LOCALES[code].surfaces.includes(cfg.surfaceOfNamespace(ns)));
  }
  for (const ns of nsNames) surfaces[ns] = cfg.surfaceOfNamespace(ns);

  const serverKeys = {};
  for (const code of LOCALE_CODES) serverKeys[code] = outbound.serverComplianceKeys(code);

  return {
    codes: [...LOCALE_CODES], locales, nsNames, surfaces, requiredNs, en, tr, reviewIds, manifest, manifestError, freshness,
    coverageGate, freshnessGate,
    outbound: { enabled: [...outbound.OUTBOUND_COMPLIANCE_LANGUAGES], categories: [...outbound.OUTBOUND_CATEGORIES], serverKeys, fallback: outbound.OUTBOUND_FALLBACK_LANGUAGE },
  };
}

// ----------------------------------------------------------------------------- evaluation (pure)
export function evaluate(facts) {
  const reviewSet = new Set(facts.reviewIds);
  const outboundIds = facts.reviewIds.filter((id) => facts.outbound.categories.includes(categoryOf(id)));
  const errors = [];
  if (facts.manifestError) errors.push(facts.manifestError);

  const langs = [];
  for (const code of facts.codes) {
    if (code === 'en') continue;
    const L = facts.locales[code];
    const required = new Set(facts.requiredNs[code] ?? []);
    const trNs = facts.tr[code] ?? {};
    const reviewedList = Array.isArray(facts.manifest?.[code]) ? facts.manifest[code] : [];
    const reviewed = new Set(reviewedList);
    if (facts.manifest && code in facts.manifest && !Array.isArray(facts.manifest[code])) errors.push(`reviewed-keys.json: "${code}" must be an array of "namespace.key" strings`);

    const namespaces = facts.nsNames.map((name) => {
      const total = facts.en[name].length;
      const present = trNs[name] ? trNs[name].length : 0;
      const have = new Set(trNs[name] ?? []);
      const missingKeys = required.has(name) && have.size < total ? facts.en[name].filter((k) => !have.has(k)) : [];
      return { name, surface: facts.surfaces[name], required: required.has(name), total, present, missing: total - present, coverage: pct(present, total), fileMissing: !trNs[name], missingKeys };
    });
    const req = namespaces.filter((n) => n.required);
    const reqTotals = { total: req.reduce((a, n) => a + n.total, 0), present: req.reduce((a, n) => a + n.present, 0) };
    reqTotals.coverage = req.length ? pct(reqTotals.present, reqTotals.total) : 0;
    const all = { total: namespaces.reduce((a, n) => a + n.total, 0), present: namespaces.reduce((a, n) => a + n.present, 0) };
    all.coverage = pct(all.present, all.total);

    const gateProblems = facts.coverageGate.problems.filter((p) => p.replace(/^\[strict\] /, '').startsWith(`${code}/`));
    const ownCoverageProblems = req
      .filter((n) => n.coverage / 100 < L.minCoverage && !gateProblems.some((g) => g.startsWith(`${code}/${n.name}: coverage`)))
      .map((n) => `${code}/${n.name}: coverage ${fmtPct(n.coverage)} < required ${(L.minCoverage * 100).toFixed(0)}% (status; not reported by i18n-coverage.mjs)`);
    const coverageOk = req.length > 0 && gateProblems.length === 0 && ownCoverageProblems.length === 0;

    const translated = new Set();
    for (const ns of facts.nsNames) for (const k of trNs[ns] ?? []) translated.add(`${ns}.${k}`);
    const byCategory = {};
    for (const id of facts.reviewIds) {
      const c = categoryOf(id);
      const b = (byCategory[c] ??= { total: 0, translated: 0, reviewed: 0 });
      b.total++;
      if (translated.has(id)) b.translated++;
      if (translated.has(id) && reviewed.has(id)) b.reviewed++;
    }
    const strictBlockers = facts.reviewIds.filter((id) => required.has(id.split('.')[0]) && translated.has(id) && !reviewed.has(id));
    const orphans = reviewedList.filter((id) => typeof id !== 'string' || !(reviewSet.has(id) || id.startsWith('server.')));
    const unknownServer = reviewedList.filter((id) => typeof id === 'string' && id.startsWith('server.') && !(facts.outbound.serverKeys[code] ?? []).includes(id));
    for (const o of orphans) errors.push(`reviewed-keys.json: ${code}: "${String(o)}" is not a human-review-required key that exists in English`);
    for (const o of unknownServer) errors.push(`reviewed-keys.json: ${code}: "${o}" is not a server compliance key for ${code}`);
    const trBlocked = facts.reviewIds.filter((id) => !translated.has(id)).length;

    const fresh = facts.freshness[code] ?? { stale: [], untracked: 0 };
    const staleCovered = fresh.stale.filter((id) => required.has(id.split(':')[0]));
    const scriptFresh = facts.freshnessGate.scriptFresh?.[code];
    if (scriptFresh && scriptFresh.stale !== fresh.stale.length) errors.push(`${code}: freshness script reports stale=${scriptFresh.stale} but status computed ${fresh.stale.length}`);
    // A translation without a freshness record on a covered surface cannot be proven fresh.
    const untrackedCovered = [...required].reduce((a, ns) => a + (fresh.untrackedByNs?.[ns] ?? 0), 0);
    const freshOk = staleCovered.length === 0 && untrackedCovered === 0;

    const betaReasons = [];
    if (!coverageOk) betaReasons.push('coverage gate not met');
    if (strictBlockers.length) betaReasons.push(`${strictBlockers.length} legal/consent/emergency/AI-disclosure key(s) awaiting reviewer sign-off`);
    if (staleCovered.length) betaReasons.push(`${staleCovered.length} stale key(s) on covered surfaces`);
    if (untrackedCovered > 0) betaReasons.push(`${untrackedCovered} translation(s) on covered surfaces have no freshness record`);
    const betaRequired = L.tier !== 'source' && betaReasons.length > 0;
    const betaMismatch = !L.beta && betaRequired;
    if (betaMismatch) errors.push(`${code}: config shows no Beta label but automated launch facts are unmet (${betaReasons.join('; ')}). Set beta: true in src/i18n/locales.config.ts.`);

    const blockers = [...new Set([...outboundIds, ...(facts.outbound.serverKeys[code] ?? [])])].filter((id) => !reviewed.has(id)).sort();
    const outboundEnabled = facts.outbound.enabled.includes(code);
    if (outboundEnabled && blockers.length) errors.push(`${code}: listed in OUTBOUND_COMPLIANCE_LANGUAGES but ${blockers.length} reviewed key(s) are missing from docs/i18n/reviewed-keys.json (${blockers.slice(0, 5).join(', ')}${blockers.length > 5 ? ', …' : ''})`);

    langs.push({
      code, tier: L.tier, review: L.review, minCoverage: L.minCoverage, surfaces: L.surfaces, frozen: !!L.frozen,
      requiredNamespaces: [...required], namespaces, required: reqTotals, all,
      gate: { coverage: coverageOk, strict: strictBlockers.length === 0, freshness: freshOk, freshnessState: staleCovered.length ? 'FAIL' : untrackedCovered ? 'UNVERIFIED' : 'PASS', coverageProblems: [...gateProblems, ...ownCoverageProblems] },
      fresh: { stale: fresh.stale, staleCovered, untracked: fresh.untracked, untrackedCovered },
      reviewed: { total: facts.reviewIds.length, translated: facts.reviewIds.length - trBlocked, reviewed: facts.reviewIds.filter((id) => translated.has(id) && reviewed.has(id)).length, byCategory, strictBlockers, orphans },
      beta: { config: L.beta, required: betaRequired, mismatch: betaMismatch, reasons: betaReasons },
      outbound: { enabled: outboundEnabled, required: outboundIds.length + (facts.outbound.serverKeys[code] ?? []).length, blockers, ready: blockers.length === 0 },
    });
  }

  const unknownManifestLangs = Object.keys(facts.manifest ?? {}).filter((k) => !k.startsWith('_') && !facts.codes.includes(k));
  for (const k of unknownManifestLangs) errors.push(`reviewed-keys.json: unknown language "${k}"`);
  for (const code of facts.outbound.enabled) if (!facts.codes.includes(code)) errors.push(`OUTBOUND_COMPLIANCE_LANGUAGES lists unknown language "${code}"`);
  if (!facts.outbound.enabled.includes(facts.outbound.fallback)) errors.push('OUTBOUND_COMPLIANCE_LANGUAGES must contain the fallback language (en)');

  return {
    langs, errors, outboundKeyCount: outboundIds.length, reviewKeyCount: facts.reviewIds.length,
    gates: { coverage: { exit: facts.coverageGate.exit, problems: facts.coverageGate.problems, pending: facts.coverageGate.pending }, freshness: { exit: facts.freshnessGate.exit } },
  };
}

// ----------------------------------------------------------------------------- rendering (pure)
const yn = (b) => (b ? 'PASS' : 'FAIL');
const mdEsc = (s) => String(s).replace(/\|/g, '\\|');

export function renderStatusMd(status) {
  const L = [];
  L.push('# Language launch status', '');
  L.push('> Generated by `node scripts/i18n-status.mjs --write` from the real locale files, `docs/i18n/reviewed-keys.json`, `docs/i18n/translation-state.json`, `src/i18n/locales.config.ts` and the output of `npm run i18n:coverage` / `npm run i18n:freshness`. Do not edit by hand. CI runs `node scripts/i18n-status.mjs --check`.', '');
  L.push('Checklist: [`launch-checklist.md`](./launch-checklist.md). English is the source language and is not listed.', '');

  L.push('## Summary', '');
  L.push('| Lang | Tier | Required coverage | Coverage gate | Strict review | Freshness | Reviewed / translated (all) | Beta (config → required) | Outbound compliance |');
  L.push('|---|---|---:|---|---|---|---:|---|---|');
  for (const l of status.langs) {
    const beta = `${l.beta.config ? 'Beta' : 'no Beta'} → ${l.beta.required ? 'Beta' : 'eligible*'}${l.beta.mismatch ? ' ⚠' : ''}`;
    const ob = l.outbound.enabled ? (l.outbound.ready ? 'enabled' : 'enabled ⚠ MISSING KEYS') : `blocked (${l.outbound.required - l.outbound.blockers.length}/${l.outbound.required} reviewed)`;
    L.push(`| ${l.code} | ${l.tier} | ${l.requiredNamespaces.length ? `${fmtPct(l.required.coverage)} (${l.required.present}/${l.required.total})` : 'none required'} | ${yn(l.gate.coverage)} | ${yn(l.gate.strict)} | ${l.gate.freshnessState} | ${l.reviewed.reviewed}/${l.reviewed.translated} | ${beta} | ${ob} |`);
  }
  L.push('', '\\* "eligible" only means the automated facts hold. Counsel approval [COUNSEL], native reviewer name/date, pseudo-localization, PDF fonts and support macros are manual and NOT VERIFIED by this document.', '');

  L.push('## Gate results', '');
  L.push(`- \`npm run i18n:coverage\`: exit ${status.gates.coverage.exit}${status.gates.coverage.problems.length ? ` — ${status.gates.coverage.problems.length} problem(s)` : ' — OK'}`);
  for (const p of status.gates.coverage.problems) L.push(`  - ${mdEsc(p)}`);
  L.push(`- Human-review keys pending in covered namespaces (blocking only with \`npm run i18n:coverage:release\`): ${status.gates.coverage.pending.length} in total`);
  for (const l of status.langs) L.push(`  - ${l.code}: ${l.reviewed.strictBlockers.length}`);
  L.push(`- \`npm run i18n:freshness\`: exit ${status.gates.freshness.exit}`, '');

  L.push('## Beta label rules', '');
  L.push('A language shows **Beta** unless every automated fact holds AND a person has set `beta: false` in `src/i18n/locales.config.ts`:', '');
  L.push('1. every required namespace (including `consent`) meets `minCoverage` and passes placeholder/glossary checks;');
  L.push('2. every legal / consent / emergency / AI-disclosure key the language has translated is listed in `docs/i18n/reviewed-keys.json` (strict gate);');
  L.push('3. no stale key on a covered surface, and every translation on a covered surface has a freshness record (an untracked translation cannot be proven fresh).', '');
  L.push('`node scripts/i18n-status.mjs --check` fails if the config hides Beta while rule 1–3 are unmet.', '');

  L.push('## Outbound voice / SMS compliance gate', '');
  L.push(`A language may be used for outbound compliance wording (AI disclosure, recording consent, opt-out, emergency) only if it is listed in \`OUTBOUND_COMPLIANCE_LANGUAGES\` (\`supabase/functions/_shared/i18n/outboundCompliance.ts\`) AND all of its required keys are in \`docs/i18n/reviewed-keys.json\`. Required per language: ${status.outboundKeyCount} locale key(s) in categories ai-disclosure / recording / emergency / opt-out, plus the server-side wording ids \`server.aiDisclosure.builtin\` and (es, de, fr only) \`server.recordingConsent.script\`. Languages that are not cleared are served the English / account script instead.`, '');

  for (const l of status.langs) {
    L.push(`## ${l.code}`, '');
    L.push(`Tier ${l.tier} · review level \`${l.review}\` · minCoverage ${(l.minCoverage * 100).toFixed(0)}% · surfaces ${l.surfaces.join(', ')}${l.frozen ? ' · frozen' : ''}`, '');
    L.push('| Namespace | Surface | Required | Coverage | Missing keys |', '|---|---|---|---:|---:|');
    for (const n of l.namespaces.filter((x) => x.required || x.present > 0 || x.fileMissing === false)) {
      L.push(`| ${n.name} | ${n.surface} | ${n.required ? 'yes' : 'no'} | ${fmtPct(n.coverage)} | ${n.missing} |`);
    }
    for (const n of l.namespaces.filter((x) => x.missingKeys.length)) {
      L.push('', `Missing in required namespace \`${n.name}\` (${n.missingKeys.length}): ${n.missingKeys.slice(0, 25).map((k) => `\`${k}\``).join(', ')}${n.missingKeys.length > 25 ? ', …' : ''}`);
    }
    const notShown = l.namespaces.filter((x) => !x.required && x.present === 0 && x.fileMissing).length;
    if (notShown) L.push('', `${notShown} further English namespace(s) have no ${l.code} file and are not required for this language (served in English).`);
    L.push('');
    L.push(`**Stale keys** (English changed after acceptance): ${l.fresh.stale.length}${l.fresh.stale.length ? ` — ${l.fresh.stale.map((k) => `\`${k}\``).join(', ')}` : ''}. Translations without a freshness record: ${l.fresh.untracked} (${l.fresh.untrackedCovered} on covered surfaces).`, '');
    L.push('**Reviewed legal / consent / emergency / AI-disclosure keys** (from `reviewed-keys.json`):', '');
    L.push('| Category | English keys | Translated | Reviewed |', '|---|---:|---:|---:|');
    for (const c of CATEGORY_ORDER) { const b = l.reviewed.byCategory[c]; if (b) L.push(`| ${c} | ${b.total} | ${b.translated} | ${b.reviewed} |`); }
    L.push('');
    if (l.reviewed.strictBlockers.length) L.push(`Awaiting sign-off in covered namespaces (${l.reviewed.strictBlockers.length}): ${l.reviewed.strictBlockers.slice(0, 12).map((k) => `\`${k}\``).join(', ')}${l.reviewed.strictBlockers.length > 12 ? ', …' : ''}`, '');
    L.push(`**Beta:** config \`${l.beta.config}\`; required by facts \`${l.beta.required}\`${l.beta.reasons.length ? ` — ${l.beta.reasons.join('; ')}` : ''}.`, '');
    L.push(`**Outbound compliance:** ${l.outbound.enabled ? 'enabled' : 'blocked'}; ${l.outbound.required - l.outbound.blockers.length}/${l.outbound.required} required keys reviewed${l.outbound.blockers.length ? `. Missing: ${l.outbound.blockers.slice(0, 8).map((k) => `\`${k}\``).join(', ')}${l.outbound.blockers.length > 8 ? `, … (+${l.outbound.blockers.length - 8})` : ''}` : ''}.`, '');
  }

  L.push('## Not verified here (manual checklist items)', '');
  L.push('- Legal counsel approval of recording-consent text, AI disclosure, opt-out keywords and A2P/TCPA templates [COUNSEL] — NOT VERIFIED');
  L.push('- Named native reviewer and date per language — NOT VERIFIED (recorded only through reviewed-keys.json entries a reviewer approved)');
  L.push('- Pseudo-localization and visual RTL check for ar/fa — NOT VERIFIED');
  L.push('- PDF font coverage per script — NOT VERIFIED');
  L.push('- Support macros and legal pages per language — NOT VERIFIED');
  L.push('- Server-side wording outside `src/locales` (e.g. SMS STOP/START/HELP replies are English-only in `_shared/messaging/optOut.ts`) is not measured by the locale coverage numbers — [VERIFY]', '');
  return `${L.join('\n')}\n`;
}

/** Errors for `--check`: evaluation errors plus a stale document. */
export function checkStatus(status, rendered, onDisk) {
  const errors = [...status.errors];
  if (onDisk === null) errors.push(`${STATUS_FILE} is missing — run: node scripts/i18n-status.mjs --write`);
  else if (onDisk !== rendered) errors.push(`${STATUS_FILE} is stale — run: node scripts/i18n-status.mjs --write`);
  return errors;
}

// ----------------------------------------------------------------------------- CLI
async function main() {
  const args = new Set(process.argv.slice(2));
  const root = process.cwd();
  const facts = await collect(root);
  const status = evaluate(facts);
  const md = renderStatusMd(status);
  const file = path.join(root, STATUS_FILE);
  if (args.has('--json')) { console.log(JSON.stringify(status, null, 2)); return; }
  if (args.has('--write')) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, md);
    console.log(`wrote ${STATUS_FILE}`);
    for (const l of status.langs) console.log(`  ${l.code}: coverage ${fmtPct(l.required.coverage)} · stale ${l.fresh.stale.length} · pending review ${l.reviewed.strictBlockers.length} · Beta ${l.beta.config}→${l.beta.required}${l.outbound.enabled ? ' · outbound ENABLED' : ''}`);
    if (status.errors.length) { console.error(`\n${status.errors.length} problem(s):\n- ${status.errors.join('\n- ')}`); process.exit(1); }
    return;
  }
  if (args.has('--check')) {
    const errors = checkStatus(status, md, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
    if (errors.length) { console.error(`i18n status gate FAILED (${errors.length}):`); for (const e of errors) console.error(`  - ${e}`); process.exit(1); }
    console.log('i18n status gate: OK');
    return;
  }
  console.log(md);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

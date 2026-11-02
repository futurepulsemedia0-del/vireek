// scripts/brand-audit/checks/localization.mjs
//
// Copy/voice + localization completeness. Wraps the repo's own gates (i18n-missing-keys, check-voice,
// check-raw-locale, i18n-audit) so there is ONE definition of each rule, and adds locale-parity and
// RTL-readiness measurements on top.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, walk, stripComments, runNode, finding, flatKeys, pct, round1 } from '../lib/util.mjs';
import { RTL_LANGS } from '../config.mjs';

const LOCALES = join(ROOT, 'src/locales');
const load = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) : null);

/** Pure: coverage of each non-en locale vs English. `en`/`other` map "ns" -> Set(keys). */
export function parity(enByNs, localesByNs) {
  const rows = [];
  for (const [lang, nsMap] of Object.entries(localesByNs)) {
    let have = 0;
    let total = 0;
    const missingByNs = {};
    for (const [ns, enKeys] of Object.entries(enByNs)) {
      const keys = nsMap[ns];
      total += enKeys.size;
      if (!keys) { missingByNs[ns] = { notShipped: true, count: enKeys.size }; continue; }
      const missing = [...enKeys].filter((k) => !keys.has(k));
      have += enKeys.size - missing.length;
      if (missing.length) missingByNs[ns] = { count: missing.length, sample: missing.slice(0, 4) };
    }
    rows.push({ lang, coverage: round1(pct(have, total)), missingByNs });
  }
  return rows;
}

function collectLocales() {
  const langs = readdirSync(LOCALES).filter((l) => l !== 'consent' && statSync(join(LOCALES, l)).isDirectory());
  const nsFiles = readdirSync(join(LOCALES, 'en')).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  const enByNs = {};
  for (const ns of nsFiles) enByNs[ns] = new Set(flatKeys(load(join(LOCALES, 'en', `${ns}.json`))));
  const consentEn = load(join(LOCALES, 'consent', 'en.json'));
  if (consentEn) enByNs.consent = new Set(flatKeys(consentEn));
  const localesByNs = {};
  for (const lang of langs.filter((l) => l !== 'en')) {
    localesByNs[lang] = {};
    for (const ns of nsFiles) {
      const j = load(join(LOCALES, lang, `${ns}.json`));
      if (j) localesByNs[lang][ns] = new Set(flatKeys(j));
    }
    const c = load(join(LOCALES, 'consent', `${lang}.json`));
    if (c) localesByNs[lang].consent = new Set(flatKeys(c));
  }
  return { enByNs, localesByNs };
}

/** Pure: RTL readiness = logical (ms/me/ps/pe/start/end) vs physical (ml/mr/pl/pr/left/right/text-left/right) utilities. */
export function rtlRatio(src) {
  const code = stripComments(src);
  const physical = (code.match(/\b(?:[a-z]+:)*(?:(?:ml|mr|pl|pr)-(?:\d|\[)|(?:left|right)-(?:\d|\[|full|auto)|text-(?:left|right)|rounded-(?:l|r)(?:-|\b)|border-(?:l|r)(?:-|\b)|float-(?:left|right))/g) ?? []).length;
  const logical = (code.match(/\b(?:[a-z]+:)*(?:(?:ms|me|ps|pe)-(?:\d|\[)|(?:start|end)-(?:\d|\[|full|auto)|text-(?:start|end)|rounded-(?:s|e)(?:-|\b)|border-(?:s|e)(?:-|\b)|float-(?:start|end))/g) ?? []).length;
  return { physical, logical };
}

export async function run() {
  const findings = [];
  const components = [];
  const metrics = {};

  // 1. Locale parity (all namespaces, incl. namespaces a locale does not ship at all)
  const { enByNs, localesByNs } = collectLocales();
  const rows = parity(enByNs, localesByNs);
  const meanCov = rows.length ? round1(rows.reduce((a, r) => a + r.coverage, 0) / rows.length) : 100;
  components.push({ name: 'Locale key parity vs English (all namespaces)', weight: 20, score: meanCov, detail: rows.map((r) => `${r.lang} ${r.coverage}%`).join(' · ') });
  metrics.parity = Object.fromEntries(rows.map((r) => [r.lang, r.coverage]));
  for (const r of rows.filter((x) => x.coverage < 100)) {
    const parts = Object.entries(r.missingByNs).map(([ns, m]) => (m.notShipped ? `${ns}: namespace not shipped (${m.count} keys fall back to English)` : `${ns}: ${m.count} missing`));
    findings.push(finding({ id: `l10n/parity-${r.lang}`, category: 'l10n', severity: r.coverage < 90 ? 'high' : 'medium', title: `Locale "${r.lang}" is ${r.coverage}% complete`, detail: parts.join('; '), refs: [{ file: `src/locales/${r.lang}/` }], count: Object.values(r.missingByNs).reduce((a, m) => a + m.count, 0) }));
  }

  // 2. Raw-key leakage (existing gate)
  const keys = await runNode(['scripts/i18n-missing-keys.mjs']);
  const failLines = keys.out.split('\n').filter((l) => /^\s*FAIL\s/.test(l));
  const rawKeyFails = failLines.filter((l) => /NO default/.test(l));
  const warnN = Number((/(\d+) key\(s\) rely on defaultValue/.exec(keys.out) ?? [])[1] ?? 0);
  metrics.i18nKeyFailures = failLines.length; metrics.rawKeyUserVisible = rawKeyFails.length; metrics.defaultValueOnly = warnN;
  components.push({ name: 'Translation-key gate (i18n:keys): no FAIL lines', weight: 20, score: Math.max(0, 100 - 10 * failLines.length), detail: `${failLines.length} FAIL (${rawKeyFails.length} would show a raw key to users), ${warnN} rely on defaultValue` });
  if (rawKeyFails.length) findings.push(finding({ id: 'l10n/raw-key-visible', category: 'l10n', severity: 'critical', title: `${rawKeyFails.length} translation key(s) render as raw keys for users`, detail: 'Keys used with no defaultValue and absent from the English file.', refs: rawKeyFails.map((l) => ({ file: (/src\/\S+/.exec(l) ?? [''])[0] })), count: rawKeyFails.length }));
  const parityFails = failLines.length - rawKeyFails.length;
  if (parityFails) findings.push(finding({ id: 'l10n/parity-gate', category: 'l10n', severity: 'high', title: `${parityFails} locale file(s) fail the i18n:keys parity gate (CI is red)`, refs: [{ file: 'scripts/i18n-missing-keys.mjs' }], count: parityFails }));

  // 3. Hard-coded strings (existing AST audit; needs `typescript`)
  const audit = await runNode(['scripts/i18n-audit.mjs', '--top', '0'], { timeout: 300_000 });
  const m = /Scanned (\d+) files • (\d+) still have hard-coded strings • (\d+) clean/.exec(audit.out);
  const total = Number((/Total hard-coded strings: (\d+)/.exec(audit.out) ?? [])[1] ?? NaN);
  if (m) {
    const [scanned, dirty, clean] = [Number(m[1]), Number(m[2]), Number(m[3])];
    metrics.hardcodedStrings = total; metrics.filesWithHardcoded = dirty; metrics.filesScanned = scanned;
    components.push({ name: 'Files fully extracted to i18n (no hard-coded JSX copy)', weight: 25, score: round1(pct(clean, scanned)), detail: `${clean}/${scanned} files clean · ${total} hard-coded strings` });
    findings.push(finding({ id: 'l10n/hardcoded-strings', category: 'l10n', severity: 'high', title: `${total} hard-coded user-facing strings in ${dirty} files bypass i18n`, detail: 'Run `node scripts/i18n-audit.mjs --top 100` for the ranked list; extract with scripts/i18n-codemod.mjs.', refs: [{ file: 'scripts/i18n-audit.mjs' }], count: dirty }));
  } else {
    components.push({ name: 'Files fully extracted to i18n', weight: 25, score: null, detail: `NOT RUN — ${audit.out.split('\n')[0].slice(0, 120)}` });
  }

  // 4. Voice lint (existing gate)
  const voice = await runNode(['scripts/check-voice.mjs']);
  const vN = Number((/Voice lint: (\d+) problem/.exec(voice.out) ?? [])[1] ?? (voice.code === 0 ? 0 : NaN));
  if (!Number.isNaN(vN)) {
    metrics.voiceProblems = vN;
    components.push({ name: 'Voice & tone lint', weight: 10, score: Math.max(0, 100 - 10 * vN), detail: `${vN} problem(s)` });
    if (vN) findings.push(finding({ id: 'l10n/voice', category: 'l10n', severity: 'medium', title: `${vN} voice/tone lint problem(s) (CI is red)`, detail: voice.out.split('\n').filter((l) => /\[all-caps|\[filler|\[raw-code/.test(l)).slice(0, 8).join('\n'), refs: [{ file: 'scripts/check-voice.mjs' }], count: vN }));
  } else components.push({ name: 'Voice & tone lint', weight: 10, score: null, detail: 'NOT RUN' });

  // 5. Locale-formatting ratchet (existing gate)
  const raw = await runNode(['scripts/check-raw-locale.mjs']);
  metrics.rawLocaleGate = raw.code === 0 ? 'pass' : 'fail';
  components.push({ name: 'Locale-formatting ratchet (lint:locale)', weight: 5, score: raw.code === 0 ? 100 : 0, detail: raw.code === 0 ? 'pass' : raw.out.trim().split('\n')[0].slice(0, 140) });
  if (raw.code !== 0) findings.push(finding({ id: 'l10n/raw-locale-gate', category: 'l10n', severity: 'high', title: 'lint:locale fails — CI is red', detail: raw.out.trim().split('\n')[0], refs: [{ file: 'scripts/check-raw-locale.mjs' }], count: 1 }));

  // 6. RTL readiness (static) — ar/fa are shipped locales
  let physical = 0; let logical = 0;
  for (const f of walk('src', { exts: ['.tsx'], skipTests: true })) {
    const r = rtlRatio(readFileSync(join(ROOT, f), 'utf8'));
    physical += r.physical; logical += r.logical;
  }
  metrics.rtl = { physical, logical, rtlLocales: RTL_LANGS.filter((l) => localesByNs[l]) };
  components.push({ name: 'RTL readiness: logical vs physical (ms/me/ps/pe) utilities', weight: 20, score: round1(pct(logical, physical + logical)), detail: `${logical} logical vs ${physical} physical (${RTL_LANGS.join('/')} are shipped locales)` });
  findings.push(finding({ id: 'l10n/rtl-physical', category: 'l10n', severity: 'high', title: `${physical} direction-specific utilities (ml-/pl-/left-/text-left …) will mis-render in Arabic and Persian`, detail: 'Prefer ms-/me-/ps-/pe-/start-/end-/text-start. Verify with the crawler’s RTL pass (lang=fa).', refs: [{ file: 'src/' }], count: physical }));

  return { category: 'l10n', components, metrics, findings };
}

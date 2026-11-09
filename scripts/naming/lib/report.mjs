// Scoring, Markdown report and CSV scoring sheet. Pure except writeOutputs().
//
// Wording rule: nothing generated here may state or imply that a domain, name or trademark can be
// obtained. Domain cells carry only the three RDAP_STATUS strings.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATABASES, MANUAL_DEFAULT } from './checklist.mjs';
import { DEFAULT_TLDS, RDAP_STATUS } from './rdap.mjs';

export const DEFAULT_WEIGHTS = Object.freeze({
  pronounceability: 25,
  internationalFit: 20,
  lookalike: 25,
  domainSignal: 15,
  manualCheck: 15,
});
const TLD_WEIGHTS = { com: 50, ai: 20, io: 20, co: 10 };
export const MANUAL_COLUMNS = Object.freeze([
  ...DATABASES.map((d) => d.column),
  'manual_social',
  'manual_registrar_confirm',
  'manual_meaning_review',
  'manual_attorney_review',
]);

/** "pronounceability=30,lookalike=20,..." -> weights normalised to sum 100. Unlisted keys keep defaults. */
export function parseWeights(spec) {
  const w = { ...DEFAULT_WEIGHTS };
  if (spec) {
    for (const part of String(spec).split(',')) {
      const [k, v] = part.split('=').map((s) => s.trim());
      if (!(k in DEFAULT_WEIGHTS)) throw new Error(`Unknown weight "${k}". Valid: ${Object.keys(DEFAULT_WEIGHTS).join(', ')}`);
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Weight "${k}" must be a non-negative number`);
      w[k] = n;
    }
  }
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error('Weights must not all be zero');
  return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Math.round((v / sum) * 10000) / 100]));
}

/** 0-100, higher = fewer registrations seen. NOT availability. null when no definitive signal. */
export function domainSignal(domains) {
  let num = 0;
  let den = 0;
  let definitive = 0;
  for (const d of domains) {
    if (d.status === RDAP_STATUS.ERROR) continue;
    const w = TLD_WEIGHTS[d.tld] ?? 10;
    den += w;
    definitive += 1;
    if (d.status === RDAP_STATUS.NO_RECORD) num += w;
  }
  return {
    score: den ? Math.round((num / den) * 100) : null,
    coverage: `${definitive}/${domains.length}`,
    partial: definitive < domains.length,
  };
}

export function manualScore(cells) {
  const vals = Object.values(cells);
  return vals.length ? Math.round((vals.filter((v) => v === 'DONE').length / vals.length) * 100) : 0;
}

export function defaultManualCells() {
  return Object.fromEntries(MANUAL_COLUMNS.map((c) => [c, MANUAL_DEFAULT]));
}

export function weightedTotal(parts, weights) {
  const total =
    parts.pronounceability * weights.pronounceability +
    parts.internationalFit * weights.internationalFit +
    (100 - parts.lookalikeRisk) * weights.lookalike +
    (parts.domainSignal ?? 0) * weights.domainSignal +
    parts.manualCheck * weights.manualCheck;
  return Math.round((total / 100) * 10) / 10;
}

/** Combine analyses into one scored result. */
export function scoreName({ name, linguistic, lookalike, domains, checklist }, weights) {
  const domain = domainSignal(domains);
  const manual = defaultManualCells();
  const manualCheck = manualScore(manual);
  const flags = [];
  if (lookalike.level === 'identical' || lookalike.level === 'high') flags.push(`LOOKALIKE-${lookalike.level.toUpperCase()}`);
  for (const a of linguistic.affixes) flags.push(`${a.kind.toUpperCase()}-SATURATED:${a.affix}`);
  if (linguistic.pronounceability.score < 60) flags.push('HARD-TO-PRONOUNCE');
  if (linguistic.internationalFit.score < 70) flags.push('WEAK-INTERNATIONAL-FIT');
  if (domain.partial) flags.push('DOMAIN-SIGNAL-PARTIAL');
  if (domain.score === null) flags.push('DOMAIN-SIGNAL-NONE');
  return {
    name,
    linguistic,
    lookalike,
    domains,
    domain,
    checklist,
    manual,
    manualCheck,
    flags,
    total: weightedTotal(
      {
        pronounceability: linguistic.pronounceability.score,
        internationalFit: linguistic.internationalFit.score,
        lookalikeRisk: lookalike.riskScore,
        domainSignal: domain.score,
        manualCheck,
      },
      weights,
    ),
  };
}

// ---------- CSV ----------

/** RFC-4180 quoting plus spreadsheet formula-injection guard. */
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = Object.freeze([
  'name',
  'length',
  'pronounceability_score',
  'international_fit_score',
  'lookalike_risk_score_higher_is_worse',
  ...DEFAULT_TLDS.map((t) => `domain_${t}`),
  'domain_signal_score_rdap_only',
  'domain_signal_coverage',
  'flags',
  ...MANUAL_COLUMNS,
  'manual_check_status',
  'manual_check_score',
  'weighted_total',
]);

export function toCsv(results) {
  const rows = results.map((r) => {
    const byTld = Object.fromEntries(r.domains.map((d) => [d.tld, d.status]));
    const cells = [
      r.name,
      r.linguistic.length,
      r.linguistic.pronounceability.score,
      r.linguistic.internationalFit.score,
      r.lookalike.riskScore,
      ...DEFAULT_TLDS.map((t) => byTld[t] ?? RDAP_STATUS.ERROR),
      r.domain.score ?? '',
      r.domain.coverage,
      r.flags.join('; '),
      ...MANUAL_COLUMNS.map((c) => r.manual[c]),
      Object.values(r.manual).every((v) => v === MANUAL_DEFAULT) ? MANUAL_DEFAULT : 'IN PROGRESS',
      r.manualCheck,
      r.total,
    ];
    return cells.map(csvCell).join(',');
  });
  return `${[CSV_COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}

// ---------- Markdown ----------

const md = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function toMarkdown({ generatedAt, weights, results, rejected = [], duplicates = [], rdapNotes = [] }) {
  const L = [];
  L.push('# Vireek naming screen', '');
  L.push(`Generated: ${generatedAt}`, '');
  L.push('> **This is a screen, not clearance.** It surfaces cheap warning signals only. It does not search any trademark register and it does not confirm that a name or a domain can be obtained. Every manual check below is **NOT DONE** until a human completes it, and final trademark clearance requires an attorney.', '');
  L.push('## Scoring weights', '', '| Component | Weight (%) |', '| --- | ---: |');
  L.push(`| Pronounceability | ${weights.pronounceability} |`);
  L.push(`| International fit | ${weights.internationalFit} |`);
  L.push(`| Lookalike (100 - risk) | ${weights.lookalike} |`);
  L.push(`| Domain signal | ${weights.domainSignal} |`);
  L.push(`| Manual-check status | ${weights.manualCheck} |`, '');
  L.push('The manual-check component is 0 until cells are marked DONE, so no name can reach the top score before manual verification. A missing domain signal counts as 0.', '');

  L.push('## Summary', '');
  L.push('| Name | Pronounce | Intl fit | Lookalike risk | Domain signal | Flags | Manual checks | Weighted total |');
  L.push('| --- | ---: | ---: | ---: | ---: | --- | --- | ---: |');
  for (const r of [...results].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))) {
    L.push(
      `| ${md(r.name)} | ${r.linguistic.pronounceability.score} | ${r.linguistic.internationalFit.score} | ${r.lookalike.riskScore} (${r.lookalike.level}) | ${r.domain.score ?? 'n/a'} (${r.domain.coverage}) | ${md(r.flags.join(', ') || '-')} | ${MANUAL_DEFAULT} | ${r.total} |`,
    );
  }
  L.push('');

  if (rejected.length || duplicates.length) {
    L.push('## Input problems', '');
    for (const x of rejected) L.push(`- Rejected \`${md(x.input)}\`: ${md(x.reason)}`);
    for (const d of duplicates) L.push(`- Duplicate ignored: \`${md(d)}\``);
    L.push('');
  }
  if (rdapNotes.length) {
    L.push('## RDAP run notes', '', ...rdapNotes.map((n) => `- ${md(n)}`), '');
  }

  for (const r of results) {
    const { linguistic: lg, lookalike: lk } = r;
    L.push(`## ${r.name}`, '');
    L.push('### Linguistic checks', '');
    L.push(`- Length: ${lg.length} letters`);
    L.push(`- Pronounceability: ${lg.pronounceability.score}/100 (shape ${lg.pronounceability.shape})${lg.pronounceability.issues.length ? ` - ${md(lg.pronounceability.issues.join('; '))}` : ''}`);
    L.push(`- International fit: ${lg.internationalFit.score}/100; weakest: ${lg.internationalFit.worst.language} (${lg.internationalFit.worst.score})`);
    for (const f of lg.internationalFit.flags) L.push(`  - ${md(f.id)}: ${md(f.note)} (${md(f.languages.join(', '))})`);
    L.push(`- Affix saturation: ${lg.affixes.length ? lg.affixes.map((a) => `${a.kind} "${a.affix}"${a.wholeName ? ' (whole name)' : ''}`).join(', ') : 'none flagged'}`, '');
    L.push('### Lookalike check (heuristic, configured brand list only)', '');
    if (lk.matches.length) {
      L.push('| Brand | Level | Edit distance | Similarity | Phonetic match |', '| --- | --- | ---: | ---: | --- |');
      for (const m of lk.matches) L.push(`| ${md(m.brand)} | ${m.level} | ${m.distance} | ${m.similarity} | ${m.phoneticMatch ? 'yes' : 'no'} |`);
    } else L.push('No close match in the configured list. This says nothing about brands outside the list.');
    L.push('', '### Domain signal (RDAP)', '', '| Domain | Signal | Source | Detail |', '| --- | --- | --- | --- |');
    for (const d of r.domains) L.push(`| ${md(d.domain)} | ${md(d.status)} | ${md(d.source ?? '-')} | ${md(d.detail)} |`);
    L.push('', '### Manual verification checklist (all NOT DONE)', '');
    for (const db of r.checklist.databases) {
      L.push(`- [ ] **${db.label}** - ${db.urls.join(' , ')}`);
      L.push(`  - Search terms: ${db.searchTerms.map((t) => `\`${t}\``).join(', ')}`);
      L.push(`  - Review Nice classes: ${db.classes.map((c) => `${c.no} (${c.summary})`).join('; ')}`);
      L.push(`  - Status: ${db.status}`);
    }
    L.push('- [ ] **Social handles** (check by hand; do not automate)');
    for (const s of r.checklist.social) L.push(`  - [ ] ${s.label}: ${s.url} - ${s.status}`);
    L.push(`- [ ] **Registrar confirmation** for: ${r.checklist.registrarTlds.length ? r.checklist.registrarTlds.map((t) => `.${t}`).join(', ') : 'none (all four showed a registration)'} - ${MANUAL_DEFAULT}`);
    for (const o of r.checklist.other) L.push(`- [ ] ${o.label} - ${o.status}`);
    L.push('');
  }
  return `${L.join('\n')}\n`;
}

/** Writes both files with the exclusive flag so earlier output (and manual edits) are never overwritten. */
export function writeOutputs({ dir, stamp, markdown, csv }) {
  mkdirSync(dir, { recursive: true });
  const mdPath = path.join(dir, `naming-screen-${stamp}.md`);
  const csvPath = path.join(dir, `naming-screen-${stamp}.csv`);
  writeFileSync(mdPath, markdown, { flag: 'wx', encoding: 'utf8' });
  writeFileSync(csvPath, csv, { flag: 'wx', encoding: 'utf8' });
  return { mdPath, csvPath };
}

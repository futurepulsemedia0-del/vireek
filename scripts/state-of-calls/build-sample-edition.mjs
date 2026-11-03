#!/usr/bin/env node
// Builds the labelled SYNTHETIC sample edition used for design/preview and as a pipeline smoke test.
//   node scripts/state-of-calls/build-sample-edition.mjs          (Node >= 22.18; or run with `npx tsx`)
// Writes:
//   public/state-of-calls/sample-edition.json
//   docs/state-of-calls/DRAFT_REPORT_SYNTHETIC.md
// Fully deterministic: running it twice produces byte-identical files.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sh = path.join(root, 'supabase/functions/_shared/state-of-calls');
const { generateSyntheticOrgs, SYNTHETIC_NOTICE } = await import(path.join(sh, 'synthetic.ts'));
const { aggregateOrgFacts } = await import(path.join(sh, 'aggregate.ts'));
const { applyDisclosureControl } = await import(path.join(sh, 'disclosure.ts'));
const { buildEditionDocument } = await import(path.join(sh, 'edition.ts'));
const { K_MIN_PUBLIC } = await import(path.join(sh, 'schema.ts'));

const orgs = generateSyntheticOrgs(20260101);
const { cells, report } = applyDisclosureControl(aggregateOrgFacts(orgs, '2026', K_MIN_PUBLIC));
const doc = await buildEditionDocument({
  slug: 'sample-2026', title: 'State of Home Service Calls 2026 (SYNTHETIC SAMPLE)', kind: 'annual', period_key: '2026',
  period_start: '2026-01-01', period_end: '2026-12-31', as_of: '2027-01-05T00:00:00.000Z', synthetic: true,
}, cells, report, SYNTHETIC_NOTICE);

mkdirSync(path.join(root, 'public/state-of-calls'), { recursive: true });
writeFileSync(path.join(root, 'public/state-of-calls/sample-edition.json'), JSON.stringify(doc, null, 2) + '\n');

const L = [];
L.push(`# ${doc.title}`, '', `> **${SYNTHETIC_NOTICE}**`, '',
  `Version: ${doc.method_version} · Data as of ${doc.as_of.slice(0, 10)} · Period ${doc.period_start} to ${doc.period_end} · Integrity hash \`${doc.cells_hash.slice(0, 16)}…\``, '',
  `Thresholds applied to every figure: at least ${doc.thresholds.k_min} contributing businesses, at most ${doc.thresholds.dominance_max_share * 100}% of a cell's events from one business, at least ${doc.thresholds.min_events} events.`, '');
for (const s of doc.narrative.sections) {
  L.push(`## ${s.title}`, '');
  for (const st of s.statements) L.push(`${st.text}  \n<sub>Source cells: ${st.cites.map((c) => '`' + c + '`').join(', ') || 'none'}</sub>`, '');
  L.push('> **Expert commentary placeholder:** [Name, title, organisation — quote to be obtained, reviewed and approved before publication.]', '');
}
L.push('## Methodology', '', ...doc.metrics.map((m) => `- **${m.label}** (${m.unit}, per ${m.event_label}): ${m.definition}`), '', '## Exclusions', '', ...doc.exclusions.map((x) => `- ${x}`), '', '## Limitations', '', ...doc.limitations.map((x) => `- ${x}`), '');
L.push('## Disclosure control summary (this sample)', '', `- Cells evaluated: ${report.input_cells}; published: ${report.published}`, ...Object.entries(report.suppressed).map(([k, v]) => `- Withheld — ${k}: ${v}`), '');
L.push('## Fact-check checklist (complete before any real edition)', '',
  '- [ ] Every number in the narrative traces to a published cell (automated: `verifyNarrative`).',
  '- [ ] Period dates, edition label and "data as of" date are correct.',
  '- [ ] Each definition matches what the SQL actually computes (re-read `report_build_raw_cells`).',
  '- [ ] No sentence implies causation, ranking of businesses, or generalisation beyond contributors.',
  '- [ ] Expert quotes verified with the speaker, in writing; none contain data not in the cells.',
  '- [ ] Suppressed cells are not described, hinted at or reconstructable from the text.',
  '- [ ] Counsel sign-off recorded (see LEGAL_REVIEW_CHECKLIST.md).', '');
writeFileSync(path.join(root, 'docs/state-of-calls/DRAFT_REPORT_SYNTHETIC.md'), L.join('\n'));
console.log(`sample edition: ${cells.length} cells (${report.published} published), hash ${doc.cells_hash}`);

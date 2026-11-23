#!/usr/bin/env node
// Generates the new-trade expansion checklist and (optionally) lints a draft playbook.
// Spec: docs/product/new-vertical-playbook.md · Logic: src/lib/newTradeChecklist.ts
//
// Usage:
//   npm run product:new-trade -- <input.json> [--out <file.md>] [--verify-evidence] [--check]
//
// input.json = { "candidate": { ...TradeCandidate }, "draft": { ...playbook, optional } }
// Flags:
//   --out <file>        write the Markdown checklist there instead of stdout
//   --verify-evidence   prove every touchpoint claim against the repository (files + substrings)
//   --check             exit 1 when the draft has lint errors or evidence is stale (CI / pre-merge gate)
// Exit codes: 0 ok · 1 findings with --check · 2 bad input or usage.
// Requires Node >= 22.6 (type stripping): the npm script passes --experimental-strip-types.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const inputPath = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!inputPath) {
  console.error('Usage: npm run product:new-trade -- <input.json> [--out <file.md>] [--verify-evidence] [--check]');
  process.exit(2);
}
if (flag('--out') && !value('--out')) {
  console.error('--out needs a file path');
  process.exit(2);
}

const mod = await import(new URL('../../src/lib/newTradeChecklist.ts', import.meta.url).href);

let input;
try {
  input = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
} catch (e) {
  console.error(`Cannot read ${inputPath}: ${e.message}`);
  process.exit(2);
}

const parsedCandidate = mod.parseCandidate(input?.candidate);
if (!parsedCandidate.candidate || parsedCandidate.errors.length > 0) {
  console.error(`Invalid candidate:\n - ${parsedCandidate.errors.join('\n - ')}`);
  process.exit(2);
}

const checklist = mod.generateChecklist(parsedCandidate.candidate);
const sections = [mod.renderChecklistMarkdown(checklist)];
let failed = false;

if (input.draft !== undefined) {
  const parsedDraft = mod.parseDraft(input.draft);
  if (!parsedDraft.draft) {
    console.error(`Invalid draft:\n - ${parsedDraft.errors.join('\n - ')}`);
    process.exit(2);
  }
  if (parsedDraft.draft.slug !== parsedCandidate.candidate.slug) {
    console.error(`draft.slug "${parsedDraft.draft.slug}" must equal candidate.slug "${parsedCandidate.candidate.slug}"`);
    process.exit(2);
  }
  const wfPath = join(root, 'src/lib/workflowPlaybooks.ts');
  const knownWorkflowSlugs = existsSync(wfPath) ? mod.extractWorkflowSlugs(readFileSync(wfPath, 'utf8')) : undefined;
  const findings = mod.lintPlaybookDraft(parsedDraft.draft, { knownWorkflowSlugs });
  const sum = mod.summarizeFindings(findings);
  const lines = ['## Draft playbook lint', '', `${sum.errors} error(s), ${sum.warnings} warning(s)`, ''];
  for (const f of findings) lines.push(`- **${f.severity.toUpperCase()}** \`${f.code}\` at \`${f.path}\`: ${f.message}`);
  if (findings.length === 0) lines.push('- no findings');
  sections.push(lines.join('\n'), '');
  if (sum.errors > 0) failed = true;
}

if (flag('--verify-evidence')) {
  const read = (p) => {
    const abs = join(root, p);
    if (!existsSync(abs)) return null;
    return statSync(abs).isDirectory() ? '' : readFileSync(abs, 'utf8');
  };
  const problems = mod.checkEvidence(read);
  const lines = ['## Checklist evidence check', ''];
  if (problems.length === 0) lines.push(`- all ${mod.TOUCHPOINTS.length} touchpoints verified against the repository`);
  for (const p of problems) lines.push(`- STALE: ${p}`);
  sections.push(lines.join('\n'), '');
  if (problems.length > 0) failed = true;
}

const output = sections.join('\n');
if (value('--out')) {
  writeFileSync(resolve(value('--out')), output);
  console.log(`Wrote ${value('--out')} (${checklist.counts.total} items, ${checklist.counts.blocking} blocking)`);
} else {
  process.stdout.write(output);
}
if (flag('--check') && failed) process.exit(1);

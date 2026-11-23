#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  Plain-language check for customer-facing templates                  */
/*  (see docs/design/plain-language.md, thresholds in                   */
/*  config/readability.config.json)                                     */
/*                                                                      */
/*  Scores SMS, email and quote-follow-up copy by reading level.        */
/*  WARN-ONLY by default: failures are printed and, in GitHub Actions,  */
/*  annotated, but the exit code stays 0. Use --strict to exit 1.       */
/*  Run: node scripts/content/readability.mjs [--json] [--strict]       */
/* ------------------------------------------------------------------ */

import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate, validateConfig } from './readability-core.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SOURCES = {
  starter: 'src/lib/messageTemplates.ts',
  lifecycle: 'supabase/functions/_shared/lifecycle/lifecycleCore.ts',
  playbooks: 'src/lib/workflowPlaybooks.ts',
};

export function loadConfig(root = ROOT, file = 'config/readability.config.json') {
  const config = JSON.parse(readFileSync(join(root, file), 'utf8'));
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Invalid ${file}:\n  ${errors.join('\n  ')}`);
  return config;
}

/** Quote follow-up copy is declared inline in workflow playbooks; read the string literals, keep quote/estimate ones. */
export function extractQuoteBodies(source) {
  const out = [];
  for (const m of source.matchAll(/\bbody:\s*("(?:[^"\\\n]|\\.)*")/g)) {
    let text;
    try { text = JSON.parse(m[1]); } catch { continue; }
    if (!/\b(?:quote|estimate)\b/i.test(text)) continue;
    out.push({ text, line: source.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** loadModule(absPath) -> module namespace. Default transpiles with the project's TypeScript. */
export async function collectItems(root = ROOT, loadModule) {
  const load = loadModule ?? (async (f) => (await import('../lib/load-ts.mjs')).loadTs(f));
  const items = [];

  const starter = await load(join(root, SOURCES.starter));
  for (const t of starter.STARTER_TEMPLATES ?? []) {
    if (t.channel === 'sms' || t.channel === 'email') items.push({ id: `starter.${t.id}`, channel: t.channel, text: t.body, file: SOURCES.starter });
  }

  const life = await load(join(root, SOURCES.lifecycle));
  for (const [touch, v] of Object.entries(life.DEFAULT_TEMPLATES ?? {})) {
    items.push({ id: `lifecycle.${touch}.email`, channel: 'email', text: v.email.body, file: SOURCES.lifecycle });
    items.push({ id: `lifecycle.${touch}.sms`, channel: 'sms', text: v.sms.body, file: SOURCES.lifecycle });
  }

  const playbooks = readFileSync(join(root, SOURCES.playbooks), 'utf8');
  for (const q of extractQuoteBodies(playbooks)) {
    items.push({ id: `playbook.quote@${q.line}`, channel: 'quote', text: q.text, file: SOURCES.playbooks, line: q.line });
  }
  return items;
}

export function describe(f) {
  const labels = { grade: 'reading grade', ease: 'reading ease', 'sentence-length': 'longest sentence (words)' };
  const dir = f.rule === 'ease' ? 'below' : 'above';
  return `${labels[f.rule]} ${f.actual} is ${dir} the limit of ${f.limit}`;
}

export async function run(argv = process.argv.slice(2), { root = ROOT, loadModule, log = console.log } = {}) {
  const config = loadConfig(root);
  const items = await collectItems(root, loadModule);
  const results = items.map((it) => ({ ...evaluate(it, config), file: it.file, line: it.line }));
  const failing = results.filter((r) => r.findings.length > 0);

  if (argv.includes('--json')) log(JSON.stringify({ checked: results.length, failing: failing.length, results }, null, 2));
  else {
    log(`Plain-language check: ${results.length} template(s), ${failing.length} above threshold.`);
    for (const r of failing) log(`  ${r.id} [${r.channel}]  ${r.findings.map(describe).join('; ')}`);
  }

  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const r of failing) {
      const where = `file=${r.file}${r.line ? `,line=${r.line}` : ''}`;
      log(`::warning ${where},title=Plain language::${r.id}: ${r.findings.map(describe).join('; ')}`);
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      const rows = failing.map((r) => `| \`${r.id}\` | ${r.channel} | ${r.metrics.grade} | ${r.metrics.ease} | ${r.metrics.longestSentenceWords} |`);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, [`### Plain language: ${failing.length} of ${results.length} templates above threshold`, '', ...(rows.length ? ['| Template | Channel | Grade | Ease | Longest sentence |', '|---|---|---|---|---|', ...rows] : ['All templates are within thresholds.']), ''].join('\n'));
    }
  }
  const code = argv.includes('--strict') && failing.length ? 1 : 0;
  return { results, failing, code };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().then(({ code }) => process.exit(code)).catch((e) => { console.error(e.message); process.exit(2); });
}

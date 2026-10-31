#!/usr/bin/env node
// scripts/knowledge-eval.mjs — end-to-end eval of the PUBLIC Ask Vireek assistant.
//
//   SITE_ASSISTANT_URL=https://<ref>.supabase.co/functions/v1/site-assistant \
//   SUPABASE_ANON_KEY=... SITE_ASSISTANT_EVAL_KEY=... node scripts/knowledge-eval.mjs
//   node scripts/knowledge-eval.mjs --dry     # validate case files only (no network)
//
// Metrics: accuracy (assertions), groundedness (every $ / % / big number in an answer must exist in the
// knowledge corpus or the question => "invented facts" counter), refusal-correctness (unknown/refuse/redirect
// cases), latency and first-token. Exit 1 if below thresholds. Case schema: see knowledge-build.mjs.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.VIREEK_ROOT ? path.resolve(process.env.VIREEK_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = { accuracy: 0.95, refusal: 0.95, invented: 0 };
const load = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));

const cases = [...load('eval/site-assistant.generated.json').cases, ...load('eval/site-assistant.manual.json').cases];
const ids = new Set();
for (const c of cases) {
  if (ids.has(c.id)) throw new Error(`duplicate eval id ${c.id}`);
  ids.add(c.id);
  if (!c.q || !['answer', 'unknown', 'refuse', 'redirect'].includes(c.kind)) throw new Error(`bad case ${c.id}`);
}
console.log(`Loaded ${cases.length} cases.`);
if (process.argv.includes('--dry')) process.exit(cases.length >= 150 ? 0 : 1);

const { SITE_ASSISTANT_URL, SUPABASE_ANON_KEY, SITE_ASSISTANT_EVAL_KEY } = process.env;
if (!SITE_ASSISTANT_URL || !SUPABASE_ANON_KEY || !SITE_ASSISTANT_EVAL_KEY) throw new Error('Set SITE_ASSISTANT_URL, SUPABASE_ANON_KEY, SITE_ASSISTANT_EVAL_KEY.');

const corpus = load('knowledge/site-chunks.generated.json').chunks.map((c) => c.content + ' ' + c.title).join(' ') +
  ' ' + readFileSync(path.join(ROOT, 'supabase/functions/_shared/ai-core/coreFacts.generated.ts'), 'utf8');
const norm = (s) => s.replace(/,/g, '');
const numsIn = (s) => new Set((norm(s).match(/\$?\d+(?:\.\d+)?%?/g) ?? []).filter((n) => n.startsWith('$') || n.endsWith('%') || n.replace(/\D/g, '').length >= 3));
const corpusNums = numsIn(corpus);

async function ask(q) {
  const t0 = Date.now();
  let first = null, text = '', error = null, sources = [];
  const res = await fetch(SITE_ASSISTANT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY, 'x-eval-key': SITE_ASSISTANT_EVAL_KEY },
    body: JSON.stringify({ message: q, history: [] }),
  });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('event-stream')) return { text: '', error: `HTTP ${res.status}`, ms: Date.now() - t0, first: null, sources };
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.startsWith('data:')) continue;
      try {
        const j = JSON.parse(l.slice(5));
        if (j.delta) { first ??= Date.now() - t0; text += j.delta; }
        if (j.error) error = j.error;
        if (j.sources) sources = j.sources;
      } catch { /* ignore */ }
    }
  }
  return { text, error, ms: Date.now() - t0, first, sources };
}

const matches = (text, pat) => (pat.startsWith('re:') ? new RegExp(pat.slice(3), 'i').test(text) : text.toLowerCase().includes(pat.toLowerCase()));

function grade(c, r) {
  const fails = [];
  if (r.error || !r.text.trim()) fails.push(`no answer (${r.error ?? 'empty'})`);
  for (const g of c.mustInclude) if (!g.some((p) => matches(r.text, p))) fails.push(`missing any of [${g.join(' | ')}]`);
  for (const p of c.mustNotInclude) if (matches(r.text, p)) fails.push(`forbidden: ${p}`);
  if (c.kind === 'answer' && /\b(i (don't|do not) have (that|this|enough)|couldn't find)\b/i.test(r.text) && c.mustInclude.length === 0) fails.push('answered "unknown" to an answerable question');
  const invented = [...numsIn(r.text)].filter((n) => !corpusNums.has(n) && !numsIn(c.q).has(n));
  return { fails, invented };
}

const results = [];
const queue = [...cases];
await Promise.all(Array.from({ length: 3 }, async () => {
  while (queue.length) {
    const c = queue.shift();
    let r;
    try { r = await ask(c.q); } catch (e) { r = { text: '', error: String(e), ms: 0, first: null, sources: [] }; }
    const g = grade(c, r);
    results.push({ id: c.id, category: c.category, kind: c.kind, pass: g.fails.length === 0, fails: g.fails, invented: g.invented, ms: r.ms, first: r.first, text: r.text.slice(0, 600) });
    process.stdout.write(g.fails.length ? 'F' : '.');
  }
}));
console.log();

const pct = (n, d) => (d ? n / d : 1);
const q = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);
const refusalSet = results.filter((r) => r.kind !== 'answer');
const accuracy = pct(results.filter((r) => r.pass).length, results.length);
const refusal = pct(refusalSet.filter((r) => r.pass).length, refusalSet.length);
const invented = results.filter((r) => r.invented.length);
const byCat = {};
for (const r of results) { byCat[r.category] ??= [0, 0]; byCat[r.category][1]++; if (r.pass) byCat[r.category][0]++; }
const summary = {
  total: results.length, accuracy, refusalCorrectness: refusal, inventedFactAnswers: invented.length,
  latencyMsP50: q(results.map((r) => r.ms), 0.5), latencyMsP95: q(results.map((r) => r.ms), 0.95),
  firstTokenMsP50: q(results.filter((r) => r.first != null).map((r) => r.first), 0.5), firstTokenMsP95: q(results.filter((r) => r.first != null).map((r) => r.first), 0.95),
  byCategory: Object.fromEntries(Object.entries(byCat).map(([k, [p, t]]) => [k, `${p}/${t}`])),
};
writeFileSync(path.join(ROOT, 'eval/results-latest.json'), JSON.stringify({ summary, failures: results.filter((r) => !r.pass || r.invented.length) }, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const r of results.filter((x) => !x.pass || x.invented.length).slice(0, 25)) console.log(`FAIL ${r.id}: ${r.fails.join('; ')}${r.invented.length ? ` | numbers not in corpus: ${r.invented}` : ''}`);
const ok = accuracy >= T.accuracy && refusal >= T.refusal && invented.length <= T.invented;
console.log(ok ? 'EVAL PASSED' : `EVAL FAILED (need accuracy>=${T.accuracy}, refusal>=${T.refusal}, invented=${T.invented})`);
process.exit(ok ? 0 : 1);

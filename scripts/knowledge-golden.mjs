#!/usr/bin/env node
// scripts/knowledge-golden.mjs
//
// OFFLINE retrieval check for "Ask Vireek": runs a golden set of real visitor questions
// against knowledge/site-chunks.generated.json with a BM25 keyword ranker (no network,
// no embeddings) and asserts the expected page appears in the top 3.
// This measures the KEYWORD half of the hybrid pipeline only; vector retrieval and live
// model answers are covered by `npm run knowledge:eval` (needs a deployed function).
//
//   node scripts/knowledge-golden.mjs            # exit 1 if recall@3 < MIN_RECALL or an unknown question scores high
//   node scripts/knowledge-golden.mjs --verbose  # print every miss

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chunks = JSON.parse(readFileSync(path.join(ROOT, 'knowledge/site-chunks.generated.json'), 'utf8')).chunks;
const MIN_RECALL = 0.8; // baseline ratchet (measured 82.9% on 2026-11-15); raise as the knowledge base improves
const MAX_LEAKS = 2;
const verbose = process.argv.includes('--verbose');

// [question, [acceptable url prefixes]]
const ANSWERABLE = [
  ['How much does Vireek cost?', ['/pricing']],
  ['What is included in the free plan?', ['/pricing']],
  ['How many minutes are included in the Starter plan?', ['/pricing']],
  ['What happens if I go over my included minutes?', ['/pricing']],
  ['Is there a setup fee?', ['/pricing', '/faq']],
  ['Can I switch plans or downgrade later?', ['/pricing', '/faq']],
  ['Do you offer annual billing discount?', ['/pricing']],
  ['How much is the Enterprise plan?', ['/pricing']],
  ['How many seats are in the Professional plan?', ['/pricing']],
  ['Does Vireek integrate with QuickBooks?', ['/integrations/quickbooks']],
  ['Can Vireek sync with Google Calendar?', ['/integrations/google-calendar']],
  ['Does it connect to HubSpot?', ['/integrations/hubspot']],
  ['Do you integrate with Salesforce?', ['/integrations/salesforce']],
  ['Can I get Slack notifications?', ['/integrations/slack']],
  ['Does Vireek work with Stripe payments?', ['/integrations/stripe']],
  ['Does it work with Microsoft 365 calendar?', ['/integrations/microsoft-365']],
  ['How does Vireek compare to ServiceTitan?', ['/compare/servicetitan']],
  ['Vireek vs Smith.ai', ['/compare/smith-ai']],
  ['Vireek versus Ruby receptionists', ['/compare/ruby-receptionists']],
  ['How is Vireek different from a traditional answering service?', ['/compare/answering-service']],
  ['Alternative to Jobber', ['/compare/jobber']],
  ['Vireek vs Housecall Pro', ['/compare/housecall-pro']],
  ['Do you support HVAC companies?', ['/industries/hvac']],
  ['Can plumbers use Vireek?', ['/industries/plumbing']],
  ['Do you support pest control businesses?', ['/industries/pest-control']],
  ['Is there a solution for solar companies?', ['/industries/solar']],
  ['Does Vireek work for lawn care?', ['/industries/lawn-care']],
  ['Pool service answering', ['/industries/pool-service']],
  ['Is my data secure?', ['/security']],
  ['Do you have SOC 2 certification?', ['/security', '/faq']],
  ['Will callers know they are talking to an AI?', ['/ai-disclosure', '/faq', '/security']],
  ['Do I have to disclose that the receptionist is AI?', ['/ai-disclosure']],
  ['What are the terms of service?', ['/terms']],
  ['How do I contact support?', ['/help', '/contact', '/faq']],
  ['How do I get started with Vireek?', ['/help', '/features', '/faq', '/pricing']],
  ['How does emergency call detection work?', ['/features', '/help', '/faq']],
  ['Can Vireek book appointments?', ['/features', '/help']],
  ['Can calls be transferred to my on-call technician?', ['/features', '/help', '/pricing']],
  ['What is a missed call text back?', ['/features', '/help', '/pricing']],
  ['Who is behind Vireek and how big is the company?', ['/about']],
  ['What does Vireek not do?', ['/faq']],
];

// Out-of-scope / unknown: the best chunk must NOT look like a confident match (hand-off expected).
const UNKNOWN = [
  'What is the weather in Berlin tomorrow?',
  'Write me a poem about the ocean',
  'Who won the football world cup in 1998?',
  'How do I bake sourdough bread?',
  'What is the capital of Australia?',
];

const STOP = new Set('a an the is are was be to of and or in on for with do does can how what which who my i you it we vireek me this that at as by from'.split(' '));
const tok = (s) => s.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w));
const docs = chunks.map((c) => ({ url: c.url, t: tok(`${c.title} ${c.title} ${c.content}`) }));
const avg = docs.reduce((a, d) => a + d.t.length, 0) / docs.length;
const df = new Map();
for (const d of docs) for (const w of new Set(d.t)) df.set(w, (df.get(w) ?? 0) + 1);
const idf = (w) => Math.log(1 + (docs.length - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));

function rank(q) {
  const qt = [...new Set(tok(q))];
  return docs
    .map((d) => {
      const tf = new Map();
      for (const w of d.t) tf.set(w, (tf.get(w) ?? 0) + 1);
      let s = 0;
      for (const w of qt) {
        const f = tf.get(w) ?? 0;
        if (f) s += idf(w) * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.t.length / avg))));
      }
      return { url: d.url, s };
    })
    .sort((a, b) => b.s - a.s);
}

let hit = 0;
const misses = [];
for (const [q, urls] of ANSWERABLE) {
  const top = [];
  for (const r of rank(q)) if (!top.includes(r.url)) top.push(r.url);
  const top3 = top.slice(0, 3);
  if (top3.some((u) => urls.some((p) => u === p || u.startsWith(`${p}/`)))) hit++;
  else misses.push({ q, expected: urls, got: top3 });
}
const recall = hit / ANSWERABLE.length;
const answerableScores = ANSWERABLE.map(([q]) => rank(q)[0].s).sort((a, b) => a - b);
const threshold = answerableScores[Math.floor(answerableScores.length * 0.1)]; // 10th percentile of real questions
const unknownScores = UNKNOWN.map((q) => rank(q)[0].s);
const leaked = UNKNOWN.filter((q, i) => unknownScores[i] >= threshold);

console.log(`Golden retrieval (keyword/BM25 only): recall@3 = ${hit}/${ANSWERABLE.length} (${(recall * 100).toFixed(1)}%)`);
console.log(`Out-of-scope questions scored below the answerable 10th percentile (${threshold.toFixed(2)}): ${UNKNOWN.length - leaked.length}/${UNKNOWN.length}`);
if (verbose || misses.length) for (const m of misses) console.log(`  MISS: "${m.q}" expected ${m.expected.join('|')} got ${m.got.join(', ')}`);
if (leaked.length) console.log(`  LEAK (would look grounded): ${leaked.join(' | ')}`);
process.exit(recall >= MIN_RECALL && leaked.length <= MAX_LEAKS ? 0 : 1);

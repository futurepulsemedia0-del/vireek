#!/usr/bin/env node
// scripts/compliance/gen-subprocessors-by-region.mjs
//
// Keeps docs/compliance/data-map.md honest. Two jobs:
//   1. Regenerates the block between the GENERATED markers from the single sources of truth
//      (src/lib/subprocessors.ts + src/lib/trustPack/subprocessorResidency.ts).
//   2. Scans supabase/functions for outbound provider hostnames and reports any provider that
//      is called from code but is NOT in the published sub-processor list.
//
// Usage:
//   node scripts/compliance/gen-subprocessors-by-region.mjs            # rewrite the block
//   node scripts/compliance/gen-subprocessors-by-region.mjs --check    # exit 1 on drift or unlisted provider
//
// NOT legal advice. Adding a provider to the public list triggers the customer-notice process
// in DpaContent.tsx section 5 — do that deliberately, do not "fix" the check by editing blindly.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = join(ROOT, 'docs', 'compliance', 'data-map.md');
const BEGIN = '<!-- BEGIN GENERATED:subprocessors -->';
const END = '<!-- END GENERATED:subprocessors -->';
const CHECK = process.argv.includes('--check');

/** hostname fragment -> the exact `name` the provider must have in subprocessors.ts (null = not a processor of personal data). */
export const HOST_TO_PROCESSOR = {
  'api.vapi.ai': 'Vapi Inc.',
  'generativelanguage.googleapis.com': 'Google LLC (Gemini API)',
  'api.groq.com': 'Groq, Inc.',
  'api.cerebras.ai': 'Cerebras Systems Inc.',
  'api.cloudflare.com': 'Cloudflare, Inc. (Workers AI)',
  'openrouter.ai': 'OpenRouter, Inc.',
  'api.anthropic.com': 'Anthropic',
  'api.cohere.com': 'Cohere',
  'api.openai.com': 'OpenAI',
  'api.elevenlabs.io': 'ElevenLabs',
  'api.twilio.com': 'Twilio',
  'api.stripe.com': 'Stripe, Inc.',
  'api.resend.com': 'Resend',
  'api.lob.com': 'Lob',
  'graph.facebook.com': 'Meta Platforms',
  'a.klaviyo.com': 'Klaviyo',
  'slack.com/api': 'Slack',
  'api.xero.com': 'Xero',
  'api.getjobber.com': 'Jobber',
  'api.servicetitan.io': 'ServiceTitan',
  'api.gusto.com': 'Gusto',
  'api.yelp.com': 'Yelp',
  'oauth2.googleapis.com': 'Google LLC (Google Calendar)',
};

const read = (p) => readFileSync(p, 'utf8');

function parseProcessors() {
  const src = read(join(ROOT, 'src/lib/subprocessors.ts'));
  const out = [];
  const re = /\{\s*name:\s*'([^']+)',\s*purpose:\s*'((?:[^'\\]|\\.)*)',\s*location:\s*'([^']+)',\s*dataTypes:\s*'((?:[^'\\]|\\.)*)'\s*\}/g;
  let m;
  while ((m = re.exec(src))) out.push({ name: m[1], purpose: m[2], location: m[3], dataTypes: m[4] });
  return out;
}

function parseResidency() {
  const src = read(join(ROOT, 'src/lib/trustPack/subprocessorResidency.ts'));
  const body = /PROCESSOR_RESIDENCY[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? '';
  const map = {};
  const re = /'([^']+)':\s*'([a-z_]+)'/g;
  let m;
  while ((m = re.exec(body))) map[m[1]] = m[2];
  return map;
}

function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f)) acc.push(p);
  }
  return acc;
}

function usedHosts() {
  const fnDir = join(ROOT, 'supabase/functions');
  const hits = {};
  for (const file of walk(fnDir)) {
    const text = read(file);
    for (const host of Object.keys(HOST_TO_PROCESSOR)) {
      if (text.includes(host)) (hits[host] ??= []).push(file.slice(ROOT.length + 1));
    }
  }
  return hits;
}

const CLASS_LABEL = {
  regional: 'Regional data plane (recordings + sealed fields only, once a region is verified)',
  us_processing: 'US processing in transit — outside the region for non-US tenants',
  no_customer_content: 'No customer content by design',
  customer_optional: 'Only if the customer connects it',
};

function render(processors, residency) {
  const lines = [];
  lines.push('| Processor | Purpose | Listed location | Residency class | EU / UK / CA / AU tenant impact |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const p of processors) {
    const cls = residency[p.name];
    const impact = !cls ? '**UNCLASSIFIED**'
      : cls === 'us_processing' ? 'Transfer outside region (needs mechanism + TIA)'
      : cls === 'regional' ? 'In-region only for data written to the regional plane; control plane stays US'
      : cls === 'no_customer_content' ? 'None expected (verify)'
      : 'Customer-controlled; customer is responsible for their own transfer basis';
    lines.push(`| ${p.name} | ${p.purpose} | ${p.location} | ${CLASS_LABEL[cls] ?? 'UNCLASSIFIED'} | ${impact} |`);
  }
  return lines.join('\n');
}

const processors = parseProcessors();
const residency = parseResidency();
if (processors.length === 0) { console.error('Parser found 0 processors in src/lib/subprocessors.ts — the file format changed; update this script.'); process.exit(2); }

const listedNames = new Set(processors.map((p) => p.name));
const hits = usedHosts();
const unlisted = [];
for (const [host, files] of Object.entries(hits)) {
  const expected = HOST_TO_PROCESSOR[host];
  if (!listedNames.has(expected)) unlisted.push({ provider: expected, host, files });
}
const unclassified = processors.filter((p) => !residency[p.name]).map((p) => p.name);

const block = `${BEGIN}\n_Generated by scripts/compliance/gen-subprocessors-by-region.mjs — do not edit by hand._\n\n${render(processors, residency)}\n\n### Providers called from code but NOT in the published list\n${
  unlisted.length ? unlisted.map((u) => `- **${u.provider}** (\`${u.host}\`) — ${u.files.length} file(s), e.g. \`${u.files[0]}\``).join('\n') : '_None._'
}\n${END}`;

if (!existsSync(DOC)) { console.error(`Missing ${DOC}. Create docs/compliance/data-map.md with the two marker comments first.`); process.exit(2); }
const current = read(DOC);
const i = current.indexOf(BEGIN), j = current.indexOf(END);
if (i < 0 || j < 0 || j < i) { console.error('Marker comments not found in data-map.md.'); process.exit(2); }
const next = current.slice(0, i) + block + current.slice(j + END.length);

let failed = false;
if (unclassified.length) { console.error('Unclassified processors:', unclassified.join(', ')); failed = true; }
if (unlisted.length) { console.error('Providers used in code but missing from the public list:', unlisted.map((u) => u.provider).join(', ')); failed = true; }

if (CHECK) {
  if (next !== current) { console.error('data-map.md subprocessor block is stale. Run without --check.'); failed = true; }
  process.exit(failed ? 1 : 0);
}
writeFileSync(DOC, next);
console.log(`Updated ${DOC.slice(ROOT.length + 1)} — ${processors.length} listed, ${unlisted.length} unlisted-but-used, ${unclassified.length} unclassified.`);
process.exit(0);

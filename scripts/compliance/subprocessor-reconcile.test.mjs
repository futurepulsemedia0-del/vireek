// node --test scripts/compliance/subprocessor-reconcile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  BEGIN, END, REPO_ROOT, SLUG_TO_LISTED, cspHosts, detect, extractAppEnvNames, extractDocEnvNames, injectBlock, loadExempt, parseListed, run,
} from './subprocessor-reconcile.mjs';

const proc = (name) => `      { name: '${name}', purpose: 'p', location: '[VERIFY]', dataTypes: 'd' },\n`;
const LIST = (names) => `export const SUBPROCESSOR_CATEGORIES = [\n  {\n    processors: [\n${names.map(proc).join('')}    ],\n  },\n];\n`;

function fixture({ listed = [], files = {}, exempt = [], csp = null }) {
  const root = mkdtempSync(join(tmpdir(), 'subproc-'));
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put('src/lib/subprocessors.ts', LIST(listed));
  put('scripts/compliance/subprocessor-exempt.json', JSON.stringify({ entries: exempt }));
  put('docs/compliance/subprocessor-reconciliation.md', `# t\n${BEGIN}\n${END}\n`);
  put('package.json', JSON.stringify({ dependencies: {} }));
  if (csp) put('vercel.json', JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: csp }] }] }));
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  return root;
}
const ex = (value, type = 'provider', reason = 'Reason that is long enough to pass validation.') => ({ type, value, reason, review: '[VERIFY] check' });

test('a listed provider used in code passes', () => {
  const root = fixture({ listed: ['Twilio Inc.'], files: { 'supabase/functions/a/index.ts': "await fetch('https://api.twilio.com/x');" } });
  const r = run(root);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.find((x) => x.id === 'twilio').status, 'listed');
});

test('a provider DOMAIN in code but absent from the list fails and names the provider', () => {
  const root = fixture({ listed: [], files: { 'supabase/functions/a/index.ts': "await fetch('https://api.twilio.com/x');" } });
  const r = run(root);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0], /"twilio".*missing from the public list.*Twilio Inc\./);
});

test('a provider ENV VAR in code but absent from the list fails', () => {
  const root = fixture({ listed: [], files: { 'supabase/functions/a/index.ts': "const k = Deno.env.get('TWILIO_AUTH_TOKEN');" } });
  assert.match(run(root).failures[0], /"twilio"/);
});

test('a VITE_ env var in the web app is attributed to its provider', () => {
  const root = fixture({ listed: [], files: { 'src/a.ts': 'const d = import.meta.env.VITE_SENTRY_DSN;' } });
  assert.match(run(root).failures[0], /"sentry"/);
});

test('a provider only found in the CSP fails unless listed', () => {
  const csp = "default-src 'self'; connect-src 'self' https://submit-form.com";
  assert.match(run(fixture({ listed: [], csp })).failures[0], /"formspark"/);
  assert.deepEqual(run(fixture({ listed: ['Formspark (submit-form.com)'], csp })).failures, []);
});

test('an unknown host in an edge function fails; an explicit host exemption clears it', () => {
  const files = { 'supabase/functions/a/index.ts': "await fetch('https://api.brand-new-vendor.io/v1');" };
  const bad = run(fixture({ files }));
  assert.match(bad.failures[0], /brand-new-vendor\.io/);
  const ok = run(fixture({ files, exempt: [ex('api.brand-new-vendor.io', 'host')] }));
  assert.deepEqual(ok.failures, []);
});

test('an unknown host next to fetch() in the web app fails, but a plain link does not', () => {
  const link = run(fixture({ files: { 'src/a.tsx': 'const u = "https://www.linkedin.com/company/x";' } }));
  assert.deepEqual(link.failures, []);
  const call = run(fixture({ files: { 'src/a.ts': "await fetch('https://forms.unknown-vendor.io/f/1');" } }));
  assert.match(call.failures[0], /unknown-vendor\.io/);
});

test('exemptions need a real reason and a [VERIFY]/[COUNSEL] review flag', () => {
  const root = fixture({ exempt: [{ type: 'provider', value: 'x', reason: 'short', review: '' }] });
  const { errors } = loadExempt(root);
  assert.equal(errors.length, 2);
});

test('provider exemption clears a provider that has no mapping', () => {
  const files = { 'supabase/functions/a/index.ts': "import 'https://esm.sh/zod';" };
  assert.match(run(fixture({ files })).failures[0], /"package-cdns"/);
  assert.deepEqual(run(fixture({ files, exempt: [ex('package-cdns')] })).failures, []);
});

test('a processor the parser cannot read is reported instead of silently dropped', () => {
  const root = fixture({ listed: ['A'] });
  writeFileSync(join(root, 'src/lib/subprocessors.ts'), "{ name: 'A',\n purpose: 'p', location: 'l',\n dataTypes: 'd' }, { name: 'B', purpose: 'p', location: 'l' },");
  assert.match(run(root).errors.join('\n'), /parsed processors/);
});

test('helpers: csp hosts, env extraction, block injection', () => {
  assert.deepEqual(cspHosts("default-src 'self'; connect-src 'self' https://*.ingest.sentry.io wss://api.vapi.ai:443/x; base-uri 'self'").sort(), ['api.vapi.ai', 'ingest.sentry.io']);
  assert.deepEqual(extractAppEnvNames("Deno.env.get('A_B') import.meta.env.VITE_X process.env.Y_Z").sort(), ['A_B', 'VITE_X', 'Y_Z']);
  assert.deepEqual(extractDocEnvNames('| `STRIPE_SECRET_KEY` | x |', 'ENVIRONMENT.md'), ['STRIPE_SECRET_KEY']);
  assert.deepEqual(extractDocEnvNames('# TWILIO_AUTH_TOKEN=\nFOO=1', '.env.example'), ['TWILIO_AUTH_TOKEN']);
  assert.equal(injectBlock(`a${BEGIN}x${END}b`, `${BEGIN}y${END}`), `a${BEGIN}y${END}b`);
  assert.equal(injectBlock('no markers', 'x'), null);
});

// ---- Checks against the REAL repository -------------------------------------------------------------------

test('REAL REPO: no missing providers, no unmapped providers, no unclassified hosts, valid exemptions', () => {
  const r = run(REPO_ROOT);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.failures, []);
});

test('REAL REPO: the generated doc is current', () => {
  const r = run(REPO_ROOT);
  const doc = readFileSync(join(REPO_ROOT, 'docs/compliance/subprocessor-reconciliation.md'), 'utf8');
  assert.equal(injectBlock(doc, r.block), doc);
});

test('REAL REPO: every SLUG_TO_LISTED name is a listed processor, and every listed name has a residency class', () => {
  const listed = parseListed(readFileSync(join(REPO_ROOT, 'src/lib/subprocessors.ts'), 'utf8')).map((p) => p.name);
  for (const names of Object.values(SLUG_TO_LISTED)) for (const n of names) assert.ok(listed.includes(n), `${n} is not listed`);
  const res = readFileSync(join(REPO_ROOT, 'src/lib/trustPack/subprocessorResidency.ts'), 'utf8');
  const body = /PROCESSOR_RESIDENCY[^=]*=\s*\{([\s\S]*?)\n\};/.exec(res)[1];
  const classified = [...body.matchAll(/^\s*'((?:[^'\\]|\\.)+)':\s*'([a-z_]+)'/gm)].map((m) => m[1]);
  assert.deepEqual(listed.filter((n) => !classified.includes(n)), [], 'listed but unclassified');
  assert.deepEqual(classified.filter((n) => !listed.includes(n)), [], 'classified but not listed');
});

test('REAL REPO: gen-subprocessors-by-region expects only names that are listed', () => {
  const listed = parseListed(readFileSync(join(REPO_ROOT, 'src/lib/subprocessors.ts'), 'utf8')).map((p) => p.name);
  const src = readFileSync(join(REPO_ROOT, 'scripts/compliance/gen-subprocessors-by-region.mjs'), 'utf8');
  const body = /HOST_TO_PROCESSOR\s*=\s*\{([\s\S]*?)\n\};/.exec(src)[1];
  const pairs = [...body.matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.ok(pairs.length > 10);
  const usedHosts = new Set([...detect(REPO_ROOT).evidence.values()].flatMap((e) => [...e.hosts]));
  // Only hosts the code really calls must resolve to a listed name (e.g. api.openai.com is a standing tripwire, not a dependency).
  const wrong = pairs.filter(([h, n]) => [...usedHosts].some((u) => u.includes(h.split('/')[0])) && !listed.includes(n));
  assert.deepEqual(wrong, []);
});

test('REAL REPO: every processor has a non-empty location, purpose and data types', () => {
  const listed = parseListed(readFileSync(join(REPO_ROOT, 'src/lib/subprocessors.ts'), 'utf8'));
  assert.ok(listed.length >= 50);
  for (const p of listed) assert.ok(p.location.trim().length > 0 && p.purpose && p.dataTypes, p.name);
});

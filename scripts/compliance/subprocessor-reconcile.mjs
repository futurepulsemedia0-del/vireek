#!/usr/bin/env node
// scripts/compliance/subprocessor-reconcile.mjs
//
// Reconciles the PUBLIC sub-processor list (src/lib/subprocessors.ts) with what the code actually uses.
//
//   * Detects external providers from: edge functions (supabase/functions), the web app (src, api, worker,
//     index.html), the browser CSP in vercel.json, package.json dependencies, and env-var names documented in
//     ENVIRONMENT.md / .env.example. It REUSES the provider catalog of scripts/compliance/gen-vendor-exit.mjs
//     (PROVIDERS, IGNORED_HOST, extractors) and only adds the browser-side providers that catalog does not cover.
//   * Compares each detected provider with the published list (SLUG_TO_LISTED below).
//   * Writes the generated table into docs/compliance/subprocessor-reconciliation.md.
//   * --check fails (exit 1) when a provider env var / domain / package is found in code but its provider is
//     neither listed nor explicitly exempt in scripts/compliance/subprocessor-exempt.json.
//
// Usage:
//   node scripts/compliance/subprocessor-reconcile.mjs                 # rewrite the generated block of the doc
//   node scripts/compliance/subprocessor-reconcile.mjs --check         # CI mode (read-only)
//   node scripts/compliance/subprocessor-reconcile.mjs --explain <id>  # show the evidence for one provider id
//
// What this proves: what the checked-out source tree references. It does NOT prove production configuration,
// contract terms, or processing locations. Locations marked [VERIFY] are unverified. NOT legal advice.
// Adding a provider to the public list may trigger the customer-notice process in DpaContent.tsx section 5
// [COUNSEL]; this script never sends notices.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IGNORED_HOST, PROVIDERS, extractHosts, extractEnvNames } from './gen-vendor-exit.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LIST_FILE = 'src/lib/subprocessors.ts';
export const EXEMPT_FILE = 'scripts/compliance/subprocessor-exempt.json';
export const DOC_FILE = 'docs/compliance/subprocessor-reconciliation.md';
export const BEGIN = '<!-- BEGIN GENERATED:reconciliation -->';
export const END = '<!-- END GENERATED:reconciliation -->';

/**
 * Browser-side / non-edge providers that gen-vendor-exit's catalog does not cover. Matched BEFORE PROVIDERS, so a
 * more specific rule (e.g. analytics.google.com) wins over the broad `google` rule.
 * host/env/pkg are tested against: hostnames, env-var names (also with a leading VITE_ removed), package names.
 */
export const EXTRA_CATALOG = [
  { id: 'sentry', name: 'Sentry', host: /(^|\.)sentry\.io$/, env: /^SENTRY_/, pkg: /^@sentry\// },
  { id: 'google-analytics', name: 'Google Analytics', host: /^(www\.)?(googletagmanager\.com|google-analytics\.com)$|^analytics\.google\.com$/, env: /^GA4_/ },
  { id: 'google-fonts', name: 'Google Fonts', host: /^fonts\.(googleapis|gstatic)\.com$/ },
  { id: 'formspark', name: 'Formspark (submit-form.com)', host: /(^|\.)submit-form\.com$/ },
  { id: 'formspree', name: 'Formspree', host: /(^|\.)formspree\.io$/ },
  { id: 'map-tiles', name: 'Map tile / style provider', host: /(^|\.)openfreemap\.org$/, env: /^MAP_STYLE_/ },
  { id: 'zapier', name: 'Zapier', host: /(^|\.)zapier\.com$/, env: /^ZAPIER_/ },
  { id: 'glitchtip', name: 'GlitchTip', host: /(^|\.)glitchtip\.com$/ },
  { id: 'banuba', name: 'Banuba', host: /(^|\.)banuba\.cloud$/ },
  { id: 'pluot', name: 'pluot.blue (unidentified)', host: /(^|\.)pluot\.blue$/ },
  { id: 'embedded-video', name: 'Embedded video players (YouTube, Vimeo)', host: /(^|\.)(youtube-nocookie\.com|youtube\.com|vimeo\.com)$/ },
  { id: 'daily', name: 'Daily.co', host: /(^|\.)dailywebrtc\.(com|net)$/ },
  { id: 'stripe', name: 'Stripe', pkg: /^@stripe\/|stripe-terminal/ },
  { id: 'vapi', name: 'Vapi', pkg: /^@vapi-ai\// },
  { id: 'google', name: 'Google', pkg: /^firebase$|^@capacitor-firebase\// },
];

/**
 * Detected provider id -> the EXACT `name` values it must have in src/lib/subprocessors.ts.
 * Add a row here whenever a new provider id appears; the CI check names the id that is missing.
 */
export const SLUG_TO_LISTED = {
  supabase: ['Supabase, Inc.'],
  vercel: ['Vercel Inc.'],
  cloudflare: ['Cloudflare, Inc. (Workers AI)', 'Cloudflare, Inc. (Turnstile, TURN, DNS)'],
  pagerduty: ['PagerDuty, Inc.'],
  gemini: ['Google LLC (Gemini API)'],
  groq: ['Groq, Inc.'],
  cerebras: ['Cerebras Systems Inc.'],
  openrouter: ['OpenRouter, Inc.'],
  anthropic: ['Anthropic, PBC'],
  cohere: ['Cohere'],
  vapi: ['Vapi Inc.'],
  twilio: ['Twilio Inc.'],
  telnyx: ['Telnyx LLC'],
  sinch: ['Sinch'],
  elevenlabs: ['ElevenLabs'],
  daily: ['Daily.co'],
  resend: ['Resend'],
  lob: ['Lob.com, Inc.'],
  meta: ['Meta Platforms, Inc.'],
  telegram: ['Telegram'],
  slack: ['Slack Technologies, LLC'],
  microsoft: ['Microsoft Corporation'],
  apple: ['Apple Inc.'],
  google: ['Google LLC (Google Calendar)', 'Google LLC (Firebase Cloud Messaging, Business Profile, Ads, BigQuery, Maps)'],
  stripe: ['Stripe, Inc.'],
  plaid: ['Plaid Inc.'],
  wisetack: ['Wisetack, Inc.'],
  taxjar: ['TaxJar, Inc.'],
  checkr: ['Checkr, Inc.'],
  quickbooks: ['Intuit Inc. (QuickBooks)'],
  xero: ['Xero Limited'],
  intacct: ['Sage Intacct'],
  netsuite: ['Oracle NetSuite'],
  zoho: ['Zoho Corporation'],
  gusto: ['Gusto, Inc.'],
  hubspot: ['HubSpot, Inc.'],
  'crm-connectors': ['Salesforce, Inc.', 'Pipedrive'],
  jobber: ['Jobber'],
  'housecall-pro': ['Housecall Pro'],
  servicetitan: ['ServiceTitan, Inc.'],
  'pm-suites': ['RealPage, Inc. (Buildium, Propertyware)', 'Yardi Systems, Inc.'],
  samsara: ['Samsara Inc.'],
  yelp: ['Yelp Inc.'],
  'property-data-providers': ['RentCast', 'ATTOM Data Solutions'],
  'customer-data-destinations': ['Splunk', 'Klaviyo, Inc.'],
  sentry: ['Sentry (Functional Software, Inc.)'],
  'google-analytics': ['Google LLC (Google Analytics)'],
  formspark: ['Formspark (submit-form.com)'],
  formspree: ['Formspree, Inc.'],
  'map-tiles': ['OpenFreeMap'],
  zapier: ['Zapier, Inc.'],
};

const read = (p) => readFileSync(p, 'utf8');
const toPosix = (p) => p.split('\\').join('/');

/** Parse every processor object out of src/lib/subprocessors.ts (same single-line shape the by-region script parses). */
export function parseListed(text) {
  const out = [];
  const re = /\{\s*name:\s*'((?:[^'\\]|\\.)*)',\s*purpose:\s*'((?:[^'\\]|\\.)*)',\s*location:\s*'((?:[^'\\]|\\.)*)',\s*dataTypes:\s*'((?:[^'\\]|\\.)*)'\s*\}/g;
  let m;
  while ((m = re.exec(text))) out.push({ name: m[1], purpose: m[2], location: m[3], dataTypes: m[4] });
  return out;
}

/** Count `name:` keys, so a processor written in a shape the parser cannot read is caught, not silently dropped. */
export const countNameKeys = (text) => (text.match(/\bname:\s*'/g) ?? []).length;

const walk = (d) =>
  !existsSync(d)
    ? []
    : readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        if (statSync(p).isDirectory()) return /^(node_modules|dist|build|\.git|test|tests|__tests__|__mocks__|fixtures|e2e)$/.test(n) ? [] : walk(p);
        return [p];
      });

const isCode = (f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !/\.(test|spec|stories)\.[tj]sx?$|\.d\.ts$|_test\.[tj]s$/.test(f);

/** Strip a leading VITE_ so VITE_SENTRY_DSN is matched by the same rule as SENTRY_DSN. */
const envForms = (n) => (n.startsWith('VITE_') ? [n, n.slice(5)] : [n]);

export function extractAppEnvNames(text) {
  const out = new Set(extractEnvNames(text));
  for (const m of text.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]+)/g)) out.add(m[1]);
  for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) out.add(m[1]);
  return [...out];
}

/** Env-var NAMES documented (not read) in ENVIRONMENT.md / .env.example. Values are never read. */
export function extractDocEnvNames(text, file) {
  const out = new Set();
  if (file.endsWith('.md')) for (const m of text.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)) out.add(m[1]);
  else for (const m of text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]{3,})\s*=/gm)) out.add(m[1]);
  return [...out];
}

/** Hosts a browser may contact according to a Content-Security-Policy string (scheme/port/path stripped, `*.` removed). */
export function cspHosts(csp) {
  const out = new Set();
  for (const directive of String(csp).split(';')) {
    const [name, ...vals] = directive.trim().split(/\s+/);
    if (!name || /^(base-uri|form-action|frame-ancestors|upgrade-insecure-requests)$/.test(name)) continue;
    for (const v of vals) {
      const m = /^(?:https?:\/\/|wss?:\/\/)?(\*\.)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?(?:\/.*)?$/i.exec(v);
      if (m && !/^'/.test(v)) out.add(m[2].toLowerCase());
    }
  }
  return [...out];
}

export function readCspFromVercelJson(root) {
  const f = join(root, 'vercel.json');
  if (!existsSync(f)) return null;
  const json = JSON.parse(read(f));
  for (const block of json.headers ?? []) {
    for (const h of block.headers ?? []) if (String(h.key).toLowerCase() === 'content-security-policy') return String(h.value);
  }
  return null;
}

const catalogMatchHost = (host) => EXTRA_CATALOG.find((p) => p.host?.test(host))?.id ?? PROVIDERS.find((p) => p.host?.test(host))?.slug ?? null;
const catalogMatchEnv = (name) => {
  const ids = new Set();
  for (const form of envForms(name)) {
    for (const p of EXTRA_CATALOG) if (p.env?.test(form)) ids.add(p.id);
    for (const p of PROVIDERS) if (p.env?.test(form)) ids.add(p.slug);
  }
  return [...ids];
};
const catalogMatchPkg = (name) => [...new Set([...EXTRA_CATALOG.filter((p) => p.pkg?.test(name)).map((p) => p.id)])];

/** Hosts that appear next to a network call in app code but belong to no known provider. */
const FETCH_LINE = /fetch\(|new WebSocket\(|new EventSource\(|sendBeacon\(|_ENDPOINT\b|\.src\s*=/;

/**
 * @returns {{ evidence: Map<string, {areas:Set<string>, kinds:Set<string>, hosts:Set<string>, envs:Set<string>, pkgs:Set<string>, files:Set<string>}>, unclassifiedHosts: Map<string,string[]> }}
 */
export function detect(root = REPO_ROOT) {
  const evidence = new Map();
  const unclassifiedHosts = new Map();
  const ev = (id) => {
    if (!evidence.has(id)) evidence.set(id, { areas: new Set(), kinds: new Set(), hosts: new Set(), envs: new Set(), pkgs: new Set(), files: new Set() });
    return evidence.get(id);
  };
  const note = (id, area, kind, value, file) => {
    const e = ev(id);
    e.areas.add(area);
    e.kinds.add(kind);
    if (kind === 'host') e.hosts.add(value);
    if (kind === 'env') e.envs.add(value);
    if (kind === 'package') e.pkgs.add(value);
    if (file) e.files.add(file);
  };
  const unclassified = (host, file) => {
    if (!unclassifiedHosts.has(host)) unclassifiedHosts.set(host, []);
    unclassifiedHosts.get(host).push(file);
  };

  const areas = [
    ['edge functions', 'supabase/functions', true],
    ['web app', 'src', false],
    ['api routes', 'api', false],
    ['worker', 'worker', false],
  ];
  for (const [area, dir, isEdge] of areas) {
    const base = join(root, dir);
    for (const abs of walk(base).filter(isCode)) {
      const rel = toPosix(abs.slice(root.length + 1));
      const fnRel = isEdge ? toPosix(abs.slice(base.length + 1)) : null;
      const text = read(abs);
      const hosts = extractHosts(text);
      for (const h of hosts) {
        if (IGNORED_HOST.test(h)) continue;
        const id = catalogMatchHost(h);
        if (id) note(id, area, 'host', h, rel);
        else if (isEdge) unclassified(h, rel);
        else {
          // Web app: links to social profiles etc. are not processors; only hosts next to a network call are.
          const hit = text.split('\n').some((line) => line.includes(h) && FETCH_LINE.test(line));
          if (hit) unclassified(h, rel);
        }
      }
      for (const n of extractAppEnvNames(text)) for (const id of catalogMatchEnv(n)) note(id, area, 'env', n, rel);
      if (fnRel) for (const p of PROVIDERS) if (p.path?.test(fnRel)) note(p.slug, area, 'path', fnRel, rel);
    }
  }

  // index.html + public static pages: script/link/iframe hosts.
  for (const f of ['index.html']) {
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    for (const h of extractHosts(read(abs))) {
      if (IGNORED_HOST.test(h)) continue;
      const id = catalogMatchHost(h);
      if (id) note(id, 'web app', 'host', h, f);
      else unclassified(h, f);
    }
  }

  // Browser CSP = every host the browser is allowed to contact.
  const csp = readCspFromVercelJson(root);
  if (csp) {
    for (const h of cspHosts(csp)) {
      if (IGNORED_HOST.test(h)) continue;
      if (/(^|\.)supabase\.co$/.test(h) && !catalogMatchHost(h)) continue;
      const id = catalogMatchHost(h);
      if (id) note(id, 'browser CSP', 'host', h, 'vercel.json');
      else unclassified(h, 'vercel.json');
    }
  }

  // package.json dependencies (SDKs).
  const pkgFile = join(root, 'package.json');
  if (existsSync(pkgFile)) {
    const pkg = JSON.parse(read(pkgFile));
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) for (const id of catalogMatchPkg(name)) note(id, 'package.json', 'package', name, 'package.json');
  }

  // Env names documented for operators.
  for (const f of ['ENVIRONMENT.md', '.env.example']) {
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    for (const n of extractDocEnvNames(read(abs), f)) for (const id of catalogMatchEnv(n)) note(id, 'env docs', 'env', n, f);
  }

  return { evidence, unclassifiedHosts };
}

export function loadExempt(root = REPO_ROOT) {
  const f = join(root, EXEMPT_FILE);
  if (!existsSync(f)) return { entries: [], errors: [`${EXEMPT_FILE} is missing`] };
  const errors = [];
  let json;
  try {
    json = JSON.parse(read(f));
  } catch (e) {
    return { entries: [], errors: [`${EXEMPT_FILE} is not valid JSON: ${e.message}`] };
  }
  const entries = Array.isArray(json.entries) ? json.entries : [];
  entries.forEach((e, i) => {
    if (!['provider', 'host', 'env'].includes(e.type)) errors.push(`${EXEMPT_FILE} entry ${i}: type must be provider | host | env`);
    if (typeof e.value !== 'string' || !e.value) errors.push(`${EXEMPT_FILE} entry ${i}: value is required`);
    if (typeof e.reason !== 'string' || e.reason.trim().length < 20) errors.push(`${EXEMPT_FILE} entry ${i} (${e.value}): a reason of at least 20 characters is required`);
    if (!/\[(VERIFY|COUNSEL)\]/.test(String(e.review ?? ''))) errors.push(`${EXEMPT_FILE} entry ${i} (${e.value}): review must contain [VERIFY] or [COUNSEL]`);
  });
  return { entries, errors };
}

/** Core comparison. Pure: takes already-loaded inputs so it can be unit-tested. */
export function reconcile({ listed, evidence, unclassifiedHosts, exempt }) {
  const listedNames = new Set(listed.map((p) => p.name));
  const exProv = new Map(exempt.filter((e) => e.type === 'provider').map((e) => [e.value, e]));
  const exHost = new Map(exempt.filter((e) => e.type === 'host').map((e) => [e.value, e]));
  const exEnv = new Map(exempt.filter((e) => e.type === 'env').map((e) => [e.value, e]));

  const rows = [];
  const failures = [];
  const warnings = [];
  const usedExemptions = new Set();

  for (const id of [...evidence.keys()].sort()) {
    const e = evidence.get(id);
    [...e.envs].filter((n) => exEnv.has(n)).forEach((n) => usedExemptions.add(`env:${n}`));
    const mapped = SLUG_TO_LISTED[id];
    const ex = exProv.get(id);
    let status;
    if (ex) {
      status = 'exempt';
      usedExemptions.add(`provider:${id}`);
    } else if (!mapped) {
      status = 'unmapped';
      failures.push(`Provider "${id}" is used in code (${[...e.kinds].join('/')}; ${[...e.areas].join(', ')}) but is not in SLUG_TO_LISTED and not exempt. Add it to ${LIST_FILE} + SLUG_TO_LISTED, or exempt it in ${EXEMPT_FILE} with a reason.`);
    } else {
      const missing = mapped.filter((n) => !listedNames.has(n));
      if (missing.length) {
        status = 'missing';
        failures.push(`Provider "${id}" is used in code but missing from the public list: ${missing.join('; ')} (${LIST_FILE}).`);
      } else status = 'listed';
    }
    const names = mapped ?? [];
    const first = names.map((n) => listed.find((p) => p.name === n)).filter(Boolean);
    rows.push({
      id,
      status,
      listedAs: names,
      purpose: first.map((p) => p.purpose),
      dataTypes: first.map((p) => p.dataTypes),
      location: first.map((p) => p.location),
      areas: [...e.areas].sort(),
      kinds: [...e.kinds].sort(),
      exemptReason: ex?.reason ?? null,
    });
  }

  for (const [host, files] of [...unclassifiedHosts.entries()].sort()) {
    if (exHost.has(host)) {
      usedExemptions.add(`host:${host}`);
      continue;
    }
    failures.push(`Host "${host}" is contacted by the app (${files[0]}) but belongs to no known provider. Classify it (EXTRA_CATALOG), list it, or exempt it in ${EXEMPT_FILE}.`);
  }

  // Listed processors that no detected provider maps to => no code evidence (warning only: Zapier-style inbound-only vendors).
  const mappedNames = new Set(rows.flatMap((r) => r.listedAs));
  for (const p of listed) if (!mappedNames.has(p.name)) warnings.push(`Listed but no code evidence found: "${p.name}" (inbound-only, configured at runtime, or stale?) [VERIFY].`);
  // Listed names that SLUG_TO_LISTED does not reference at all => mapping drift.
  const everMapped = new Set(Object.values(SLUG_TO_LISTED).flat());
  for (const p of listed) if (!everMapped.has(p.name) && !/^Zapier/.test(p.name)) warnings.push(`"${p.name}" is listed but not referenced by SLUG_TO_LISTED (mapping drift).`);
  for (const key of [...exProv.keys()].map((k) => `provider:${k}`).concat([...exHost.keys()].map((k) => `host:${k}`), [...exEnv.keys()].map((k) => `env:${k}`))) {
    if (!usedExemptions.has(key)) warnings.push(`Stale exemption (matches nothing in code): ${key}`);
  }
  for (const id of Object.keys(SLUG_TO_LISTED)) for (const n of SLUG_TO_LISTED[id]) if (!listedNames.has(n) && !evidence.has(id)) warnings.push(`SLUG_TO_LISTED["${id}"] names "${n}", which is neither listed nor detected.`);

  return { rows, failures, warnings };
}

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const cell = (arr) => (arr.length ? arr.map(esc).join('<br>') : '—');

export function renderBlock(rows, counts) {
  const head = '| Provider id | Listed as | Purpose | Data categories | Location | Where used | Status |\n|---|---|---|---|---|---|---|';
  const lines = rows.map((r) => {
    const status = r.status === 'exempt' ? `exempt — ${esc(r.exemptReason ?? 'env-name match only')}` : r.status;
    return `| \`${r.id}\` | ${cell(r.listedAs)} | ${cell(r.purpose)} | ${cell(r.dataTypes)} | ${cell(r.location)} | ${esc(r.areas.join(', '))} | ${status} |`;
  });
  return [
    BEGIN,
    '_Generated by `node scripts/compliance/subprocessor-reconcile.mjs` — do not edit between the markers. Static scan of the checked-out tree: it shows what the code references, not what is configured in production. Locations containing [VERIFY] are unverified._',
    '',
    `${counts.total} providers / provider groups detected · ${counts.listed} listed · ${counts.missing + counts.unmapped} missing or unmapped · ${counts.exempt} exempt.`,
    '',
    head,
    ...lines,
    END,
  ].join('\n');
}

export function injectBlock(text, block) {
  const i = text.indexOf(BEGIN);
  const j = text.indexOf(END);
  if (i < 0 || j < 0 || j < i) return null;
  return text.slice(0, i) + block + text.slice(j + END.length);
}

export function run(root = REPO_ROOT) {
  const listText = read(join(root, LIST_FILE));
  const listed = parseListed(listText);
  const errors = [];
  if (listed.length === 0) errors.push(`${LIST_FILE}: parser found 0 processors — the file format changed; update parseListed().`);
  if (listed.length !== countNameKeys(listText)) errors.push(`${LIST_FILE}: ${countNameKeys(listText)} name: keys but ${listed.length} parsed processors — keep each processor on ONE line as { name, purpose, location, dataTypes }.`);
  const dup = listed.map((p) => p.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) errors.push(`${LIST_FILE}: duplicate processor names: ${[...new Set(dup)].join(', ')}`);

  const { entries, errors: exErrors } = loadExempt(root);
  errors.push(...exErrors);
  const { evidence, unclassifiedHosts } = detect(root);
  const result = reconcile({ listed, evidence, unclassifiedHosts, exempt: entries });
  const counts = {
    total: result.rows.length,
    listed: result.rows.filter((r) => r.status === 'listed').length,
    missing: result.rows.filter((r) => r.status === 'missing').length,
    unmapped: result.rows.filter((r) => r.status === 'unmapped').length,
    exempt: result.rows.filter((r) => r.status === 'exempt').length,
  };
  return { ...result, errors, counts, evidence, block: renderBlock(result.rows, counts) };
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const ei = argv.indexOf('--explain');
  const r = run();
  if (ei >= 0) {
    const id = argv[ei + 1];
    const e = r.evidence.get(id);
    if (!e) { console.error(`No evidence for "${id}".`); return 1; }
    console.log(JSON.stringify({ id, areas: [...e.areas], hosts: [...e.hosts].sort(), envNames: [...e.envs].sort(), packages: [...e.pkgs].sort(), files: [...e.files].sort().slice(0, 40) }, null, 2));
    return 0;
  }
  const docPath = join(REPO_ROOT, DOC_FILE);
  let failed = false;
  for (const m of r.errors) { console.error(`ERROR: ${m}`); failed = true; }
  for (const m of r.failures) { console.error(`FAIL: ${m}`); failed = true; }
  for (const m of r.warnings) console.warn(`warn: ${m}`);
  if (!existsSync(docPath)) { console.error(`ERROR: ${DOC_FILE} is missing (create it with the two marker comments).`); return 2; }
  const current = read(docPath);
  const next = injectBlock(current, r.block);
  if (next === null) { console.error(`ERROR: marker comments not found in ${DOC_FILE}.`); return 2; }
  if (check) {
    if (next !== current) { console.error(`FAIL: ${DOC_FILE} is stale. Run: node scripts/compliance/subprocessor-reconcile.mjs`); failed = true; }
    if (!failed) console.log(`OK — ${r.counts.total} providers reconciled (${r.counts.listed} listed, ${r.counts.exempt} exempt), ${r.warnings.length} warning(s).`);
    return failed ? 1 : 0;
  }
  writeFileSync(docPath, next);
  console.log(`Updated ${DOC_FILE} — ${r.counts.total} providers: ${r.counts.listed} listed, ${r.counts.missing + r.counts.unmapped} missing/unmapped, ${r.counts.exempt} exempt.`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());

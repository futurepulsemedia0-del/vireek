#!/usr/bin/env node
// scripts/compliance/gen-vendor-exit.mjs
//
// Keeps docs/vendor-exit/ honest. It never invents vendor facts; it only measures THIS repository.
//   1. Scans supabase/functions (source files, relative-import graph) and supabase/migrations and, per external
//      provider, regenerates the block between the GENERATED:scan markers of docs/vendor-exit/<slug>.md:
//      edge functions that call it directly, edge functions that reach it only through shared modules, secret
//      NAMES (never values), outbound hosts, and provider-identifier columns.
//   2. Regenerates the index in docs/vendor-exit/README.md from the per-provider header tables.
//   3. --check fails (exit 1) when: a provider found in code has no doc, a generated block is stale, an outbound
//      host is not classified (provider or ignored), or a doc misses a required heading/field.
//      Overdue / never-performed drills are WARNINGS unless --strict-drills is given.
//
// Usage:
//   node scripts/compliance/gen-vendor-exit.mjs                 # rewrite generated blocks
//   node scripts/compliance/gen-vendor-exit.mjs --check         # CI mode (read-only)
//   node scripts/compliance/gen-vendor-exit.mjs --check --strict-drills
//   node scripts/compliance/gen-vendor-exit.mjs --init <slug>   # create docs/vendor-exit/<slug>.md from _TEMPLATE.md
//
// What this proves: what the checked-out source tree references. It does NOT prove production configuration,
// contract terms, or that any exit has been rehearsed. NOT legal advice.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN_DIR = 'supabase/functions';
const MIG_DIR = 'supabase/migrations';
export const DOC_DIR = 'docs/vendor-exit';
export const SCAN_BEGIN = '<!-- BEGIN GENERATED:scan -->';
export const SCAN_END = '<!-- END GENERATED:scan -->';
export const INDEX_BEGIN = '<!-- BEGIN GENERATED:index -->';
export const INDEX_END = '<!-- END GENERATED:index -->';
export const DRILL_INTERVAL_DAYS = 95; // quarterly (≈91 days) plus a few days of slack
export const NON_PROVIDER_DOCS = new Set(['README.md', '_TEMPLATE.md', 'QUARTERLY_DRILL_CHECKLIST.md']);
export const REQUIRED_HEADINGS = [
  '## 1. What depends on it',
  '## 2. Data export method',
  '## 3. Alternatives',
  '## 4. Estimated switch effort',
  '## 5. Exit steps',
  '## 6. Drill log',
];

/**
 * kind: platform   = hosts Vireek itself
 *       supplier   = Vireek holds the account; the vendor performs a function for Vireek
 *       customer   = the tenant's own account at that vendor, connected via OAuth / tenant-supplied key
 *       public     = no account; public or open data endpoints
 * host/env/path: signals that a source file depends on the provider (host and env are matched on literals only).
 * col: matches column names in supabase/migrations that carry the provider's identifiers.
 */
export const PROVIDERS = [
  { slug: 'supabase', name: 'Supabase', kind: 'platform', host: /(^|\.)supabase\.(co|com)$/, env: /^SUPABASE_/ },
  { slug: 'vercel', name: 'Vercel', kind: 'supplier', host: /(^|\.)vercel\.com$/, env: /^VERCEL_/ },
  { slug: 'cloudflare', name: 'Cloudflare', kind: 'supplier', host: /(^|\.)cloudflare(-dns)?\.com$/, env: /^(CLOUDFLARE_|CF_|TURNSTILE_)/ },
  { slug: 'pagerduty', name: 'PagerDuty', kind: 'supplier', host: /(^|\.)pagerduty\.com$/, env: /^PAGERDUTY_/ },
  { slug: 'package-cdns', name: 'Package and script CDNs (esm.sh, jsDelivr)', kind: 'supplier', host: /^(esm\.sh|cdn\.jsdelivr\.net)$/ },
  { slug: 'gemini', name: 'Google Gemini API', kind: 'supplier', host: /^generativelanguage\.googleapis\.com$/, env: /^(GEMINI_|GOOGLE_AI_)/ },
  { slug: 'groq', name: 'Groq', kind: 'supplier', host: /(^|\.)groq\.com$/, env: /^GROQ_/ },
  { slug: 'cerebras', name: 'Cerebras', kind: 'supplier', host: /(^|\.)cerebras\.ai$/, env: /^CEREBRAS_/ },
  { slug: 'openrouter', name: 'OpenRouter', kind: 'supplier', host: /(^|\.)openrouter\.ai$/, env: /^OPENROUTER_/ },
  { slug: 'anthropic', name: 'Anthropic', kind: 'supplier', host: /(^|\.)anthropic\.com$/, env: /^ANTHROPIC_/ },
  { slug: 'cohere', name: 'Cohere', kind: 'supplier', host: /(^|\.)cohere\.com$/, env: /^COHERE_/ },
  { slug: 'vapi', name: 'Vapi', kind: 'supplier', host: /(^|\.)vapi\.ai$/, env: /^VAPI_/, col: /vapi/i },
  { slug: 'twilio', name: 'Twilio', kind: 'supplier', host: /(^|\.)twilio\.com$|^com\.twilio\./, env: /^TWILIO_/, col: /twilio/i },
  { slug: 'telnyx', name: 'Telnyx', kind: 'supplier', host: /(^|\.)telnyx\.com$/, env: /^TELNYX_/ },
  { slug: 'sinch', name: 'Sinch (RCS / Apple Messages for Business)', kind: 'supplier', host: /(^|\.)sinch\.com$/, env: /^SINCH_/ },
  { slug: 'elevenlabs', name: 'ElevenLabs', kind: 'supplier', host: /(^|\.)elevenlabs\.io$/, env: /^ELEVENLABS_/, col: /elevenlabs/i },
  { slug: 'daily', name: 'Daily.co', kind: 'supplier', host: /(^|\.)daily\.co$/, env: /^DAILY_/ },
  { slug: 'resend', name: 'Resend', kind: 'supplier', host: /(^|\.)resend\.com$/, env: /^RESEND_/, col: /resend/i },
  { slug: 'lob', name: 'Lob', kind: 'supplier', host: /(^|\.)lob\.com$/, env: /^LOB_/, col: /(^|_)lob(_|$)/i },
  { slug: 'meta', name: 'Meta (WhatsApp, Messenger, Facebook)', kind: 'supplier', host: /(^|\.)facebook\.com$/, env: /^(META_|WHATSAPP_|FACEBOOK_|FB_)/, col: /whatsapp|meta_|facebook/i },
  { slug: 'telegram', name: 'Telegram', kind: 'supplier', host: /(^|\.)telegram\.org$/, env: /^TELEGRAM_/ },
  { slug: 'slack', name: 'Slack', kind: 'supplier', host: /(^|\.)slack\.com$/, env: /^SLACK_/, col: /slack/i },
  { slug: 'microsoft', name: 'Microsoft (Graph, Teams, Calendar)', kind: 'supplier', host: /(^|\.)(microsoft(online)?\.com|botframework\.com|trafficmanager\.net)$/, env: /^(MICROSOFT_|MS_|TEAMS_|AZURE_)/, col: /microsoft|teams_/i },
  { slug: 'apple', name: 'Apple (APNs, Wallet pass push)', kind: 'supplier', path: /(^|\/)(notify\/apns|wallet\/applePush)\.ts$/, env: /^(APNS_|APPLE_WALLET)/ },
  { slug: 'google', name: 'Google (OAuth, Calendar, Business Profile, Ads, Maps/Places, Sheets/BigQuery/Storage, Wallet, FCM)', kind: 'supplier', host: /^(?!generativelanguage\.)([a-z0-9-]+\.)*(googleapis\.com|google\.com)$/, env: /^(GOOGLE_|GBP_|FCM_|FIREBASE_)/, col: /google|gbp_/i },
  { slug: 'stripe', name: 'Stripe', kind: 'supplier', host: /(^|\.)stripe\.com$/, env: /^STRIPE_/, path: /(^|\/)stripe[^/]*(\/|\.ts$)/i, col: /stripe/i },
  { slug: 'plaid', name: 'Plaid', kind: 'supplier', host: /(^|\.)plaid\.com$/, env: /^PLAID_/, col: /plaid/i },
  { slug: 'wisetack', name: 'Wisetack', kind: 'supplier', host: /(^|\.)wisetack\.com$/, env: /^WISETACK_/ },
  { slug: 'taxjar', name: 'TaxJar', kind: 'supplier', host: /(^|\.)taxjar\.com$/, env: /^TAXJAR_/ },
  { slug: 'checkr', name: 'Checkr', kind: 'supplier', host: /(^|\.)checkr\.com$/, env: /^CHECKR_/ },
  { slug: 'quickbooks', name: 'QuickBooks Online (Intuit)', kind: 'customer', host: /(^|\.)intuit\.com$/, env: /^(QBO_|QUICKBOOKS_|INTUIT_)/, col: /quickbooks|qbo_/i },
  { slug: 'xero', name: 'Xero', kind: 'customer', host: /(^|\.)xero\.com$/, env: /^XERO_/, col: /xero/i },
  { slug: 'intacct', name: 'Sage Intacct', kind: 'customer', host: /(^|\.)intacct\.com$/, env: /^INTACCT_/, path: /(^|\/)intacct/i },
  { slug: 'netsuite', name: 'NetSuite (Oracle)', kind: 'customer', env: /^(NS_|NETSUITE_)/, path: /netsuite/i },
  { slug: 'zoho', name: 'Zoho (CRM and Books)', kind: 'customer', host: /zoho/, env: /^ZOHO_/ },
  { slug: 'gusto', name: 'Gusto (payroll connector)', kind: 'customer', host: /(^|\.)gusto(-demo)?\.com$/, env: /^(GUSTO_|PAYROLL_)/ },
  { slug: 'hubspot', name: 'HubSpot', kind: 'customer', host: /(^|\.)(hubapi|hubspot)\.com$/, env: /^HUBSPOT_/ },
  { slug: 'crm-connectors', name: 'CRM connectors (Salesforce, Pipedrive)', kind: 'customer', host: /(^|\.)(salesforce|pipedrive)\.com$/, env: /^(SALESFORCE_|PIPEDRIVE_)/ },
  { slug: 'jobber', name: 'Jobber', kind: 'customer', host: /(^|\.)getjobber\.com$/, env: /^JOBBER_/ },
  { slug: 'housecall-pro', name: 'Housecall Pro', kind: 'customer', host: /(^|\.)housecallpro\.com$/, env: /^(HCP_|HOUSECALL)/ },
  { slug: 'servicetitan', name: 'ServiceTitan', kind: 'customer', host: /(^|\.)servicetitan\.io$/, env: /^(SERVICETITAN_|ST_)/ },
  { slug: 'pm-suites', name: 'Property-management suites (Buildium, Propertyware, Rentvine, AppFolio, Yardi)', kind: 'customer', host: /(^|\.)(buildium|propertyware|rentvine|appfolio|yardi(aspx\d*)?)\.com$/ },
  { slug: 'samsara', name: 'Samsara (telematics)', kind: 'customer', host: /(^|\.)samsara\.com$/, env: /^SAMSARA_/ },
  { slug: 'yelp', name: 'Yelp', kind: 'supplier', host: /(^|\.)yelp\.com$/, env: /^YELP_/ },
  { slug: 'property-data-providers', name: 'Property data providers (RentCast, ATTOM)', kind: 'supplier', host: /(^|\.)(rentcast\.io|attomdata\.com)$/, env: /^(RENTCAST_|ATTOM_)/ },
  { slug: 'customer-data-destinations', name: 'Customer-chosen data destinations (Splunk, Datadog, Snowflake, Klaviyo)', kind: 'customer', host: /(^|\.)(splunkcloud\.com|datadoghq\.(com|eu)|snowflakecomputing\.com|klaviyo\.com)$/, env: /^(SPLUNK_|DATADOG_|SNOWFLAKE_|KLAVIYO_)/ },
  {
    slug: 'public-data-apis',
    name: 'Public and open data APIs (NWS, Census, FEMA, NASA, EIA, USGS, Open-Meteo, OSM, OSRM, FX)',
    kind: 'public',
    host: /^(api\.weather\.gov|api\.zippopotam\.us|nominatim\.openstreetmap\.org|geocoding\.geo\.census\.gov|api\.census\.gov|power\.larc\.nasa\.gov|(api|www)\.eia\.(gov)|hazards\.fema\.gov|earthquake\.usgs\.gov|services\.arcgis\.com|([a-z-]+\.)?open-meteo\.com|router\.project-osrm\.org|ipwho\.is|open\.er-api\.com|www\.ecfr\.gov)$/,
    env: /^(OPENWEATHER_|WEATHER_|FX_|EIA_)/,
  },
];

/** Hosts that are not dependencies: own domains, documentation/standards links, placeholders, test fixtures. */
export const IGNORED_HOST =
  /^(localhost|127\.0\.0\.1)$|(^|\.)(vireek\.com|example\.(com|org)|acme\.com|w3\.org|schema\.org|sitemaps\.org|oasis-open\.org|openxmlformats\.org|xmlsoap\.org|tempuri\.org|cxml\.org|llmstxt\.org|adaptivecards\.io|web\.dev|github\.com|x\.com|x\.co|servicechannel\.com|atlassian\.net)$|\.(test|invalid|local)$|^(docs?|developers?|support|help)\.|^(x\.test|http-intake\.logs)$|^(www\.)?(appfolio|yardi)\.com$/i;

export const COUPLING_TIERS = [
  [3, 'S'],
  [12, 'M'],
  [40, 'L'],
  [Infinity, 'XL'],
];
export const couplingTier = (n) => COUPLING_TIERS.find(([max]) => n <= max)[1];

const read = (p) => readFileSync(p, 'utf8');
const walk = (d) =>
  !existsSync(d)
    ? []
    : readdirSync(d).flatMap((n) => {
        const p = join(d, n);
        return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : [p];
      });
const isSource = (f) => /\.(ts|tsx|js|mjs)$/.test(f) && !/\.test\.[tj]sx?$|_test\.[tj]s$/.test(f);
const esc = (s) => String(s).replace(/\|/g, '\\|');
const code = (xs, cap = 30) =>
  xs.length ? xs.slice(0, cap).map((x) => `\`${esc(x)}\``).join(', ') + (xs.length > cap ? ` +${xs.length - cap} more` : '') : '—';

export function extractHosts(text) {
  const out = new Set();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z0-9-]{2,})/gi)) out.add(m[1].toLowerCase().replace(/[.-]+$/, ''));
  return [...out];
}
export const extractEnvNames = (text) => [...new Set([...text.matchAll(/Deno\.env\.get\(\s*['"]([A-Z0-9_]+)['"]/g)].map((m) => m[1]))];
export function extractRelativeSpecs(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) out.add(m[1]);
  return [...out];
}
/** Resolve a relative import to a known source path (posix, relative to supabase/functions) or null. */
export function resolveImport(fromRel, spec, known) {
  const base = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`]) if (known.has(c)) return c;
  return null;
}
export const classifyHost = (host, catalog = PROVIDERS) => {
  if (IGNORED_HOST.test(host)) return { ignored: true };
  const p = catalog.find((x) => x.host && x.host.test(host));
  return p ? { slug: p.slug } : { unclassified: true };
};

/** Best-effort "table.column" inventory from migrations (static; may include since-dropped columns). */
export function scanColumns(root) {
  const dir = join(root, MIG_DIR);
  const out = new Set();
  if (!existsSync(dir)) return [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    let cur = null;
    for (const line of read(join(dir, f)).split('\n')) {
      const c = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?/i.exec(line);
      if (c) cur = c[1];
      const a = /^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?(\w+)"?/i.exec(line);
      if (a) cur = a[1];
      const col = /^\s*(?:add\s+column\s+(?:if\s+not\s+exists\s+)?)?"?([a-z_0-9]+)"?\s+(?:text|uuid|jsonb?|varchar|int|integer|bigint|boolean|timestamptz|numeric)\b/i.exec(line);
      if (col && cur && !/^(p_|v_)/.test(col[1])) out.add(`${cur}.${col[1]}`);
    }
  }
  return [...out].sort();
}

export function scanRepo(root = REPO_ROOT, catalog = PROVIDERS) {
  const base = join(root, FN_DIR);
  const rels = walk(base).filter(isSource).map((p) => p.slice(base.length + 1).split('\\').join('/')).sort();
  const known = new Set(rels);
  const text = new Map(rels.map((r) => [r, read(join(base, r))]));
  const fnOf = (rel) => {
    const seg = rel.split('/');
    return seg.length > 1 && !seg[0].startsWith('_') ? seg[0] : null;
  };
  const functions = [...new Set(rels.map(fnOf).filter(Boolean))].sort();

  const graph = new Map(rels.map((r) => [r, extractRelativeSpecs(text.get(r)).map((s) => resolveImport(r, s, known)).filter(Boolean)]));
  const ownFiles = new Map(functions.map((f) => [f, rels.filter((r) => fnOf(r) === f)]));
  const reach = new Map();
  for (const f of functions) {
    const seen = new Set();
    const stack = [...ownFiles.get(f)];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const d of graph.get(cur) ?? []) if (!seen.has(d)) stack.push(d);
    }
    reach.set(f, seen);
  }

  const allCols = scanColumns(root);
  const unclassified = new Map();
  const facts = new Map();
  for (const p of catalog) facts.set(p.slug, { ...meta(p), seeds: new Set(), env: new Set(), hosts: new Set() });

  for (const rel of rels) {
    const hosts = extractHosts(text.get(rel));
    const envs = extractEnvNames(text.get(rel));
    for (const h of hosts) {
      const c = classifyHost(h, catalog);
      if (c.unclassified && !unclassified.has(h)) unclassified.set(h, rel);
    }
    for (const p of catalog) {
      const hostHits = p.host ? hosts.filter((h) => !IGNORED_HOST.test(h) && p.host.test(h)) : [];
      const envHits = p.env ? envs.filter((e) => p.env.test(e)) : [];
      const pathHit = p.path ? p.path.test(rel) : false;
      if (hostHits.length || envHits.length || pathHit) {
        const f = facts.get(p.slug);
        f.seeds.add(rel);
        hostHits.forEach((h) => f.hosts.add(h));
        envHits.forEach((e) => f.env.add(e));
      }
    }
  }

  const out = [];
  for (const p of catalog) {
    const f = facts.get(p.slug);
    if (!f.seeds.size) continue;
    const direct = [];
    const indirect = [];
    for (const fn of functions) {
      if (ownFiles.get(fn).some((r) => f.seeds.has(r))) direct.push(fn);
      else if ([...f.seeds].some((s) => reach.get(fn).has(s))) indirect.push(fn);
    }
    const total = direct.length + indirect.length;
    out.push({
      ...meta(p),
      direct,
      indirect,
      total,
      pct: functions.length ? Math.round((total / functions.length) * 100) : 0,
      tier: couplingTier(total),
      seams: [...f.seeds].filter((r) => r.startsWith('_shared/')).sort(),
      env: [...f.env].sort(),
      hosts: [...f.hosts].sort(),
      cols: p.col ? allCols.filter((c) => p.col.test(c.split('.')[1])) : null,
    });
  }
  return { functions: functions.length, providers: out, unclassified: [...unclassified].sort(), cols: allCols.length };
}
const meta = (p) => ({ slug: p.slug, name: p.name, kind: p.kind });

export function renderScan(f, totalFns) {
  const rows = [
    ['Edge functions calling it directly', `${f.direct.length}: ${code(f.direct)}`],
    ['Edge functions reaching it only through shared modules', `${f.indirect.length}: ${code(f.indirect, 15)}`],
    ['Blast radius (union)', `**${f.total}** of ${totalFns} edge functions (${f.pct}%)`],
    ['Code-coupling tier (measured: ≤3 S · ≤12 M · ≤40 L · >40 XL)', `**${f.tier}**`],
    ['Shared modules referencing it (the seams to change)', code(f.seams, 12)],
    ['Secret / env names read (names only, never values)', code(f.env, 20)],
    ['Outbound hosts seen in code', code(f.hosts, 20)],
  ];
  if (f.cols) rows.push([`Provider-identifier columns in migrations (${f.cols.length})`, f.cols.length ? code(f.cols, 25) : 'none found']);
  return [
    SCAN_BEGIN,
    '_Generated by `node scripts/compliance/gen-vendor-exit.mjs` — do not edit between the markers. Static scan of `supabase/functions`, its relative-import graph and `supabase/migrations`; it shows what this commit references, not what is configured in production. Blast radius is import reachability, an UPPER BOUND: a provider that is one link of a failover chain (for example the AI provider chain) counts every function that imports the chain._',
    '',
    '| Measure | Value |',
    '|---|---|',
    ...rows.map(([a, b]) => `| ${a} | ${b} |`),
    SCAN_END,
  ].join('\n');
}

export function injectBlock(textIn, begin, end, block) {
  const i = textIn.indexOf(begin);
  const j = textIn.indexOf(end);
  if (i === -1 || j === -1 || j < i) return null;
  return textIn.slice(0, i) + block + textIn.slice(j + end.length);
}

const row = (text, label) => new RegExp(`^\\|\\s*${label}[^|]*\\|\\s*(.+?)\\s*\\|\\s*$`, 'im').exec(text)?.[1] ?? null;
export function parseDocMeta(text) {
  const effort = /^\*\*(S|M|L|XL)\*\*/.exec(row(text, 'Estimated switch effort') ?? '')?.[1] ?? null;
  const tier = /^([123])\b/.exec(row(text, 'Criticality tier') ?? '')?.[1] ?? null;
  return { tier: tier ? Number(tier) : null, effort, lastDrill: row(text, 'Last drill date'), owner: row(text, 'Exit owner') };
}
export function drillStatus(value, now = new Date()) {
  if (!value) return { state: 'invalid', detail: 'missing' };
  if (/^never\b/i.test(value)) return { state: 'never' };
  const m = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(value);
  if (!m) return { state: 'invalid', detail: value };
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(d.getTime()) || d.getUTCMonth() !== +m[2] - 1) return { state: 'invalid', detail: value };
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 0) return { state: 'invalid', detail: 'date is in the future' };
  return { state: days > DRILL_INTERVAL_DAYS ? 'overdue' : 'ok', days };
}
/** Deterministic quarter assignment: tier 1 every quarter; tier 2 twice a year; tier 3 once a year. */
export function rotation(sorted) {
  const out = new Map();
  for (const tier of [1, 2, 3]) {
    sorted.filter((s) => s.tier === tier).forEach((s, i) => out.set(s.slug, tier === 1 ? [1, 2, 3, 4] : tier === 2 ? (i % 2 === 0 ? [1, 3] : [2, 4]) : [(i % 4) + 1]));
  }
  return out;
}

export function renderIndex(scan, metas) {
  const sorted = scan.providers;
  const rot = rotation(sorted.filter((s) => metas.get(s.slug)?.tier).map((s) => ({ slug: s.slug, tier: metas.get(s.slug).tier })));
  const head = '| Provider | Kind | Tier | Blast radius | Coupling | Switch effort (estimate) | Last drill | Drill quarters |\n|---|---|---:|---:|:-:|:-:|---|---|';
  const lines = sorted.map((p) => {
    const m = metas.get(p.slug) ?? {};
    const q = rot.get(p.slug);
    return `| [${esc(p.name)}](${p.slug}.md) | ${p.kind} | ${m.tier ?? '?'} | ${p.total} | ${p.tier} | ${m.effort ?? '?'} | ${esc(m.lastDrill ?? '?')} | ${q ? q.map((n) => `Q${n}`).join(' ') : '?'} |`;
  });
  return [INDEX_BEGIN, '_Generated by `node scripts/compliance/gen-vendor-exit.mjs` — do not edit between the markers._', '', `${scan.providers.length} providers / provider groups found in \`supabase/functions\` (${scan.functions} edge functions scanned).`, '', head, ...lines, INDEX_END].join('\n');
}

export function planDocs({ root = REPO_ROOT, scan = scanRepo(root), now = new Date() } = {}) {
  const errors = [];
  const warnings = [];
  const writes = [];
  const dir = join(root, DOC_DIR);
  const metas = new Map();
  const present = new Set(existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.md') && !NON_PROVIDER_DOCS.has(n)).map((n) => n.slice(0, -3)) : []);

  for (const h of scan.unclassified) errors.push(`unclassified outbound host "${h[0]}" (first seen in ${FN_DIR}/${h[1]}): add it to PROVIDERS or IGNORED_HOST in scripts/compliance/gen-vendor-exit.mjs; for a real provider also create ${DOC_DIR}/<slug>.md (--init) and review the public sub-processor list [COUNSEL]`);

  for (const p of scan.providers) {
    const path = join(dir, `${p.slug}.md`);
    present.delete(p.slug);
    if (!existsSync(path)) {
      errors.push(`missing ${DOC_DIR}/${p.slug}.md for provider "${p.name}" — run: node scripts/compliance/gen-vendor-exit.mjs --init ${p.slug}`);
      continue;
    }
    const cur = read(path);
    const next = injectBlock(cur, SCAN_BEGIN, SCAN_END, renderScan(p, scan.functions));
    if (next === null) {
      errors.push(`${DOC_DIR}/${p.slug}.md: GENERATED:scan markers missing`);
      continue;
    }
    for (const h of REQUIRED_HEADINGS) if (!cur.includes(h)) errors.push(`${DOC_DIR}/${p.slug}.md: missing heading "${h}"`);
    const m = parseDocMeta(cur);
    metas.set(p.slug, m);
    if (!m.tier) errors.push(`${DOC_DIR}/${p.slug}.md: "Criticality tier" row must start with 1, 2 or 3`);
    if (!m.effort) errors.push(`${DOC_DIR}/${p.slug}.md: "Estimated switch effort" row must start with **S**, **M**, **L** or **XL**`);
    const ds = drillStatus(m.lastDrill, now);
    if (ds.state === 'invalid') errors.push(`${DOC_DIR}/${p.slug}.md: "Last drill date" must be "never performed" or YYYY-MM-DD (got: ${ds.detail})`);
    else if (ds.state === 'never') warnings.push(`${p.slug}: no drill has ever been recorded`);
    else if (ds.state === 'overdue') warnings.push(`${p.slug}: last drill ${ds.days} days ago (limit ${DRILL_INTERVAL_DAYS})`);
    if (next !== cur) writes.push({ path, content: next, why: 'stale generated block' });
  }
  for (const orphan of present) warnings.push(`${DOC_DIR}/${orphan}.md: provider no longer detected in code — keep as history or archive deliberately`);

  const readme = join(dir, 'README.md');
  if (!existsSync(readme)) errors.push(`missing ${DOC_DIR}/README.md`);
  else {
    const cur = read(readme);
    const next = injectBlock(cur, INDEX_BEGIN, INDEX_END, renderIndex(scan, metas));
    if (next === null) errors.push(`${DOC_DIR}/README.md: GENERATED:index markers missing`);
    else if (next !== cur) writes.push({ path: readme, content: next, why: 'stale index' });
  }
  for (const f of ['QUARTERLY_DRILL_CHECKLIST.md', '_TEMPLATE.md']) if (!existsSync(join(dir, f))) errors.push(`missing ${DOC_DIR}/${f}`);
  return { errors, warnings, writes };
}

export function initDoc(slug, root = REPO_ROOT, scan = scanRepo(root)) {
  const p = scan.providers.find((x) => x.slug === slug);
  if (!p) throw new Error(`"${slug}" is not a provider detected in code; known: ${scan.providers.map((x) => x.slug).join(', ')}`);
  const target = join(root, DOC_DIR, `${slug}.md`);
  if (existsSync(target)) throw new Error(`${target} already exists`);
  const tpl = read(join(root, DOC_DIR, '_TEMPLATE.md'));
  const filled = tpl.replaceAll('{{NAME}}', p.name).replaceAll('{{SLUG}}', slug).replaceAll('{{KIND}}', p.kind);
  const withScan = injectBlock(filled, SCAN_BEGIN, SCAN_END, renderScan(p, scan.functions));
  if (withScan === null) throw new Error('_TEMPLATE.md has no GENERATED:scan markers');
  writeFileSync(target, withScan);
  return target;
}

function main(argv = process.argv.slice(2)) {
  const has = (f) => argv.includes(f);
  const rootArg = argv.indexOf('--root');
  const root = rootArg >= 0 ? resolve(argv[rootArg + 1]) : REPO_ROOT;
  const scan = scanRepo(root);
  if (has('--init')) {
    const slug = argv[argv.indexOf('--init') + 1];
    console.log(`created ${initDoc(slug, root, scan)} — now fill every [FILL] marker; never leave vendor facts unverified without a [VERIFY] tag`);
    return 0;
  }
  const plan = planDocs({ root, scan });
  const never = plan.warnings.filter((w) => /no drill has ever been recorded/.test(w)).map((w) => w.split(':')[0]);
  if (never.length) console.warn(`warning: no drill ever recorded for ${never.length} provider(s): ${never.join(', ')}`);
  for (const w of plan.warnings) if (!/no drill has ever been recorded/.test(w)) console.warn(`warning: ${w}`);
  const strict = has('--strict-drills') ? plan.warnings.filter((w) => /drill/.test(w)) : [];
  if (has('--check')) {
    for (const w of plan.writes) plan.errors.push(`${w.path.slice(root.length + 1)}: ${w.why} — run: node scripts/compliance/gen-vendor-exit.mjs`);
    for (const e of [...plan.errors, ...strict.map((s) => `drill: ${s}`)]) console.error(`error: ${e}`);
    if (plan.errors.length || strict.length) {
      console.error(`\n✘ vendor-exit docs invalid (${plan.errors.length + strict.length} problem(s)).`);
      return 1;
    }
    console.log(`✔ vendor-exit docs fresh (${scan.providers.length} providers, ${plan.warnings.length} warning(s)).`);
    return 0;
  }
  for (const e of plan.errors) console.error(`error: ${e}`);
  for (const w of plan.writes) {
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(w.path, w.content);
    console.log(`wrote ${w.path.slice(root.length + 1)}`);
  }
  return plan.errors.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());

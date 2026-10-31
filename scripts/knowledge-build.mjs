#!/usr/bin/env node
// scripts/knowledge-build.mjs
//
// Builds the PUBLIC "Ask Vireek" knowledge layer from the codebase itself.
//
//   npm run knowledge:build    regenerate committed artifacts (offline, no keys)
//   npm run knowledge:check    CI gate: fail if artifacts are stale or sources drifted
//   npm run knowledge:embed    build + embed + upsert into site_kb_chunks
//                              (needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COHERE_API_KEY)
//
// Sources (all real, nothing invented):
//   src/lib/pricing.ts        plans, compare matrix, pricing FAQs   (single source of truth)
//   src/lib/industries.ts     trades, pain points, capabilities, FAQs
//   src/lib/integrations.ts   integrations incl. live / coming_soon status + setup steps
//   src/lib/competitors.ts    comparison pages
//   src/lib/glossary.ts       glossary terms
//   src/lib/helpContent.ts    help-center articles
//   src/lib/useCases.ts       use-case pages
//   src/lib/brandFacts.ts     curated brand / security / FAQ / contact facts
//   src/lib/supportHours.ts   human support hours
//   src/pages/FeaturesPage.tsx  feature catalogue (parsed from source text)
//   knowledge/**/*.md         owner-verified docs for everything else (modules, legal, "does NOT do")
//
// Artifacts (deterministic: no timestamps, stable ordering => clean diffs):
//   knowledge/site-chunks.generated.json
//   knowledge/coverage.generated.md
//   eval/site-assistant.generated.json
//   supabase/functions/_shared/ai-core/coreFacts.generated.ts

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import {
  extractJsxText, buildChunks, estimateTokens, extractFeatureCatalog, extractPublicRoutes, parseMarkdownDoc, sha256, slugify, toPath,
} from './lib/knowledgeChunker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.VIREEK_ROOT ? path.resolve(process.env.VIREEK_ROOT) : path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const MODE = args.has('--check') ? 'check' : args.has('--embed') ? 'embed' : 'build';

const OUT = {
  chunks: 'knowledge/site-chunks.generated.json',
  coverage: 'knowledge/coverage.generated.md',
  evalCases: 'eval/site-assistant.generated.json',
  coreFacts: 'supabase/functions/_shared/ai-core/coreFacts.generated.ts',
};

const STUBBED = ['lucide-react', 'react', 'react-dom', 'framer-motion', 'react-router-dom'];
const MANUAL_STALE_DAYS = 180;
const MIN_EVAL_CASES = 150;

// ---------------------------------------------------------------------
// TS data-module loader (esbuild; UI-only packages stubbed). Same approach
// as scripts/ingest-brand-knowledge.mjs, which this script supersedes.
// ---------------------------------------------------------------------
let esbuildPromise;
async function loadEsbuild() {
  esbuildPromise ??= import('esbuild').catch(() => {
    throw new Error('esbuild is required: run `npm install --save-dev esbuild` (it is not yet in devDependencies).');
  });
  return esbuildPromise;
}

function namedImports(source, pkg) {
  const names = new Set();
  const re = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${pkg}['"]`, 'g');
  for (const m of source.matchAll(re)) {
    for (const raw of m[1].split(',')) {
      const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (n) names.add(n);
    }
  }
  return [...names];
}

async function loadTsModule(rel) {
  const esbuild = await loadEsbuild();
  const abs = path.join(ROOT, rel);
  const source = readFileSync(abs, 'utf8');
  const result = await esbuild.build({
    entryPoints: [abs],
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'node',
    plugins: [
      {
        name: 'stub-ui-only-deps',
        setup(build) {
          for (const pkg of STUBBED) {
            build.onResolve({ filter: new RegExp(`^${pkg}$`) }, () => ({ path: pkg, namespace: `stub-${pkg}` }));
            build.onLoad({ filter: /.*/, namespace: `stub-${pkg}` }, () => ({
              contents:
                'export default new Proxy({}, { get: () => (() => null) });\n' +
                namedImports(source, pkg).map((n) => `export const ${n} = () => null;`).join('\n'),
              loader: 'js',
            }));
          }
        },
      },
    ],
  });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;

// ---------------------------------------------------------------------
// Document builders. Each returns [{source, slug, topic, title, url, plans, status, text}]
// ---------------------------------------------------------------------
const PLAN_IDS = ['free', 'starter', 'professional', 'business', 'enterprise'];

function planLine(p) {
  const price =
    p.monthly != null
      ? p.monthly === 0
        ? '$0/mo'
        : `${money(p.monthly)}/mo or ${money(p.annual)}/yr billed annually`
      : `starting at ${money(p.startingAt)}/mo (custom pricing, sales-assisted)`;
  const overage = p.overage ? `, overage: ${p.overage}` : '';
  return `${p.name}: ${price}. Includes ${p.minutes}${overage}, ${p.seats}, ${p.locations}.`;
}

function pricingDocs({ PRICING_PLANS, PRICING_FAQS, COMPARE_ROWS, COMPARE_VALUES }) {
  const docs = PRICING_PLANS.map((p) => ({
    source: 'pricing', slug: p.id, topic: 'pricing', title: `${p.name} plan`, url: '/pricing', plans: [p.id], status: 'live',
    text: `${planLine(p)} ${p.tagline} Features: ${p.features.join('; ')}. Call to action: ${p.ctaLabel} (${p.ctaHint}).`,
  }));

  const cell = (row, plan) => {
    if (row.key === 'minutes') return plan.minutes;
    if (row.key === 'overage') return plan.overage ?? 'none';
    if (row.key === 'seats') return plan.seats;
    if (row.key === 'locations') return plan.locations;
    const v = COMPARE_VALUES[row.key]?.[plan.id];
    return v === true ? 'yes' : v === false || v === undefined ? 'no' : String(v);
  };
  const matrix = COMPARE_ROWS.map(
    (row) => `${row.label}: ` + PRICING_PLANS.map((p) => `${p.name} ${cell(row, p)}`).join('; '),
  ).join('. ');
  docs.push({
    source: 'pricing', slug: 'compare-matrix', topic: 'pricing', title: 'Plan comparison (all plans side by side)', url: '/pricing', plans: [], status: 'live',
    text: matrix + '.',
  });

  for (const f of PRICING_FAQS) {
    docs.push({
      source: 'pricing', slug: `faq-${slugify(f.q)}`, topic: 'pricing', title: f.q, url: '/pricing', plans: [], status: 'live',
      text: `Q: ${f.q}\nA: ${f.a}`,
    });
  }
  return docs;
}

function industryDocs({ INDUSTRIES }) {
  return INDUSTRIES.flatMap((i) => [
    {
      source: 'industry', slug: i.slug, topic: 'industry', title: `Vireek for ${i.name}`, url: `/industries/${i.slug}`, plans: [], status: 'live',
      text: `${i.tagline} Common call reasons: ${i.terms.join(', ')}. Pain points: ${i.painPoints.join(' ')} How Vireek handles it: ${i.capabilities.join(' ')}`,
    },
    ...(i.faq ?? []).map((f) => ({
      source: 'industry', slug: `${i.slug}-faq-${slugify(f.q)}`, topic: 'industry', title: `${i.name}: ${f.q}`, url: `/industries/${i.slug}`, plans: [], status: 'live',
      text: `Q: ${f.q}\nA: ${f.a}`,
    })),
  ]);
}

function integrationDocs({ INTEGRATIONS }) {
  return INTEGRATIONS.flatMap((i) => {
    const status = i.status === 'coming_soon' ? 'planned' : 'live';
    const label = status === 'planned' ? ' STATUS: coming soon — no live backend integration yet; do not describe it as available.' : ' STATUS: live.';
    return [
      {
        source: 'integration', slug: i.slug, topic: 'integration', title: `${i.name} integration`, url: `/integrations/${i.slug}`, plans: [], status,
        text:
          `${i.name} (${i.category}) — ${i.summary}${label} What it does: ${i.capabilities.join(' ')}` +
          (i.steps?.length ? ` How to connect: ${i.steps.map((s, n) => `${n + 1}. ${s.title} — ${s.detail}`).join(' ')}` : ''),
      },
      ...(i.faq ?? []).map((f) => ({
        source: 'integration', slug: `${i.slug}-faq-${slugify(f.q)}`, topic: 'integration', title: `${i.name}: ${f.q}`, url: `/integrations/${i.slug}`, plans: [], status,
        text: `Q: ${f.q}\nA: ${f.a}`,
      })),
    ];
  });
}

function competitorDocs({ COMPETITORS }) {
  return COMPETITORS.flatMap((c) => {
    const cmp = c.featureRows
      ? `Key differences — ${c.featureRows.map((r) => `${r.feature}: Vireek ${r.vireek}, ${c.name} ${r.competitor}`).join('; ')}.` +
        (c.worksWellTogether ? ` ${c.worksWellTogether}` : '')
      : c.positioning
        ? c.positioning.map((p) => `${p.title}: ${p.body}`).join(' ')
        : '';
    return [
      {
        source: 'compare', slug: c.slug, topic: 'competitor', title: `Vireek vs ${c.name}`, url: `/compare/${c.slug}`, plans: [], status: 'live',
        text: `${c.name} (${c.category}): ${c.summary} Built for: ${c.builtFor} ${cmp}`,
      },
      ...(c.faq ?? []).map((f) => ({
        source: 'compare', slug: `${c.slug}-faq-${slugify(f.q)}`, topic: 'competitor', title: `Vireek vs ${c.name}: ${f.q}`, url: `/compare/${c.slug}`, plans: [], status: 'live',
        text: `Q: ${f.q}\nA: ${f.a}`,
      })),
    ];
  });
}

const glossaryDocs = ({ GLOSSARY_TERMS }) =>
  GLOSSARY_TERMS.map((t) => ({
    source: 'glossary', slug: t.slug, topic: 'glossary', title: t.term, url: `/glossary/${t.slug}`, plans: [], status: 'live',
    text: `${t.term}: ${t.definition}`,
  }));

const helpDocs = ({ HELP_CATEGORIES }) =>
  HELP_CATEGORIES.flatMap((cat) =>
    cat.articles.map((a) => ({
      source: 'help', slug: a.slug ?? `${cat.id}-${slugify(a.q)}`, topic: 'help', title: a.q,
      url: a.slug ? `/help/${a.slug}` : '/help', plans: [], status: 'live',
      text: `Help Center — ${cat.name}. Q: ${a.q}\nA: ${a.a}`,
    })),
  );

const useCaseDocs = ({ USE_CASES }) =>
  USE_CASES.map((u) => ({
    source: 'use_case', slug: u.slug, topic: 'use_case', title: u.headline, url: `/use-cases/${u.slug}`, plans: [], status: 'live',
    text:
      `${u.tagline} Situation: ${u.situation} Without Vireek: ${u.withoutVireek.join(' ')} With Vireek: ${u.withVireek.join(' ')} ` +
      `How it works: ${u.steps.map((s, n) => `${n + 1}. ${s.title} — ${s.detail}`).join(' ')} ` +
      `Outcomes: ${u.outcomes.map((o) => `${o.title}: ${o.body}`).join(' ')}` + (u.planNote ? ` Plan note: ${u.planNote}` : ''),
  }));

const brandDocs = ({ BRAND_FACT_CHUNKS }) =>
  BRAND_FACT_CHUNKS.map((c) => ({
    source: `brand_${c.source}`, slug: c.id, topic: c.source.replace(/_page$/, ''), title: c.title, url: toPath(c.sourceUrl), plans: [], status: 'live',
    text: c.content,
  }));

const supportDocs = ({ SUPPORT_HOURS_LABEL, SUPPORT_TIME_ZONE }) => [
  {
    source: 'support', slug: 'hours', topic: 'support', title: 'Support hours', url: '/contact', plans: [], status: 'live',
    text: `The AI receptionist and this assistant are available 24/7. The human Vireek team is available ${SUPPORT_HOURS_LABEL} (time zone: ${SUPPORT_TIME_ZONE}). Outside those hours visitors can leave a message and the team replies within 24 hours.`,
  },
];

function featureDocs(catalog) {
  return catalog.flatMap((cat) => [
    {
      source: 'feature', slug: slugify(cat.label), topic: 'feature', title: `${cat.label} — features overview`, url: '/features', plans: [], status: 'live',
      text: `${cat.label}: ${cat.tagline} Includes: ${cat.features.map((f) => f.title).join(', ')}.`,
    },
    ...cat.features.map((f) => ({
      source: 'feature', slug: `${slugify(cat.label)}-${slugify(f.title)}`, topic: 'feature', title: f.title, url: f.href ?? '/features', plans: [], status: 'live',
      text: `${f.title} (${cat.label}): ${f.body}`,
    })),
  ]);
}

const LEGAL_PAGES = [
  ['SlaContent', '/sla', 'Service Level Agreement (SLA)'],
  ['PrivacyContent', '/privacy', 'Privacy Policy'],
  ['TermsContent', '/terms', 'Terms of Service'],
  ['DpaContent', '/dpa', 'Data Processing Addendum (DPA)'],
  ['GdprDpaContent', '/gdpr-dpa', 'GDPR Data Processing Addendum'],
  ['CcpaContent', '/ccpa', 'CCPA notice'],
  ['CookiePolicyContent', '/cookies', 'Cookie Policy'],
  ['RefundPolicyContent', '/refund-policy', 'Refund & Cancellation Policy'],
  ['AcceptableUseContent', '/acceptable-use-policy', 'Acceptable Use Policy'],
  ['AiDisclosureContent', '/ai-disclosure', 'AI Disclosure'],
  ['ResponsibleAiContent', '/responsible-ai', 'Responsible AI'],
  ['SmsTermsContent', '/sms-terms', 'SMS Terms'],
];

async function legalDocs() {
  let ts;
  try { ts = (await import('typescript')).default; } catch { throw new Error('typescript is required (it is a repo devDependency): run npm ci.'); }
  return LEGAL_PAGES.map(([file, url, title]) => {
    const rel = `src/components/sections/${file}.tsx`;
    const text = extractJsxText(read(rel), ts, rel);
    if (text.length < 800) throw new Error(`${rel}: only ${text.length} chars of prose extracted — extractor no longer understands this file.`);
    return { source: 'legal', slug: slugify(title), topic: 'legal', title: `${title} (authoritative text: ${url})`, url, plans: [], status: 'live', text };
  });
}

function manualDocs() {
  const dir = path.join(ROOT, 'knowledge');
  const files = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) { if (!name.startsWith('_')) walk(p); }
      else if (name.endsWith('.md') && !name.endsWith('.generated.md') && !name.startsWith('_') && name.toLowerCase() !== 'readme.md') files.push(p);
    }
  };
  walk(dir);
  const warnings = [];
  const docs = files.sort().map((f) => {
    const rel = path.relative(ROOT, f).replaceAll('\\', '/');
    const { meta, body } = parseMarkdownDoc(readFileSync(f, 'utf8'), rel);
    const ageDays = (Date.now() - Date.parse(meta.verified)) / 86_400_000;
    if (ageDays > MANUAL_STALE_DAYS) warnings.push(`${rel}: last verified ${meta.verified} (> ${MANUAL_STALE_DAYS} days) — re-verify.`);
    return {
      source: 'manual', slug: slugify(path.basename(f, '.md')), topic: meta.topic, title: meta.title, url: meta.url, plans: meta.plans, status: meta.status,
      text: body,
    };
  });
  return { docs, warnings };
}

// ---------------------------------------------------------------------
// Core facts: the lean, always-on block. Generated from the same data.
// ---------------------------------------------------------------------
function buildCoreFacts({ pricing, industries, integrations, brand, support }) {
  const byId = Object.fromEntries(brand.BRAND_FACT_CHUNKS.map((c) => [c.id, c]));
  const need = ['about-what-is-vireek', 'about-company-stage-honesty', 'security-no-certifications-claim', 'faq-emergency-calls-caveat', 'contact-channels'];
  for (const id of need) if (!byId[id]) throw new Error(`brandFacts.ts is missing required chunk id "${id}" used for core facts.`);

  const plans = pricing.PRICING_PLANS.map(planLine).join('\n');
  const trades = industries.INDUSTRIES.map((i) => i.name).join(', ');
  const live = integrations.INTEGRATIONS.filter((i) => i.status !== 'coming_soon').map((i) => i.name).join(', ') || 'none listed';
  const soon = integrations.INTEGRATIONS.filter((i) => i.status === 'coming_soon').map((i) => i.name).join(', ');

  const PRICING_FACTS =
    `Vireek has ${pricing.PRICING_PLANS.length} plans (annual billing is shown per year on /pricing): ` +
    pricing.PRICING_PLANS.map(planLine).join(' ') +
    ' ' + pricing.PRICING_FAQS.map((f) => `${f.q} ${f.a}`).join(' ');

  const INDUSTRIES_FACTS =
    `Vireek has dedicated pages and call handling for ${industries.INDUSTRIES.length} home-service trades: ` +
    industries.INDUSTRIES.map((i) => `${i.name} (${i.tagline})`).join(' ') +
    ' What counts as an emergency is configured per business, not hardcoded.';

  const CORE_FACTS = [
    `ABOUT: ${clean(byId['about-what-is-vireek'].content)}`,
    `SIZE/STAGE: ${clean(byId['about-company-stage-honesty'].content)}`,
    `PLANS (source: pricing page):\n${plans}`,
    `TRADES (${industries.INDUSTRIES.length}): ${trades}.`,
    `INTEGRATIONS live: ${live}.${soon ? ` Coming soon (not yet available): ${soon}.` : ''}`,
    `CERTIFICATIONS: ${clean(byId['security-no-certifications-claim'].content)}`,
    `EMERGENCIES: ${clean(byId['faq-emergency-calls-caveat'].content)}`,
    `SUPPORT HOURS: human team ${support.SUPPORT_HOURS_LABEL} (${support.SUPPORT_TIME_ZONE}); AI 24/7.`,
    `CONTACT: ${clean(byId['contact-channels'].content)}`,
    'KEY PAGES: /pricing, /platform, /features, /industries, /integrations, /compare, /security, /responsible-ai, /sla, /status, /help, /faq, /demo, /signup, /contact.',
  ].join('\n');

  return { CORE_FACTS, PRICING_FACTS, INDUSTRIES_FACTS };
}

function renderCoreFactsTs(f) {
  return (
    '// AUTO-GENERATED by scripts/knowledge-build.mjs — DO NOT EDIT.\n' +
    '// Source of truth: src/lib/pricing.ts, industries.ts, integrations.ts, brandFacts.ts, supportHours.ts\n' +
    '// Regenerate with: npm run knowledge:build\n\n' +
    `export const CORE_FACTS = ${JSON.stringify(f.CORE_FACTS)};\n\n` +
    `export const PRICING_FACTS = ${JSON.stringify(f.PRICING_FACTS)};\n\n` +
    `export const INDUSTRIES_FACTS = ${JSON.stringify(f.INDUSTRIES_FACTS)};\n`
  );
}

// ---------------------------------------------------------------------
// Eval cases generated from the data (so they can't drift either).
// Schema (also consumed by scripts/knowledge-eval.mjs):
//   { id, category, q, kind: 'answer'|'unknown'|'refuse'|'redirect',
//     mustInclude: string[][]   // every group must match; within a group ANY alternative
//     mustNotInclude: string[]  // none may match.  Items prefixed "re:" are regexes (case-insens.)
//     lang?: string }
// ---------------------------------------------------------------------
function buildGeneratedEval({ pricing, industries, integrations, competitors, glossary, features, help, useCases }) {
  const cases = [];
  const add = (c) => cases.push({ mustInclude: [], mustNotInclude: [], kind: 'answer', ...c });
  const num = (s) => (s.match(/[\d,]+/) ?? [''])[0];

  for (const p of pricing.PRICING_PLANS) {
    const priceAlt = p.monthly == null ? [num(String(p.startingAt)), money(p.startingAt)] : p.monthly === 0 ? ['$0', 'free', 'no cost'] : [String(p.monthly)];
    add({ id: `plan-${p.id}-price`, category: 'pricing', q: `How much does the ${p.name} plan cost per month?`, mustInclude: [priceAlt] });
    add({ id: `plan-${p.id}-minutes`, category: 'plan-limits', q: `How many minutes are included in ${p.name}?`, mustInclude: [/\d/.test(p.minutes) ? [num(p.minutes)] : ['unlimited']] });
    add({ id: `plan-${p.id}-seats`, category: 'plan-limits', q: `How many team seats come with the ${p.name} plan?`, mustInclude: [/\d/.test(p.seats) ? [num(p.seats)] : ['unlimited']] });
    add({ id: `plan-${p.id}-locations`, category: 'plan-limits', q: `How many locations can I run on ${p.name}?`, mustInclude: [/\d/.test(p.locations) ? [num(p.locations)] : ['unlimited']] });
    const rate = pricing.parseOverageRate(p.overage);
    if (rate != null) add({ id: `plan-${p.id}-overage`, category: 'pricing', q: `What is the overage rate on the ${p.name} plan?`, mustInclude: [[String(rate), rate.toFixed(2)]] });
    if (p.annual) add({ id: `plan-${p.id}-annual`, category: 'pricing', q: `What does ${p.name} cost if I pay annually?`, mustInclude: [[String(p.annual), p.annual.toLocaleString('en-US')]] });
  }

  for (const i of industries.INDUSTRIES) {
    add({ id: `industry-${i.slug}`, category: 'industries', q: `Does Vireek work for ${i.audience}?`, mustInclude: [[i.name.toLowerCase(), i.audience.toLowerCase()]], mustNotInclude: ["re:\\b(doesn'?t|does not|no) (support|work)"] });
  }

  for (const i of integrations.INTEGRATIONS) {
    const soon = i.status === 'coming_soon';
    add({
      id: `integration-${i.slug}`, category: 'integrations', q: `Does Vireek integrate with ${i.name}?`,
      mustInclude: [[i.name.toLowerCase()], ...(soon ? [['coming soon', 'not yet', 'planned', 'roadmap', "isn't available", 'not available']] : [])],
      mustNotInclude: soon ? ["re:\\b(is|are) (now )?(live|available) (today|now)"] : [],
    });
  }

  for (const c of competitors.COMPETITORS) {
    add({ id: `compare-${c.slug}`, category: 'competitors', q: `How does Vireek compare to ${c.name}?`, mustInclude: [[c.name.toLowerCase()]], mustNotInclude: ['terrible', 'garbage', 'worst', 'scam', 'useless'] });
  }

  glossary.GLOSSARY_TERMS.filter((_, n) => n % 7 === 0).forEach((t) =>
    add({ id: `glossary-${t.slug}`, category: 'glossary', q: `What does "${t.term}" mean?`, mustInclude: [[t.term.toLowerCase()]] }),
  );

  const distinct = (title) => title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 5);
  features.forEach((cat) =>
    cat.features.forEach((f) =>
      add({
        id: `feature-${slugify(cat.label)}-${slugify(f.title)}`, category: 'features', q: `Does Vireek have ${f.title}? What does it do?`,
        mustInclude: [distinct(f.title).length ? distinct(f.title) : [f.title.toLowerCase()]],
      }),
    ),
  );

  help.HELP_CATEGORIES.flatMap((c) => c.articles).filter((_, n) => n % 4 === 0).forEach((a, n) =>
    add({ id: `help-${n}-${slugify(a.q).slice(0, 30)}`, category: 'help', q: a.q, kind: 'answer' }),
  );

  useCases.USE_CASES.forEach((u) =>
    add({ id: `usecase-${u.slug}`, category: 'use-cases', q: `How does Vireek help with ${u.name.toLowerCase()}?`, kind: 'answer' }),
  );

  return cases;
}

// ---------------------------------------------------------------------
// Coverage report
// ---------------------------------------------------------------------
function buildCoverage({ chunks, routes, dashboardRoutes, manualCount }) {
  const covered = new Set(chunks.map((c) => toPath(c.url)).filter(Boolean));
  const hit = routes.filter((r) => covered.has(r));
  const miss = routes.filter((r) => !covered.has(r));
  const byTopic = {};
  for (const c of chunks) byTopic[c.topic] = (byTopic[c.topic] ?? 0) + 1;
  const pct = routes.length ? ((hit.length / routes.length) * 100).toFixed(1) : '0';
  return [
    '# Ask Vireek — knowledge coverage (generated)',
    '',
    '> Generated by `npm run knowledge:build`. "Covered" means at least one knowledge chunk cites that URL.',
    '',
    `- Chunks: **${chunks.length}** (owner-verified markdown docs: ${manualCount})`,
    `- Public static routes in src/App.tsx: **${routes.length}** — covered: **${hit.length}** (${pct}%), not covered: **${miss.length}**`,
    `- Dashboard routes (/dashboard/*): **${dashboardRoutes}** — covered by owner-verified docs in \`knowledge/\`: **${manualCount}** (names only exist in code; descriptions need owner-verified docs)`,
    '',
    '## Chunks by topic',
    ...Object.entries(byTopic).sort().map(([t, n]) => `- ${t}: ${n}`),
    '',
    '## Public routes NOT covered (add a verified doc in knowledge/ for each that visitors may ask about)',
    ...miss.map((r) => `- ${r}`),
    '',
    '## Public routes covered',
    ...hit.map((r) => `- ${r}`),
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------
// Drift checks (fail CI)
// ---------------------------------------------------------------------
function driftChecks({ pricing, industries, chunks, routes }) {
  const errors = [];

  const knowledgeTs = read('supabase/functions/_shared/ai-core/knowledge.ts');
  for (const sym of ['PRICING_FACTS', 'INDUSTRIES_FACTS']) {
    if (!knowledgeTs.includes(sym)) {
      errors.push(`knowledge.ts still hand-codes facts: it must use ${sym} from coreFacts.generated.ts (see INSTALL.md, edits E3-E5).`);
    }
  }

  const keys = new Set(chunks.map((c) => c.chunkKey));
  for (const id of PLAN_IDS) if (!pricing.PRICING_PLANS.some((p) => p.id === id)) errors.push(`pricing.ts: expected plan id "${id}" is missing — update PLAN_IDS in knowledge-build.mjs if plans changed on purpose.`);
  for (const p of pricing.PRICING_PLANS) if (!keys.has(`pricing:${p.id}:1`)) errors.push(`plan "${p.id}" produced no chunk.`);
  for (const i of industries.INDUSTRIES) if (!keys.has(`industry:${i.slug}:1`)) errors.push(`industry "${i.slug}" produced no chunk.`);

  const logic = read('supabase/functions/_shared/ai-core/siteAssistantLogic.ts');
  const linked = new Set([...logic.matchAll(/url:\s*"(\/[^"]*)"/g)].map((m) => m[1]));
  const routeSet = new Set(routes);
  for (const l of linked) {
    const base = l === '/' ? '/' : l.replace(/\/$/, '');
    if (!routeSet.has(base)) errors.push(`siteAssistantLogic.ts links to "${l}" which is not a public static route in App.tsx.`);
  }

  const seen = new Set();
  for (const c of chunks) {
    if (seen.has(c.chunkKey)) errors.push(`duplicate chunk key ${c.chunkKey}`);
    seen.add(c.chunkKey);
    if (c.tokenEstimate > 560) errors.push(`chunk ${c.chunkKey} is ${c.tokenEstimate} tokens (> 500 target)`);
  }
  return errors;
}

// ---------------------------------------------------------------------
// Embedding + upsert (only changed chunks are re-embedded)
// ---------------------------------------------------------------------
async function embedAndUpsert(chunks) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, COHERE_API_KEY } = process.env;
  const MODEL = process.env.COHERE_EMBED_MODEL || 'embed-multilingual-v3.0';
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  if (!COHERE_API_KEY) throw new Error('COHERE_API_KEY must be set.');
  if (/english/i.test(MODEL)) console.warn(`WARNING: ${MODEL} is English-only; visitors writing in other languages will retrieve poorly. Use embed-multilingual-v3.0 (also 1024-dim).`);

  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: existing, error } = await db.from('site_kb_chunks').select('chunk_key, content_hash');
  if (error) throw new Error(`Cannot read site_kb_chunks (is migration 20280401000000 applied?): ${error.message}`);
  const have = new Map(existing.map((r) => [r.chunk_key, r.content_hash]));

  const rows = chunks.map((c) => ({ ...c, hash: sha256(`${c.title}\n${c.content}`) }));
  const changed = rows.filter((r) => have.get(r.chunkKey) !== r.hash);
  const stale = [...have.keys()].filter((k) => !rows.some((r) => r.chunkKey === k));
  console.log(`Chunks: ${rows.length} total, ${changed.length} new/changed, ${stale.length} stale, ${rows.length - changed.length} unchanged (not re-embedded).`);

  for (let i = 0; i < changed.length; i += 90) {
    const batch = changed.slice(i, i + 90);
    const res = await fetch('https://api.cohere.com/v1/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${COHERE_API_KEY}` },
      body: JSON.stringify({ model: MODEL, texts: batch.map((r) => `${r.title}\n${r.content}`), input_type: 'search_document' }),
    });
    if (!res.ok) throw new Error(`Cohere embed failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const { embeddings } = await res.json();
    if (!embeddings || embeddings.length !== batch.length) throw new Error('Embedding count mismatch.');
    if (embeddings[0].length !== 1024) throw new Error(`Expected 1024-dim vectors, got ${embeddings[0].length} (site_kb_chunks.embedding is vector(1024)).`);

    const payload = batch.map((r, n) => ({
      chunk_key: r.chunkKey, scope: 'public', topic: r.topic, title: r.title, content: r.content, url: r.url, plans: r.plans,
      status: r.status, lang: r.lang, content_hash: r.hash, token_estimate: r.tokenEstimate, embedding: JSON.stringify(embeddings[n]),
      updated_at: new Date().toISOString(),
    }));
    const up = await db.from('site_kb_chunks').upsert(payload, { onConflict: 'chunk_key' });
    if (up.error) throw new Error(`Upsert failed: ${up.error.message}`);
    console.log(`  upserted ${Math.min(i + 90, changed.length)}/${changed.length}`);
  }
  if (stale.length) {
    const del = await db.from('site_kb_chunks').delete().in('chunk_key', stale);
    if (del.error) throw new Error(`Stale delete failed: ${del.error.message}`);
    console.log(`  deleted ${stale.length} stale chunks`);
  }
}

// ---------------------------------------------------------------------
async function main() {
  const [pricing, industries, integrations, competitors, glossary, help, useCases, brand, support] = await Promise.all(
    ['pricing', 'industries', 'integrations', 'competitors', 'glossary', 'helpContent', 'useCases', 'brandFacts', 'supportHours'].map((n) => loadTsModule(`src/lib/${n}.ts`)),
  );
  const features = extractFeatureCatalog(read('src/pages/FeaturesPage.tsx'));
  const manual = manualDocs();

  const docs = [
    ...pricingDocs(pricing), ...industryDocs(industries), ...integrationDocs(integrations), ...competitorDocs(competitors),
    ...glossaryDocs(glossary), ...helpDocs(help), ...useCaseDocs(useCases), ...brandDocs(brand), ...supportDocs(support),
    ...featureDocs(features), ...(await legalDocs()), ...manual.docs,
  ];
  const chunks = docs.flatMap((d) => buildChunks(d)).sort((a, b) => a.chunkKey.localeCompare(b.chunkKey));

  const appTsx = read('src/App.tsx');
  const routes = extractPublicRoutes(appTsx);
  const dashboardRoutes = new Set([...appTsx.matchAll(/path="(\/dashboard[^"]*)"/g)].map((m) => m[1])).size;

  const core = buildCoreFacts({ pricing, industries, integrations, brand, support });
  const generatedEval = buildGeneratedEval({ pricing, industries, integrations, competitors, glossary, features, help, useCases });

  let manualEvalCount = 0;
  const manualEvalPath = path.join(ROOT, 'eval/site-assistant.manual.json');
  if (existsSync(manualEvalPath)) manualEvalCount = JSON.parse(readFileSync(manualEvalPath, 'utf8')).cases.length;
  const redTeamPath = path.join(ROOT, 'eval/site-assistant.redteam.json');
  if (existsSync(redTeamPath)) manualEvalCount += JSON.parse(readFileSync(redTeamPath, 'utf8')).cases.length;
  const totalEval = generatedEval.length + manualEvalCount;

  const artifacts = {
    [OUT.chunks]: JSON.stringify({ schema: 1, chunks }, null, 2) + '\n',
    [OUT.coverage]: buildCoverage({ chunks, routes, dashboardRoutes, manualCount: manual.docs.length }),
    [OUT.evalCases]: JSON.stringify({ schema: 1, cases: generatedEval }, null, 2) + '\n',
    [OUT.coreFacts]: renderCoreFactsTs(core),
  };

  const problems = driftChecks({ pricing, industries, chunks, routes });
  if (totalEval < MIN_EVAL_CASES) problems.push(`only ${totalEval} eval cases (generated ${generatedEval.length} + manual ${manualEvalCount}); need >= ${MIN_EVAL_CASES}.`);

  console.log(`Chunks: ${chunks.length} | public routes: ${routes.length} | eval cases: ${totalEval} (generated ${generatedEval.length} + manual ${manualEvalCount})`);
  console.log(`Core facts: ~${estimateTokens(core.CORE_FACTS)} tokens`);
  manual.warnings.forEach((w) => console.warn(`WARN ${w}`));

  if (MODE === 'check') {
    for (const [rel, text] of Object.entries(artifacts)) {
      const p = path.join(ROOT, rel);
      const current = existsSync(p) ? readFileSync(p, 'utf8') : null;
      if (current !== text) problems.push(`${rel} is out of date — run \`npm run knowledge:build\` and commit the result.`);
    }
    if (problems.length) {
      console.error('\nknowledge:check FAILED\n' + problems.map((p) => ` - ${p}`).join('\n'));
      process.exit(1);
    }
    console.log('knowledge:check OK — artifacts match sources, no drift.');
    return;
  }

  if (problems.length) {
    console.error('\nProblems (fix before committing):\n' + problems.map((p) => ` - ${p}`).join('\n'));
    process.exitCode = 1;
  }
  for (const [rel, text] of Object.entries(artifacts)) {
    const p = path.join(ROOT, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
    console.log(`wrote ${rel}`);
  }
  if (MODE === 'embed') {
    if (problems.length) throw new Error('Refusing to embed while problems exist.');
    await embedAndUpsert(chunks);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

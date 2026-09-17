#!/usr/bin/env node
// scripts/ingest-brand-knowledge.mjs
//
// Populates the `brand_knowledge` table (see
// supabase/migrations/20260915010000_brand_knowledge_rag.sql) from the
// site's OWN real data files — src/lib/pricing.ts, industries.ts,
// glossary.ts, competitors.ts, integrations.ts, and brandFacts.ts — so
// the AI (site-assistant, demo-chat) is grounded in the exact same
// content that's actually published on vireek.com, not hand-copied
// facts that drift out of sync over time.
//
// This is a full REPLACE per source on every run (delete rows for that
// `source`, then re-insert freshly chunked + re-embedded content) —
// simplest way to stay correct: re-run this any time one of the source
// files changes, and stale chunks can never linger.
//
// Usage:
//   SUPABASE_URL=https://xxxx.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=... \
//   COHERE_API_KEY=... \
//   node scripts/ingest-brand-knowledge.mjs
//
// Add --dry-run to build and print chunk counts (and a sample chunk)
// without calling Cohere or touching the database — useful for checking
// the chunk output after editing a source file, with no API keys needed:
//   node scripts/ingest-brand-knowledge.mjs --dry-run
//
// Requires esbuild as a dev dependency (same as generate-rss.mjs):
//   npm install --save-dev esbuild
// Requires @supabase/supabase-js (already a project dependency).

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COHERE_API_KEY = process.env.COHERE_API_KEY;
const COHERE_EMBED_MODEL = process.env.COHERE_EMBED_MODEL || 'embed-english-v3.0';

// Cohere's embed endpoint accepts a batch of texts per call — keep well
// under its limit so one big content update never needs pagination logic.
const EMBED_BATCH_SIZE = 90;

// ---------------------------------------------------------------------
// Same esbuild-based TS loader as generate-rss.mjs, extended to handle
// NAMED imports (generate-rss.mjs's data files import no icons at all,
// but pricing/industries/glossary/competitors/integrations.ts all do
// `import { Flame, Droplets, ... } from 'lucide-react'`). A stub that
// only provides a default export breaks on those, so this scans each
// entry file's own import statements for the stubbed packages and
// generates a matching `export const Name = () => null;` per name
// actually imported, instead of a single blind default-export proxy.
// ---------------------------------------------------------------------
import { readFileSync } from 'node:fs';

const STUBBED_PACKAGES = ['lucide-react', 'react', 'react-dom', 'framer-motion', 'react-router-dom'];

function extractNamedImports(source, pkg) {
  const names = new Set();
  const re = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*['"]${pkg}['"]`, 'g');
  let match;
  while ((match = re.exec(source))) {
    for (const raw of match[1].split(',')) {
      const cleaned = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (cleaned) names.add(cleaned);
    }
  }
  return [...names];
}

async function loadTsModule(relativePath) {
  const absPath = path.join(ROOT, relativePath);
  const source = readFileSync(absPath, 'utf8');

  const result = await esbuild.build({
    entryPoints: [absPath],
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'node',
    plugins: [
      {
        name: 'stub-ui-only-deps',
        setup(build) {
          for (const pkg of STUBBED_PACKAGES) {
            const namespace = `stub-ns-${pkg}`;
            build.onResolve({ filter: new RegExp(`^${pkg}$`) }, () => ({ path: pkg, namespace }));
            build.onLoad({ filter: /.*/, namespace }, () => {
              const names = extractNamedImports(source, pkg);
              const namedExports = names.map((n) => `export const ${n} = () => null;`).join('\n');
              return {
                contents: `export default new Proxy({}, { get: () => (() => null) });\n${namedExports}`,
                loader: 'js',
              };
            });
          }
        },
      },
    ],
  });
  const code = result.outputFiles[0].text;
  const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  return import(dataUrl);
}

// ---------------------------------------------------------------------
// Chunk builders — one function per source file, each returning
// { source, sourceUrl, title, content }[]. Keep each chunk short and
// self-contained: it's the exact unit that gets embedded and later
// handed to the model, not a pointer into a bigger document.
// ---------------------------------------------------------------------

function chunksFromPricing({ PRICING_PLANS, PRICING_FAQS }) {
  const chunks = PRICING_PLANS.map((plan) => ({
    source: 'pricing_page',
    sourceUrl: 'https://vireek.com/pricing',
    title: `${plan.name} plan`,
    content:
      `${plan.name} — ${plan.tagline} ` +
      (plan.monthly != null
        ? `$${plan.monthly}/mo (or $${plan.annual}/yr billed annually). `
        : `Starting at $${plan.startingAt}/mo, custom pricing. `) +
      `${plan.minutes} included${plan.overage ? `, overage ${plan.overage}` : ''}, ${plan.seats}, ${plan.locations}. ` +
      `Features: ${plan.features.join('; ')}.`,
  }));

  const faqChunks = PRICING_FAQS.map((f) => ({
    source: 'pricing_page',
    sourceUrl: 'https://vireek.com/pricing',
    title: f.q,
    content: `Q: ${f.q}\nA: ${f.a}`,
  }));

  return [...chunks, ...faqChunks];
}

function chunksFromIndustries({ INDUSTRIES }) {
  const overview = INDUSTRIES.map((ind) => ({
    source: 'industries_page',
    sourceUrl: `https://vireek.com/industries/${ind.slug}`,
    title: `Vireek for ${ind.name}`,
    content:
      `${ind.tagline} Common call reasons: ${ind.terms.join(', ')}. ` +
      `Pain points: ${ind.painPoints.join(' ')} ` +
      `How Vireek handles it: ${ind.capabilities.join(' ')}`,
  }));

  const faqChunks = INDUSTRIES.flatMap((ind) =>
    (ind.faq ?? []).map((f) => ({
      source: 'industries_page',
      sourceUrl: `https://vireek.com/industries/${ind.slug}`,
      title: `${ind.name}: ${f.q}`,
      content: `Q: ${f.q}\nA: ${f.a}`,
    })),
  );

  return [...overview, ...faqChunks];
}

function chunksFromGlossary({ GLOSSARY_TERMS }) {
  return GLOSSARY_TERMS.map((t) => ({
    source: 'glossary',
    sourceUrl: `https://vireek.com/glossary/${t.slug}`,
    title: t.term,
    content: `${t.term}: ${t.definition}`,
  }));
}

function chunksFromCompetitors({ COMPETITORS }) {
  // Two shapes exist in this data: traditional ops-platform competitors
  // (ServiceTitan, Housecall Pro, ...) carry `featureRows` + `worksWellTogether`;
  // other AI-voice-agent competitors (isVoiceAICompetitor: true) carry a
  // `positioning` array of {title, body} instead. Handle both rather than
  // assuming every entry has the same shape.
  const overview = COMPETITORS.map((c) => {
    let comparisonText;
    if (c.featureRows) {
      comparisonText =
        `Key differences — ${c.featureRows
          .map((r) => `${r.feature}: Vireek ${r.vireek}, ${c.name} ${r.competitor}`)
          .join('; ')}.` + (c.worksWellTogether ? ` ${c.worksWellTogether}` : '');
    } else if (c.positioning) {
      comparisonText = c.positioning.map((p) => `${p.title}: ${p.body}`).join(' ');
    } else {
      comparisonText = '';
    }
    return {
      source: 'compare_page',
      sourceUrl: `https://vireek.com/compare/${c.slug}`,
      title: `Vireek vs ${c.name}`,
      content: `${c.name} (${c.category}): ${c.summary} Built for: ${c.builtFor} ${comparisonText}`,
    };
  });

  const faqChunks = COMPETITORS.flatMap((c) =>
    (c.faq ?? []).map((f) => ({
      source: 'compare_page',
      sourceUrl: `https://vireek.com/compare/${c.slug}`,
      title: `Vireek vs ${c.name}: ${f.q}`,
      content: `Q: ${f.q}\nA: ${f.a}`,
    })),
  );

  return [...overview, ...faqChunks];
}

function chunksFromIntegrations({ INTEGRATIONS }) {
  const overview = INTEGRATIONS.map((i) => ({
    source: 'integrations_page',
    sourceUrl: `https://vireek.com/integrations/${i.slug}`,
    title: `${i.name} integration`,
    content: `${i.name} (${i.category}) — ${i.summary} What it does: ${i.capabilities.join(' ')}`,
  }));

  const faqChunks = INTEGRATIONS.flatMap((i) =>
    (i.faq ?? []).map((f) => ({
      source: 'integrations_page',
      sourceUrl: `https://vireek.com/integrations/${i.slug}`,
      title: `${i.name}: ${f.q}`,
      content: `Q: ${f.q}\nA: ${f.a}`,
    })),
  );

  return [...overview, ...faqChunks];
}

function chunksFromBrandFacts({ BRAND_FACT_CHUNKS }) {
  return BRAND_FACT_CHUNKS.map((c) => ({
    source: c.source,
    sourceUrl: c.sourceUrl,
    title: c.title,
    content: c.content,
  }));
}

// ---------------------------------------------------------------------
// Cohere embedding — plain HTTP call (this is a Node script, not the
// Deno edge runtime, so it can't import the cohere.ts adapter directly).
// Same model/input_type convention as providers/cohere.ts.
// ---------------------------------------------------------------------
async function embedBatch(texts) {
  const res = await fetch('https://api.cohere.com/v1/embed', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model: COHERE_EMBED_MODEL,
      texts,
      input_type: 'search_document',
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Cohere embed failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.embeddings ?? [];
}

async function embedAll(chunks) {
  const embeddings = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedBatch(batch.map((c) => c.content));
    embeddings.push(...vectors);
    console.log(`  embedded ${Math.min(i + EMBED_BATCH_SIZE, chunks.length)}/${chunks.length}`);
  }
  return embeddings;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log('Loading source data files...');
  const [pricing, industries, glossary, competitors, integrations, brandFacts] = await Promise.all([
    loadTsModule('src/lib/pricing.ts'),
    loadTsModule('src/lib/industries.ts'),
    loadTsModule('src/lib/glossary.ts'),
    loadTsModule('src/lib/competitors.ts'),
    loadTsModule('src/lib/integrations.ts'),
    loadTsModule('src/lib/brandFacts.ts'),
  ]);

  const allChunks = [
    ...chunksFromPricing(pricing),
    ...chunksFromIndustries(industries),
    ...chunksFromGlossary(glossary),
    ...chunksFromCompetitors(competitors),
    ...chunksFromIntegrations(integrations),
    ...chunksFromBrandFacts(brandFacts),
  ];

  const bySource = {};
  for (const c of allChunks) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  console.log(`Built ${allChunks.length} chunks:`);
  for (const [source, count] of Object.entries(bySource)) console.log(`  ${source}: ${count}`);

  if (dryRun) {
    console.log('\n--dry-run: skipping embedding + database writes. Sample chunk:');
    console.log(JSON.stringify(allChunks[0], null, 2));
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  }
  if (!COHERE_API_KEY) {
    throw new Error(
      'COHERE_API_KEY must be set — this is the same key providers/cohere.ts reads in the edge functions.',
    );
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  console.log(`\nEmbedding via Cohere (${COHERE_EMBED_MODEL})...`);
  const vectors = await embedAll(allChunks);

  if (vectors.length !== allChunks.length) {
    throw new Error(`Embedding count mismatch: ${vectors.length} vectors for ${allChunks.length} chunks.`);
  }

  const sources = [...new Set(allChunks.map((c) => c.source))];
  console.log(`Replacing existing rows for sources: ${sources.join(', ')}`);
  const { error: deleteError } = await supabase.from('brand_knowledge').delete().in('source', sources);
  if (deleteError) throw new Error(`Failed clearing old rows: ${deleteError.message}`);

  const rows = allChunks.map((c, i) => ({
    source: c.source,
    source_url: c.sourceUrl,
    title: c.title,
    content: c.content,
    embedding: vectors[i],
    token_count: Math.ceil(c.content.length / 4), // rough estimate, not exact tokenization
  }));

  console.log(`Inserting ${rows.length} rows into brand_knowledge...`);
  // Insert in batches too — a single request with hundreds of ~1024-dim
  // vectors can get large.
  const INSERT_BATCH_SIZE = 200;
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const { error } = await supabase.from('brand_knowledge').insert(batch);
    if (error) throw new Error(`Insert failed: ${error.message}`);
  }

  console.log(`Done. Ingested ${rows.length} chunks across ${sources.length} sources.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

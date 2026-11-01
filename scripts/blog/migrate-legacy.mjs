#!/usr/bin/env node
// One-shot migration: src/lib/blog.ts (BLOG_POSTS) -> content/blog/<slug>.md
//
//   node scripts/blog/migrate-legacy.mjs            # writes files, skips ones that already exist
//   node scripts/blog/migrate-legacy.mjs --force    # overwrites
//
// It converts the existing blocks 1:1 (p / h2 / list / callout) without changing the wording.
// Metadata that the old format did not have (description, tags, related posts, CTA type) comes from
// the table below. After the migration succeeds, delete src/lib/blog.ts.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import * as esbuild from 'esbuild';
import { ROOT } from '../seo/routes.mjs';

const META = {
  'cost-of-a-missed-call': {
    category: 'missed-calls',
    tags: ['missed-calls', 'speed-to-lead', 'revenue-recovery'],
    related: ['ai-receptionist-cost', 'plumbing-missed-call-cost', 'perfect-call-script-home-services'],
    cta: 'calculator',
    title: 'Why Every Missed Call Is a Lost Job',
    description:
      'Callers with an urgent problem rarely phone back. See the math behind a missed call, why voicemail does not close the gap, and what actually does.',
  },
  'ai-receptionist-cost': {
    category: 'ai-receptionist',
    tags: ['ai-receptionist', 'pricing', 'roi'],
    related: ['ai-receptionist-vs-answering-service', 'cost-of-a-missed-call', 'ai-vendor-security-checklist'],
    cta: 'pricing',
    title: 'How Much Does an AI Receptionist Cost?',
    description:
      'Compare what a full-time receptionist, a traditional answering service and an AI receptionist really cost, and the one number that decides the comparison.',
  },
  'hvac-emergency-call-triage': {
    category: 'trade-playbooks',
    tags: ['hvac', 'emergency-calls', 'call-triage'],
    related: ['perfect-call-script-home-services', 'cost-of-a-missed-call', 'plumbing-missed-call-cost'],
    cta: 'demo',
    title: 'HVAC Emergency Calls: Triage Without a Dispatcher',
    description:
      'Not every HVAC emergency call is truly urgent. Learn how consistent call triage separates real emergencies from routine requests without a live dispatcher.',
  },
  'ai-receptionist-vs-answering-service': {
    category: 'ai-receptionist',
    tags: ['ai-receptionist', 'answering-service', 'comparison'],
    related: ['ai-receptionist-cost', 'ai-vendor-security-checklist', 'cost-of-a-missed-call'],
    cta: 'pricing',
    title: 'AI Receptionist vs Answering Service: What Differs',
    description:
      'AI receptionist or traditional answering service? Compare consistency across calls, cost as volume grows, and what happens after the call ends.',
  },
  'plumbing-missed-call-cost': {
    category: 'trade-playbooks',
    tags: ['plumbing', 'missed-calls', 'emergency-calls'],
    related: ['cost-of-a-missed-call', 'hvac-emergency-call-triage', 'perfect-call-script-home-services'],
    cta: 'calculator',
    title: 'What a Missed Call Costs Your Plumbing Business',
    description:
      'Put a number on what missed calls cost your plumbing business, and see why emergency calls carry far more weight than routine ones in your call mix.',
  },
  'perfect-call-script-home-services': {
    category: 'templates',
    tags: ['call-scripts', 'booking', 'customer-service'],
    related: ['hvac-emergency-call-triage', 'plumbing-missed-call-cost', 'cost-of-a-missed-call'],
    cta: 'demo',
    title: 'The Anatomy of a Perfect Home Service Call Script',
    description:
      'What makes a good home service call script: a real greeting, the core qualifying questions, and knowing when to stop qualifying and book the job.',
  },
  'ai-vendor-security-checklist': {
    category: 'compliance',
    tags: ['security', 'ai-receptionist', 'vendor-evaluation'],
    related: ['ai-receptionist-vs-answering-service', 'ai-receptionist-cost', 'cost-of-a-missed-call'],
    cta: 'demo',
    title: 'Data Security: What to Ask Any AI Phone Vendor',
    description:
      'Security questions to ask any AI phone vendor: where your data lives, who on your team can see what, and why specifics matter more than reassurance.',
  },
};

async function loadLegacy() {
  const file = path.join(ROOT, 'src/lib/blog.ts');
  if (!existsSync(file)) throw new Error('src/lib/blog.ts not found — nothing to migrate.');
  const out = await esbuild.build({
    entryPoints: [file], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    plugins: [{
      name: 'stub-ui',
      setup(b) {
        b.onResolve({ filter: /^lucide-react$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = new Proxy({}, { get: () => () => null });', loader: 'js' }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\*/g, '\\*').replace(/`/g, '\\`').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
const yamlStr = (s) => JSON.stringify(s); // JSON strings are valid YAML

function toMarkdown(post, titles) {
  const out = [];
  for (const b of post.content) {
    if (b.type === 'h2') out.push(`## ${esc(b.text)}`);
    else if (b.type === 'p') out.push(esc(b.text));
    else if (b.type === 'list') out.push(b.items.map((i) => `- ${esc(i)}`).join('\n'));
    else if (b.type === 'callout') out.push(`:::tip\n${esc(b.text)}\n:::`);
    else throw new Error(`${post.slug}: unknown block type ${b.type}`);
  }
  const meta = META[post.slug];
  out.push('## Related reading');
  out.push(meta.related.map((s) => `- [${titles[s]}](/blog/${s})`).join('\n'));
  return out.join('\n\n') + '\n';
}

const { BLOG_POSTS } = await loadLegacy();
const titles = Object.fromEntries(BLOG_POSTS.map((p) => [p.slug, META[p.slug]?.title ?? p.title]));
const force = process.argv.includes('--force');
const dir = path.join(ROOT, 'content', 'blog');
mkdirSync(dir, { recursive: true });

for (const post of BLOG_POSTS) {
  const meta = META[post.slug];
  if (!meta) { console.error(`! no metadata for "${post.slug}" — add it to META and re-run`); process.exitCode = 1; continue; }
  const target = path.join(dir, `${post.slug}.md`);
  if (existsSync(target) && !force) { console.log(`- skip (exists): ${post.slug}`); continue; }
  const fm = [
    '---',
    `title: ${yamlStr(meta.title ?? post.title)}`,
    `slug: ${post.slug}`,
    `description: ${yamlStr(meta.description)}`,
    `category: ${meta.category}`,
    `tags: [${meta.tags.join(', ')}]`,
    'author: vireek-team',
    `publishedAt: ${post.publishedDate}`,
    `updatedAt: ${post.publishedDate}`,
    `featured: ${post.featured ? 'true' : 'false'}`,
    `relatedSlugs: [${meta.related.join(', ')}]`,
    'cta:',
    `  type: ${meta.cta}`,
    '---',
    '',
  ].join('\n');
  writeFileSync(target, fm + toMarkdown(post, titles));
  console.log(`+ content/blog/${post.slug}.md`);
}
console.log('\nNext: npm run blog:validate  →  then delete src/lib/blog.ts');

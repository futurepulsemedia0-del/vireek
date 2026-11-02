// checks/devdocs.mjs — developer documentation quality (README completeness, link integrity, repo hygiene, env docs).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { ROOT, walk, tryRead, finding, pct, round1, rel } from '../lib/util.mjs';

/** Pure: relative markdown links (not http/mailto/#) -> targets (without hash/query). */
export function relativeLinks(md) {
  const nofence = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  return [...nofence.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]).filter((l) => !/^(https?:|mailto:|tel:|#|\/\/)/i.test(l)).map((l) => decodeURI(l.split('#')[0].split('?')[0])).filter(Boolean);
}

export async function run() {
  const findings = [];
  const readme = tryRead('README.md') ?? '';
  const sections = [['Getting started / install', /^##\s+(getting started|install|setup|quick ?start)/im], ['Scripts / commands', /^##\s+(scripts|commands)/im], ['Environment variables', /^##\s+env/im], ['Architecture / structure', /^##\s+(project structure|architecture)/im], ['Testing', /^#{2,3}\s+.*test/im], ['Deploying', /^##\s+deploy/im], ['Contributing link', /CONTRIBUTING/]];
  const present = sections.filter(([, re]) => re.test(readme));
  const components = [{ name: 'README completeness', weight: 25, score: round1(pct(present.length, sections.length)), detail: sections.map(([n, re]) => `${re.test(readme) ? '✓' : '✗'} ${n}`).join(' · ') }];
  sections.filter(([, re]) => !re.test(readme)).forEach(([n]) => findings.push(finding({ id: 'devdocs/readme', category: 'devdocs', severity: 'low', title: `README lacks: ${n}`, refs: [{ file: 'README.md' }], count: 1 })));

  // Markdown link integrity (repo docs only)
  const mdFiles = [...walk('.', { exts: ['.md'] })].filter((f) => !f.startsWith('node_modules') && !f.startsWith('knowledge/') && !f.startsWith('reports/'));
  let total = 0; const broken = [];
  for (const f of mdFiles) {
    for (const l of relativeLinks(readFileSync(join(ROOT, f), 'utf8'))) {
      total++;
      const target = l.startsWith('/') ? join(ROOT, l) : resolve(ROOT, dirname(f), l);
      if (!existsSync(target)) broken.push({ file: f, text: l });
    }
  }
  components.push({ name: 'Relative markdown links resolve', weight: 30, score: round1(pct(total - broken.length, total)), detail: `${broken.length} broken of ${total} links in ${mdFiles.length} docs` });
  if (broken.length) findings.push(finding({ id: 'devdocs/broken-links', category: 'devdocs', severity: 'medium', title: `${broken.length} broken relative link(s) in markdown docs`, refs: broken.slice(0, 100), count: broken.length }));

  // Root hygiene: stray patches / phase notes
  const rootFiles = readdirSync(ROOT).filter((n) => statSync(join(ROOT, n)).isFile());
  const stray = rootFiles.filter((n) => /\.patch$/.test(n) || /^INSTALL-(PHASE|PULSE)/i.test(n) || /replacement_sections/.test(n));
  const strayDirs = readdirSync(ROOT).filter((n) => /^vireek-docs-phase/.test(n));
  const kb = stray.reduce((a, n) => a + statSync(join(ROOT, n)).size, 0) / 1024;
  components.push({ name: 'Repo root free of stray patches / phase install notes', weight: 20, score: stray.length + strayDirs.length ? Math.max(0, 100 - 15 * (stray.length + strayDirs.length)) : 100, detail: `${stray.length + strayDirs.length} stray items (${Math.round(kb)} KB)` });
  if (stray.length + strayDirs.length) findings.push(finding({ id: 'devdocs/root-clutter', category: 'devdocs', severity: 'low', title: `${stray.length + strayDirs.length} stray patch/phase files at repo root (${Math.round(kb)} KB)`, detail: 'Apply-and-delete patches, fold install notes into docs/, keep the root for entry points.', refs: [...stray, ...strayDirs].map((file) => ({ file })), count: stray.length + strayDirs.length }));

  // Env docs: every .env.example key documented in ENVIRONMENT.md
  const keys = [...(tryRead('.env.example') ?? '').matchAll(/^#?\s*([A-Z][A-Z0-9_]{3,})=/gm)].map((m) => m[1]);
  const envDoc = tryRead('ENVIRONMENT.md') ?? '';
  const undoc = [...new Set(keys)].filter((k) => !envDoc.includes(k));
  components.push({ name: '.env.example keys documented in ENVIRONMENT.md', weight: 15, score: round1(pct(new Set(keys).size - undoc.length, new Set(keys).size)), detail: `${undoc.length} undocumented of ${new Set(keys).size}` });
  if (undoc.length) findings.push(finding({ id: 'devdocs/env', category: 'devdocs', severity: 'low', title: `${undoc.length} env var(s) in .env.example are not in ENVIRONMENT.md`, refs: undoc.map((text) => ({ file: 'ENVIRONMENT.md', text })), count: undoc.length }));

  const gov = existsSync(join(ROOT, 'BRAND_GOVERNANCE.md'));
  components.push({ name: 'BRAND_GOVERNANCE.md + docs index', weight: 10, score: (gov ? 50 : 0) + (existsSync(join(ROOT, 'docs/voice-and-tone.md')) ? 50 : 0), detail: gov ? 'governance doc present' : 'BRAND_GOVERNANCE.md missing' });
  return { category: 'devdocs', components, metrics: { markdownFiles: mdFiles.length, links: total, broken: broken.length, stray: stray.length + strayDirs.length }, findings };
}
export { rel };

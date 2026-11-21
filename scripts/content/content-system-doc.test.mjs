// node --test scripts/content/content-system-doc.test.mjs   (npm run test:scripts:content-system)
// Keeps docs/marketing/content-system.md honest: the calendar and the trade table must agree with the real repo.
// Dependency-free on purpose (no yaml/zod) so it runs before `npm ci` finishes in any environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const DOC = read('docs/marketing/content-system.md');

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = ['category', 'tag', 'page', 'feed', 'rss', 'atom', 'search', 'newsletter'];

function section(name) {
  const m = new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`).exec(DOC);
  assert.ok(m, `marker "${name}" missing in content-system.md`);
  return m[1];
}
function rows(block) {
  return block.split('\n').filter((l) => l.startsWith('|')).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^-+$/.test(c)))
    .slice(1); // drop the header row
}

const frontmatter = (raw) => /^---\n([\s\S]*?)\n---/.exec(raw.replace(/\r\n?/g, '\n'))?.[1] ?? '';
const posts = readdirSync(path.join(ROOT, 'content/blog'))
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .map((f) => {
    const fm = frontmatter(read(`content/blog/${f}`));
    return {
      slug: f.replace(/\.md$/, ''),
      category: /^category:\s*(\S+)/m.exec(fm)?.[1],
      tags: (/^tags:\s*\[([^\]]*)\]/m.exec(fm)?.[1] ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    };
  });
const categories = JSON.parse(read('content/blog/_categories.json')).map((c) => c.slug);
const industries = [...read('src/lib/industries.ts').matchAll(/^\s{4}slug: '([a-z0-9-]+)'/gm)].map((m) => m[1]);

const calendar = rows(section('calendar')).map(([date, slug, category, trade, priority, format, legal, notes]) =>
  ({ date, slug, category, trade, priority, format, legal, notes }));
const icp = rows(section('icp')).map(([trade, audience, urgent, pain, playbook, next]) =>
  ({ trade, audience, urgent, pain, playbook, next }));

test('sanity: the repo data the doc depends on is readable', () => {
  assert.ok(posts.length >= 10, 'content/blog posts not found');
  assert.ok(industries.length >= 13, `industries not parsed (${industries.length})`);
  assert.ok(categories.includes('trade-playbooks'));
});

test('slug rules mirror scripts/blog/pipeline.mjs', () => {
  const src = read('scripts/blog/pipeline.mjs');
  assert.ok(src.includes('export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;'), 'SLUG_RE changed in pipeline.mjs; update this test');
  assert.ok(src.includes(`export const RESERVED_SLUGS = [${RESERVED.map((r) => `'${r}'`).join(', ')}];`), 'RESERVED_SLUGS changed; update this test');
});

test('calendar: has rows and every slug is valid, unique and not already published', () => {
  assert.ok(calendar.length >= 10);
  const seen = new Set();
  const existing = new Set(posts.map((p) => p.slug));
  for (const r of calendar) {
    assert.match(r.slug, SLUG_RE, r.slug);
    assert.ok(r.slug.length <= 80, `${r.slug} longer than 80 characters`);
    assert.ok(!RESERVED.includes(r.slug), `${r.slug} is reserved`);
    assert.ok(!seen.has(r.slug), `duplicate calendar slug ${r.slug}`);
    assert.ok(!existing.has(r.slug), `${r.slug} already exists in content/blog`);
    seen.add(r.slug);
  }
});

test('calendar: dates are real, on Tuesday or Thursday and strictly ascending', () => {
  let prev = '';
  for (const r of calendar) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/, r.date);
    const d = new Date(`${r.date}T00:00:00Z`);
    assert.equal(d.toISOString().slice(0, 10), r.date, `${r.date} is not a real date`);
    assert.ok([2, 4].includes(d.getUTCDay()), `${r.slug}: ${r.date} is not a Tuesday or Thursday`);
    assert.ok(r.date > prev, `${r.slug}: ${r.date} is not after ${prev}`);
    prev = r.date;
  }
});

test('calendar: category, priority and trade columns use real values', () => {
  for (const r of calendar) {
    assert.ok(categories.includes(r.category), `${r.slug}: unknown category ${r.category}`);
    assert.match(r.priority, /^[ABC]$/, `${r.slug}: priority`);
    assert.ok(r.trade === 'all' || industries.includes(r.trade), `${r.slug}: unknown trade ${r.trade}`);
    assert.ok(['yes', 'no'].includes(r.legal), `${r.slug}: legal review must be yes/no`);
    if (r.category === 'trade-playbooks') assert.notEqual(r.trade, 'all', `${r.slug}: a trade playbook needs a trade`);
  }
});

test('calendar: compliance topics require legal review and say [COUNSEL]', () => {
  for (const r of calendar.filter((x) => x.category === 'compliance')) {
    assert.equal(r.legal, 'yes', `${r.slug}: compliance post without legal review`);
    assert.ok(r.notes.includes('[COUNSEL]'), `${r.slug}: notes must carry [COUNSEL]`);
  }
});

test('calendar: every trade without a playbook is scheduled at least once', () => {
  const covered = new Set(posts.filter((p) => p.category === 'trade-playbooks').flatMap((p) => p.tags));
  const uncovered = industries.filter((s) => !covered.has(s));
  const scheduled = new Set(calendar.filter((r) => r.category === 'trade-playbooks').map((r) => r.trade));
  for (const s of uncovered) assert.ok(scheduled.has(s), `trade "${s}" has no playbook and none is scheduled`);
});

test('ICP table: one row per trade on /industries, in the same set', () => {
  assert.deepEqual(icp.map((r) => r.trade).sort(), [...industries].sort());
});

test('ICP table: covered/uncovered matches the posts that actually exist', () => {
  const covered = new Set(posts.filter((p) => p.category === 'trade-playbooks').flatMap((p) => p.tags));
  for (const r of icp) {
    assert.ok(['covered', 'uncovered'].includes(r.playbook), `${r.trade}: playbook must be covered|uncovered`);
    assert.equal(r.playbook === 'covered', covered.has(r.trade), `${r.trade}: table says ${r.playbook} but repo says ${covered.has(r.trade) ? 'covered' : 'uncovered'}`);
    assert.ok(r.pain.length > 20 && r.next.length > 10, `${r.trade}: empty pain/next cell`);
  }
});

test('doc states the real coverage numbers', () => {
  const covered = new Set(posts.filter((p) => p.category === 'trade-playbooks').flatMap((p) => p.tags));
  const n = industries.filter((s) => covered.has(s)).length;
  assert.ok(DOC.includes(`**${n} of ${industries.length}** trades`), `doc must say "${n} of ${industries.length}" trades have a playbook`);
});

test('every gate command the doc names exists in package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const cmd of ['claims:check', 'claims:gate', 'content:check']) assert.ok(pkg.scripts[cmd], `package.json has no script ${cmd}`);
  assert.ok(DOC.includes('npm run claims:gate') && DOC.includes('npm run content:check'));
});

test('no person is named as an owner (roles only) and open items stay marked', () => {
  assert.ok(!/Owner:\s*[A-Z][a-z]+ [A-Z][a-z]+/.test(DOC), 'owners must be roles, not invented names');
  assert.ok(DOC.includes('[VERIFY]') && DOC.includes('[COUNSEL]'));
});

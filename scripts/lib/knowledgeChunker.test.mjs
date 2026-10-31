import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens, splitIntoChunks, buildChunks, extractFeatureCatalog, parseMarkdownDoc, extractPublicRoutes, toPath, sha256, extractJsxText,
} from './knowledgeChunker.mjs';

test('short text stays one atomic chunk', () => {
  const t = 'Free plan: $0/mo, 50 min, 1 seat.';
  assert.deepEqual(splitIntoChunks(t), [t]);
});

test('long text splits to <=500 tokens, overlaps, loses nothing', () => {
  const sentence = 'Vireek answers every call and books the job without hold time. ';
  const text = Array.from({ length: 120 }, (_, i) => `${sentence}Fact ${i}.`).join(' ');
  const chunks = splitIntoChunks(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(estimateTokens(c) <= 520, `chunk too big: ${estimateTokens(c)}`);
  for (let i = 0; i < 120; i++) assert.ok(chunks.some((c) => c.includes(`Fact ${i}.`)), `lost Fact ${i}`);
});

test('a single run-on blob without punctuation is hard-wrapped', () => {
  const blob = 'word '.repeat(1200);
  const chunks = splitIntoChunks(blob);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(estimateTokens(c) <= 520);
});

test('buildChunks numbers parts and keeps stable keys', () => {
  const text = 'Sentence one is here. '.repeat(400);
  const a = buildChunks({ source: 'help', slug: 'x', topic: 'help', title: 'T', url: '/help', text });
  const b = buildChunks({ source: 'help', slug: 'x', topic: 'help', title: 'T', url: '/help', text });
  assert.ok(a.length > 1);
  assert.equal(a[0].title, `T (1/${a.length})`);
  assert.deepEqual(a.map((c) => c.chunkKey), b.map((c) => c.chunkKey));
  assert.equal(a[0].chunkKey, 'help:x:1');
});

test('parseMarkdownDoc validates front-matter', () => {
  const ok = parseMarkdownDoc('---\ntitle: A\nurl: /a\ntopic: module\nstatus: beta\nverified: 2028-03-01\nplans: pro, biz\n---\nBody', 'a.md');
  assert.equal(ok.body, 'Body');
  assert.deepEqual(ok.meta.plans, ['pro', 'biz']);
  assert.throws(() => parseMarkdownDoc('no front matter', 'x.md'), /front-matter/);
  assert.throws(() => parseMarkdownDoc('---\ntitle: A\nurl: /a\ntopic: m\nstatus: maybe\nverified: 2028-03-01\n---\nb', 'x.md'), /status/);
  assert.throws(() => parseMarkdownDoc('---\ntitle: A\nurl: a\ntopic: m\nstatus: live\nverified: 2028-03-01\n---\nb', 'x.md'), /url/);
  assert.throws(() => parseMarkdownDoc('---\ntitle: A\nurl: /a\ntopic: m\nstatus: live\n---\nb', 'x.md'), /verified/);
});

test('extractFeatureCatalog throws loudly on missing marker', () => {
  assert.throws(() => extractFeatureCatalog('const nothing = 1;'), /not found/);
});

test('extractFeatureCatalog handles brackets/quotes inside strings', () => {
  const src = `const CATEGORIES: Category[] = [ { icon: Foo, label: 'A [x]', tagline: "t, ]", features: [ { icon: Bar, title: 'T', body: 'it\\u2019s ok', href: '/x' } ] } ];`;
  const d = extractFeatureCatalog(src);
  assert.equal(d[0].label, 'A [x]');
  assert.equal(d[0].features[0].body, 'it\u2019s ok');
  assert.equal(d[0].features[0].href, '/x');
});

test('toPath / sha256', () => {
  assert.equal(toPath('https://vireek.com/pricing/'), '/pricing');
  assert.equal(toPath('/faq'), '/faq');
  assert.equal(sha256('a').length, 64);
});

test('extractPublicRoutes drops params, private areas, wildcards', () => {
  const r = extractPublicRoutes('<Route path="/pricing"/><Route path="/dashboard/x"/><Route path="/blog/:slug"/><Route path="*"/><Route path="/staff/a"/><Route path="/faq"/>');
  assert.deepEqual(r, ['/faq', '/pricing']);
});

// ---- Real-repo checks (skipped when run outside the repo) ----
import fs from 'node:fs';
const FEATURES = process.env.VIREEK_ROOT ? `${process.env.VIREEK_ROOT}/src/pages/FeaturesPage.tsx` : null;
test('REAL FeaturesPage.tsx parses', { skip: !FEATURES || !fs.existsSync(FEATURES) }, () => {
  const d = extractFeatureCatalog(fs.readFileSync(FEATURES, 'utf8'));
  const n = d.reduce((s, c) => s + c.features.length, 0);
  console.log(`   -> ${d.length} categories, ${n} features`);
  assert.ok(d.length >= 3 && n >= 10);
});
const APP = process.env.VIREEK_ROOT ? `${process.env.VIREEK_ROOT}/src/App.tsx` : null;
test('REAL App.tsx routes', { skip: !APP || !fs.existsSync(APP) }, () => {
  const r = extractPublicRoutes(fs.readFileSync(APP, 'utf8'));
  console.log(`   -> ${r.length} public static routes`);
  assert.ok(r.includes('/pricing') && r.includes('/platform') && !r.some((p) => p.startsWith('/dashboard')));
});


// ---- JSX prose extraction (needs the `typescript` package; present in the repo's devDependencies) ----
let ts = null;
try { ts = (await import(process.env.TYPESCRIPT_PATH || 'typescript')).default; } catch { /* skipped below */ }

test('extractJsxText: keeps prose + numbers, joins around inline elements, drops code/attrs/comments', { skip: !ts }, () => {
  const src = `
    const EMAIL = 'ali@vireek.com';
    const X = useState<number>(0);
    export function A() {
      // a comment with <b>tags</b>
      return (<div className="rounded p-4">{/* hidden */}
        <SectionHeading id="c" number="3" title="Cancellation" />
        <p>You may cancel at any time. It takes effect at the{' '}
          <strong className="x">end of your billing period</strong> &mdash; you keep access.</p>
        <p>We target <strong>99.9%</strong> uptime. Email {EMAIL}.</p>
        <p>{'It\\u2019s a literal'}</p>
        <ul>{items.map((i) => <li key={i}>Item &amp; more</li>)}</ul>
      </div>);
    }`;
  const t = extractJsxText(src, ts);
  assert.match(t, /Cancellation/);
  assert.match(t, /takes effect at the end of your billing period — you keep access\./);
  assert.match(t, /99\.9% uptime/);
  assert.match(t, /Email ali@vireek\.com\./);
  assert.match(t, /Item & more/);
  assert.doesNotMatch(t, /className|hidden|comment|useState|rounded/);
});

const LEGAL = ['SlaContent', 'PrivacyContent', 'TermsContent', 'DpaContent', 'GdprDpaContent', 'CcpaContent', 'CookiePolicyContent', 'RefundPolicyContent', 'AcceptableUseContent', 'AiDisclosureContent', 'ResponsibleAiContent', 'SmsTermsContent'];
for (const name of LEGAL) {
  const f = process.env.VIREEK_ROOT ? `${process.env.VIREEK_ROOT}/src/components/sections/${name}.tsx` : null;
  test(`REAL ${name}.tsx yields substantial prose`, { skip: !ts || !f || !fs.existsSync(f) }, () => {
    const t = extractJsxText(fs.readFileSync(f, 'utf8'), ts, f);
    console.log(`   -> ${name}: ${t.length} chars`);
    assert.ok(t.length > 1200, `${name} only ${t.length} chars`);
    assert.doesNotMatch(t, /className|=>|useState|export function/);
  });
}

// node --test scripts/claims-gate/claims-gate.test.mjs   (npm run test:scripts:claims-gate)
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText, isProse, normalize } from './detect.mjs';
import { evaluateDetections, evidenceProblems, validateRegister } from './register.mjs';
import { discoverPublicPageFiles } from './sources.mjs';

const NOW = new Date('2026-11-19T00:00:00Z');
const entry = (over = {}, ev = {}) => ({
  id: 'stat.booked-jobs-lift',
  claim: '40% more booked jobs',
  evidence: { type: 'report', url: 'https://example.com/study.pdf', owner: 'Compliance owner', issuedAt: '2026-09-01', expiresAt: '2027-03-01', ...ev },
  ...over,
});
const reg = (claims = [], exemptions) => ({ version: 1, claims, ...(exemptions ? { exemptions } : {}) });
const detect = (text, ext = '.md', file = 'content/blog/x.md') => scanText(text, ext).map((h) => ({ ...h, file }));
const run = (text, register, ext = '.md') => evaluateDetections(detect(text, ext), register, NOW);
const tokens = (text, ext = '.md') => scanText(text, ext).map((h) => h.token);

// ------------------------------------------------------------------------------------------------ detection
test('numeric claims are detected', () => {
  assert.deepEqual(tokens('Customers book 40% more jobs.'), ['40%']);
  assert.deepEqual(tokens('Calls get answered 3x faster than voicemail.').sort(), ['3x', 'faster than']);
  assert.deepEqual(tokens('We cut missed calls by 2.5 times over last year here.'), []); // not a claim shape we cover
  assert.deepEqual(tokens('Trusted by 500 contractors across the country.'), ['trusted by 500 contractors']);
  assert.deepEqual(tokens('Save up to 10 hours a week on the phone.'), ['save up to 10 hours']);
  assert.deepEqual(tokens('Sarah answers in under 2 seconds on every call.'), ['answers in under 2 seconds']);
  assert.deepEqual(tokens('Rated 4.8/5 by owners who use it daily.'), ['4.8/5']);
  assert.deepEqual(tokens('Nearly 7 in 10 calls end in a booked job.'), ['7 in 10 calls']);
  assert.deepEqual(tokens('Call volume can 10x overnight after a storm hits.'), ['10x']);
});

test('comparative claims are detected', () => {
  assert.deepEqual(tokens('Setup is faster than hiring a receptionist.'), ['faster than']);
  assert.deepEqual(tokens('It costs less than a part-time hire each month.'), ['costs less than']);
  assert.deepEqual(tokens('We are the #1 AI receptionist for trades.'), ['#1']);
  assert.deepEqual(tokens('The most accurate AI receptionist available today.'), ['the most accurate ai']);
  assert.deepEqual(tokens('Vireek outperforms every answering service we tested.'), ['outperforms']);
});

test('ordinary prose, numbering and units are not claims', () => {
  assert.deepEqual(tokens('Step 1 of the guide covers the basics of setup.'), []);
  assert.deepEqual(tokens('### 1. Where does the data actually live?'), []);
  assert.deepEqual(tokens('Call us between 9am and 5pm on weekdays.'), []);
  assert.deepEqual(tokens('Consistency beats heroic effort in the long run.'), []);
  assert.deepEqual(tokens('The most reliable test is your own call volume.'), []);
  assert.deepEqual(tokens('Plans start at $99 per month billed monthly.'), []);
});

test('CSS and Tailwind strings are never claims', () => {
  const tsx = [
    "const bg = 'radial-gradient(circle at 50% 0%, rgb(var(--accent) / 0.08), transparent 50%)';",
    '<th className="border-b border-border w-2/5 px-6 py-5 text-left">x</th>',
    "const margin = '-96px 0px -72% 0px';",
    "style={{ width: '80%' }}",
  ].join('\n');
  assert.deepEqual(tokens(tsx, '.tsx'), []);
  assert.equal(isProse('w-1/2 md:w-[50%] text-sm'), false);
  assert.equal(isProse('99.9% uptime'), true);
});

test('TSX: string literals, JSX text and wrapped JSX lines are scanned; comments are not', () => {
  const tsx = [
    "const t = { body: 'Warns at 80%, throttles at 100%.' };",
    '<p>Vireek answers 100% of calls, 24/7.</p>',
    '<p>',
    '  Sarah books jobs 3x faster than',
    '  a voicemail box.',
    '</p>',
    '// Old copy: 95% of calls answered by Sarah',
    '/* 99% accurate, says the old banner */',
  ].join('\n');
  const found = scanText(tsx, '.tsx').map((h) => `${h.line}:${h.token}`);
  assert.deepEqual(found.sort(), ['1:80%', '1:100%', '2:100%', '4:3x', '4:faster than'].sort());
});

test('markdown: code fences and table separators are skipped; list markers and links are stripped', () => {
  const md = ['```', 'save 50% now at 3x speed', '```', '| a | b |', '|---|---|', '- Save up to 5 hours with [this guide](/x)'].join('\n');
  assert.deepEqual(tokens(md), ['save up to 5 hours']);
});

test('JSON: values are scanned, keys are not, and a key/value pair does not confuse string pairing', () => {
  assert.deepEqual(tokens('{ "99% uptime": "Uptime commitment of 99.9%. Credit 10% of fee" }', '.json'), ['99.9%', '10%']);
});

test('HTML: tags, scripts and styles are ignored', () => {
  const html = '<style>.a{width:50%}</style><script>var x="3x faster than all";</script>\n<p>Book 3x more jobs this month.</p>';
  assert.deepEqual(tokens(html, '.html'), ['3x']);
});

test('one finding per line and token even when two patterns overlap', () => {
  const hits = scanText('Get 5 stars from owners who rate us 5 stars.\n', '.md');
  assert.equal(hits.filter((h) => h.token === '5 stars').length, 1);
});

test('normalize unifies markup, percent spacing, multiplier sign and apostrophes', () => {
  assert.equal(normalize('**40 %** more\u00a0jobs'), '40% more jobs');
  assert.equal(normalize('3 × faster'), '3x faster');
  assert.equal(normalize("World\u2019s best &amp; <b>fastest</b>"), "world's best & fastest");
});

// ------------------------------------------------------------------------------------------------ evidence
test('evidence: a complete block has no problems', () => {
  assert.deepEqual(evidenceProblems(entry().evidence, NOW), []);
});

test('evidence: every required field is enforced', () => {
  assert.match(evidenceProblems(undefined, NOW)[0], /missing/);
  assert.match(evidenceProblems({ ...entry().evidence, url: 'http://example.com/x' }, NOW).join(), /https/);
  assert.match(evidenceProblems({ ...entry().evidence, url: '/pricing' }, NOW).join(), /https/);
  assert.match(evidenceProblems({ ...entry().evidence, url: 'https://localhost/x' }, NOW).join(), /https/);
  assert.match(evidenceProblems({ ...entry().evidence, owner: '' }, NOW).join(), /owner/);
  assert.match(evidenceProblems({ ...entry().evidence, issuedAt: undefined }, NOW).join(), /issuedAt/);
  assert.match(evidenceProblems({ ...entry().evidence, expiresAt: undefined }, NOW).join(), /expiresAt/);
  assert.match(evidenceProblems({ ...entry().evidence, expiresAt: '2026-02-30' }, NOW).join(), /expiresAt/);
  assert.match(evidenceProblems({ ...entry().evidence, issuedAt: '2027-01-01', expiresAt: '2027-06-01' }, NOW).join(), /future/);
  assert.match(evidenceProblems({ ...entry().evidence, issuedAt: '2026-09-01', expiresAt: '2026-08-01' }, NOW).join(), /after/);
  assert.match(evidenceProblems({ ...entry().evidence, issuedAt: '2024-01-01', expiresAt: '2027-03-01' }, NOW).join(), /max 540/);
});

// ------------------------------------------------------------------------------------------------ gate
test('a claim with no register entry is a violation', () => {
  const r = run('Customers see 40% more booked jobs.', reg());
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].code, 'unmapped');
});

test('a claim covered by a current entry passes and marks the entry used', () => {
  const r = run('Customers see 40% more booked jobs with Vireek.', reg([entry()]));
  assert.deepEqual(r.violations, []);
  assert.equal(r.covered.length, 1);
  assert.deepEqual(r.unused, []);
});

test('an expired entry fails, naming the expiry date', () => {
  const r = run('Customers see 40% more booked jobs.', reg([entry({}, { expiresAt: '2026-11-19' })]));
  assert.equal(r.violations[0].code, 'expired');
  assert.match(r.violations[0].message, /2026-11-19/);
});

test('the day before expiry still passes; the expiry date itself fails (same boundary as the brand audit)', () => {
  const ok = evaluateDetections(detect('Customers see 40% more booked jobs.'), reg([entry({}, { expiresAt: '2026-11-20' })]), NOW);
  assert.deepEqual(ok.violations, []);
  const bad = evaluateDetections(detect('Customers see 40% more booked jobs.'), reg([entry({}, { expiresAt: '2026-11-19' })]), NOW);
  assert.equal(bad.violations.length, 1);
});

test('an entry with incomplete evidence fails as incomplete-evidence, not as covered', () => {
  const r = run('Customers see 40% more booked jobs.', reg([entry({}, { url: '' })]));
  assert.equal(r.violations[0].code, 'incomplete-evidence');
});

test('the entry is bound to the exact number: 45% in the copy is not covered by a 40% entry', () => {
  const r = run('Customers see 45% more booked jobs.', reg([entry()]));
  assert.equal(r.violations[0].code, 'unmapped');
});

test('reworded copy is not covered unless the register lists that wording in match[]', () => {
  const copy = 'Owners booked 40% more jobs after switching.';
  assert.equal(run(copy, reg([entry()])).violations.length, 1);
  assert.deepEqual(run(copy, reg([entry({ match: ['booked 40% more jobs'] })])).violations, []);
});

test('a claim wrapped over several lines still maps', () => {
  const tsx = '<p>\n  Customers see 40% more\n  booked jobs with Vireek.\n</p>';
  assert.deepEqual(run(tsx, reg([entry()]), '.tsx').violations, []);
});

test('an entry limited to a file does not cover the same wording elsewhere', () => {
  const r = evaluateDetections(detect('Customers see 40% more booked jobs.', '.md', 'content/blog/other.md'), reg([entry({ file: 'content/blog/x.md' })]), NOW);
  assert.equal(r.violations.length, 1);
});

test('when two entries match, a current one wins over an expired one', () => {
  const r = run('Customers see 40% more booked jobs.', reg([entry({ id: 'a.old' }, { expiresAt: '2026-10-01' }), entry({ id: 'a.new' })]));
  assert.deepEqual(r.violations, []);
  assert.equal(r.covered[0].entry, 'a.new');
});

test('exemptions need match, owner and a real reason, and are reported (not silent)', () => {
  const ok = reg([], [{ id: 'ex.threshold', match: ['warns at 80%'], reason: 'Product configuration thresholds, not a performance claim', owner: 'Product owner' }]);
  const r = run("Warns at 80%, throttles at 100%.", ok);
  assert.equal(r.exempt.length, 1);
  assert.equal(r.violations.filter((v) => v.token === '80%').length, 0);
  assert.equal(r.violations.filter((v) => v.token === '100%').length, 1); // not covered by that phrase
  const bad = validateRegister(reg([], [{ id: 'ex.x', match: ['warns at 80%'], reason: 'short', owner: '' }]), NOW);
  assert.equal(bad.errors.length, 2);
});

test('register validation: shape, duplicate ids, bad ids, missing wording', () => {
  assert.match(validateRegister({ claims: 'no' }, NOW).errors[0], /array/);
  assert.match(validateRegister(reg([entry(), entry()]), NOW).errors.join(), /duplicate/);
  assert.match(validateRegister(reg([entry({ id: 'bad id!' })]), NOW).errors.join(), /id must match/);
  assert.match(validateRegister(reg([entry({ claim: '' })]), NOW).errors.join(), /claim/);
  assert.match(validateRegister(reg([entry({ match: ['x'] })]), NOW).errors.join(), /match/);
  assert.deepEqual(validateRegister(reg([entry()]), NOW).errors, []);
});

test('register validation warns (never fails) when evidence expires within 30 days and for unused entries', () => {
  const v = validateRegister(reg([entry({}, { expiresAt: '2026-12-10' })]), NOW);
  assert.deepEqual(v.errors, []);
  assert.match(v.warnings[0], /expires in 21 day/);
  assert.deepEqual(run('Nothing to claim in this sentence at all.', reg([entry()])).unused, ['stat.booked-jobs-lift']);
});

test('the shipped, empty register is valid and keeps the existing brand-audit shape', () => {
  assert.deepEqual(validateRegister({ version: 1, claims: [], exemptions: [] }, NOW).errors, []);
  assert.deepEqual(validateRegister({ version: 1, claims: [] }, NOW).errors, []);
});

// ------------------------------------------------------------------------------------------------ scope
test('public page discovery follows lazy and static imports and reports unresolved routes', () => {
  const appSrc = [
    "import { AboutPage } from '@/pages/AboutPage';",
    "const PricingPage = lazy(() => import('@/pages/PricingPage').then((m) => ({ default: m.PricingPage })));",
    '<Route path="/about" element={<AboutPage />} />',
    '<Route path="/pricing" element={<PricingPage />} />',
    '<Route path="/dashboard" element={<DashboardPage />} />',
    '<Route path="/ghost" element={<GhostPage />} />',
  ].join('\n');
  const known = new Set(['pages/AboutPage', 'pages/PricingPage']);
  const r = discoverPublicPageFiles({ appSrc, publicPaths: ['/about', '/pricing', '/ghost', '/missing'], resolve: (m) => (known.has(m) ? `src/${m}.tsx` : null) });
  assert.deepEqual(r.files, ['src/pages/AboutPage.tsx', 'src/pages/PricingPage.tsx']);
  assert.deepEqual(r.unresolved, ['/ghost', '/missing']);
});

import test from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { toPlainText, splitSentences, countSyllables, score, evaluate, validateConfig, thresholdsFor } from './readability-core.mjs';
import { extractQuoteBodies, run } from './readability.mjs';

const CONFIG = {
  minWordsForGrade: 12,
  thresholds: { sms: { maxGrade: 8, minEase: 60, maxSentenceWords: 20 }, email: { maxGrade: 9, minEase: 55, maxSentenceWords: 25 }, quote: { maxGrade: 8, minEase: 60, maxSentenceWords: 22 } },
  ignorePhrases: ['Reply STOP to opt out.'],
  overrides: {},
};

test('syllables: common customer-copy words', () => {
  const expected = { the: 1, table: 2, make: 1, created: 3, appointment: 3, confirmed: 2, schedule: 2, reschedule: 3, technician: 3, maintenance: 3, simple: 2, house: 1 };
  for (const [w, n] of Object.entries(expected)) assert.equal(countSyllables(w), n, w);
  assert.equal(countSyllables('2027'), 1);
});

test('score matches a hand computation', () => {
  // 10 words, 2 sentences, 10 syllables: ease = 206.835 - 1.015*5 - 84.6*1 = 117.16; grade = 0.39*5 + 11.8 - 15.59 = -1.84
  const s = score('The cat sat on the mat. The dog ran fast.');
  assert.deepEqual([s.words, s.sentences, s.syllables], [10, 2, 10]);
  assert.equal(s.ease, 117.2);
  assert.equal(s.grade, -1.8);
  assert.equal(s.longestSentenceWords, 6);
});

test('sentence splitting keeps abbreviations, times and decimals together', () => {
  assert.deepEqual(splitSentences('Call Dr. Smith at 5 p.m. today. It costs $4.50 per visit! Ok?'), ['Call Dr. Smith at 5 pm today.', 'It costs $4.50 per visit!', 'Ok?']);
  assert.deepEqual(splitSentences('First line\nSecond line'), ['First line', 'Second line']);
});

test('template normalisation', () => {
  assert.equal(toPlainText('Hi {{first_name|there}}, pay {{payment_link}} now.'), 'Hi there, pay now.');
  assert.equal(toPlainText('Hi {{name}}, see https://x.example/a?b=1 today'), 'Hi Sam, see today');
  assert.equal(toPlainText('{{#offer}}Enjoy {{offer}}.{{/offer}}'), 'Enjoy Sam.');
  assert.equal(toPlainText('Hi [Name], it is us.'), 'Hi Sam, it is us.');
  assert.equal(toPlainText('Hello. Reply STOP to opt out.', ['Reply STOP to opt out.']), 'Hello.');
  assert.equal(toPlainText(null), '');
});

test('simple copy passes, dense copy fails with the right rules', () => {
  const ok = evaluate({ id: 'a', channel: 'sms', text: 'Hi {{first_name|there}}, your visit is set for Monday at 9. Call us if you need to change it.' }, CONFIG);
  assert.deepEqual(ok.findings, []);
  const dense = 'Notwithstanding the aforementioned contractual considerations, the organization’s administrative representatives necessitate comprehensive documentation regarding unforeseen modifications to installation specifications.';
  const bad = evaluate({ id: 'b', channel: 'email', text: dense }, CONFIG);
  assert.deepEqual(bad.findings.map((f) => f.rule).sort(), ['ease', 'grade']);
  const longSentence = evaluate({ id: 'c', channel: 'sms', text: 'We will text you when the technician leaves and again when they arrive so that you never wait by the door for long.' }, CONFIG);
  assert.deepEqual(longSentence.findings.map((f) => f.rule), ['sentence-length']);
});

test('very short copy only gets the sentence-length rule', () => {
  const r = evaluate({ id: 's', channel: 'sms', text: 'Technicians rescheduled appointments.' }, CONFIG);
  assert.deepEqual(r.findings, []);
});

test('empty text produces no findings and no crash', () => {
  assert.deepEqual(evaluate({ id: 'e', channel: 'sms', text: '{{payment_link}}' }, CONFIG).findings, []);
});

test('per-template override replaces only the named limits', () => {
  const cfg = { ...CONFIG, overrides: { x: { maxSentenceWords: 40 } } };
  assert.deepEqual(thresholdsFor({ id: 'x', channel: 'sms' }, cfg), { maxGrade: 8, minEase: 60, maxSentenceWords: 40 });
  assert.throws(() => thresholdsFor({ id: 'x', channel: 'fax' }, cfg), /No thresholds/);
});

test('config validation', () => {
  assert.deepEqual(validateConfig(CONFIG), []);
  assert.ok(validateConfig({ thresholds: {} }).length >= 3);
  assert.ok(validateConfig({ ...CONFIG, overrides: { x: { maxGrade: 12 } } }).some((e) => /reason/.test(e)));
});

test('quote copy extraction keeps only quote/estimate bodies and decodes escapes', () => {
  const src = 'a\n config: { body: "Hi, following up on your estimate \\u2014 any questions?" },\n config: { body: "Thanks for your order." },\n config: { body: "About the quote." }';
  const out = extractQuoteBodies(src);
  assert.deepEqual(out.map((o) => o.text), ['Hi, following up on your estimate — any questions?', 'About the quote.']);
  assert.deepEqual(out.map((o) => o.line), [2, 4]);
});

test('run(): warns but exits 0 by default, exits 1 only with --strict', async () => {
  const fakeModules = {
    'messageTemplates.ts': { STARTER_TEMPLATES: [{ id: 'long', channel: 'sms', body: 'Notwithstanding the aforementioned contractual considerations, the organization’s administrative representatives necessitate comprehensive documentation.' }] },
    'lifecycleCore.ts': { DEFAULT_TEMPLATES: {} },
  };
  const loadModule = async (f) => fakeModules[f.split('/').pop()];
  const root = mkdtempSync(join(tmpdir(), 'readability-'));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'src/lib'), { recursive: true });
  copyFileSync(new URL('../../config/readability.config.json', import.meta.url), join(root, 'config/readability.config.json'));
  writeFileSync(join(root, 'src/lib/workflowPlaybooks.ts'), 'const x = 1;');
  const lines = [];
  const warn = await run([], { root, loadModule, log: (l) => lines.push(l) });
  assert.equal(warn.code, 0);
  assert.equal(warn.failing.length, 1);
  assert.match(lines.join('\n'), /starter\.long/);
  const strict = await run(['--strict'], { root, loadModule, log: () => {} });
  assert.equal(strict.code, 1);
});

test('repository config is valid', async () => {
  const { loadConfig } = await import('./readability.mjs');
  assert.doesNotThrow(() => loadConfig());
});

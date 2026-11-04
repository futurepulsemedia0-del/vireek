#!/usr/bin/env node
// Measures structured-extraction accuracy of the voice-log prompt+schema against Gemini.
//
//   GEMINI_API_KEY=... node --experimental-strip-types scripts/eval-voice-log.mjs --text
//   GEMINI_API_KEY=... node --experimental-strip-types scripts/eval-voice-log.mjs --audio-dir ./samples --snr 20,10,5
//   node --experimental-strip-types scripts/eval-voice-log.mjs --dry-run        (no network; validates fixtures)
//
// --text       : the 100 labeled dictations as text (measures extraction logic + language coverage).
// --audio-dir  : real recordings + labels.json: [{ "file": "a.m4a", "lang": "es", "expected": { findings, safety, parts, timeMinutes } }]
//                Each file is scored clean and, with --snr, again with pink noise mixed in (needs ffmpeg).
// Exit code 1 when any threshold in scoring.ts is missed.
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DICTATIONS } from '../src/lib/voiceLog/eval/dictations.ts';
import { THRESHOLDS, aggregate, scoreCase } from '../src/lib/voiceLog/eval/scoring.ts';
import { RESPONSE_SCHEMA, SYSTEM_PROMPT, mimeFromExt, normalizeExtraction } from '../supabase/functions/_shared/voice-log/extract.ts';
import { mixNoise } from './voice-log-noise.mjs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const key = process.env.GEMINI_API_KEY;

if (flag('--dry-run')) {
  const m = aggregate(DICTATIONS.map((d) => scoreCase(d.expected, {
    language: d.lang, transcript: d.text, summary: '', needs_review: false, customer_notes: [], time_minutes: d.expected.timeMinutes, time_confidence: 1,
    findings: [...d.expected.findings, ...d.expected.safety].map((kw, i) => ({ text: kw, severity: i >= d.expected.findings.length ? 'safety' : 'minor', equipment_hint: null, confidence: 1 })),
    parts: d.expected.parts.map((p) => ({ name: p.kw, quantity: p.qty, confidence: 1 })),
  })));
  console.log(`dry-run: ${DICTATIONS.length} dictations, oracle pass=${m.pass}`);
  process.exit(m.pass ? 0 : 1);
}
if (!key) { console.error('GEMINI_API_KEY is required (use --dry-run for an offline check).'); process.exit(2); }

async function extract(parts) {
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4000, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, ...(model.includes('2.5') ? { thinkingConfig: { thinkingBudget: 512 } } : {}) },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body),
    });
    if (res.ok) {
      const j = await res.json();
      const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      try { return normalizeExtraction(JSON.parse(text.replace(/```json|```/g, '').trim())); } catch { return null; }
    }
    if (res.status < 500 && res.status !== 429) throw new Error(`gemini ${res.status}`);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error('gemini unavailable');
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

function report(title, scores, failedParse) {
  const m = aggregate(scores);
  console.log(`\n== ${title} (${m.cases} cases, ${failedParse} unparseable counted as misses)`);
  for (const [k, v] of Object.entries(m)) if (typeof v === 'number' && k !== 'cases') console.log(`  ${k.padEnd(18)} ${(v * 100).toFixed(1)}%`);
  console.log(`  thresholds: ${JSON.stringify(THRESHOLDS)}`);
  console.log(`  RESULT: ${m.pass ? 'PASS' : `FAIL (${m.failures.join(', ')})`}`);
  return m.pass;
}
const EMPTY = { language: 'und', transcript: '', summary: '', findings: [], parts: [], time_minutes: null, time_confidence: 0, customer_notes: [], needs_review: true };

let allPass = true;
if (flag('--text') || !val('--audio-dir')) {
  let bad = 0;
  const scores = await pool(DICTATIONS, 4, async (d) => {
    const ex = await extract([{ text: `Technician dictation (transcript):\n${d.text}` }]);
    if (!ex) bad++;
    return scoreCase(d.expected, ex ?? EMPTY);
  });
  allPass = report('text dictations', scores, bad) && allPass;
}

const dir = val('--audio-dir');
if (dir) {
  const labels = JSON.parse(await readFile(join(dir, 'labels.json'), 'utf8'));
  const snrs = (val('--snr') ?? '').split(',').filter(Boolean).map(Number);
  const tmp = await mkdtemp(join(tmpdir(), 'vlog-'));
  try {
    for (const snr of [null, ...snrs]) {
      let bad = 0;
      const scores = await pool(labels, 3, async (l) => {
        let path = join(dir, l.file); let mime = mimeFromExt(l.file);
        if (snr !== null) { path = join(tmp, `${snr}-${l.file}.wav`); await mixNoise(join(dir, l.file), path, snr); mime = 'audio/wav'; }
        const data = (await readFile(path)).toString('base64');
        const ex = await extract([{ inline_data: { mime_type: mime, data } }, { text: `Spoken language: ${l.lang ?? 'auto'}.` }]);
        if (!ex) bad++;
        return scoreCase(l.expected, ex ?? EMPTY);
      });
      allPass = report(snr === null ? 'audio (clean)' : `audio + pink noise @ ${snr} dB SNR`, scores, bad) && allPass;
    }
  } finally { await rm(tmp, { recursive: true, force: true }); }
}
process.exit(allPass ? 0 : 1);

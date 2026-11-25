#!/usr/bin/env node
// scripts/voice/trade-vocab-eval.mjs
//
// Before/after evaluation of the trade vocabulary on LABELED calls. Pure scoring: it never calls an STT provider and
// never invents numbers. You supply, per call, the human reference transcript and the two machine transcripts
// (baseline = without the vocabulary, biased = with it); it reports corpus-level WER and vocabulary-term recall.
//
//   node scripts/voice/trade-vocab-eval.mjs --calls calls.jsonl --vocab vocab.json [--out result.json] [--min-calls 30] [--fail-on-regression]
//
//   calls.jsonl   one JSON object per line: {"id": "...", "reference": "...", "baseline": "...", "biased": "..."}
//   vocab.json    JSON array of published-snapshot entries: [{"term": "...", "synonyms": ["..."]}, ...]
//                 (the `entries` column of a trade_vocab_versions row)
//
// Metrics (both aggregated over the whole set, not averaged per call):
//   WER          word-level Levenshtein edits / reference words. Lower is better. Can exceed 1.
//   term recall  for every vocabulary surface form (term or synonym) found in the REFERENCE, how many of those occurrences
//                are also found in the hypothesis (capped per form at the reference count). Higher is better.
//                Longer phrases are matched first so "heat pump" is not also counted as "pump".
//
// Calls with an empty reference are rejected (a WER over nothing is meaningless). The output is plain JSON; paste its numbers
// into the staff page ("Record evaluation") only if they came from this script run on real labeled calls.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Lowercase, NFKC, drop punctuation except apostrophes/hyphens inside a word, split on whitespace. */
export function tokenize(text) {
  if (typeof text !== "string") return [];
  const s = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}\p{M}'\s-]+/gu, " ")
    .replace(/(^|\s)['-]+|['-]+(?=\s|$)/g, " ");
  return s.split(/\s+/u).filter(Boolean);
}

/** Word-level edit distance (substitution, insertion, deletion all cost 1). */
export function editDistance(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  let prev = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1);
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1);
    }
    prev = cur;
  }
  return prev[m];
}

/** Surface forms (term + synonyms) as token arrays, longest first, de-duplicated. */
export function surfaceForms(entries) {
  const seen = new Set();
  const forms = [];
  for (const e of entries) {
    for (const raw of [e?.term, ...(Array.isArray(e?.synonyms) ? e.synonyms : [])]) {
      const toks = tokenize(raw);
      if (toks.length === 0) continue;
      const key = toks.join(" ");
      if (seen.has(key)) continue;
      seen.add(key);
      forms.push(toks);
    }
  }
  return forms.sort((a, b) => b.length - a.length || a.join(" ").localeCompare(b.join(" ")));
}

/** Non-overlapping occurrence counts per form; longer forms claim their tokens first. Returns Map<formKey, count>. */
export function countForms(tokens, forms) {
  const used = new Array(tokens.length).fill(false);
  const counts = new Map();
  for (const f of forms) {
    const key = f.join(" ");
    let c = 0;
    for (let i = 0; i + f.length <= tokens.length; i++) {
      let ok = true;
      for (let k = 0; k < f.length; k++) {
        if (used[i + k] || tokens[i + k] !== f[k]) { ok = false; break; }
      }
      if (!ok) continue;
      for (let k = 0; k < f.length; k++) used[i + k] = true;
      c++;
      i += f.length - 1;
    }
    if (c > 0) counts.set(key, c);
  }
  return counts;
}

/** Parse JSONL; throws with the 1-based line number on any malformed or incomplete record. */
export function parseCalls(jsonl) {
  const calls = [];
  const lines = String(jsonl).split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { throw new Error(`line ${idx + 1}: not valid JSON`); }
    for (const k of ["reference", "baseline", "biased"]) {
      if (typeof o[k] !== "string") throw new Error(`line ${idx + 1}: "${k}" must be a string`);
    }
    if (tokenize(o.reference).length === 0) throw new Error(`line ${idx + 1}: empty reference transcript`);
    calls.push({ id: typeof o.id === "string" ? o.id : String(calls.length + 1), reference: o.reference, baseline: o.baseline, biased: o.biased });
  });
  if (calls.length === 0) throw new Error("no calls in input");
  return calls;
}

const round = (x, d = 4) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

export function evaluate(calls, entries, { minCalls = 30 } = {}) {
  const forms = surfaceForms(entries);
  let refWords = 0;
  let baseEdits = 0;
  let biasEdits = 0;
  let termOcc = 0;
  let baseHit = 0;
  let biasHit = 0;

  for (const c of calls) {
    const ref = tokenize(c.reference);
    refWords += ref.length;
    baseEdits += editDistance(ref, tokenize(c.baseline));
    biasEdits += editDistance(ref, tokenize(c.biased));
    if (forms.length > 0) {
      const refCounts = countForms(ref, forms);
      const baseCounts = countForms(tokenize(c.baseline), forms);
      const biasCounts = countForms(tokenize(c.biased), forms);
      for (const [key, n] of refCounts) {
        termOcc += n;
        baseHit += Math.min(n, baseCounts.get(key) ?? 0);
        biasHit += Math.min(n, biasCounts.get(key) ?? 0);
      }
    }
  }

  const baselineWer = baseEdits / refWords;
  const biasedWer = biasEdits / refWords;
  const baselineRecall = termOcc > 0 ? baseHit / termOcc : null;
  const biasedRecall = termOcc > 0 ? biasHit / termOcc : null;
  const warnings = [];
  if (calls.length < minCalls) warnings.push(`only ${calls.length} calls (< ${minCalls}): indicative, not conclusive`);
  if (termOcc === 0) warnings.push("no vocabulary term occurs in the reference transcripts: term recall is undefined");
  else if (termOcc < 30) warnings.push(`only ${termOcc} vocabulary-term occurrences: term recall is indicative, not conclusive`);

  return {
    n_calls: calls.length,
    n_ref_words: refWords,
    n_term_occurrences: termOcc,
    baseline_wer: round(baselineWer),
    biased_wer: round(biasedWer),
    wer_delta: round(biasedWer - baselineWer),
    baseline_term_recall: round(baselineRecall),
    biased_term_recall: round(biasedRecall),
    term_recall_delta: baselineRecall === null ? null : round(biasedRecall - baselineRecall),
    regression: biasedWer > baselineWer || (baselineRecall !== null && biasedRecall < baselineRecall),
    warnings,
  };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function main(argv) {
  const callsPath = arg(argv, "--calls");
  const vocabPath = arg(argv, "--vocab");
  if (!callsPath || !vocabPath) {
    console.error("usage: trade-vocab-eval.mjs --calls calls.jsonl --vocab vocab.json [--out result.json] [--min-calls 30] [--fail-on-regression]");
    return 2;
  }
  const minRaw = arg(argv, "--min-calls");
  const minCalls = minRaw === undefined ? 30 : Number(minRaw);
  if (!Number.isInteger(minCalls) || minCalls < 1) { console.error("--min-calls must be a positive integer"); return 2; }
  let result;
  try {
    const entries = JSON.parse(readFileSync(vocabPath, "utf8"));
    if (!Array.isArray(entries)) throw new Error("vocab file must be a JSON array");
    result = evaluate(parseCalls(readFileSync(callsPath, "utf8")), entries, { minCalls });
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const out = arg(argv, "--out");
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (out) writeFileSync(out, text);
  process.stdout.write(text);
  return argv.includes("--fail-on-regression") && result.regression ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));

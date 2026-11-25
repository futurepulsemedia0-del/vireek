// Tests for the scoring maths only, on tiny hand-made fixtures. These fixtures prove the arithmetic; they are NOT a
// measurement of how well any speech-to-text provider performs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countForms, editDistance, evaluate, main, parseCalls, surfaceForms, tokenize } from "./trade-vocab-eval.mjs";

test("tokenize lowercases, strips punctuation, keeps inner apostrophes and hyphens", () => {
  assert.deepEqual(tokenize("The P-trap, isn't  LEAKING!"), ["the", "p-trap", "isn't", "leaking"]);
  assert.deepEqual(tokenize("Müller’s unit."), ["müller's", "unit"]);
  assert.deepEqual(tokenize(null), []);
});

test("editDistance counts substitutions, insertions and deletions", () => {
  assert.equal(editDistance(["a", "b", "c"], ["a", "b", "c"]), 0);
  assert.equal(editDistance(["a", "b", "c"], ["a", "x", "c"]), 1);
  assert.equal(editDistance(["a", "b", "c"], ["a", "c"]), 1);
  assert.equal(editDistance(["a"], ["a", "b", "c"]), 2);
  assert.equal(editDistance([], ["a", "b"]), 2);
  assert.equal(editDistance(["a", "b"], []), 2);
});

test("surfaceForms de-duplicates and puts longer phrases first", () => {
  const forms = surfaceForms([{ term: "heat pump", synonyms: ["pump", "Heat Pump"] }, { term: "pump" }]);
  assert.deepEqual(forms, [["heat", "pump"], ["pump"]]);
});

test("countForms lets a longer phrase claim its tokens so the shorter one is not double counted", () => {
  const forms = surfaceForms([{ term: "heat pump" }, { term: "pump" }]);
  const counts = countForms(tokenize("the heat pump and the sump pump"), forms);
  assert.equal(counts.get("heat pump"), 1);
  assert.equal(counts.get("pump"), 1);
});

test("evaluate computes corpus-level WER and term recall", () => {
  const calls = [
    // 5 reference words, the baseline mishears the term (1 sub), biased is perfect.
    { id: "1", reference: "replace the contactor today please", baseline: "replace the contact or today please", biased: "replace the contactor today please" },
    // 3 reference words, identical in both.
    { id: "2", reference: "the p-trap leaks", baseline: "the p-trap leaks", biased: "the p-trap leaks" },
  ];
  const r = evaluate(calls, [{ term: "contactor" }, { term: "P-trap" }], { minCalls: 1 });
  assert.equal(r.n_calls, 2);
  assert.equal(r.n_ref_words, 8);
  // baseline: 1 sub + 1 insertion ("contact or" vs "contactor") = 2 edits / 8 words
  assert.equal(r.baseline_wer, 0.25);
  assert.equal(r.biased_wer, 0);
  assert.equal(r.n_term_occurrences, 2);
  assert.equal(r.baseline_term_recall, 0.5);
  assert.equal(r.biased_term_recall, 1);
  assert.equal(r.regression, false);
  assert.deepEqual(r.warnings.filter((w) => w.includes("calls")), []);
});

test("term recall is capped per form at the reference count", () => {
  const r = evaluate(
    [{ id: "1", reference: "valve", baseline: "valve valve valve", biased: "valve" }],
    [{ term: "valve" }],
    { minCalls: 1 },
  );
  assert.equal(r.baseline_term_recall, 1);
  assert.equal(r.biased_term_recall, 1);
});

test("a regression is flagged", () => {
  const r = evaluate(
    [{ id: "1", reference: "check the flue", baseline: "check the flue", biased: "check the flu" }],
    [{ term: "flue" }],
    { minCalls: 1 },
  );
  assert.equal(r.regression, true);
  assert.ok(r.wer_delta > 0);
  assert.equal(r.term_recall_delta, -1);
});

test("small samples and missing terms produce warnings, not numbers pretending to be solid", () => {
  const r = evaluate([{ id: "1", reference: "hello there", baseline: "hello there", biased: "hello there" }], [{ term: "contactor" }]);
  assert.ok(r.warnings.some((w) => w.includes("only 1 calls")));
  assert.ok(r.warnings.some((w) => w.includes("term recall is undefined")));
  assert.equal(r.baseline_term_recall, null);
  assert.equal(r.term_recall_delta, null);
});

test("parseCalls rejects malformed input with the line number", () => {
  assert.throws(() => parseCalls('{"reference":"a","baseline":"a","biased":"a"}\nnot json'), /line 2: not valid JSON/);
  assert.throws(() => parseCalls('{"reference":"a","baseline":"a"}'), /line 1: "biased" must be a string/);
  assert.throws(() => parseCalls('{"reference":"  ...  ","baseline":"a","biased":"a"}'), /empty reference/);
  assert.throws(() => parseCalls("\n\n"), /no calls/);
});

test("CLI: exit codes and --fail-on-regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "tve-"));
  const vocab = join(dir, "vocab.json");
  const good = join(dir, "good.jsonl");
  const bad = join(dir, "bad.jsonl");
  writeFileSync(vocab, JSON.stringify([{ term: "flue" }]));
  writeFileSync(good, JSON.stringify({ reference: "check the flue", baseline: "check the flu", biased: "check the flue" }));
  writeFileSync(bad, JSON.stringify({ reference: "check the flue", baseline: "check the flue", biased: "check the flu" }));
  const quiet = (fn) => { const w = process.stdout.write; process.stdout.write = () => true; try { return fn(); } finally { process.stdout.write = w; } };
  assert.equal(quiet(() => main(["--calls", good, "--vocab", vocab, "--fail-on-regression", "--min-calls", "1"])), 0);
  assert.equal(quiet(() => main(["--calls", bad, "--vocab", vocab, "--fail-on-regression", "--min-calls", "1"])), 1);
  assert.equal(quiet(() => main(["--calls", bad, "--vocab", vocab, "--min-calls", "1"])), 0);
  const err = console.error; console.error = () => {};
  try {
    assert.equal(main([]), 2);
    assert.equal(main(["--calls", join(dir, "missing.jsonl"), "--vocab", vocab]), 2);
    assert.equal(main(["--calls", good, "--vocab", vocab, "--min-calls", "0"]), 2);
  } finally { console.error = err; }
});

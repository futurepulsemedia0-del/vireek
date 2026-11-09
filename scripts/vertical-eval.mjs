#!/usr/bin/env node
// scripts/vertical-eval.mjs  (Node >= 22.18)
//
//   node scripts/vertical-eval.mjs                 all splits, deterministic layer only (no network, no LLM): the CI gate
//   node scripts/vertical-eval.mjs --split dev     only the dev split
//   node scripts/vertical-eval.mjs --update-baseline
//
// Runs eval/vertical-ai/cases.*.json through supabase/functions/_shared/vertical-ai/answer.ts (the same planAnswer the
// live voice handlers use) and reports the Vertical AI metrics. Exit code 1 when a gate fails or a metric regresses
// against eval/vertical-ai/baseline.json. LIMITATION: cases were authored by the same team that wrote the rules; the
// "holdout" split is the only part written after the rules were frozen, and neither replaces real call transcripts.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { planAnswer } from "../supabase/functions/_shared/vertical-ai/answer.ts";
import { resolvePrice, extractDollarAmountsCents, allowedCents } from "../supabase/functions/_shared/vertical-ai/pricing.ts";
import { ONTOLOGY_SEED } from "../supabase/functions/_shared/vertical-ai/ontologySeed.ts";

const dir = new URL("../eval/vertical-ai/", import.meta.url);
const args = process.argv.slice(2);
const splitArg = args.includes("--split") ? args[args.indexOf("--split") + 1] : "all";
const baselineUrl = new URL("baseline.json", dir);
const reportUrl = new URL("report.json", dir);
const baseline = existsSync(baselineUrl) ? JSON.parse(readFileSync(baselineUrl, "utf8")) : {};
const fixtures = JSON.parse(readFileSync(new URL("fixtures.json", dir), "utf8"));

const cases = readdirSync(dir).filter((f) => /^cases\..+\.json$/.test(f)).flatMap((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")))
  .filter((c) => splitArg === "all" || c.split === splitArg);

const PRICE_CTX = { afterHours: false, emergency: false };
const rows = [];
const fails = [];
for (const c of cases) {
  const isPrice = c.price && typeof c.price === "object";
  const plan = planAnswer({
    text: c.text, entries: ONTOLOGY_SEED, outdoorTempF: c.context?.outdoorTempF ?? null,
    now: new Date("2026-11-07T12:00:00Z"),
    priceBook: isPrice ? fixtures.tenantA : null, priceCtx: c.context?.priceCtx ?? PRICE_CTX,
  });
  const exp = c.expect;
  const r = {
    id: c.id, category: c.category, urgencyOk: plan.urgency.urgency === exp.urgency,
    predictedUrgency: plan.urgency.urgency, expectedUrgency: exp.urgency,
    handoffOk: plan.answer.handoff.required === !!exp.handoff, predictedHandoff: plan.answer.handoff.required,
    intentOk: exp.intent === undefined ? true : plan.request.intent === exp.intent, predictedIntent: plan.request.intent,
    tradeOk: exp.trade === undefined ? null : plan.trade === exp.trade, predictedTrade: plan.trade,
    priceOk: null, ungroundedEmitted: plan.answer.statements.filter((s) => s.evidenceIds.length === 0).length, statements: plan.answer.statements.length,
    spokenPriceOk: true,
  };
  if (isPrice) {
    const got = plan.price?.status ?? "none";
    const from = plan.price?.candidates?.[0]?.totalFromCents ?? null;
    r.priceOk = got === c.price.status && (c.price.fromCents == null || from === c.price.fromCents);
    r.predictedPrice = { status: got, fromCents: from };
    if (plan.price) {
      const allowed = allowedCents(plan.price);
      r.spokenPriceOk = extractDollarAmountsCents(plan.answer.spoken).every((x) => allowed.has(x));
    }
  }
  rows.push(r);
  if (!r.urgencyOk || !r.handoffOk || !r.intentOk || r.tradeOk === false || r.priceOk === false || !r.spokenPriceOk) fails.push({ ...r, text: c.text });
}

// ---- cross-tenant leakage: tenant A's lookups must never surface tenant B rows or amounts --------------------
const bIds = new Set(fixtures.tenantB.map((x) => x.id));
const bOnly = new Set(fixtures.tenantB.map((x) => x.price_cents));
for (const x of fixtures.tenantA) { bOnly.delete(x.price_cents); }
const leakQueries = ["drain cleaning", "ac tune-up", "hourly rate", "sewer camera", "clogged drain", "price for drain cleaning", "how much is an ac tune-up", "sewer camera inspection"];
let leaks = 0;
for (const q of leakQueries) {
  const res = resolvePrice(fixtures.tenantA, q, PRICE_CTX);
  for (const cand of res.candidates) {
    if (bIds.has(cand.itemId)) leaks++;
    if (extractDollarAmountsCents(cand.spoken).some((x) => bOnly.has(x))) leaks++;
  }
}

// ---- metrics -------------------------------------------------------------------------------------------------
const byId = new Map(cases.map((c) => [c.id, c]));
const emRows = rows.filter((r) => r.expectedUrgency === "emergency");
const nonEm = rows.filter((r) => r.expectedUrgency !== "emergency");
const rate = (a, b) => (b === 0 ? null : a / b);
const advRows = rows.filter((r) => String(r.category).startsWith("adversarial"));
const tradeRows = rows.filter((r) => r.tradeOk !== null);
const priceRows = rows.filter((r) => r.priceOk !== null);
const stmts = rows.reduce((s, r) => s + r.statements, 0);
const ungrounded = rows.reduce((s, r) => s + r.ungroundedEmitted, 0);
const metrics = {
  cases: rows.length,
  emergencyCases: emRows.length,
  emergencyRecall: rate(emRows.filter((r) => r.predictedUrgency === "emergency").length, emRows.length),
  falseEmergencyRate: rate(nonEm.filter((r) => r.predictedUrgency === "emergency").length, nonEm.length),
  urgencyAccuracy: rate(rows.filter((r) => r.urgencyOk).length, rows.length),
  tradeAccuracy: rate(tradeRows.filter((r) => r.tradeOk).length, tradeRows.length),
  priceAccuracy: rate(priceRows.filter((r) => r.priceOk).length, priceRows.length),
  spokenPriceGroundedRate: rate(rows.filter((r) => r.spokenPriceOk).length, rows.length),
  groundedStatementRate: stmts === 0 ? null : (stmts - ungrounded) / stmts,
  handoffCorrectness: rate(rows.filter((r) => r.handoffOk).length, rows.length),
  refusalCorrectness: rate(advRows.filter((r) => r.intentOk && r.handoffOk).length, advRows.length),
  crossTenantLeakage: leaks,
};

const GATES = {
  emergencyRecall: { op: ">=", v: 0.99 },
  falseEmergencyRate: { op: "<=", v: 0.05 },
  tradeAccuracy: { op: ">=", v: 0.85 },
  priceAccuracy: { op: ">=", v: 1 },
  spokenPriceGroundedRate: { op: ">=", v: 1 },
  groundedStatementRate: { op: ">=", v: 1 },
  handoffCorrectness: { op: ">=", v: 0.9 },
  refusalCorrectness: { op: ">=", v: 0.95 },
  crossTenantLeakage: { op: "<=", v: 0 },
};
const gateFails = [];
for (const [k, g] of Object.entries(GATES)) {
  const x = metrics[k];
  if (x == null) continue;
  if ((g.op === ">=" && x < g.v) || (g.op === "<=" && x > g.v)) gateFails.push(`${k}=${x} (needs ${g.op} ${g.v})`);
}
const regress = [];
for (const k of ["emergencyRecall", "urgencyAccuracy", "tradeAccuracy", "priceAccuracy", "handoffCorrectness", "refusalCorrectness"]) {
  if (baseline[k] != null && metrics[k] != null && metrics[k] < baseline[k] - 1e-9) regress.push(`${k}: ${metrics[k]} < baseline ${baseline[k]}`);
}

const byCat = {};
for (const r of rows) { const b = (byCat[r.category] ??= { n: 0, urgencyOk: 0, handoffOk: 0 }); b.n++; b.urgencyOk += r.urgencyOk ? 1 : 0; b.handoffOk += r.handoffOk ? 1 : 0; }
const report = { split: splitArg, metrics, gates: GATES, gateFails, regress, byCategory: byCat, failures: fails.map((f) => ({ id: f.id, category: f.category, text: byId.get(f.id)?.text, expectedUrgency: f.expectedUrgency, predictedUrgency: f.predictedUrgency, handoff: f.predictedHandoff, intent: f.predictedIntent, trade: f.predictedTrade, price: f.predictedPrice })) };
writeFileSync(reportUrl, JSON.stringify(report, null, 2) + "\n");
if (args.includes("--update-baseline")) writeFileSync(baselineUrl, JSON.stringify(metrics, null, 2) + "\n");

console.log(JSON.stringify(metrics, null, 2));
console.log(`failures: ${fails.length}`);
for (const f of report.failures) console.log(" -", f.id, f.category, "|", f.text, "| urgency", f.expectedUrgency, "->", f.predictedUrgency, "| handoff->", f.handoff, "| intent->", f.intent, "| trade->", f.trade, f.price ? "| price->" + JSON.stringify(f.price) : "");
if (gateFails.length) console.log("GATE FAIL:", gateFails.join("; "));
if (regress.length) console.log("REGRESSION:", regress.join("; "));
process.exit(gateFails.length || regress.length ? 1 : 0);

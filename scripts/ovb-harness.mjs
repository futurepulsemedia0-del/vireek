#!/usr/bin/env node
// scripts/ovb-harness.mjs — Open Voice Benchmark open harness (no dependencies, Node 18+).
//
// Runs YOUR agent against the PUBLIC scenarios of the current suite and writes a bundle
// (ovb-bundle/1) you can submit for scoring. Held-out scenarios are never part of a bundle.
//
//   node scripts/ovb-harness.mjs --api https://api.example.com/ovb --api-token SECRET \
//        --name "Acme Voice" --version 2.4.1 --out bundle.json \
//        [--base https://<project>.supabase.co/functions/v1/ovb-public --anon-key <anon>] \
//        [--submit --submission-token ovb_sub_...]
//
// Your agent implements:  POST {api}/turn  (Authorization: Bearer <api-token>)
//   request : { protocol:"ovb-agent/1", suite_version, scenario_ref, call_id, turn_index,
//               caller_turn: string|null (null = call just connected, send your greeting),
//               interrupt: boolean, history:[{role:"caller"|"agent",text}], business_profile, context, seed }
//   response: { reply: string, outcome?: "booked"|"escalated"|"transferred"|"callback_scheduled"|"declined"|"info_only"|"ended_no_action", end_call?: boolean }
// "[silence]" as caller_turn means the caller said nothing. Configure your agent with `business_profile`.

import { writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---- must stay byte-identical to supabase/functions/_shared/ovb/logic.ts (parity-tested) ----
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const HOMOPHONES = { to: 'two', two: 'to', for: 'four', their: 'there', there: 'their', no: 'know', right: 'write', hear: 'here', here: 'hear', by: 'buy', one: 'won' };
const FILLERS = ['uh', 'um', 'you know'];
export function injectAsrNoise(text, seed, level) {
  if (!level || level < 1) return text;
  const rnd = mulberry32(seed);
  const drop = [0, 0.03, 0.08, 0.15][Math.min(3, level)];
  const swap = [0, 0, 0.15, 0.25][Math.min(3, level)];
  const out = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const bare = word.toLowerCase().replace(/[^a-z]/g, '');
    const hasDigit = /\d/.test(word);
    const r = rnd();
    if (!hasDigit && r < drop) continue;
    if (!hasDigit && HOMOPHONES[bare] && rnd() < swap) { out.push(HOMOPHONES[bare]); continue; }
    out.push(word);
    if (!hasDigit && rnd() < drop / 2) out.push(FILLERS[Math.floor(rnd() * FILLERS.length)]);
  }
  return out.join(' ') || text;
}
export function expectedCallerTexts(s, seed) {
  const level = s.acoustic?.noise_level ?? 0;
  return s.turns.map((t, i) => injectAsrNoise(t.text, fnv1a(`${seed}:${s.scenario_key}:${i}`), level));
}
// -------------------------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function post(url, headers, body, ms = 25000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const started = performance.now();
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const latency = Math.round(performance.now() - started);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return { json: await res.json(), latency };
  } finally { clearTimeout(timer); }
}

export async function runScenario({ api, token, suite, profile, scenario, seed }) {
  const turns = [];
  let outcome = null;
  const texts = expectedCallerTexts(scenario, seed);
  const ask = async (callerTurn, interrupt) => {
    const { json, latency } = await post(`${api.replace(/\/+$/, '')}/turn`, { Authorization: `Bearer ${token}` }, {
      protocol: 'ovb-agent/1', suite_version: suite.version, scenario_ref: scenario.scenario_key, call_id: `${scenario.scenario_key}:${seed}`,
      turn_index: turns.filter((t) => t.role === 'caller').length, caller_turn: callerTurn, interrupt,
      history: turns.map(({ role, text }) => ({ role, text })), business_profile: profile, context: scenario.business_context, seed,
    });
    if (typeof json.reply !== 'string' || !json.reply.trim()) throw new Error('agent reply missing');
    turns.push({ role: 'agent', text: json.reply, latency_ms: latency });
    if (typeof json.outcome === 'string') outcome = json.outcome;
    return json.end_call === true;
  };
  if (await ask(null, false)) return { scenario_key: scenario.scenario_key, seed, outcome, turns };
  for (let i = 0; i < texts.length; i++) {
    turns.push({ role: 'caller', text: texts[i] });
    if (await ask(texts[i], Boolean(scenario.turns[i]?.interrupt))) break;
  }
  return { scenario_key: scenario.scenario_key, seed, outcome, turns };
}

async function main() {
  const api = arg('api'); const token = arg('api-token');
  const base = arg('base'); const anon = arg('anon-key', '');
  if (!api || !token || !base) { console.error('Usage: --api <agent base url> --api-token <secret> --base <ovb-public url> [--anon-key k] --name <n> --version <v> [--out file] [--submit --submission-token t]'); process.exit(2); }
  const headers = anon ? { apikey: anon, Authorization: `Bearer ${anon}` } : {};
  const { json: cat } = await post(base, headers, { action: 'catalog' });
  if (!cat.suite) throw new Error('No published suite');
  console.log(`Suite ${cat.suite.version} — ${cat.scenarios.length} public scenarios`);
  const results = [];
  for (const scenario of cat.scenarios) {
    const seed = randomInt(0, 2147483647);
    try {
      results.push(await runScenario({ api, token, suite: cat.suite, profile: cat.suite.business_profile, scenario, seed }));
      console.log(`  ✓ ${scenario.scenario_key}`);
    } catch (e) { console.error(`  ✗ ${scenario.scenario_key}: ${e.message}`); process.exitCode = 1; }
  }
  const bundle = { protocol: 'ovb-bundle/1', suite_version: cat.suite.version, manifest_hash: cat.suite.manifest_hash, agent: { name: arg('name', 'agent'), version: arg('version', 'unknown') }, results };
  writeFileSync(arg('out', 'bundle.json'), JSON.stringify(bundle, null, 2));
  console.log(`Wrote ${arg('out', 'bundle.json')} (${results.length}/${cat.scenarios.length} scenarios)`);
  if (process.argv.includes('--submit')) {
    const res = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${arg('submission-token', '')}`, ...headers }, body: JSON.stringify({ action: 'submit_bundle', bundle }) });
    console.log(res.status, await res.text());
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(e.message); process.exit(1); });

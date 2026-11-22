// Load / chaos simulation for the token executor and durable compensation (pure engine, in-memory stores).
// Run:  node --experimental-strip-types load/workflow/engine-sim.mjs [--runs=2000] [--workers=8] [--branches=6] [--len=3] [--crash=0.02] [--seed=1]
//
// What it proves (and what it does NOT): the ORCHESTRATION invariants hold under many concurrent workers and random process deaths —
//   I1 every (run, node) side effect executes at most once       I2 no join is released twice
//   I3 a token never changes after reaching a terminal state     I5 fan-out concurrency never exceeds its limit
//   I4 compensation runs in reverse order, at most once each     every run reaches a terminal state (liveness)
//   --overlap=1 deliberately lets two workers tick the same run (a tick outliving its run lease) and REPORTS duplicate join releases.
// It does NOT measure Postgres, network or the real executor: use load/k6/workflow-executor.load.js + load/workflow/verify.sql on staging for that.
import { createMemoryTokenStore, runParallel, runForeach } from '../../supabase/functions/_shared/workflow-compiler/tokens.ts';
import { advanceCompensation, buildCompensationRows, createMemoryCompStore } from '../../supabase/functions/_shared/workflow-compiler/compensation.ts';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const OVERLAP = arg('overlap', 0);   // 1 = ignore the run lease (models a tick that outlives its lease)
const RUNS = arg('runs', 2000), WORKERS = arg('workers', 8), BRANCHES = arg('branches', 6), LEN = arg('len', 3), CRASH = arg('crash', 0.02), SEED = arg('seed', 1);
const FOREACH_RUNS = Math.floor(RUNS / 10), FOREACH_ITEMS = 25, FOREACH_CONC = 4;

let s = SEED >>> 0;
const rand = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let clock = 0; const now = () => clock;   // virtual clock: crashes expire leases deterministically
const LEASE = 1000;

const graph = { nodes: {}, edges: {} };
for (let b = 0; b < BRANCHES; b++) for (let k = 0; k < LEN; k++) {
  graph.nodes[`t${b}_${k}`] = { id: `t${b}_${k}`, kind: 'lookup' };
  graph.edges[`t${b}_${k}`] = { next: k === LEN - 1 ? 'j' : `t${b}_${k + 1}` };
}
const starts = Array.from({ length: BRANCHES }, (_, b) => `t${b}_0`);

const violations = [];
const info = { joinDoubleRelease: 0 };
const leased = new Set();   // models claim_compiled_runs(): one worker per run at a time
const execCount = new Map();               // `${run}:${node}` -> n
const released = new Map();                // run -> n
const lat = [];
const runs = Array.from({ length: RUNS }, (_, i) => ({ id: `r${i}`, store: createMemoryTokenStore({ now, leaseMs: LEASE }), done: false, crashed: 0 }));

async function tickRun(run) {
  const t0 = performance.now();
  let crashedNow = false;
  const out = await runParallel('p', {
    graph, joinId: 'j', maxHops: 50, store: run.store, cfg: { mode: 'all' }, starts, concurrency: 3, deadline: Infinity, now,
    exec: async (_t, node) => {
      const key = `${run.id}:${node}`;
      execCount.set(key, (execCount.get(key) ?? 0) + 1);
      if (execCount.get(key) > 1) violations.push(`I1 ${key} executed ${execCount.get(key)}x`);
      await sleep(rand() * 2);
      if (rand() < CRASH) { crashedNow = true; run.crashed++; throw Object.assign(new Error('process died'), { __crash: true }); }
      return { edge: 'next', output: { ok: 1 }, done: 'completed' };
    },
  });
  lat.push(performance.now() - t0);
  if (out.kind === 'released') {
    released.set(run.id, (released.get(run.id) ?? 0) + 1);
    if (released.get(run.id) > 1) { if (OVERLAP) info.joinDoubleRelease++; else violations.push(`I2 join of ${run.id} released ${released.get(run.id)}x`); }
    run.done = true; run.decision = out.decision.action;
  }
  return crashedNow;
}

const queue = runs.map((r) => r);
async function worker() {
  let spins = 0;
  while (runs.some((r) => !r.done) && spins < 100000) {
    spins++;
    const r = queue[Math.floor(rand() * queue.length)];
    if (!r || r.done || (!OVERLAP && leased.has(r.id))) { await sleep(0); continue; }
    leased.add(r.id);
    try { await tickRun(r); } finally { leased.delete(r.id); }
    clock += 50;                                  // time passes; crashed leases will expire
    if (clock % 1000 === 0) await sleep(0);
  }
}
const tStart = performance.now();
await Promise.all(Array.from({ length: WORKERS }, worker));
const elapsed = (performance.now() - tStart) / 1000;

// I3 / liveness
const notDone = runs.filter((r) => !r.done).length;
if (notDone) violations.push(`liveness: ${notDone} runs never released`);
const failedByCrash = runs.filter((r) => r.decision === 'fail').length;

// ---- fan-out concurrency
let peak = 0, live = 0; const itemRuns = new Map();
async function foreachRun(i) {
  const store = createMemoryTokenStore({ now, leaseMs: LEASE });
  const deps = () => ({ store, total: FOREACH_ITEMS, concurrency: FOREACH_CONC, now, deadline: Infinity, runItem: async (n) => {
    const k = `f${i}:${n}`; itemRuns.set(k, (itemRuns.get(k) ?? 0) + 1); if (itemRuns.get(k) > 1) violations.push(`I1 item ${k} ran ${itemRuns.get(k)}x`);
    live++; peak = Math.max(peak, live); await sleep(rand() * 2); live--; return { ok: true }; } });
  // two competing workers for the SAME fan-out; the cap is per fan-out, so measure it per fan-out
  let local = 0, localPeak = 0;
  const d = deps(); const inner = d.runItem; d.runItem = async (n) => { local++; localPeak = Math.max(localPeak, local); try { return await inner(n); } finally { local--; } };
  await Promise.all([runForeach('f', d), runForeach('f', d)]);
  const fin = await runForeach('f', d);
  if (fin.kind !== 'completed') violations.push(`foreach ${i} ended ${fin.kind}`);
  if (localPeak > FOREACH_CONC) violations.push(`I5 foreach ${i} peak ${localPeak} > ${FOREACH_CONC}`);
}
await Promise.all(Array.from({ length: FOREACH_RUNS }, (_, i) => foreachRun(i)));

// ---- compensation: reverse order, once each, crash => failed not repeated
const steps = Array.from({ length: 12 }, (_, i) => ({ nodeId: `a${i}`, status: 'completed', compensator: `u${i}`, seq: i + 1 }));
for (let i = 0; i < Math.min(500, RUNS); i++) {
  const cs = createMemoryCompStore({ now, leaseMs: LEASE }); await cs.plan(buildCompensationRows(steps));
  const order = [];
  const mk = () => ({ store: cs, now, deadline: Infinity, run: async (c) => { order.push(c); await sleep(0); }, record: async () => {} });
  if (rand() < 0.3) { await cs.claim(); clock += LEASE * 2; }  // a worker died holding the lease
  await Promise.all([advanceCompensation(mk()), advanceCompensation(mk())]);
  const seqs = order.map((c) => Number(c.slice(1)));
  if (new Set(order).size !== order.length) violations.push(`I4 comp run ${i}: an undo ran twice`);
  for (let k = 1; k < seqs.length; k++) if (seqs[k] > seqs[k - 1]) violations.push(`I4 comp run ${i}: not reverse order`);
}

lat.sort((a, b) => a - b); const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? 0;
const totalExec = [...execCount.values()].reduce((a, b) => a + b, 0);
console.log(JSON.stringify({
  config: { RUNS, WORKERS, BRANCHES, LEN, CRASH, SEED, OVERLAP }, seconds: +elapsed.toFixed(2), runsReleased: RUNS - notDone, runsFailedByCrash: failedByCrash,
  nodeExecutions: totalExec, execPerSec: Math.round(totalExec / elapsed), tickMs: { p50: +p(0.5).toFixed(2), p95: +p(0.95).toFixed(2), p99: +p(0.99).toFixed(2) },
  foreach: { runs: FOREACH_RUNS, itemsEach: FOREACH_ITEMS, limit: FOREACH_CONC }, violations: violations.length,
  informational: OVERLAP ? { joinDoubleReleaseUnderLeaseOverlap: info.joinDoubleRelease, note: 'run-level overlap is NOT prevented by tokens; node side effects still ran at most once (I1 = 0 violations)' } : undefined,
}, null, 2));
if (violations.length) { console.error(violations.slice(0, 20).join('\n')); process.exit(1); }

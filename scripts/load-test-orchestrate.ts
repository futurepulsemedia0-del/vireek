// scripts/load-test-orchestrate.ts
// In-memory load test of the orchestration layer (no network, no database).
// It measures the CPU cost of join/fan-out decisions, NOT edge-function or Postgres throughput.
// Run: node --experimental-strip-types scripts/load-test-orchestrate.ts   (or: npx tsx scripts/load-test-orchestrate.ts)
import { advanceForeach, advanceParallel, startForeach, startParallel } from "../supabase/functions/_shared/workflow-compiler/orchestrate.ts";
import { compileIr } from "../supabase/functions/_shared/workflow-compiler/spec.ts";

const RUNS = Number(process.env.RUNS ?? 2000);
const BRANCHES = 8, ITEMS = 200, CONCURRENCY = 10;

const nodes: any[] = [
  { id: "c1", kind: "lookup", label: "Customer", capability: "customer_profile" },
  { id: "p", kind: "parallel", label: "Fan" },
  { id: "j", kind: "join", label: "Join", params: { parallel: "p", mode: "all" } },
  { id: "done", kind: "action", label: "Notify", capability: "notify_owner", params: { title: "o", message: "m" } },
];
const edges: any[] = [{ from: "c1", to: "p", on: "next" }, { from: "j", to: "done", on: "next" }];
for (let i = 0; i < BRANCHES; i++) {
  nodes.push({ id: `t${i}`, kind: "lookup", label: `T${i}`, capability: "technician_roster" });
  edges.push({ from: "p", to: `t${i}`, on: `b${i}` }, { from: `t${i}`, to: "j", on: "next" });
}
const c: any = compileIr({ name: "L", summary: "s", trigger: { event: "call.emergency" }, sla_minutes: 30, nodes, edges }, { allowParallel: true });
if (!c.ok) throw new Error(c.errors.join("; "));
const starts = Array.from({ length: BRANCHES }, (_, i) => `t${i}`);

const t0 = performance.now();
let nodeCalls = 0;
for (let r = 0; r < RUNS; r++) {
  const res = await advanceParallel(startParallel(starts, 0), {
    graph: c.graph, joinId: "j", cfg: { mode: "all" }, maxHopsPerBranch: 10, deadline: Infinity, now: () => 0,
    exec: async () => { nodeCalls++; return { edge: "next" }; }, checkpoint: async () => {},
  });
  if (res.decision.action !== "proceed") throw new Error("unexpected decision");
}
const t1 = performance.now();
let items = 0;
for (let r = 0; r < RUNS; r++) {
  const res = await advanceForeach(startForeach(ITEMS, CONCURRENCY), { deadline: Infinity, now: () => 0, checkpoint: async () => {}, runItem: async () => { items++; return { ok: true }; } });
  if (res.status !== "completed") throw new Error("unexpected status");
}
const t2 = performance.now();
const fmt = (n: number) => n.toFixed(1);
console.log(JSON.stringify({
  runs: RUNS,
  parallel: { branches: BRANCHES, ms: +fmt(t1 - t0), runsPerSec: Math.round(RUNS / ((t1 - t0) / 1000)), nodeCalls },
  foreach: { items: ITEMS, concurrency: CONCURRENCY, ms: +fmt(t2 - t1), runsPerSec: Math.round(RUNS / ((t2 - t1) / 1000)), itemsRun: items },
}, null, 2));

// supabase/functions/_shared/workflow-compiler/run-analytics.ts
//
// Phase 3 (pure core): analytics over compiled_workflow_audit + compiled_workflow_runs.
// Event shapes follow the executor: node_started{kind}, edge_taken{edge,to} (node_id = node just finished),
// approval_requested, timer_set, action_outcome_unknown, engine_error.
// LLM token cost: the executor does NOT record tokens today, so cost is null until it does (see costPerRun).
import { maskPii } from "./spec.ts";

export interface AuditRow { run_id: string; seq: number; event_type: string; node_id: string | null; detail: Record<string, unknown>; created_at: string }
export interface RunRow { id: string; status: string; started_at: string; completed_at: string | null; sla_breached_at: string | null; stop_reason: string | null }

export interface Span { run: string; node: string; kind: string | null; startMs: number; durationMs: number | null; edge: string | null; approvalWaitMs: number | null }
const FAIL_EDGES = new Set(["fail", "rejected", "timeout"]);
const ms = (iso: string) => Date.parse(iso);

export function buildSpans(rows: readonly AuditRow[]): Span[] {
  const byRun = new Map<string, AuditRow[]>();
  for (const r of rows) (byRun.get(r.run_id) ?? byRun.set(r.run_id, []).get(r.run_id)!).push(r);
  const spans: Span[] = [];
  for (const [run, list] of byRun) {
    list.sort((a, b) => a.seq - b.seq);
    list.forEach((r, i) => {
      if (r.event_type !== "node_started" || !r.node_id) return;
      const t0 = ms(r.created_at);
      let end: AuditRow | undefined, asked: AuditRow | undefined;
      for (let j = i + 1; j < list.length; j++) {
        const x = list[j];
        if (x.node_id !== r.node_id) { if (x.event_type === "node_started") break; continue; }
        if (x.event_type === "approval_requested") asked = x;
        if (x.event_type === "edge_taken") { end = x; break; }
      }
      spans.push({
        run, node: r.node_id, kind: typeof r.detail?.kind === "string" ? r.detail.kind : null, startMs: t0,
        durationMs: end ? Math.max(0, ms(end.created_at) - t0) : null,
        edge: end && typeof end.detail?.edge === "string" ? end.detail.edge : null,
        approvalWaitMs: asked && end ? Math.max(0, ms(end.created_at) - ms(asked.created_at)) : null,
      });
    });
  }
  return spans;
}

export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export interface NodeStat { node: string; runs: number; finished: number; failures: number; failureRate: number; p50: number | null; p95: number | null; totalMs: number; approvalWaitP50: number | null }
export function nodeStats(spans: readonly Span[]): NodeStat[] {
  const g = new Map<string, Span[]>();
  for (const s of spans) (g.get(s.node) ?? g.set(s.node, []).get(s.node)!).push(s);
  return [...g].map(([node, xs]) => {
    const d = xs.flatMap((x) => (x.durationMs === null ? [] : [x.durationMs])).sort((a, b) => a - b);
    const w = xs.flatMap((x) => (x.approvalWaitMs === null ? [] : [x.approvalWaitMs])).sort((a, b) => a - b);
    const failures = xs.filter((x) => x.edge !== null && FAIL_EDGES.has(x.edge)).length;
    return { node, runs: xs.length, finished: d.length, failures, failureRate: d.length ? failures / d.length : 0, p50: percentile(d, 50), p95: percentile(d, 95), totalMs: d.reduce((a, b) => a + b, 0), approvalWaitP50: percentile(w, 50) };
  }).sort((a, b) => a.node.localeCompare(b.node));
}

/** Nodes holding the largest share of finished step time. Approvals are human wait, reported but not called a bottleneck. */
export function bottlenecks(stats: readonly NodeStat[], kinds: ReadonlyMap<string, string | null>, minShare = 0.3): { node: string; share: number }[] {
  const own = stats.filter((s) => kinds.get(s.node) !== "approval");
  const total = own.reduce((a, s) => a + s.totalMs, 0);
  if (total <= 0) return [];
  return own.map((s) => ({ node: s.node, share: s.totalMs / total }))
    .filter((x) => x.share >= minShare).sort((a, b) => b.share - a.share);
}

export function funnel(spans: readonly Span[], order: readonly string[]): { node: string; runs: number; ofStart: number }[] {
  const reached = new Map<string, Set<string>>();
  for (const s of spans) (reached.get(s.node) ?? reached.set(s.node, new Set()).get(s.node)!).add(s.run);
  const first = reached.get(order[0])?.size ?? 0;
  return order.map((node) => { const n = reached.get(node)?.size ?? 0; return { node, runs: n, ofStart: first ? n / first : 0 }; });
}

/** For SLA-breached runs: which step held that run the longest. */
export function slaHotspots(runs: readonly RunRow[], spans: readonly Span[]): { node: string; breaches: number }[] {
  const breached = new Set(runs.filter((r) => r.sla_breached_at).map((r) => r.id));
  const c = new Map<string, number>();
  for (const id of breached) {
    const mine = spans.filter((s) => s.run === id && s.durationMs !== null);
    if (!mine.length) continue;
    const worst = mine.reduce((a, b) => ((b.durationMs ?? 0) > (a.durationMs ?? 0) ? b : a));
    c.set(worst.node, (c.get(worst.node) ?? 0) + 1);
  }
  return [...c].map(([node, breaches]) => ({ node, breaches })).sort((a, b) => b.breaches - a.breaches || a.node.localeCompare(b.node));
}

/** Tokens per run from detail.tokens_in / tokens_out when present. null = not instrumented (never a made-up zero). */
export function costPerRun(rows: readonly AuditRow[], usdPer1kIn: number, usdPer1kOut: number): Map<string, { tokensIn: number; tokensOut: number; usd: number }> | null {
  const out = new Map<string, { tokensIn: number; tokensOut: number; usd: number }>();
  let seen = false;
  for (const r of rows) {
    const a = Number(r.detail?.tokens_in), b = Number(r.detail?.tokens_out);
    if (!Number.isFinite(a) && !Number.isFinite(b)) continue;
    seen = true;
    const cur = out.get(r.run_id) ?? { tokensIn: 0, tokensOut: 0, usd: 0 };
    cur.tokensIn += Number.isFinite(a) ? a : 0; cur.tokensOut += Number.isFinite(b) ? b : 0;
    cur.usd = (cur.tokensIn / 1000) * usdPer1kIn + (cur.tokensOut / 1000) * usdPer1kOut;
    out.set(r.run_id, cur);
  }
  return seen ? out : null;
}

/** Modified z-score (median/MAD): robust to the very outliers it is hunting. Returns flagged indexes. */
export function anomalies(values: readonly number[], threshold = 3.5): number[] {
  if (values.length < 5) return [];
  const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const m = med([...values]);
  const mad = med(values.map((v) => Math.abs(v - m)));
  if (mad === 0) return values.flatMap((v, i) => (v !== m ? [i] : []));
  return values.flatMap((v, i) => (0.6745 * Math.abs(v - m) / mad > threshold ? [i] : []));
}

// ---------------------------------------------------------------- time-travel debugger helpers
const SECRET_KEY = /(token|secret|password|authorization|api[_-]?key|phone|email|address|ssn)/i;
/** Deep redaction for replay views: secret-ish keys are dropped to a marker, strings are PII-masked. */
export function redactForReplay(v: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof v === "string") return maskPii(v).slice(0, 500);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redactForReplay(x, depth + 1));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = SECRET_KEY.test(k) ? "[redacted]" : redactForReplay(x, depth + 1);
    return o;
  }
  return v;
}

export interface ReplayFrame { seq: number; event: string; node: string | null; detail: unknown }
/** Step-by-step frames for a run; `upTo` lets the UI scrub. Read-only: a what-if re-run goes through the sandbox/test mode, never this. */
export function replayFrames(rows: readonly AuditRow[], upTo = Infinity): ReplayFrame[] {
  return [...rows].sort((a, b) => a.seq - b.seq).filter((r) => r.seq <= upTo).map((r) => ({ seq: r.seq, event: r.event_type, node: r.node_id, detail: redactForReplay(r.detail) }));
}

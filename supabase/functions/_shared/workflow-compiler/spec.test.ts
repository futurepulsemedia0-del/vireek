// supabase/functions/_shared/workflow-compiler/spec.ts
//
// Vireek Workflow Compiler — the deterministic core.
//
// The AI never produces something the engine executes directly. It produces an
// untrusted INTENT GRAPH (the "IR"). Everything in this file is plain code that
// decides whether that IR is allowed to become a workflow:
//
//   IR (from AI)  --validateIr()-->  errors[]  (fed back to the AI for repair)
//                 --lowerIr()----->  CompiledGraph (what the executor runs)
//                 --buildReport()->  risk / coverage report shown to the owner
//
// Zero imports, zero I/O: runs unchanged under Deno (edge functions) and under
// vitest (spec.test.ts), so every safety rule below is unit-tested.

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const COMPILER_VERSION = 1;
export const MAX_NODES = 24;
export const MAX_PATHS = 64;

export const TRIGGER_EVENTS = [
  "call.created", "call.missed", "call.emergency",
  "lead.created", "job.created", "job.completed",
  "quote.sent", "quote.accepted", "quote.declined",
  "payment.received", "review.completed",
] as const;
export type TriggerEvent = (typeof TRIGGER_EVENTS)[number];

export type NodeKind = "lookup" | "reason" | "decision" | "action" | "approval" | "verify" | "wait";
export type EdgeOn = "next" | "true" | "false" | "fail" | "approved" | "rejected" | "timeout" | "pass";

export const TRADES = ["hvac", "plumbing", "electrical", "roofing", "restoration", "locksmith", "general"] as const;
export const RULE_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "truthy", "falsy", "in", "contains"] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export interface Rule {
  path: string;
  op: RuleOp;
  value?: string | number | boolean | Array<string | number>;
}

export interface ReasonField { key: string; type: "string" | "number" | "boolean" }

export interface IrNode {
  id: string;
  kind: NodeKind;
  label: string;
  capability?: string;
  params?: Record<string, unknown>;
  // reason
  question?: string;
  options?: string[];
  fields?: ReasonField[];
  // decision / verify(state_rule)
  rule?: Rule;
  // approval
  prompt?: string;
  timeout_minutes?: number;
  gates?: string[];
}

export interface IrEdge { from: string; to: string; on: EdgeOn }

export interface WorkflowIr {
  name: string;
  summary: string;
  trigger: { event: TriggerEvent };
  sla_minutes?: number | null;
  nodes: IrNode[];
  edges: IrEdge[];
  assumptions?: string[];
}

export interface CompiledGraph {
  version: number;
  entry: string;
  trigger_event: TriggerEvent;
  sla_minutes: number | null;
  nodes: Record<string, IrNode & { auto?: boolean }>;
  edges: Record<string, Partial<Record<EdgeOn, string>>>;
}

// ---------------------------------------------------------------------------
// Capability registry — the ONLY things a workflow may read or do.
// `outputs` is also what later nodes may reference as {{node.field}}.
// `commitment` = spends money / commits staff / contacts third parties; such
// actions can only compile when a human-approval node dominates them.
// ---------------------------------------------------------------------------

interface CapabilitySpec {
  kind: NodeKind;
  label: string;
  outputs: string[];
  commitment?: boolean;
  customerFacing?: boolean;
  params: Record<string, { type: "string" | "number" | "enum" | "path"; required?: boolean; values?: readonly string[]; max?: number }>;
}

export const CAPABILITIES: Record<string, CapabilitySpec> = {
  customer_profile: {
    kind: "lookup", label: "Customer profile & VIP status",
    outputs: ["found", "name", "is_vip", "tags", "lifetime_jobs", "lifetime_spend"],
    params: {},
  },
  technician_roster: {
    kind: "lookup", label: "Technician availability",
    outputs: ["total", "available_count", "available_names"],
    params: {},
  },
  part_availability: {
    kind: "lookup", label: "Parts stock check",
    outputs: ["query", "in_stock", "available_qty", "locations"],
    params: { query_path: { type: "path", required: true }, min_qty: { type: "number", max: 1000 } },
  },
  dispatch_technician: {
    kind: "action", label: "Dispatch best technician", commitment: true,
    outputs: ["job_id", "technician_id", "technician_name", "assigned"],
    params: { service_type_path: { type: "path" } },
  },
  post_contractor_handoff: {
    kind: "action", label: "Post to contractor network", commitment: true,
    outputs: ["handoff_id"],
    params: {
      trade: { type: "enum", values: TRADES, required: true },
      title: { type: "string", required: true, max: 120 },
      summary: { type: "string", max: 400 },
    },
  },
  send_sms: {
    kind: "action", label: "Text the customer", customerFacing: true,
    outputs: ["sent"],
    params: { body: { type: "string", required: true, max: 320 } },
  },
  notify_owner: {
    kind: "action", label: "Notify the owner",
    outputs: ["notified"],
    params: { title: { type: "string", required: true, max: 100 }, message: { type: "string", required: true, max: 400 } },
  },
  job_assigned: { kind: "verify", label: "Verify technician assigned", outputs: ["passed"], params: { target: { type: "string", required: true } } },
  handoff_posted: { kind: "verify", label: "Verify handoff is open", outputs: ["passed"], params: { target: { type: "string", required: true } } },
  state_rule: { kind: "verify", label: "Verify a condition", outputs: ["passed"], params: {} },
};

const OUTPUTS_BY_KIND: Partial<Record<NodeKind, string[]>> = {
  approval: ["approved", "price_cents", "note"],
  decision: ["result"],
  wait: ["waited"],
};
const REASON_BASE = ["choice", "confidence", "rationale"];
const ROOTS = ["trigger", "customer", "sla"];

const ID_RE = /^[a-z][a-z0-9_]{0,23}$/;
const PATH_RE = /^[a-z][a-z0-9_]*(\.[A-Za-z0-9_]+){1,3}$/;
const TEMPLATE_RE = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

function adjacency(edges: IrEdge[]): Map<string, IrEdge[]> {
  const m = new Map<string, IrEdge[]>();
  for (const e of edges) {
    const list = m.get(e.from) ?? [];
    list.push(e);
    m.set(e.from, list);
  }
  return m;
}

function reachableFrom(start: string, adj: Map<string, IrEdge[]>, skip?: string): Set<string> {
  const seen = new Set<string>();
  if (start === skip) return seen;
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur) || cur === skip) continue;
    seen.add(cur);
    for (const e of adj.get(cur) ?? []) stack.push(e.to);
  }
  return seen;
}

function findCycle(ids: string[], adj: Map<string, IrEdge[]>): string[] | null {
  const color = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    path.push(id);
    for (const e of adj.get(id) ?? []) {
      const c = color.get(e.to) ?? 0;
      if (c === 1) return [...path.slice(path.indexOf(e.to)), e.to];
      if (c === 0) {
        const found = visit(e.to);
        if (found) return found;
      }
    }
    path.pop();
    color.set(id, 2);
    return null;
  };
  for (const id of ids) if ((color.get(id) ?? 0) === 0) { const f = visit(id); if (f) return f; }
  return null;
}

/** Entry = the one node with no incoming edge. */
export function findEntry(ir: Pick<WorkflowIr, "nodes" | "edges">): string[] {
  const incoming = new Set(ir.edges.map((e) => e.to));
  return ir.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const REQUIRED_EDGES: Record<NodeKind, EdgeOn[]> = {
  lookup: ["next"], reason: ["next"], decision: ["true", "false"],
  action: [], approval: ["approved"], verify: [], wait: ["next"],
};
const ALLOWED_EDGES: Record<NodeKind, EdgeOn[]> = {
  lookup: ["next", "fail"], reason: ["next", "fail"], decision: ["true", "false"],
  action: ["next", "fail"], approval: ["approved", "rejected", "timeout"],
  verify: ["pass", "fail"], wait: ["next"],
};

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max ? v : null;
}

function checkTemplate(text: string, where: string, scope: Set<string>, ir: WorkflowIr, errors: string[]) {
  for (const m of text.matchAll(TEMPLATE_RE)) {
    const err = checkPathRef(m[1], scope, ir);
    if (err) errors.push(`${where}: template {{${m[1]}}} — ${err}`);
  }
}

function checkPathRef(path: string, scope: Set<string>, ir: WorkflowIr): string | null {
  const [root, field] = path.split(".");
  if (!field) return "must look like node.field";
  if (ROOTS.includes(root)) return null; // trigger.* / customer.* / sla.* are open-ended
  if (!scope.has(root)) return `"${root}" is not an earlier node on every path to this step`;
  const node = ir.nodes.find((n) => n.id === root)!;
  let known: string[] | undefined;
  if (node.kind === "reason") known = [...REASON_BASE, ...(node.fields ?? []).map((f) => f.key)];
  else if (node.capability && CAPABILITIES[node.capability]) known = CAPABILITIES[node.capability].outputs;
  else known = OUTPUTS_BY_KIND[node.kind];
  if (known && !known.includes(field)) return `node "${root}" has no output "${field}" (has: ${known.join(", ")})`;
  return null;
}

/** Nodes that are guaranteed to have run before `id` on EVERY path from entry. */
function guaranteedBefore(id: string, entry: string, ir: WorkflowIr, adj: Map<string, IrEdge[]>): Set<string> {
  const out = new Set<string>();
  for (const n of ir.nodes) {
    if (n.id === id || n.id === entry && id !== entry) { if (n.id === entry && id !== entry) out.add(n.id); continue; }
    // n dominates id iff removing n makes id unreachable from entry
    if (!reachableFrom(entry, adj, n.id).has(id)) out.add(n.id);
  }
  return out;
}

export function validateIr(raw: unknown): { errors: string[]; ir: WorkflowIr | null } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { errors: ["IR must be a JSON object"], ir: null };
  const ir = raw as WorkflowIr;

  if (!str(ir.name, 80)) errors.push("name is required (max 80 chars)");
  if (!str(ir.summary, 600)) errors.push("summary is required (max 600 chars)");
  if (!ir.trigger || !TRIGGER_EVENTS.includes(ir.trigger.event)) {
    errors.push(`trigger.event must be one of: ${TRIGGER_EVENTS.join(", ")}`);
  }
  if (ir.sla_minutes != null && !(Number.isInteger(ir.sla_minutes) && ir.sla_minutes >= 1 && ir.sla_minutes <= 10080)) {
    errors.push("sla_minutes must be an integer 1..10080 or null");
  }
  if (!Array.isArray(ir.nodes) || ir.nodes.length === 0) errors.push("nodes must be a non-empty array");
  if (!Array.isArray(ir.edges)) errors.push("edges must be an array");
  if (errors.length) return { errors, ir: null };
  if (ir.nodes.length > MAX_NODES) return { errors: [`too many nodes (max ${MAX_NODES})`], ir: null };

  const ids = new Set<string>();
  for (const n of ir.nodes) {
    if (!n || typeof n.id !== "string" || !ID_RE.test(n.id)) { errors.push(`invalid node id "${String(n?.id)}" (lowercase letters, digits, underscore)`); continue; }
    if (ids.has(n.id)) errors.push(`duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  if (errors.length) return { errors, ir: null };

  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  for (const e of ir.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) { errors.push(`edge ${e.from}->${e.to} references an unknown node`); continue; }
    if (e.from === e.to) errors.push(`edge ${e.from}->${e.to} is a self-loop`);
    const kind = byId.get(e.from)!.kind;
    if (!ALLOWED_EDGES[kind]?.includes(e.on)) errors.push(`node "${e.from}" (${kind}) cannot have an "${e.on}" edge (allowed: ${ALLOWED_EDGES[kind]?.join(", ")})`);
  }
  if (errors.length) return { errors, ir: null };

  const adj = adjacency(ir.edges);
  const seenOn = new Set<string>();
  for (const e of ir.edges) {
    const key = `${e.from}:${e.on}`;
    if (seenOn.has(key)) errors.push(`node "${e.from}" has two "${e.on}" edges`);
    seenOn.add(key);
  }

  const entries = findEntry(ir);
  if (entries.length !== 1) errors.push(`graph must have exactly one entry node (no incoming edge); found ${entries.length}: ${entries.join(", ") || "none"}`);
  const cycle = findCycle([...ids], adj);
  if (cycle) errors.push(`graph contains a cycle: ${cycle.join(" -> ")} (loops are not allowed)`);
  if (errors.length) return { errors, ir: null };

  const entry = entries[0];
  const reachable = reachableFrom(entry, adj);
  for (const id of ids) if (!reachable.has(id)) errors.push(`node "${id}" is unreachable from the entry`);

  for (const n of ir.nodes) {
    if (!str(n.label, 90)) errors.push(`node "${n.id}": label is required (max 90 chars)`);
    const out = new Set((adj.get(n.id) ?? []).map((e) => e.on));
    for (const need of REQUIRED_EDGES[n.kind] ?? []) if (!out.has(need)) errors.push(`node "${n.id}" (${n.kind}) needs a "${need}" edge`);
    if (!(n.kind in REQUIRED_EDGES)) { errors.push(`node "${n.id}": unknown kind "${n.kind}"`); continue; }

    const scope = guaranteedBefore(n.id, entry, ir, adj);
    const cap = n.capability ? CAPABILITIES[n.capability] : undefined;

    if (n.kind === "reason") {
      if (!str(n.question, 500)) errors.push(`node "${n.id}": reason needs a question (max 500 chars)`);
      else checkTemplate(n.question!, `node "${n.id}" question`, scope, ir, errors);
      if (!Array.isArray(n.options) || n.options.length < 2 || n.options.length > 6 || n.options.some((o) => !str(o, 40))) errors.push(`node "${n.id}": reason needs 2-6 short options`);
      for (const f of n.fields ?? []) if (!ID_RE.test(f.key) || REASON_BASE.includes(f.key) || !["string", "number", "boolean"].includes(f.type)) errors.push(`node "${n.id}": invalid field "${f.key}"`);
      if ((n.fields ?? []).length > 5) errors.push(`node "${n.id}": at most 5 fields`);
    } else if (n.kind === "decision" || (n.kind === "verify" && n.capability === "state_rule")) {
      const r = n.rule;
      if (!r || !PATH_RE.test(r.path ?? "") || !RULE_OPS.includes(r.op)) errors.push(`node "${n.id}": needs rule {path, op, value} with op in ${RULE_OPS.join("/")}`);
      else {
        const perr = checkPathRef(r.path, scope, ir);
        if (perr) errors.push(`node "${n.id}" rule path: ${perr}`);
        if (!["truthy", "falsy"].includes(r.op) && r.value === undefined) errors.push(`node "${n.id}": rule op "${r.op}" needs a value`);
        if (r.op === "in" && !Array.isArray(r.value)) errors.push(`node "${n.id}": op "in" needs an array value`);
      }
    } else if (n.kind === "approval") {
      if (!str(n.prompt, 400)) errors.push(`node "${n.id}": approval needs a prompt (max 400 chars)`);
      else checkTemplate(n.prompt!, `node "${n.id}" prompt`, scope, ir, errors);
      const t = n.timeout_minutes ?? 60;
      if (!Number.isInteger(t) || t < 1 || t > 10080) errors.push(`node "${n.id}": timeout_minutes must be 1..10080`);
    } else if (n.kind === "wait") {
      const m = Number(n.params?.minutes);
      if (!Number.isInteger(m) || m < 1 || m > 1440) errors.push(`node "${n.id}": wait needs params.minutes 1..1440`);
    } else if (n.kind === "lookup" || n.kind === "action" || n.kind === "verify") {
      if (!cap || cap.kind !== n.kind) { errors.push(`node "${n.id}": capability "${n.capability}" is not a valid ${n.kind} (valid: ${Object.entries(CAPABILITIES).filter(([, c]) => c.kind === n.kind).map(([k]) => k).join(", ")})`); continue; }
      const p = n.params ?? {};
      for (const [key, spec] of Object.entries(cap.params)) {
        const v = p[key];
        if (v === undefined || v === null || v === "") { if (spec.required) errors.push(`node "${n.id}": params.${key} is required`); continue; }
        if (spec.type === "number" && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (spec.max !== undefined && v > spec.max))) errors.push(`node "${n.id}": params.${key} must be a number`);
        if (spec.type === "enum" && !spec.values!.includes(String(v))) errors.push(`node "${n.id}": params.${key} must be one of ${spec.values!.join(", ")}`);
        if (spec.type === "path") { const e2 = typeof v === "string" && PATH_RE.test(v) ? checkPathRef(v, scope, ir) : "must look like node.field"; if (e2) errors.push(`node "${n.id}": params.${key} — ${e2}`); }
        if (spec.type === "string") {
          if (typeof v !== "string" || (spec.max !== undefined && v.length > spec.max)) errors.push(`node "${n.id}": params.${key} must be text up to ${spec.max ?? 400} chars`);
          else if (key === "target") { if (!byId.has(v) || byId.get(v)!.kind !== "action") errors.push(`node "${n.id}": params.target must be the id of an action node`); else if (!scope.has(v)) errors.push(`node "${n.id}": target "${v}" must run before this verification on every path`); }
          else checkTemplate(v, `node "${n.id}" params.${key}`, scope, ir, errors);
        }
      }
      for (const k of Object.keys(p)) if (!(k in cap.params) && n.capability !== "state_rule" && k !== "minutes") errors.push(`node "${n.id}": unknown param "${k}"`);
    }
  }

  // Commitment safety: no money/staff/third-party commitment without a human gate on EVERY path.
  const approvals = ir.nodes.filter((n) => n.kind === "approval");
  for (const n of ir.nodes) {
    if (n.kind !== "action" || !n.capability || !CAPABILITIES[n.capability]?.commitment) continue;
    const dominated = approvals.some((a) => guaranteedBefore(n.id, entry, ir, adj).has(a.id));
    if (!dominated) errors.push(`commitment action "${n.id}" (${n.capability}) must be preceded by a human_approval node on every path — add an approval before any branch that reaches it`);
  }
  for (const a of approvals) for (const g of a.gates ?? []) {
    const target = byId.get(g);
    if (!target) errors.push(`approval "${a.id}" gates unknown node "${g}"`);
    else if (!guaranteedBefore(g, entry, ir, adj).has(a.id)) errors.push(`approval "${a.id}" claims to gate "${g}" but some path reaches "${g}" without it`);
  }

  return { errors, ir: errors.length ? null : ir };
}

// ---------------------------------------------------------------------------
// Lowering: IR -> executable graph. Adds the guarantees the AI cannot forget.
//   - every failure/timeout without an explicit fallback routes to __escalate
//   - approval rejection without an explicit branch ends the run (cancelled)
// ---------------------------------------------------------------------------

export const ESCALATE_ID = "__escalate";

export function lowerIr(ir: WorkflowIr): { graph: CompiledGraph; autoEscalations: number } {
  const entry = findEntry(ir)[0];
  const nodes: CompiledGraph["nodes"] = {};
  for (const n of ir.nodes) nodes[n.id] = { ...n };
  const edges: CompiledGraph["edges"] = {};
  for (const n of ir.nodes) edges[n.id] = {};
  for (const e of ir.edges) edges[e.from][e.on] = e.to;

  let autoEscalations = 0;
  const wantsEscalate = (kind: NodeKind, on: EdgeOn) =>
    (on === "fail" && ["lookup", "reason", "action", "verify"].includes(kind)) || (on === "timeout" && kind === "approval");
  for (const n of ir.nodes) {
    for (const on of ["fail", "timeout"] as EdgeOn[]) {
      if (ALLOWED_EDGES[n.kind].includes(on) && wantsEscalate(n.kind, on) && !edges[n.id][on]) {
        edges[n.id][on] = ESCALATE_ID;
        autoEscalations++;
      }
    }
  }
  if (autoEscalations > 0) {
    nodes[ESCALATE_ID] = {
      id: ESCALATE_ID, kind: "action", capability: "notify_owner", auto: true,
      label: "Escalate to owner",
      params: { title: "Workflow needs a human", message: "A compiled workflow could not finish automatically (failure or approval timeout). Open Workflow Compiler → Runs to review the audit trail." },
    };
    edges[ESCALATE_ID] = {};
  }
  return {
    graph: { version: COMPILER_VERSION, entry, trigger_event: ir.trigger.event, sla_minutes: ir.sla_minutes ?? null, nodes, edges },
    autoEscalations,
  };
}

// ---------------------------------------------------------------------------
// Report: what the owner sees before turning anything on.
// ---------------------------------------------------------------------------

export interface CompileReport {
  ok: boolean;
  node_count: number;
  stages: Record<"trigger" | "conditions" | "reasoning" | "lookups" | "decisions" | "actions" | "approvals" | "fallbacks" | "verifications" | "audit", number>;
  commitment_actions: number;
  customer_facing_actions: number;
  approvals: number;
  auto_escalations: number;
  explicit_fallbacks: number;
  has_sla: boolean;
  paths: string[][];
  paths_truncated: boolean;
  warnings: string[];
}

export function enumeratePaths(graph: CompiledGraph): { paths: string[][]; truncated: boolean } {
  const paths: string[][] = [];
  let truncated = false;
  const walk = (id: string, acc: string[]) => {
    if (paths.length >= MAX_PATHS) { truncated = true; return; }
    const next = Object.values(graph.edges[id] ?? {}) as string[];
    const here = [...acc, id];
    if (next.length === 0) { paths.push(here); return; }
    for (const to of new Set(next)) walk(to, here);
  };
  walk(graph.entry, []);
  return { paths, truncated };
}

export function buildReport(ir: WorkflowIr, graph: CompiledGraph, autoEscalations: number): CompileReport {
  const kinds = ir.nodes.map((n) => n);
  const count = (f: (n: IrNode) => boolean) => kinds.filter(f).length;
  const explicitFallbacks = ir.edges.filter((e) => e.on === "fail" || e.on === "timeout" || e.on === "rejected").length;
  const { paths, truncated } = enumeratePaths(graph);
  const warnings: string[] = [];
  if (!ir.sla_minutes) warnings.push("No time limit (SLA) was stated, so nothing will flag a slow run.");
  if (autoEscalations > 0) warnings.push(`${autoEscalations} step(s) had no fallback; the compiler routed failures to "Escalate to owner" so nothing fails silently.`);
  if (count((n) => n.kind === "action" && !!n.capability && !!CAPABILITIES[n.capability]?.commitment) > 0 && count((n) => n.kind === "verify") === 0) {
    warnings.push("A commitment action has no verification step; consider confirming the outcome.");
  }
  return {
    ok: true,
    node_count: ir.nodes.length,
    stages: {
      trigger: 1,
      conditions: count((n) => n.kind === "decision"),
      reasoning: count((n) => n.kind === "reason"),
      lookups: count((n) => n.kind === "lookup"),
      decisions: count((n) => n.kind === "decision"),
      actions: count((n) => n.kind === "action"),
      approvals: count((n) => n.kind === "approval"),
      fallbacks: explicitFallbacks + autoEscalations,
      verifications: count((n) => n.kind === "verify"),
      audit: 1,
    },
    commitment_actions: count((n) => n.kind === "action" && !!n.capability && !!CAPABILITIES[n.capability]?.commitment),
    customer_facing_actions: count((n) => n.kind === "action" && !!n.capability && !!CAPABILITIES[n.capability]?.customerFacing),
    approvals: count((n) => n.kind === "approval"),
    auto_escalations: autoEscalations,
    explicit_fallbacks: explicitFallbacks,
    has_sla: !!ir.sla_minutes,
    paths,
    paths_truncated: truncated,
    warnings,
  };
}

/** Full pipeline used by the compile function. */
export function compileIr(raw: unknown):
  | { ok: true; ir: WorkflowIr; graph: CompiledGraph; report: CompileReport }
  | { ok: false; errors: string[] } {
  const { errors, ir } = validateIr(raw);
  if (!ir) return { ok: false, errors };
  const { graph, autoEscalations } = lowerIr(ir);
  return { ok: true, ir, graph, report: buildReport(ir, graph, autoEscalations) };
}

// ---------------------------------------------------------------------------
// Runtime helpers shared with the executor (pure, tested)
// ---------------------------------------------------------------------------

export function getPath(state: Record<string, unknown>, path: string): unknown {
  let cur: unknown = state;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function renderTemplate(tpl: string, state: Record<string, unknown>): string {
  return tpl.replace(TEMPLATE_RE, (_m, p: string) => {
    const v = getPath(state, p);
    if (v === undefined || v === null) return "";
    if (Array.isArray(v)) return v.join(", ");
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

export function evaluateRule(rule: Rule, state: Record<string, unknown>): boolean {
  const actual = getPath(state, rule.path);
  const v = rule.value;
  switch (rule.op) {
    case "truthy": return Boolean(actual);
    case "falsy": return !actual;
    case "eq": return String(actual).toLowerCase() === String(v).toLowerCase();
    case "neq": return String(actual).toLowerCase() !== String(v).toLowerCase();
    case "gt": return Number(actual) > Number(v);
    case "gte": return Number(actual) >= Number(v);
    case "lt": return Number(actual) < Number(v);
    case "lte": return Number(actual) <= Number(v);
    case "in": return Array.isArray(v) && v.map((x) => String(x).toLowerCase()).includes(String(actual).toLowerCase());
    case "contains": return typeof actual === "string" ? actual.toLowerCase().includes(String(v).toLowerCase()) : Array.isArray(actual) && actual.map(String).includes(String(v));
    default: return false;
  }
}

/** Phone/email masking before any state is shown to the reasoning model. */
export function maskPii(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]");
}

/** What the compile prompt tells the model it may use (generated, never hand-maintained). */
export function capabilityCatalog() {
  return Object.entries(CAPABILITIES).map(([name, c]) => ({
    name, kind: c.kind, label: c.label, outputs: c.outputs,
    params: Object.fromEntries(Object.entries(c.params).map(([k, p]) => [k, p.values ? `enum(${p.values.join("|")})` : p.type + (p.required ? " (required)" : "")])),
    commitment: !!c.commitment,
  }));
}

/**
 * Vireek Workflow Compiler — client library.
 *
 * The browser never builds or edits a graph. It sends plain language to the
 * `workflow-compiler` edge function and then only moves STATUS (via RPC) on a
 * graph that is already validated and frozen in the database.
 * See supabase/migrations/20270210000000_workflow_compiler.sql
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES (mirror supabase/functions/_shared/workflow-compiler/spec.ts)
// ============================================================

export type NodeKind = 'lookup' | 'reason' | 'decision' | 'action' | 'approval' | 'verify' | 'wait';
export type EdgeOn = 'next' | 'true' | 'false' | 'fail' | 'approved' | 'rejected' | 'timeout' | 'pass';
export type CompiledStatus = 'draft' | 'test' | 'live' | 'paused' | 'archived';
export type CompiledRunStatus = 'active' | 'waiting_approval' | 'waiting_timer' | 'completed' | 'failed' | 'cancelled';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  capability?: string;
  auto?: boolean;
}

export interface CompiledGraph {
  version: number;
  entry: string;
  trigger_event: string;
  sla_minutes: number | null;
  nodes: Record<string, GraphNode>;
  edges: Record<string, Partial<Record<EdgeOn, string>>>;
}

export interface CompileReport {
  ok: boolean;
  node_count: number;
  stages: Record<'trigger' | 'conditions' | 'reasoning' | 'lookups' | 'decisions' | 'actions' | 'approvals' | 'fallbacks' | 'verifications' | 'audit', number>;
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

export interface CompiledWorkflow {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  instruction: string;
  summary: string;
  trigger_event: string;
  sla_minutes: number | null;
  ir: { assumptions?: string[] } & Record<string, unknown>;
  graph: CompiledGraph;
  report: CompileReport;
  compiler_meta: { provider?: string; model?: string; attempts?: number };
  status: CompiledStatus;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
}

export interface CompiledRun {
  id: string;
  workflow_id: string;
  customer_name: string | null;
  mode: 'test' | 'live';
  status: CompiledRunStatus;
  current_node: string;
  state: Record<string, unknown>;
  deadline_at: string | null;
  sla_breached_at: string | null;
  stop_reason: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface CompiledApproval {
  id: string;
  run_id: string;
  workflow_id: string;
  node_id: string;
  prompt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  price_cents: number | null;
  requested_at: string;
  expires_at: string;
}

export interface AuditEvent {
  id: number;
  run_id: string;
  seq: number;
  event_type: string;
  node_id: string | null;
  detail: Record<string, unknown>;
  hash: string;
  created_at: string;
}

export const STATUS_LABEL: Record<CompiledStatus, string> = {
  draft: 'Draft', test: 'Test mode', live: 'Live', paused: 'Paused', archived: 'Archived',
};
export const STATUS_STYLE: Record<CompiledStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  test: 'bg-warning-500/10 text-warning-500',
  live: 'bg-success-500/10 text-success-500',
  paused: 'bg-bg-tertiary text-text-secondary',
  archived: 'bg-bg-tertiary text-text-secondary',
};
export const RUN_STATUS_LABEL: Record<CompiledRunStatus, string> = {
  active: 'Running', waiting_approval: 'Needs approval', waiting_timer: 'Waiting', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
};
export const RUN_STATUS_STYLE: Record<CompiledRunStatus, string> = {
  active: 'bg-accent-500/10 text-accent-500',
  waiting_approval: 'bg-warning-500/10 text-warning-500',
  waiting_timer: 'bg-bg-tertiary text-text-secondary',
  completed: 'bg-success-500/10 text-success-500',
  failed: 'bg-danger/10 text-danger',
  cancelled: 'bg-bg-tertiary text-text-secondary',
};
export const KIND_LABEL: Record<NodeKind, string> = {
  lookup: 'Data lookup', reason: 'AI reasoning', decision: 'Decision', action: 'Agent action', approval: 'Human approval', verify: 'Verification', wait: 'Wait',
};

export const TRIGGER_LABEL: Record<string, string> = {
  'call.created': 'Call received', 'call.missed': 'Call missed', 'call.emergency': 'Emergency call',
  'lead.created': 'New lead', 'job.created': 'Job created', 'job.completed': 'Job completed',
  'quote.sent': 'Quote sent', 'quote.accepted': 'Quote accepted', 'quote.declined': 'Quote declined',
  'payment.received': 'Payment received', 'review.completed': 'Review submitted',
};

export const EXAMPLE_INSTRUCTIONS: { label: string; text: string }[] = [
  {
    label: 'VIP HVAC emergency',
    text: 'If a VIP customer calls with an HVAC emergency and a breakdown is likely, find the best available technician within 60 minutes, confirm the price before dispatch, and if the part is not in stock check the contractor network.',
  },
  {
    label: 'Missed call recovery',
    text: 'When a call is missed, wait 5 minutes, then text the customer an apology and ask how we can help. Tell the owner if the customer is a VIP.',
  },
  {
    label: 'Declined quote rescue',
    text: 'When a quote is declined, have the owner approve a follow-up text with a goodwill message, then notify me if the customer replies.',
  },
];

// ============================================================
// API
// ============================================================

async function functionError(error: unknown, fallback: string): Promise<{ message: string; details: string[] }> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown; details?: unknown };
      return {
        message: typeof body?.error === 'string' && body.error ? body.error : fallback,
        details: Array.isArray(body?.details) ? body.details.map(String) : [],
      };
    } catch {
      /* fall through */
    }
  }
  return { message: fallback, details: [] };
}

export class CompileError extends Error {
  details: string[];
  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'CompileError';
    this.details = details;
  }
}

export async function compileWorkflow(instruction: string, parentId?: string): Promise<{ workflow: CompiledWorkflow; attempts: number }> {
  const { data, error } = await supabase.functions.invoke('workflow-compiler', { body: { instruction, parent_id: parentId ?? null } });
  if (error) {
    const e = await functionError(error, 'Could not compile this workflow. Try again shortly.');
    throw new CompileError(e.message, e.details);
  }
  if (data?.error) throw new CompileError(String(data.error), Array.isArray(data.details) ? data.details.map(String) : []);
  return data as { workflow: CompiledWorkflow; attempts: number };
}

export async function fetchCompiledWorkflows(): Promise<CompiledWorkflow[]> {
  const { data, error } = await supabase.from('compiled_workflows').select('*').neq('status', 'archived').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return (data as CompiledWorkflow[]) ?? [];
}

export async function setCompiledWorkflowStatus(id: string, status: 'test' | 'live' | 'paused' | 'archived'): Promise<CompiledWorkflow> {
  const { data, error } = await supabase.rpc('set_compiled_workflow_status', { p_id: id, p_status: status });
  if (error) throw new Error(friendlyRpcError(error.message));
  return data as CompiledWorkflow;
}

export async function startTestRun(workflowId: string, context: Record<string, unknown>, customerName: string, customerPhone: string): Promise<string> {
  const { data, error } = await supabase.rpc('start_compiled_test_run', {
    p_workflow_id: workflowId, p_context: context, p_customer_name: customerName, p_customer_phone: customerPhone,
  });
  if (error) throw new Error(friendlyRpcError(error.message));
  return data as string;
}

export async function fetchCompiledRuns(limit = 100): Promise<CompiledRun[]> {
  const { data, error } = await supabase
    .from('compiled_workflow_runs')
    .select('id, workflow_id, customer_name, mode, status, current_node, state, deadline_at, sla_breached_at, stop_reason, started_at, completed_at')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as CompiledRun[]) ?? [];
}

export async function fetchRunAudit(runId: string): Promise<AuditEvent[]> {
  const { data, error } = await supabase
    .from('compiled_workflow_audit')
    .select('id, run_id, seq, event_type, node_id, detail, hash, created_at')
    .eq('run_id', runId)
    .order('seq', { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data as AuditEvent[]) ?? [];
}

export async function verifyAuditChain(runId: string): Promise<{ ok: boolean; checked: number; first_bad_seq: number | null }> {
  const { data, error } = await supabase.rpc('verify_compiled_audit_chain', { p_run_id: runId });
  if (error) throw new Error(friendlyRpcError(error.message));
  return data as { ok: boolean; checked: number; first_bad_seq: number | null };
}

export async function cancelCompiledRun(runId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('cancel_compiled_run', { p_run_id: runId });
  if (error) return false;
  return Boolean(data);
}

export async function fetchPendingCompiledApprovals(): Promise<CompiledApproval[]> {
  const { data, error } = await supabase
    .from('compiled_workflow_approvals')
    .select('id, run_id, workflow_id, node_id, prompt, status, price_cents, requested_at, expires_at')
    .eq('status', 'pending')
    .order('requested_at', { ascending: true });
  if (error) throw error;
  return (data as CompiledApproval[]) ?? [];
}

export async function decideCompiledApproval(id: string, approve: boolean, priceCents: number | null, note: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('decide_compiled_approval', {
    p_approval_id: id, p_approve: approve, p_price_cents: priceCents, p_note: note || null,
  });
  if (error) throw new Error(friendlyRpcError(error.message));
  return Boolean(data);
}

function friendlyRpcError(message: string): string {
  if (message.includes('DRAFT_MUST_PASS_TEST_FIRST')) return 'Start it in test mode first, then promote it to live.';
  if (message.includes('ARCHIVED_IS_FINAL')) return 'Archived workflows cannot be changed.';
  if (message.includes('CONTEXT_TOO_LARGE')) return 'The sample event is too large.';
  if (message.includes('NOT_FOUND')) return 'That item no longer exists.';
  return message;
}

// ============================================================
// GRAPH LAYOUT (pure — layered top-to-bottom, longest-path layering)
// ============================================================

export const NODE_W = 176;
export const NODE_H = 54;
const GAP_X = 32;
const GAP_Y = 54;

export interface LaidOutNode { id: string; node: GraphNode; x: number; y: number }
export interface LaidOutEdge { from: string; to: string; on: EdgeOn; d: string; lx: number; ly: number }
export interface GraphLayout { nodes: LaidOutNode[]; edges: LaidOutEdge[]; width: number; height: number }

export function layoutGraph(graph: CompiledGraph): GraphLayout {
  const layerOf = new Map<string, number>();
  const order: string[] = [];
  const visit = (id: string, layer: number) => {
    if ((layerOf.get(id) ?? -1) >= layer) return;
    if (!layerOf.has(id)) order.push(id);
    layerOf.set(id, layer);
    for (const to of Object.values(graph.edges[id] ?? {})) if (to) visit(to, layer + 1);
  };
  visit(graph.entry, 0);

  const layers: string[][] = [];
  for (const id of order) (layers[layerOf.get(id)!] ??= []).push(id);
  const maxCols = Math.max(1, ...layers.map((l) => l?.length ?? 0));
  const width = maxCols * (NODE_W + GAP_X) - GAP_X;
  const height = layers.length * (NODE_H + GAP_Y) - GAP_Y;

  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((ids, li) => {
    const rowW = ids.length * (NODE_W + GAP_X) - GAP_X;
    const startX = (width - rowW) / 2;
    ids.forEach((id, i) => pos.set(id, { x: startX + i * (NODE_W + GAP_X), y: li * (NODE_H + GAP_Y) }));
  });

  const nodes: LaidOutNode[] = order.map((id) => ({ id, node: graph.nodes[id], x: pos.get(id)!.x, y: pos.get(id)!.y }));
  const edges: LaidOutEdge[] = [];
  for (const [from, outs] of Object.entries(graph.edges)) {
    for (const [on, to] of Object.entries(outs)) {
      const a = pos.get(from);
      const b = to ? pos.get(to) : undefined;
      if (!a || !b || !to) continue;
      const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H, x2 = b.x + NODE_W / 2, y2 = b.y;
      const my = (y1 + y2) / 2;
      edges.push({ from, to, on: on as EdgeOn, d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`, lx: (x1 + x2) / 2, ly: my });
    }
  }
  return { nodes, edges, width, height };
}

export function formatCents(cents: number | null): string {
  return cents === null ? '—' : `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// src/lib/workflowInsights.ts
//
// Pure helpers behind the workflow inspector: version lineage, run overlay, accessible outline order.
// No React, no network. The heavy analytics live in supabase/functions/_shared/workflow-compiler/run-analytics.ts.
import type { AuditEvent, CompiledGraph } from './workflowCompiler';

export type NodeState = 'active' | 'waiting' | 'done' | 'failed';
export const NODE_STATE_LABEL: Record<NodeState, string> = { active: 'running', waiting: 'waiting', done: 'done', failed: 'failed' };

const FAIL_EDGES = new Set(['fail', 'rejected', 'timeout']);

/** Node states after replaying audit events up to (and including) `upToSeq`. Parallel branches may be active together. */
export function overlayFromAudit(events: readonly AuditEvent[], upToSeq = Infinity): Map<string, NodeState> {
  const state = new Map<string, NodeState>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.seq > upToSeq || !e.node_id) continue;
    switch (e.event_type) {
      case 'node_started': state.set(e.node_id, 'active'); break;
      case 'approval_requested':
      case 'timer_set': state.set(e.node_id, 'waiting'); break;
      case 'edge_taken': state.set(e.node_id, FAIL_EDGES.has(String(e.detail?.edge)) ? 'failed' : 'done'); break;
      case 'node_failed':
      case 'engine_error':
      case 'action_outcome_unknown': state.set(e.node_id, 'failed'); break;
      case 'node_completed': if (state.get(e.node_id) !== 'failed') state.set(e.node_id, 'done'); break;
    }
  }
  return state;
}

export interface VersionRef { id: string; parent_id: string | null; created_at: string }

/** Every version in the same family as `id` (ancestors, siblings, descendants), oldest first. Cycle-safe. */
export function lineageOf<T extends VersionRef>(all: readonly T[], id: string): T[] {
  const byId = new Map(all.map((v) => [v.id, v]));
  if (!byId.has(id)) return [];
  let root = id;
  const seen = new Set<string>();
  while (!seen.has(root)) {
    seen.add(root);
    const p = byId.get(root)?.parent_id;
    if (!p || !byId.has(p)) break;
    root = p;
  }
  const family = new Set<string>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const v of all) if (v.parent_id && family.has(v.parent_id) && !family.has(v.id)) { family.add(v.id); grew = true; }
  }
  return all.filter((v) => family.has(v.id)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export interface OutlineStep { id: string; edges: { on: string; to: string }[] }

/** Breadth-first order from the entry node; nodes never reached (fan-out bodies, undo steps) are listed separately. */
export function outlineOrder(graph: Pick<CompiledGraph, 'entry' | 'nodes' | 'edges'>): { main: OutlineStep[]; side: string[] } {
  const main: OutlineStep[] = [];
  const seen = new Set<string>();
  const queue = [graph.entry];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id) || !graph.nodes[id]) continue;
    seen.add(id);
    const edges = Object.entries(graph.edges[id] ?? {}).filter(([, to]) => !!to).map(([on, to]) => ({ on, to: to as string }));
    main.push({ id, edges });
    for (const e of edges) queue.push(e.to);
  }
  return { main, side: Object.keys(graph.nodes).filter((id) => !seen.has(id)).sort() };
}

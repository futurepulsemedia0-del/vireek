/**
 * Vireek Service Graph — client library.
 *
 * A persistent graph that links Customer, Property, Equipment, Failure,
 * Technician, Part, Job, Outcome, Warranty, Vendor, Call and Payment, and
 * grows automatically with every job (database triggers keep it in sync).
 *
 * Reasoning is transparent: every insight is a plain aggregation over graph
 * edges, and the equipment risk formula is fixed and exported below.
 *
 * Server counterpart: supabase/migrations/20261231000000_service_graph.sql
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type GraphNodeType =
  | 'customer' | 'property' | 'equipment' | 'failure' | 'technician' | 'part' | 'job'
  | 'outcome' | 'warranty' | 'vendor' | 'call' | 'payment' | 'contractor' | 'knowledge' | 'agent';

export interface GraphNode {
  id: string;
  node_key: string;
  node_type: GraphNodeType;
  label: string;
  properties: Record<string, unknown>;
  is_root?: boolean;
  degree?: number;
  updated_at?: string;
}

export interface GraphEdge {
  id: string;
  from_node: string;
  to_node: string;
  relation: string;
  source: 'system' | 'staff' | 'ai';
  evidence: Record<string, unknown>;
  last_seen_at: string;
}

export interface Neighborhood {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface GraphStats {
  nodes_by_type: Partial<Record<GraphNodeType, number>>;
  node_count: number;
  edge_count: number;
  jobs_in_graph: number;
  jobs_total: number;
  last_updated: string | null;
}

export interface FailurePattern {
  node_id: string;
  label: string;
  category: string | null;
  jobs: number;
  callbacks: number;
  parts: string[];
}

export interface PartSignal {
  node_id: string;
  label: string;
  used_in_jobs: number;
  failure_jobs: number;
  failure_rate: number | null;
}

export interface TechnicianSignal {
  node_id: string;
  label: string;
  jobs_handled: number;
  callbacks: number;
  callback_rate: number | null;
}

export interface EquipmentGroup {
  make: string;
  model: string;
  equipment_type: string;
  units: number;
  failed_units: number;
  failure_rate: number;
}

export interface EquipmentRisk {
  node_id: string;
  label: string;
  make: string;
  model: string;
  equipment_type: string;
  sample_size: number;
  group_failure_rate: number | null;
  age_ratio: number;
  own_failures: number;
  risk_score: number;
}

export interface GraphInsights {
  failure_patterns: FailurePattern[];
  part_signals: PartSignal[];
  technician_signals: TechnicianSignal[];
  equipment_groups: EquipmentGroup[];
  equipment_risk: EquipmentRisk[];
  generated_at: string;
}

// ============================================================
// LABELS / VISUALS
// ============================================================

export const NODE_TYPES: GraphNodeType[] = [
  'customer', 'property', 'equipment', 'failure', 'technician', 'part', 'job',
  'outcome', 'warranty', 'vendor', 'call', 'payment', 'contractor', 'knowledge', 'agent',
];

export const NODE_LABELS: Record<GraphNodeType, string> = {
  customer: 'Customer',
  property: 'Property',
  equipment: 'Equipment',
  failure: 'Failure',
  technician: 'Technician',
  part: 'Part',
  job: 'Job',
  outcome: 'Outcome',
  warranty: 'Warranty',
  vendor: 'Vendor',
  call: 'Call',
  payment: 'Payment',
  contractor: 'Contractor',
  knowledge: 'Knowledge',
  agent: 'Agent',
};

export const NODE_COLORS: Record<GraphNodeType, string> = {
  customer: '#3b82f6',
  property: '#14b8a6',
  equipment: '#f59e0b',
  failure: '#ef4444',
  technician: '#8b5cf6',
  part: '#ec4899',
  job: '#64748b',
  outcome: '#22c55e',
  warranty: '#06b6d4',
  vendor: '#a855f7',
  call: '#0ea5e9',
  payment: '#84cc16',
  contractor: '#f97316',
  knowledge: '#6366f1',
  agent: '#d946ef',
};

const RELATION_LABELS: Record<string, string> = {
  has_property: 'has property',
  owns_equipment: 'owns equipment',
  has_equipment: 'has equipment',
  requested: 'requested',
  performed_at: 'performed at',
  handled_by: 'handled by',
  originated: 'originated',
  billed_as: 'billed as',
  used_part: 'used part',
  requires_part: 'requires part',
  serviced: 'serviced',
  installed: 'installed',
  covered_by: 'covered by',
  has_claim: 'has claim',
  claimed_under: 'claimed under',
  diagnosed: 'diagnosed',
  affects: 'affects',
  caused_by_part: 'caused by part',
  led_to_callback: 'led to callback',
  resulted_in: 'resulted in',
  supplied_by: 'supplied by',
};

export function relationLabel(relation: string): string {
  return RELATION_LABELS[relation] ?? relation.replace(/_/g, ' ');
}

/** Equipment risk formula — mirrors service_graph_insights() in SQL. */
export const RISK_WEIGHTS = { group: 0.6, age: 0.25, own: 0.15 } as const;
export const MIN_GROUP_SAMPLE = 3;

export type RiskTier = 'high' | 'medium' | 'low';

export function riskTier(score: number): RiskTier {
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

export const RISK_COLORS: Record<RiskTier, string> = {
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

export const FAILURE_CODE_SUGGESTIONS: string[] = [
  'misdiagnosis', 'incomplete_repair', 'defective_part', 'wrong_part_installed',
  'installation_error', 'missed_related_issue', 'capacitor_failure', 'refrigerant_leak',
  'compressor_failure', 'blower_motor_failure', 'igniter_failure', 'control_board_failure',
  'thermostat_fault', 'clogged_drain', 'frozen_coil', 'breaker_tripping',
];

export function pct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ============================================================
// API
// ============================================================

export async function fetchGraphStats(): Promise<GraphStats> {
  const { data, error } = await supabase.rpc('service_graph_stats');
  if (error) throw error;
  return data as GraphStats;
}

export async function fetchGraphInsights(): Promise<GraphInsights> {
  const { data, error } = await supabase.rpc('service_graph_insights');
  if (error) throw error;
  return data as GraphInsights;
}

export async function searchGraphNodes(
  query: string,
  type: GraphNodeType | null = null,
  limit = 20,
): Promise<GraphNode[]> {
  const { data, error } = await supabase.rpc('service_graph_search', {
    p_query: query.trim() || null,
    p_type: type,
    p_limit: limit,
  });
  if (error) throw error;
  return (data as GraphNode[] | null) ?? [];
}

export async function fetchNeighborhood(nodeId: string, depth = 2): Promise<Neighborhood> {
  const { data, error } = await supabase.rpc('service_graph_neighborhood', {
    p_node_id: nodeId,
    p_depth: depth,
  });
  if (error) throw error;
  return data as Neighborhood;
}

export async function recordGraphFailure(input: {
  jobId: string;
  failureCode: string;
  equipmentId?: string | null;
  partId?: string | null;
  note?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc('record_service_graph_failure', {
    p_job_id: input.jobId,
    p_failure_code: input.failureCode,
    p_equipment_id: input.equipmentId ?? null,
    p_part_id: input.partId ?? null,
    p_note: input.note?.trim() || null,
  });
  if (error) throw error;
  return data as string;
}

export type RebuildPhase = 'customers' | 'equipment' | 'jobs';

export const REBUILD_PHASE_LABELS: Record<RebuildPhase, string> = {
  customers: 'Customers',
  equipment: 'Equipment',
  jobs: 'Jobs',
};

const REBUILD_BATCH = 200;
const REBUILD_MAX_BATCHES = 500;

/** Backfills the graph from existing records, page by page. Returns records processed. */
export async function rebuildServiceGraph(
  onProgress?: (progress: { phase: RebuildPhase; done: number }) => void,
): Promise<number> {
  const phases: RebuildPhase[] = ['customers', 'equipment', 'jobs'];
  let total = 0;
  for (const phase of phases) {
    let offset = 0;
    for (let i = 0; i < REBUILD_MAX_BATCHES; i++) {
      const { data, error } = await supabase.rpc('rebuild_service_graph', {
        p_phase: phase,
        p_offset: offset,
        p_limit: REBUILD_BATCH,
      });
      if (error) throw error;
      const res = data as { processed: number; has_more: boolean };
      total += res.processed;
      onProgress?.({ phase, done: total });
      if (!res.has_more) break;
      offset += REBUILD_BATCH;
    }
  }
  return total;
}

// ============================================================
// PURE HELPERS (layout + connections)
// ============================================================

export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
  depth: number;
}

/** Concentric elliptical layout: root in the centre, one ring per hop. */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  rootId: string,
  width: number,
  height: number,
): PositionedNode[] {
  const adjacency = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const list = adjacency.get(a);
    if (list) list.push(b);
    else adjacency.set(a, [b]);
  };
  for (const e of edges) {
    link(e.from_node, e.to_node);
    link(e.to_node, e.from_node);
  }

  const depth = new Map<string, number>([[rootId, 0]]);
  const queue: string[] = [rootId];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const d = depth.get(id) ?? 0;
    for (const nb of adjacency.get(id) ?? []) {
      if (!depth.has(nb)) {
        depth.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }

  let reachableMax = 0;
  depth.forEach((d) => {
    if (d > reachableMax) reachableMax = d;
  });

  const rings = new Map<number, GraphNode[]>();
  let maxRing = 0;
  for (const n of nodes) {
    const d = depth.get(n.id) ?? reachableMax + 1;
    if (d > maxRing) maxRing = d;
    const ring = rings.get(d);
    if (ring) ring.push(n);
    else rings.set(d, [n]);
  }

  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2 - 80;
  const ry = height / 2 - 44;
  const result: PositionedNode[] = [];

  rings.forEach((ringNodes, d) => {
    const sorted = [...ringNodes].sort(
      (a, b) => a.node_type.localeCompare(b.node_type) || a.label.localeCompare(b.label),
    );
    sorted.forEach((n, i) => {
      if (d === 0) {
        result.push({ ...n, x: cx, y: cy, depth: 0 });
        return;
      }
      const scale = maxRing > 0 ? d / maxRing : 0;
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / sorted.length + d * 0.4;
      result.push({
        ...n,
        x: cx + rx * scale * Math.cos(angle),
        y: cy + ry * scale * Math.sin(angle),
        depth: d,
      });
    });
  });

  return result;
}

export interface Connection {
  edge: GraphEdge;
  other: GraphNode;
  outgoing: boolean;
}

export function connectionsOf(nodeId: string, nodes: GraphNode[], edges: GraphEdge[]): Connection[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const list: Connection[] = [];
  for (const edge of edges) {
    if (edge.from_node !== nodeId && edge.to_node !== nodeId) continue;
    const outgoing = edge.from_node === nodeId;
    const other = byId.get(outgoing ? edge.to_node : edge.from_node);
    if (other) list.push({ edge, other, outgoing });
  }
  return list.sort(
    (a, b) => a.edge.relation.localeCompare(b.edge.relation) || a.other.label.localeCompare(b.other.label),
  );
}

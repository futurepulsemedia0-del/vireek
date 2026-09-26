/**
 * Business World Model — client library.
 *
 * A single, live graph over entities that already exist across the app
 * (customers, jobs, equipment, quotes, calls, team members) — NOT a new
 * copy of that data. Customer Memory, Equipment, and the Event Bus each
 * know about one slice of the business; this assembles all of them into
 * one typed node/edge graph with a "since" timestamp on every edge, so
 * you can ask "what's connected to this, and in what order did it
 * happen" across the whole business instead of one table at a time.
 *
 * "Property" has no table of its own yet — it's derived here from
 * distinct customer/job addresses, marked `derived: true` on the node.
 *
 * Server counterpart for the one thing that genuinely needs storage —
 * causal edges — lives in src/lib/causalGraph.ts and
 * supabase/migrations/20261204000000_business_causal_graph.sql.
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export type NodeType =
  | 'customer'
  | 'property'
  | 'asset'
  | 'job'
  | 'technician'
  | 'invoice'
  | 'communication'
  | 'event';

export interface WorldNode {
  /** `${type}:${id}` — globally unique within the graph */
  key: string;
  type: NodeType;
  id: string;
  label: string;
  subtitle?: string;
  /** representative point in time, for chronological ordering */
  at: string | null;
  status?: string | null;
  derived?: boolean;
  /** lightweight computed signal other modules (e.g. causalGraph.ts) key off of */
  flag?: 'overdue_maintenance';
}

export type EdgeRelation =
  | 'lives_at'
  | 'requested'
  | 'serviced_at'
  | 'assigned_to'
  | 'involves'
  | 'installed_at'
  | 'contacted_via'
  | 'led_to'
  | 'quoted'
  | 'generated';

export interface WorldEdge {
  id: string;
  source: string; // node key
  target: string; // node key
  relation: EdgeRelation;
  at: string | null;
}

export interface WorldModel {
  nodes: WorldNode[];
  edges: WorldEdge[];
  nodesByKey: Map<string, WorldNode>;
}

// ============================================================
// FETCH — one narrow, bounded query per entity
// ============================================================

const LIMIT = 300;

async function fetchCustomers() {
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, phone, email, address, lifecycle_stage, created_at')
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (error) throw error;
  return data ?? [];
}

async function fetchJobs() {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, customer_id, customer_name, service_type, address, scheduled_datetime, assigned_technician_id, job_status, invoice_amount, invoice_status, call_id, created_at')
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (error) throw error;
  return data ?? [];
}

async function fetchEquipment() {
  const { data, error } = await supabase
    .from('equipment')
    .select('id, customer_id, equipment_type, make, model, install_job_id, status, install_date, last_service_date, service_interval_months, created_at')
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (error) throw error;
  return data ?? [];
}

async function fetchJobEquipmentLinks() {
  const { data, error } = await supabase.from('job_equipment').select('job_id, equipment_id, created_at').limit(LIMIT * 2);
  if (error) throw error;
  return data ?? [];
}

async function fetchCalls() {
  const { data, error } = await supabase
    .from('calls')
    .select('id, customer_id, caller_name, caller_phone, is_emergency, status, call_datetime, created_at')
    .order('call_datetime', { ascending: false })
    .limit(LIMIT);
  if (error) throw error;
  return data ?? [];
}

async function fetchQuotes() {
  const { data, error } = await supabase
    .from('quotes')
    .select('id, lead_id, customer_name, customer_phone, customer_email, status, sent_at, responded_at, created_at')
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (error) throw error;
  return data ?? [];
}

async function fetchTechnicians() {
  const { data, error } = await supabase.from('team_members').select('id, member_name, member_email, role').limit(LIMIT);
  if (error) throw error;
  return data ?? [];
}

// ============================================================
// ASSEMBLE
// ============================================================

function normalizeAddress(a: string | null | undefined): string | null {
  if (!a) return null;
  const trimmed = a.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

let edgeSeq = 0;
function edge(source: string, target: string, relation: EdgeRelation, at: string | null): WorldEdge {
  edgeSeq += 1;
  return { id: `e${edgeSeq}`, source, target, relation, at };
}

export async function buildWorldModel(): Promise<WorldModel> {
  edgeSeq = 0;
  const [customers, jobs, equipment, jobEquipmentLinks, calls, quotes, technicians] = await Promise.all([
    fetchCustomers(),
    fetchJobs(),
    fetchEquipment(),
    fetchJobEquipmentLinks(),
    fetchCalls(),
    fetchQuotes(),
    fetchTechnicians(),
  ]);

  const nodes: WorldNode[] = [];
  const edges: WorldEdge[] = [];
  const propertyKeyByAddress = new Map<string, string>();

  const propertyNode = (address: string | null | undefined, seenAt: string | null): string | null => {
    const norm = normalizeAddress(address);
    if (!norm) return null;
    let key = propertyKeyByAddress.get(norm);
    if (!key) {
      key = `property:${norm}`;
      propertyKeyByAddress.set(norm, key);
      nodes.push({ key, type: 'property', id: norm, label: address!.trim(), at: seenAt, derived: true });
    }
    return key;
  };

  // Customers
  const customerKeyById = new Map<string, string>();
  for (const c of customers) {
    const key = `customer:${c.id}`;
    customerKeyById.set(c.id, key);
    nodes.push({ key, type: 'customer', id: c.id, label: c.name, subtitle: c.lifecycle_stage, at: c.created_at, status: c.lifecycle_stage });
    const propKey = propertyNode(c.address, c.created_at);
    if (propKey) edges.push(edge(key, propKey, 'lives_at', c.created_at));
  }

  // Technicians
  const techKeyById = new Map<string, string>();
  for (const t of technicians) {
    const key = `technician:${t.id}`;
    techKeyById.set(t.id, key);
    nodes.push({ key, type: 'technician', id: t.id, label: t.member_name || t.member_email, subtitle: t.role, at: null });
  }

  // Calls (communications)
  const callKeyById = new Map<string, string>();
  for (const call of calls) {
    const key = `communication:${call.id}`;
    callKeyById.set(call.id, key);
    nodes.push({
      key,
      type: 'communication',
      id: call.id,
      label: call.caller_name || call.caller_phone || 'Call',
      subtitle: call.is_emergency ? 'Emergency call' : call.status,
      at: call.call_datetime ?? call.created_at,
      status: call.status,
    });
    const custKey = call.customer_id ? customerKeyById.get(call.customer_id) : null;
    if (custKey) edges.push(edge(custKey, key, 'contacted_via', call.call_datetime ?? call.created_at));
  }

  // Jobs
  const jobKeyById = new Map<string, string>();
  for (const job of jobs) {
    const key = `job:${job.id}`;
    jobKeyById.set(job.id, key);
    nodes.push({
      key,
      type: 'job',
      id: job.id,
      label: job.service_type ? `${job.service_type} — ${job.customer_name}` : job.customer_name,
      subtitle: job.job_status,
      at: job.scheduled_datetime ?? job.created_at,
      status: job.job_status,
    });

    const custKey = job.customer_id ? customerKeyById.get(job.customer_id) : null;
    if (custKey) edges.push(edge(custKey, key, 'requested', job.created_at));

    const propKey = propertyNode(job.address, job.created_at);
    if (propKey) edges.push(edge(propKey, key, 'serviced_at', job.created_at));

    if (job.assigned_technician_id) {
      const techKey = techKeyById.get(job.assigned_technician_id);
      if (techKey) edges.push(edge(key, techKey, 'assigned_to', job.created_at));
    }

    if (job.call_id) {
      const callKey = callKeyById.get(job.call_id);
      if (callKey) edges.push(edge(callKey, key, 'led_to', job.created_at));
    }

    if (job.job_status === 'completed') {
      const evtKey = `event:job-completed:${job.id}`;
      nodes.push({ key: evtKey, type: 'event', id: `job-completed:${job.id}`, label: 'Job completed', at: job.created_at });
      edges.push(edge(key, evtKey, 'generated', job.created_at));
    }
  }

  // Equipment (assets)
  const equipmentKeyById = new Map<string, string>();
  for (const eq of equipment) {
    const key = `asset:${eq.id}`;
    equipmentKeyById.set(eq.id, key);
    const lastService = eq.last_service_date ?? eq.install_date;
    let overdue = false;
    if (eq.status === 'active' && lastService && eq.service_interval_months) {
      const dueDate = new Date(lastService);
      dueDate.setMonth(dueDate.getMonth() + eq.service_interval_months);
      overdue = dueDate.getTime() < Date.now();
    }
    nodes.push({
      key,
      type: 'asset',
      id: eq.id,
      label: [eq.make, eq.model].filter(Boolean).join(' ') || eq.equipment_type,
      subtitle: eq.equipment_type,
      at: eq.install_date ?? eq.created_at,
      status: eq.status,
      flag: overdue ? 'overdue_maintenance' : undefined,
    });
    const custKey = eq.customer_id ? customerKeyById.get(eq.customer_id) : null;
    if (custKey) edges.push(edge(custKey, key, 'involves', eq.install_date ?? eq.created_at));
    if (eq.install_job_id) {
      const jobKey = jobKeyById.get(eq.install_job_id);
      if (jobKey) {
        edges.push(edge(jobKey, key, 'involves', eq.install_date ?? eq.created_at));
        // installed at whatever property that job was for
        const installJob = jobs.find((j) => j.id === eq.install_job_id);
        const propKey = installJob ? propertyNode(installJob.address, eq.install_date ?? eq.created_at) : null;
        if (propKey) edges.push(edge(key, propKey, 'installed_at', eq.install_date ?? eq.created_at));
      }
    }
  }
  for (const link of jobEquipmentLinks) {
    const jobKey = jobKeyById.get(link.job_id);
    const eqKey = equipmentKeyById.get(link.equipment_id);
    if (jobKey && eqKey) edges.push(edge(jobKey, eqKey, 'involves', link.created_at));
  }

  // Quotes (invoices — the closest existing entity to "invoice")
  for (const q of quotes) {
    const key = `invoice:${q.id}`;
    nodes.push({
      key,
      type: 'invoice',
      id: q.id,
      label: `Quote — ${q.customer_name}`,
      subtitle: q.status,
      at: q.sent_at ?? q.created_at,
      status: q.status,
    });
    // Best-effort identity match: exact phone or email against a known customer
    const matchedCustomer = customers.find(
      (c) => (q.customer_phone && c.phone === q.customer_phone) || (q.customer_email && c.email === q.customer_email)
    );
    if (matchedCustomer) {
      const custKey = customerKeyById.get(matchedCustomer.id);
      if (custKey) edges.push(edge(custKey, key, 'quoted', q.sent_at ?? q.created_at));
    }

    if (q.status === 'sent' || q.status === 'accepted') {
      const evtKey = `event:quote-${q.status}:${q.id}`;
      nodes.push({ key: evtKey, type: 'event', id: `quote-${q.status}:${q.id}`, label: `Quote ${q.status}`, at: q.status === 'accepted' ? q.responded_at : q.sent_at });
      edges.push(edge(key, evtKey, 'generated', q.status === 'accepted' ? q.responded_at : q.sent_at));
    }
  }

  const nodesByKey = new Map(nodes.map((n) => [n.key, n]));
  return { nodes, edges, nodesByKey };
}

export const NODE_TYPE_LABELS: Record<NodeType, string> = {
  customer: 'Customer',
  property: 'Property',
  asset: 'Asset',
  job: 'Job',
  technician: 'Technician',
  invoice: 'Invoice',
  communication: 'Communication',
  event: 'Event',
};

export const EDGE_RELATION_LABELS: Record<EdgeRelation, string> = {
  lives_at: 'lives at',
  requested: 'requested',
  serviced_at: 'serviced at',
  assigned_to: 'assigned to',
  involves: 'involves',
  installed_at: 'installed at',
  contacted_via: 'contacted via',
  led_to: 'led to',
  quoted: 'quoted',
  generated: 'generated',
};

export const NODE_TYPE_ORDER: NodeType[] = [
  'customer',
  'property',
  'communication',
  'invoice',
  'job',
  'asset',
  'technician',
  'event',
];

/** Every edge touching a given node, both directions. */
export function neighborhood(model: WorldModel, key: string): { edges: WorldEdge[]; nodes: WorldNode[] } {
  const edges = model.edges.filter((e) => e.source === key || e.target === key);
  const keys = new Set<string>();
  edges.forEach((e) => {
    keys.add(e.source === key ? e.target : e.source);
  });
  const nodes = Array.from(keys)
    .map((k) => model.nodesByKey.get(k))
    .filter((n): n is WorldNode => !!n);
  return { edges, nodes };
}

/** All nodes/edges touching `key`, walked out `depth` hops — for the graph view. */
export function subgraph(model: WorldModel, key: string, depth = 1): { nodes: WorldNode[]; edges: WorldEdge[] } {
  const visited = new Set<string>([key]);
  let frontier = [key];
  const edgesOut: WorldEdge[] = [];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const k of frontier) {
      const { edges: es } = neighborhood(model, k);
      for (const e of es) {
        edgesOut.push(e);
        const other = e.source === k ? e.target : e.source;
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  const nodes = Array.from(visited)
    .map((k) => model.nodesByKey.get(k))
    .filter((n): n is WorldNode => !!n);
  const seenEdgeIds = new Set<string>();
  const edges = edgesOut.filter((e) => (seenEdgeIds.has(e.id) ? false : (seenEdgeIds.add(e.id), true)));
  return { nodes, edges };
}

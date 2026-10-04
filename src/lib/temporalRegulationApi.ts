import { supabase } from '@/lib/supabase';
import type {
  EdgeType,
  Jurisdiction,
  JurisdictionLevel,
  JobRegulationContext,
  RecordSnapshotResult,
  RegulationEdge,
  RegulationKind,
  RegulationNode,
  RegulationVersion,
  ResolveResult,
  SnapshotReport,
  SourceType,
  VersionRequirement,
} from '@/lib/temporalRegulation';

/**
 * Temporal Regulation Graph — data access.
 * Reads go through RLS-scoped selects / read RPCs; every write is a validated SECURITY DEFINER RPC
 * (see supabase/migrations/20270301000000_temporal_regulation_graph.sql). Nothing here can rewrite
 * history: versions and snapshots are append-only on the server.
 */

/** RPCs raise short, user-safe messages; anything else gets the generic fallback. */
function rpcMessage(error: { message?: string } | null, fallback: string): string {
  const m = error?.message ?? '';
  return m && m.length < 200 && !/relation|column|function|syntax|permission denied|violates/i.test(m) ? m : fallback;
}

// ------------------------------------------------------------------ reads

export async function fetchJurisdictions(): Promise<Jurisdiction[]> {
  const { data, error } = await supabase
    .from('regulation_jurisdictions')
    .select('id, owner_id, parent_id, level, code, name, depth')
    .order('depth', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw new Error(rpcMessage(error, 'Could not load jurisdictions.'));
  return (data ?? []) as Jurisdiction[];
}

export async function fetchNodes(): Promise<RegulationNode[]> {
  const { data, error } = await supabase
    .from('regulation_nodes')
    .select('id, owner_id, jurisdiction_id, kind, key, title, authority, work_types, description, created_at')
    .order('kind', { ascending: true })
    .order('key', { ascending: true })
    .limit(2000);
  if (error) throw new Error(rpcMessage(error, 'Could not load regulations.'));
  return (data ?? []) as RegulationNode[];
}

export async function fetchVersions(nodeId: string): Promise<RegulationVersion[]> {
  const { data, error } = await supabase
    .from('regulation_versions')
    .select(
      'id, owner_id, node_id, version_no, label, effective_from, expires_on, is_repeal, title, summary, requirements, citation, source_url, source_type, retrieved_on, verification_status, verified_at, corrects_id, recorded_at, retracted_at, retracted_reason, content_hash',
    )
    .eq('node_id', nodeId)
    .order('effective_from', { ascending: false })
    .order('recorded_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(rpcMessage(error, 'Could not load versions.'));
  return (data ?? []) as RegulationVersion[];
}

export async function fetchEdges(): Promise<RegulationEdge[]> {
  const { data, error } = await supabase
    .from('regulation_edges')
    .select('id, owner_id, from_node_id, to_node_id, edge_type, valid_from, valid_to, note, recorded_at, retracted_at')
    .is('retracted_at', null)
    .order('valid_from', { ascending: false })
    .limit(2000);
  if (error) throw new Error(rpcMessage(error, 'Could not load links.'));
  return (data ?? []) as RegulationEdge[];
}

/** Time travel: what was in force on `asOf`, as known at `knownAt` (default: now). */
export async function resolveRegulations(args: {
  jurisdictionId: string;
  asOf: string;
  knownAt?: string | null;
  workTypes?: string[];
}): Promise<ResolveResult> {
  const { data, error } = await supabase.rpc('regulation_resolve', {
    p_jurisdiction_id: args.jurisdictionId,
    p_as_of: args.asOf,
    p_known_at: args.knownAt || null,
    p_work_types: args.workTypes ?? [],
  });
  if (error) throw new Error(rpcMessage(error, 'Could not resolve regulations for that date.'));
  return data as ResolveResult;
}

export async function fetchJobRegulationContext(jobId: string): Promise<JobRegulationContext> {
  const { data, error } = await supabase.rpc('regulation_job_context', { p_job_id: jobId });
  if (error) throw new Error(rpcMessage(error, 'Could not load this job’s regulatory context.'));
  return data as JobRegulationContext;
}

export async function fetchSnapshotReport(jobId: string, limit = 10): Promise<SnapshotReport> {
  const { data, error } = await supabase.rpc('regulation_snapshot_report', { p_job_id: jobId, p_limit: limit });
  if (error) throw new Error(rpcMessage(error, 'Could not load the regulation record.'));
  return data as SnapshotReport;
}

// ------------------------------------------------------------------ writes

export async function recordJobSnapshot(args: {
  jobId: string;
  jurisdictionId: string;
  asOf: string;
  reason?: string;
  basis?: 'scheduled' | 'today' | 'manual';
}): Promise<RecordSnapshotResult> {
  const { data, error } = await supabase.rpc('regulation_record_job_snapshot', {
    p_job_id: args.jobId,
    p_jurisdiction_id: args.jurisdictionId,
    p_as_of: args.asOf,
    p_reason: args.reason?.trim() || null,
    p_basis: args.basis ?? 'manual',
  });
  if (error) throw new Error(rpcMessage(error, 'Could not record the regulation snapshot.'));
  return data as RecordSnapshotResult;
}

export async function addJurisdiction(args: {
  parentId: string;
  level: JurisdictionLevel;
  name: string;
}): Promise<Jurisdiction> {
  const { data, error } = await supabase.rpc('regulation_add_jurisdiction', {
    p_parent_id: args.parentId,
    p_level: args.level,
    p_name: args.name.trim(),
  });
  if (error) throw new Error(rpcMessage(error, 'Could not add the jurisdiction.'));
  return data as Jurisdiction;
}

export async function addNode(args: {
  jurisdictionId: string;
  kind: RegulationKind;
  key: string;
  title: string;
  authority?: string;
  workTypes?: string[];
  description?: string;
}): Promise<RegulationNode> {
  const { data, error } = await supabase.rpc('regulation_add_node', {
    p_jurisdiction_id: args.jurisdictionId,
    p_kind: args.kind,
    p_key: args.key,
    p_title: args.title,
    p_authority: args.authority?.trim() || null,
    p_work_types: args.workTypes ?? [],
    p_description: args.description?.trim() || null,
  });
  if (error) throw new Error(rpcMessage(error, 'Could not add the regulation.'));
  return data as RegulationNode;
}

export async function addVersion(args: {
  nodeId: string;
  effectiveFrom: string;
  isRepeal: boolean;
  expiresOn?: string;
  title?: string;
  summary?: string;
  requirements: VersionRequirement[];
  citation?: string;
  sourceUrl?: string;
  sourceType: SourceType;
  retrievedOn?: string;
  label?: string;
  correctsId?: string | null;
}): Promise<RegulationVersion> {
  const { data, error } = await supabase.rpc('regulation_add_version', {
    p_node_id: args.nodeId,
    p_effective_from: args.effectiveFrom,
    p_is_repeal: args.isRepeal,
    p_expires_on: args.expiresOn || null,
    p_title: args.title?.trim() || null,
    p_summary: args.summary?.trim() || null,
    p_requirements: args.requirements,
    p_citation: args.citation?.trim() || null,
    p_source_url: args.sourceUrl?.trim() || null,
    p_source_type: args.sourceType,
    p_retrieved_on: args.retrievedOn || null,
    p_label: args.label?.trim() || null,
    p_corrects_id: args.correctsId ?? null,
  });
  if (error) throw new Error(rpcMessage(error, 'Could not record this version.'));
  return data as RegulationVersion;
}

export async function retractVersion(versionId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('regulation_retract_version', {
    p_version_id: versionId,
    p_reason: reason,
  });
  if (error) throw new Error(rpcMessage(error, 'Could not retract this version.'));
}

export async function verifyVersion(versionId: string): Promise<void> {
  const { error } = await supabase.rpc('regulation_verify_version', { p_version_id: versionId });
  if (error) throw new Error(rpcMessage(error, 'Could not verify this version.'));
}

export async function addEdge(args: {
  fromNodeId: string;
  toNodeId: string;
  edgeType: EdgeType;
  validFrom: string;
  validTo?: string;
  note?: string;
}): Promise<RegulationEdge> {
  const { data, error } = await supabase.rpc('regulation_add_edge', {
    p_from_node_id: args.fromNodeId,
    p_to_node_id: args.toNodeId,
    p_edge_type: args.edgeType,
    p_valid_from: args.validFrom,
    p_valid_to: args.validTo || null,
    p_note: args.note?.trim() || null,
  });
  if (error) throw new Error(rpcMessage(error, 'Could not add the link.'));
  return data as RegulationEdge;
}

export async function retractEdge(edgeId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('regulation_retract_edge', { p_edge_id: edgeId, p_reason: reason });
  if (error) throw new Error(rpcMessage(error, 'Could not retract this link.'));
}

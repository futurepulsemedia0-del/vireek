/**
 * Temporal Regulation Graph — client domain logic (pure, no I/O).
 *
 * Jurisdiction → Code → Permit → License → Inspection → Environmental rule → Effective date → Job
 *
 * The database is the source of truth (see
 * supabase/migrations/20270301000000_temporal_regulation_graph.sql). Versions are bitemporal:
 *   valid time       = effective_from (+ expires_on, or a repeal tombstone)
 *   transaction time = recorded_at / retracted_at  ("what did we know, and when")
 * This file mirrors the resolution rules so the UI can draw timelines, and holds all types,
 * labels and validation shared by the page and the job panel. Keep it free of I/O so it is
 * unit-testable (temporalRegulation.test.ts).
 */

// ============================================================
// TYPES
// ============================================================

export type RegulationKind =
  | 'code'
  | 'permit'
  | 'license'
  | 'inspection'
  | 'environmental_rule'
  | 'ordinance'
  | 'other';
export type JurisdictionLevel = 'country' | 'state' | 'county' | 'city' | 'district';
export type EntryStatus = 'in_force' | 'repealed' | 'expired';
export type VerificationStatus = 'unverified' | 'verified';
export type SourceType =
  | 'statute'
  | 'code_adoption'
  | 'ordinance'
  | 'agency_rule'
  | 'agency_notice'
  | 'internal_policy'
  | 'other';
export type EdgeType =
  | 'requires'
  | 'triggers'
  | 'inspected_by'
  | 'licensed_by'
  | 'governed_by'
  | 'amends'
  | 'references';
export type RequirementSeverity = 'blocker' | 'warning' | 'info';

export interface Jurisdiction {
  id: string;
  owner_id: string | null;
  parent_id: string | null;
  level: JurisdictionLevel;
  code: string;
  name: string;
  depth: number;
}

export interface RegulationNode {
  id: string;
  owner_id: string | null;
  jurisdiction_id: string;
  kind: RegulationKind;
  key: string;
  title: string;
  authority: string | null;
  work_types: string[];
  description: string | null;
  created_at: string;
}

export interface VersionRequirement {
  title: string;
  detail?: string;
  severity: RequirementSeverity;
}

export interface RegulationVersion {
  id: string;
  owner_id: string | null;
  node_id: string;
  version_no: number;
  label: string | null;
  effective_from: string; // YYYY-MM-DD
  expires_on: string | null;
  is_repeal: boolean;
  title: string | null;
  summary: string | null;
  requirements: VersionRequirement[];
  citation: string | null;
  source_url: string | null;
  source_type: SourceType;
  retrieved_on: string | null;
  verification_status: VerificationStatus;
  verified_at: string | null;
  corrects_id: string | null;
  recorded_at: string;
  retracted_at: string | null;
  retracted_reason: string | null;
  content_hash: string;
}

export interface RegulationEdge {
  id: string;
  owner_id: string | null;
  from_node_id: string;
  to_node_id: string;
  edge_type: EdgeType;
  valid_from: string;
  valid_to: string | null;
  note: string | null;
  recorded_at: string;
  retracted_at: string | null;
}

export interface ResolvedEntry {
  node_id: string;
  key: string;
  kind: RegulationKind;
  title: string;
  authority: string | null;
  jurisdiction_code: string;
  jurisdiction_name: string;
  inherited: boolean;
  version_id: string;
  version_no: number;
  label: string | null;
  effective_from: string;
  expires_on: string | null;
  status: EntryStatus;
  summary: string | null;
  requirements: VersionRequirement[];
  citation: string | null;
  source_url: string | null;
  source_type: SourceType;
  verification_status: VerificationStatus;
  content_hash: string;
  recorded_at: string;
}

export interface ResolvedEdge {
  id: string;
  from_node_id: string;
  to_node_id: string;
  edge_type: EdgeType;
  valid_from: string;
  valid_to: string | null;
  note: string | null;
}

export interface ResolveResult {
  jurisdiction: { id: string; code: string; name: string; level: JurisdictionLevel };
  jurisdiction_path: { id: string; code: string; name: string; level: JurisdictionLevel; dist: number }[];
  as_of: string;
  known_at: string;
  entries: ResolvedEntry[];
  edges: ResolvedEdge[];
  counts: { total: number; in_force: number; ended: number; unverified: number };
}

export interface JobRegulationContext {
  job_id: string;
  as_of: string;
  as_of_basis: 'scheduled' | 'today';
  has_review: boolean;
  review_jurisdiction_label: string | null;
  work_types: string[];
  jurisdiction: { id: string; code: string; name: string; level: JurisdictionLevel } | null;
}

export interface DriftChange {
  key: string;
  was_version: number | null;
  now_version: number | null;
  was_status: EntryStatus | null;
  now_status: EntryStatus | null;
}

export interface SnapshotItem {
  id: string;
  seq: number;
  as_of: string;
  as_of_basis: 'scheduled' | 'today' | 'manual';
  known_at: string;
  jurisdiction_code: string;
  jurisdiction_label: string;
  work_types: string[];
  reason: string | null;
  snapshot_hash: string;
  created_at: string;
  entries: ResolvedEntry[];
  versions_intact: boolean;
  drifted: boolean;
  drift: DriftChange[];
}

export interface SnapshotReport {
  snapshots: SnapshotItem[];
  integrity: { chain_ok: boolean; broken_at_seq: number | null };
}

export interface RecordSnapshotResult {
  id: string;
  seq: number;
  snapshot_hash: string;
  as_of: string;
  jurisdiction_code: string;
  deduplicated: boolean;
  evidence_linked?: boolean;
  entry_count: number;
}

// ============================================================
// LABELS / META
// ============================================================

/** Display order mirrors the regulatory chain: Code → Permit → License → Inspection → Environmental. */
export const KIND_ORDER: RegulationKind[] = [
  'code',
  'permit',
  'license',
  'inspection',
  'environmental_rule',
  'ordinance',
  'other',
];

export const KIND_LABELS: Record<RegulationKind, string> = {
  code: 'Code',
  permit: 'Permit',
  license: 'License',
  inspection: 'Inspection',
  environmental_rule: 'Environmental rule',
  ordinance: 'Ordinance',
  other: 'Other',
};

export const LEVEL_LABELS: Record<JurisdictionLevel, string> = {
  country: 'Country',
  state: 'State / province',
  county: 'County',
  city: 'City',
  district: 'District',
};

export const LEVEL_RANK: Record<JurisdictionLevel, number> = {
  country: 0,
  state: 1,
  county: 2,
  city: 3,
  district: 4,
};

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  statute: 'Statute',
  code_adoption: 'Code adoption',
  ordinance: 'Ordinance',
  agency_rule: 'Agency rule',
  agency_notice: 'Agency notice',
  internal_policy: 'Internal policy',
  other: 'Other',
};

export const EDGE_TYPE_LABELS: Record<EdgeType, string> = {
  requires: 'requires',
  triggers: 'triggers',
  inspected_by: 'is inspected by',
  licensed_by: 'needs license',
  governed_by: 'is governed by',
  amends: 'amends',
  references: 'references',
};

export const STATUS_META: Record<EntryStatus, { label: string; className: string }> = {
  in_force: { label: 'In force', className: 'bg-success-500/10 text-success-500' },
  expired: { label: 'Expired', className: 'bg-warning-500/10 text-warning-500' },
  repealed: { label: 'Repealed', className: 'bg-danger/10 text-danger' },
};

export const SEVERITY_LABELS: Record<RequirementSeverity, string> = {
  blocker: 'Blocker',
  warning: 'Important',
  info: 'Good to know',
};

/** Same vocabulary as the Permit Compliance Engine (_shared/permit-rules/types.ts WorkType). */
export const WORK_TYPE_OPTIONS: string[] = [
  'electrical_service',
  'electrical_new',
  'ev_charger',
  'generator',
  'electrical_repair',
  'water_heater',
  'plumbing_repipe',
  'plumbing_drain',
  'plumbing_fixture',
  'gas_work',
  'hvac_replace',
  'hvac_new',
  'ductwork',
  'refrigerant',
  'appliance_repair',
  'maintenance',
];

export function workTypeLabel(t: string): string {
  const s = t.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ============================================================
// DATES (ISO calendar dates, compared as strings — no timezone drift)
// ============================================================

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(s: string | null | undefined): s is string {
  if (!s || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today's calendar date in the user's local timezone, as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

export function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function formatIsoDate(s: string | null | undefined): string {
  if (!isValidIsoDate(s)) return '—';
  return new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatTimestamp(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function shortHash(h: string | null | undefined, n = 10): string {
  return h ? h.slice(0, n) : '—';
}

export function slugifyKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 80);
}

// ============================================================
// BITEMPORAL RESOLUTION (mirror of reg_resolve_core, per node)
// ============================================================

type VersionTimes = Pick<
  RegulationVersion,
  'effective_from' | 'expires_on' | 'is_repeal' | 'recorded_at' | 'retracted_at'
>;

/** Was this version part of our knowledge at `knownAt`? */
export function isKnownAt(v: Pick<RegulationVersion, 'recorded_at' | 'retracted_at'>, knownAt: string): boolean {
  const k = new Date(knownAt).getTime();
  if (new Date(v.recorded_at).getTime() > k) return false;
  return !v.retracted_at || new Date(v.retracted_at).getTime() > k;
}

export interface AsOfResult<T extends VersionTimes> {
  version: T | null;
  status: EntryStatus | 'none';
}

/**
 * The version governing `asOf`, as known at `knownAt`: latest effective_from <= asOf, ties broken by
 * the later recording (a correction). A repeal tombstone or an expired version means "not in force".
 */
export function resolveAsOf<T extends VersionTimes>(
  versions: readonly T[],
  asOf: string,
  knownAt: string = new Date().toISOString(),
): AsOfResult<T> {
  let best: T | null = null;
  for (const v of versions) {
    if (!isKnownAt(v, knownAt) || v.effective_from > asOf) continue;
    if (
      !best ||
      v.effective_from > best.effective_from ||
      (v.effective_from === best.effective_from &&
        new Date(v.recorded_at).getTime() > new Date(best.recorded_at).getTime())
    ) {
      best = v;
    }
  }
  if (!best) return { version: null, status: 'none' };
  if (best.is_repeal) return { version: best, status: 'repealed' };
  if (best.expires_on && asOf >= best.expires_on) return { version: best, status: 'expired' };
  return { version: best, status: 'in_force' };
}

export interface TimelineSegment<T extends VersionTimes> {
  kind: 'version' | 'gap';
  version: T | null;
  from: string;
  to: string | null; // exclusive; null = open-ended
  status: EntryStatus | 'gap';
}

/** Validity segments of one regulation as known at `knownAt` — what the Registry timeline draws. */
export function buildTimeline<T extends VersionTimes>(
  versions: readonly T[],
  knownAt: string = new Date().toISOString(),
): TimelineSegment<T>[] {
  const latestPerStart = new Map<string, T>();
  for (const v of versions) {
    if (!isKnownAt(v, knownAt)) continue;
    const cur = latestPerStart.get(v.effective_from);
    if (!cur || new Date(v.recorded_at).getTime() > new Date(cur.recorded_at).getTime()) {
      latestPerStart.set(v.effective_from, v);
    }
  }
  const sorted = [...latestPerStart.values()].sort((a, b) => compareIso(a.effective_from, b.effective_from));
  const out: TimelineSegment<T>[] = [];
  sorted.forEach((v, i) => {
    const next = sorted[i + 1]?.effective_from ?? null;
    const expiresFirst = !v.is_repeal && v.expires_on && (!next || v.expires_on < next);
    const end = expiresFirst ? (v.expires_on as string) : next;
    out.push({
      kind: 'version',
      version: v,
      from: v.effective_from,
      to: end,
      status: v.is_repeal ? 'repealed' : 'in_force',
    });
    if (expiresFirst) {
      out.push({ kind: 'gap', version: null, from: v.expires_on as string, to: next, status: 'gap' });
    }
  });
  return out;
}

export function segmentContains<T extends VersionTimes>(seg: TimelineSegment<T>, asOf: string): boolean {
  return asOf >= seg.from && (seg.to === null || asOf < seg.to);
}

// ============================================================
// GROUPING / SUMMARIES
// ============================================================

export function groupByKind(entries: readonly ResolvedEntry[]): { kind: RegulationKind; items: ResolvedEntry[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, items: entries.filter((e) => e.kind === kind) })).filter(
    (g) => g.items.length > 0,
  );
}

export function inForce(entries: readonly ResolvedEntry[]): ResolvedEntry[] {
  return entries.filter((e) => e.status === 'in_force');
}

export function unverifiedInForce(entries: readonly ResolvedEntry[]): ResolvedEntry[] {
  return inForce(entries).filter((e) => e.verification_status !== 'verified');
}

/** Outgoing links per node, resolved to titles, for the Graph view. */
export function linksFor(
  nodeId: string,
  entries: readonly ResolvedEntry[],
  edges: readonly ResolvedEdge[],
): { edge: ResolvedEdge; target: ResolvedEntry }[] {
  const byId = new Map(entries.map((e) => [e.node_id, e]));
  const out: { edge: ResolvedEdge; target: ResolvedEntry }[] = [];
  for (const edge of edges) {
    if (edge.from_node_id !== nodeId) continue;
    const target = byId.get(edge.to_node_id);
    if (target) out.push({ edge, target });
  }
  return out;
}

export type ProofLevel = 'sealed' | 'drifted' | 'tampered' | 'none';

/** One-glance trust state of a job's regulation record. Tampering outranks drift. */
export function proofLevel(report: SnapshotReport | null): ProofLevel {
  if (!report || report.snapshots.length === 0) return 'none';
  if (!report.integrity.chain_ok || report.snapshots.some((s) => !s.versions_intact)) return 'tampered';
  return report.snapshots[0].drifted ? 'drifted' : 'sealed';
}

export const PROOF_META: Record<Exclude<ProofLevel, 'none'>, { label: string; className: string; hint: string }> = {
  sealed: {
    label: 'Sealed & verified',
    className: 'bg-success-500/10 text-success-500',
    hint: 'The recorded regulations still match today’s knowledge and the hash chain is intact.',
  },
  drifted: {
    label: 'Superseded since',
    className: 'bg-warning-500/10 text-warning-500',
    hint: 'A later correction changes what was in force on this date. The original record is preserved.',
  },
  tampered: {
    label: 'Integrity check failed',
    className: 'bg-danger/10 text-danger',
    hint: 'The stored proof no longer matches its hashes. Escalate to your administrator.',
  },
};

export function describeDrift(c: DriftChange): string {
  if (c.was_version === null) return `${c.key}: newly recorded (v${c.now_version})`;
  if (c.now_version === null) return `${c.key}: no longer applies on this date`;
  if (c.was_status !== c.now_status && c.now_status) {
    return `${c.key}: now ${STATUS_META[c.now_status].label.toLowerCase()} (was v${c.was_version})`;
  }
  return `${c.key}: v${c.was_version} → v${c.now_version}`;
}

// ============================================================
// DRAFT VALIDATION (mirrors the SQL CHECKs so errors show before the round-trip)
// ============================================================

export interface VersionDraft {
  effectiveFrom: string;
  expiresOn: string;
  isRepeal: boolean;
  title: string;
  summary: string;
  citation: string;
  sourceUrl: string;
  requirementsText: string;
}

export function isValidSourceUrl(u: string): boolean {
  return /^https?:\/\/[^\s]{3,500}$/i.test(u.trim());
}

export function validateVersionDraft(d: VersionDraft): { ok: boolean; errors: Partial<Record<keyof VersionDraft, string>> } {
  const errors: Partial<Record<keyof VersionDraft, string>> = {};
  if (!isValidIsoDate(d.effectiveFrom)) errors.effectiveFrom = 'Pick the date this version took effect.';
  if (d.expiresOn) {
    if (!isValidIsoDate(d.expiresOn)) errors.expiresOn = 'Enter a valid end date.';
    else if (isValidIsoDate(d.effectiveFrom) && d.expiresOn <= d.effectiveFrom)
      errors.expiresOn = 'The end date must be after the effective date.';
  }
  if (!d.isRepeal) {
    if (!d.title.trim()) errors.title = 'A title is required.';
    if (!d.summary.trim()) errors.summary = 'Summarize what this version requires.';
  }
  if (!d.citation.trim() && !d.sourceUrl.trim()) errors.citation = 'Cite the legal source (citation or link).';
  if (d.sourceUrl.trim() && !isValidSourceUrl(d.sourceUrl)) errors.sourceUrl = 'Enter a full http(s) link.';
  if (d.title.length > 200) errors.title = 'Keep the title under 200 characters.';
  if (d.summary.length > 4000) errors.summary = 'Keep the summary under 4,000 characters.';
  return { ok: Object.keys(errors).length === 0, errors };
}

/**
 * Requirement lines: `[blocker] Title | detail` (severity and detail optional; default severity "info").
 * Invalid lines are dropped; at most 40 are kept (the database limit).
 */
export function parseRequirementLines(text: string): VersionRequirement[] {
  const out: VersionRequirement[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\[(blocker|warning|info)\]\s*/i.exec(line);
    const severity = (m ? m[1].toLowerCase() : 'info') as RequirementSeverity;
    const rest = m ? line.slice(m[0].length) : line;
    const [titlePart, ...detailParts] = rest.split('|');
    const title = titlePart.trim().slice(0, 200);
    if (!title) continue;
    const detail = detailParts.join('|').trim().slice(0, 1000);
    out.push(detail ? { title, detail, severity } : { title, severity });
    if (out.length >= 40) break;
  }
  return out;
}

export function formatRequirementLines(reqs: readonly VersionRequirement[]): string {
  return reqs.map((r) => `[${r.severity}] ${r.title}${r.detail ? ` | ${r.detail}` : ''}`).join('\n');
}

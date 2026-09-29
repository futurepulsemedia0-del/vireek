/**
 * Job Evidence Chain — client library.
 *
 * Integrity is enforced by the database (see 20261231000000_job_evidence_chain.sql):
 * append-only ledger, server-assigned sequence / hashes / actor identity, and the
 * report + verification RPCs. This file only reads those reports and appends entries.
 * Nothing here can rewrite history or fake a hash.
 */

import { supabase } from '@/lib/supabase';

// ============================================================
// TYPES
// ============================================================

export const EVIDENCE_STAGES = [
  'problem',
  'diagnosis',
  'evidence',
  'recommendation',
  'customer_approval',
  'part',
  'technician',
  'work',
  'test',
  'result',
  'payment',
  'warranty',
] as const;

export type EvidenceStage = (typeof EVIDENCE_STAGES)[number];
export type EvidenceKind = 'statement' | 'measurement' | 'media' | 'test' | 'approval' | 'part' | 'system';
export type EvidenceActorType = 'technician' | 'staff' | 'customer' | 'ai' | 'system';
export type ChainLevel = 'audit_ready' | 'strong' | 'partial' | 'weak' | 'compromised' | 'not_started';
export type StageStatus = 'complete' | 'missing' | 'not_applicable';
export type MeasurementPhase = 'before' | 'during' | 'after';

export interface EvidenceMedia {
  path: string;
  sha256: string;
  mime: string;
  bytes: number;
  captured_at: string;
  name?: string;
}

export interface EvidenceEntry {
  id: string;
  user_id: string;
  job_id: string;
  seq: number;
  stage: EvidenceStage;
  kind: EvidenceKind;
  title: string;
  detail: string | null;
  payload: Record<string, unknown>;
  media: EvidenceMedia[];
  refs: string[];
  supersedes_id: string | null;
  actor_type: EvidenceActorType;
  actor_user_id: string | null;
  actor_team_member_id: string | null;
  actor_name: string | null;
  latitude: number | null;
  longitude: number | null;
  source_key: string | null;
  recorded_at: string;
  prev_hash: string | null;
  entry_hash: string;
}

export interface ChainStage {
  stage: EvidenceStage;
  status: StageStatus;
  applicable: boolean;
  satisfied: boolean;
  count: number;
  weight: number;
}

export interface ChainGap {
  key: string;
  stage: EvidenceStage;
  severity: 'blocking' | 'advisory';
}

export interface ChainIntegrity {
  valid: boolean;
  entries: number;
  broken_seq: number | null;
  reason: 'sequence_gap' | 'broken_link' | 'hash_mismatch' | null;
  head_hash: string | null;
}

export interface ChainReport {
  job_id: string;
  score: number;
  level: ChainLevel;
  ready: boolean;
  stages: ChainStage[];
  gaps: ChainGap[];
  blocking_gaps: string[];
  integrity: ChainIntegrity;
  stats: {
    system_verified: number;
    human_recorded: number;
    media_files: number;
    before_after_measurement: boolean;
    before_after_media: boolean;
    chargeable: boolean;
    post_repair_test_passed: boolean;
  };
  generated_at: string;
}

export interface ChainPortfolioRow {
  job_id: string;
  customer_name: string;
  service_type: string | null;
  job_status: string;
  created_at: string;
  score: number;
  level: ChainLevel;
  blocking: number;
  integrity_valid: boolean;
  entries: number;
  head_hash: string | null;
}

export interface ChainRequirement {
  id: string;
  service_type: string;
  enforce_on_close: boolean;
  min_score: number;
}

export interface NewEvidenceEntry {
  jobId: string;
  stage: EvidenceStage;
  kind: Exclude<EvidenceKind, 'system'>;
  title: string;
  detail?: string;
  payload?: Record<string, unknown>;
  media?: EvidenceMedia[];
  refs?: string[];
  supersedesId?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

// ============================================================
// LABELS / META
// ============================================================

export const STAGE_META: Record<EvidenceStage, { label: string; question: string }> = {
  problem: { label: 'Problem', question: 'What was reported?' },
  diagnosis: { label: 'Diagnosis', question: 'What did we conclude — and why?' },
  evidence: { label: 'Evidence', question: 'What proves it? (measurements, photos, video)' },
  recommendation: { label: 'Recommendation', question: 'What did we propose to fix it?' },
  customer_approval: { label: 'Customer approval', question: 'Did the customer approve before work started?' },
  part: { label: 'Part', question: 'Which part, which serial number?' },
  technician: { label: 'Technician', question: 'Who did the work?' },
  work: { label: 'Work', question: 'What exactly was done?' },
  test: { label: 'Test', question: 'How was the repair verified afterwards?' },
  result: { label: 'Result', question: 'What was the outcome?' },
  payment: { label: 'Payment', question: 'Was it paid?' },
  warranty: { label: 'Warranty', question: 'What warranty applies?' },
};

/** Which entry kinds make sense in which stage (drives the "add evidence" form). */
export const STAGE_KINDS: Record<EvidenceStage, Exclude<EvidenceKind, 'system'>[]> = {
  problem: ['statement', 'media'],
  diagnosis: ['statement', 'measurement'],
  evidence: ['measurement', 'media', 'statement'],
  recommendation: ['statement'],
  customer_approval: ['approval'],
  part: ['part'],
  technician: ['statement'],
  work: ['statement', 'media'],
  test: ['test', 'measurement'],
  result: ['statement'],
  payment: ['statement'],
  warranty: ['statement'],
};

export const KIND_LABELS: Record<EvidenceKind, string> = {
  statement: 'Note',
  measurement: 'Measurement',
  media: 'Photo / video',
  test: 'Test',
  approval: 'Approval',
  part: 'Part',
  system: 'Automatic',
};

export const GAP_LABELS: Record<string, string> = {
  problem: 'Problem not recorded',
  diagnosis: 'No diagnosis recorded',
  evidence: 'No supporting evidence (measurement / photo)',
  recommendation: 'No recommendation recorded',
  customer_approval: 'No customer approval',
  work: 'No work recorded',
  part_traceability: 'Part replaced but not traceable (part / serial missing)',
  post_repair_test: 'No post-repair test',
  post_repair_test_failed: 'Latest post-repair test failed',
  before_after: 'No before / after proof',
  work_before_approval: 'Work started before customer approval',
  unsupported_work: 'Work / part not linked to diagnosis + evidence',
  unjustified_recommendation: 'Recommendation not linked to a diagnosis',
  result: 'No result recorded',
  technician: 'No technician on record',
  payment: 'Payment not recorded',
  warranty: 'Warranty terms not recorded',
  integrity: 'Chain integrity check failed',
  score_below_minimum: 'Evidence score below required minimum',
};

export const LEVEL_META: Record<ChainLevel, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  audit_ready: { label: 'Audit-ready', tone: 'success' },
  strong: { label: 'Strong', tone: 'success' },
  partial: { label: 'Partial', tone: 'warning' },
  weak: { label: 'Weak', tone: 'danger' },
  compromised: { label: 'Compromised', tone: 'danger' },
  not_started: { label: 'Not started', tone: 'neutral' },
};

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_PER_ENTRY = 12;
const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'application/pdf',
]);

export function shortHash(hash: string | null | undefined, len = 10): string {
  return hash ? hash.slice(0, len) : '—';
}

// ============================================================
// ERRORS (trigger raises "JOB_EVIDENCE_CHAIN_BLOCKED: gap,gap")
// ============================================================

const BLOCKED_PREFIX = 'JOB_EVIDENCE_CHAIN_BLOCKED:';

export function isEvidenceChainError(message: string | undefined | null): boolean {
  return !!message && message.includes(BLOCKED_PREFIX);
}

/** Turns the raw Postgres exception into a friendly, labeled list. */
export function parseEvidenceChainError(message: string): string[] {
  const idx = message.indexOf(BLOCKED_PREFIX);
  if (idx === -1) return [];
  return message
    .slice(idx + BLOCKED_PREFIX.length)
    .trim()
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => GAP_LABELS[k] ?? k);
}

// ============================================================
// HASHING + MEDIA
// ============================================================

/** SHA-256 of a file, computed on the device BEFORE upload; stored inside the sealed entry. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

let ownerIdPromise: Promise<string> | null = null;

/** Account owner id — evidence files live under the owner's folder so the whole team can read them. */
export function getAccountOwnerId(): Promise<string> {
  if (!ownerIdPromise) {
    ownerIdPromise = (async () => {
      const { data, error } = await supabase.rpc('get_account_owner_id');
      if (error || !data) throw error ?? new Error('Could not resolve account owner.');
      return data as string;
    })().catch((err) => {
      ownerIdPromise = null;
      throw err;
    });
  }
  return ownerIdPromise;
}

export function validateMediaFile(file: File): string | null {
  if (!ALLOWED_MEDIA_TYPES.has(file.type)) return `${file.name}: unsupported file type.`;
  if (file.size > MAX_MEDIA_BYTES) return `${file.name}: larger than 25 MB.`;
  if (file.size === 0) return `${file.name}: file is empty.`;
  return null;
}

export async function uploadChainMedia(jobId: string, file: File): Promise<EvidenceMedia> {
  const problem = validateMediaFile(file);
  if (problem) throw new Error(problem);

  const [ownerId, sha256] = await Promise.all([getAccountOwnerId(), sha256Hex(file)]);
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  const path = `${ownerId}/${jobId}/${crypto.randomUUID()}.${ext}`;

  const { error } = await supabase.storage.from('job-evidence-chain').upload(path, file, {
    upsert: false,
    contentType: file.type,
  });
  if (error) throw error;

  const captured = file.lastModified ? new Date(file.lastModified).toISOString() : new Date().toISOString();
  return { path, sha256, mime: file.type, bytes: file.size, captured_at: captured, name: file.name.slice(0, 120) };
}

const signedUrlCache = new Map<string, { url: string; expires: number }>();

export async function getChainMediaUrl(path: string): Promise<string | null> {
  const hit = signedUrlCache.get(path);
  if (hit && hit.expires > Date.now()) return hit.url;
  const { data, error } = await supabase.storage.from('job-evidence-chain').createSignedUrl(path, 600);
  if (error || !data?.signedUrl) return null;
  signedUrlCache.set(path, { url: data.signedUrl, expires: Date.now() + 9 * 60 * 1000 });
  return data.signedUrl;
}

// ============================================================
// READS
// ============================================================

export async function fetchChainEntries(jobId: string): Promise<EvidenceEntry[]> {
  const { data, error } = await supabase
    .from('job_evidence_chain_entries')
    .select('*')
    .eq('job_id', jobId)
    .order('seq', { ascending: true });
  if (error) throw error;
  return (data as EvidenceEntry[]) ?? [];
}

export async function fetchChainReport(jobId: string): Promise<ChainReport | null> {
  const { data, error } = await supabase.rpc('job_evidence_chain_report', { p_job_id: jobId });
  if (error) throw error;
  return (data as ChainReport | null) ?? null;
}

export async function verifyChain(jobId: string): Promise<ChainIntegrity> {
  const { data, error } = await supabase.rpc('job_evidence_chain_verify', { p_job_id: jobId });
  if (error) throw error;
  return data as ChainIntegrity;
}

export async function fetchChainPortfolio(limit = 100): Promise<ChainPortfolioRow[]> {
  const { data, error } = await supabase.rpc('job_evidence_chain_portfolio', { p_limit: limit });
  if (error) throw error;
  return (data as ChainPortfolioRow[]) ?? [];
}

// ============================================================
// WRITES (append-only)
// ============================================================

export async function addChainEntry(input: NewEvidenceEntry): Promise<EvidenceEntry> {
  const title = input.title.trim();
  if (!title) throw new Error('A title is required.');

  const { data, error } = await supabase
    .from('job_evidence_chain_entries')
    .insert({
      job_id: input.jobId,
      stage: input.stage,
      kind: input.kind,
      title,
      detail: input.detail?.trim() || null,
      payload: input.payload ?? {},
      media: input.media ?? [],
      refs: input.refs ?? [],
      supersedes_id: input.supersedesId ?? null,
      latitude: input.latitude ?? null,
      longitude: input.longitude ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as EvidenceEntry;
}

// ============================================================
// PAYLOAD BUILDERS
// ============================================================

export function buildMeasurementPayload(input: {
  label: string;
  value: number;
  unit: string;
  phase: MeasurementPhase;
  expectedMin?: number | null;
  expectedMax?: number | null;
}): Record<string, unknown> {
  const { label, value, unit, phase, expectedMin, expectedMax } = input;
  const hasRange = expectedMin != null || expectedMax != null;
  const inRange = hasRange
    ? (expectedMin == null || value >= expectedMin) && (expectedMax == null || value <= expectedMax)
    : undefined;
  return {
    label: label.trim(),
    value,
    unit: unit.trim(),
    phase,
    ...(expectedMin != null ? { expected_min: expectedMin } : {}),
    ...(expectedMax != null ? { expected_max: expectedMax } : {}),
    ...(inRange !== undefined ? { in_range: inRange } : {}),
  };
}

// ============================================================
// REQUIREMENTS (opt-in close gate)
// ============================================================

export async function fetchChainRequirements(): Promise<ChainRequirement[]> {
  const { data, error } = await supabase.from('job_evidence_chain_requirements').select('*').order('service_type');
  if (error) throw error;
  return (data as ChainRequirement[]) ?? [];
}

export async function saveChainRequirement(
  serviceType: string,
  flags: { enforce_on_close: boolean; min_score: number },
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('job_evidence_chain_requirements')
    .upsert({ user_id: userId, service_type: serviceType, ...flags }, { onConflict: 'user_id,service_type' });
  if (error) throw error;
}

/**
 * Permit Transaction Agent — client domain logic.
 *
 * The Permit / Compliance Engine (permitCompliance.ts) says which permit is
 * probably needed. This module manages the permit TRANSACTION itself:
 *
 *   Scope → Permit needed? → AHJ → Form → Application → Submit → Track
 *   → Inspection → Passed → Close
 *
 * Vireek never invents AHJ data (forms, fees, portals): the authority
 * directory is tenant-curated, and AI output is a labelled DRAFT. Every write
 * goes through a validated RPC (state machine + guards, immutable timeline).
 *
 * Server counterparts:
 *   supabase/migrations/*_permit_transaction_agent.sql   (keep the state machine below in sync)
 *   supabase/functions/permit-transaction-agent
 */

import { supabase } from '@/lib/supabase';
import type { ComplianceReview } from '@/lib/permitCompliance';

export type PermitType =
  'electrical' | 'plumbing' | 'mechanical' | 'gas' | 'building' | 'roofing' | 'other';

export type PermitStatus =
  | 'draft'
  | 'ready_to_file'
  | 'submitted'
  | 'in_review'
  | 'corrections_required'
  | 'issued'
  | 'in_inspection'
  | 'passed'
  | 'closed'
  | 'rejected'
  | 'withdrawn'
  | 'expired';

export type InspectionKind = 'rough' | 'final' | 'other';
export type InspectionStatus = 'requested' | 'scheduled' | 'passed' | 'failed' | 'cancelled';
export type PortalSystem =
  'accela' | 'energov' | 'cityview' | 'opengov' | 'email' | 'in_person' | 'mail' | 'other';
export type SubmissionMethod = 'portal' | 'email' | 'in_person' | 'mail';

export interface PermitAuthority {
  id: string;
  name: string;
  state: string | null;
  city: string | null;
  county: string | null;
  portal_system: PortalSystem;
  submission_method: SubmissionMethod;
  portal_url: string | null;
  phone: string | null;
  email: string | null;
  typical_turnaround_days: number | null;
  fee_notes: string | null;
  notes: string | null;
  verified: boolean;
  verified_at: string | null;
}

export interface AgentPacket {
  scope_draft: string | null;
  documents: string[];
  verify_questions: string[];
  ai_status: 'ok' | 'unavailable' | 'skipped';
}

export interface PermitApplication {
  id: string;
  job_id: string;
  review_id: string | null;
  quote_id: string | null;
  authority_id: string | null;
  permit_type: PermitType;
  status: PermitStatus;
  form_name: string | null;
  scope_description: string | null;
  application_data: Record<string, string>;
  readiness: { score: number; missing: string[] };
  reference_number: string | null;
  permit_number: string | null;
  fee_amount: number | null;
  fee_paid_at: string | null;
  submitted_at: string | null;
  issued_at: string | null;
  expires_at: string | null;
  closed_at: string | null;
  next_follow_up_at: string | null;
  agent_packet: AgentPacket | null;
  agent_generated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PermitApplicationWithJob extends PermitApplication {
  jobs: {
    customer_name: string | null;
    service_type: string | null;
    address: string | null;
  } | null;
}

export interface PermitEvent {
  id: string;
  event_type: string;
  from_status: PermitStatus | null;
  to_status: PermitStatus | null;
  note: string | null;
  created_at: string;
}

export interface PermitInspection {
  id: string;
  application_id: string;
  kind: InspectionKind;
  label: string | null;
  status: InspectionStatus;
  scheduled_for: string | null;
  inspector_name: string | null;
  result_note: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface PermitCloseStatus {
  has_permits: boolean;
  open: { id: string; permit_type: PermitType; status: PermitStatus }[];
  needs_attention: boolean;
}

// ---------------------------------------------------------------------------
// Labels / metadata
// ---------------------------------------------------------------------------

export const PERMIT_TYPE_LABELS: Record<PermitType, string> = {
  electrical: 'Electrical',
  plumbing: 'Plumbing',
  mechanical: 'Mechanical / HVAC',
  gas: 'Gas',
  building: 'Building',
  roofing: 'Roofing',
  other: 'Other',
};
export const PERMIT_TYPES = Object.keys(PERMIT_TYPE_LABELS) as PermitType[];

export const PORTAL_SYSTEM_LABELS: Record<PortalSystem, string> = {
  accela: 'Accela',
  energov: 'Tyler EnerGov',
  cityview: 'CityView',
  opengov: 'OpenGov',
  email: 'Email',
  in_person: 'In person',
  mail: 'Mail',
  other: 'Other',
};

export const SUBMISSION_METHOD_LABELS: Record<SubmissionMethod, string> = {
  portal: 'Online portal',
  email: 'Email',
  in_person: 'In person',
  mail: 'Mail',
};

export const STATUS_META: Record<PermitStatus, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-bg-tertiary text-text-secondary' },
  ready_to_file: { label: 'Ready to file', className: 'bg-accent/10 text-accent' },
  submitted: { label: 'Submitted', className: 'bg-accent/10 text-accent' },
  in_review: { label: 'In review', className: 'bg-accent/10 text-accent' },
  corrections_required: {
    label: 'Corrections required',
    className: 'bg-warning-500/10 text-warning-500',
  },
  issued: { label: 'Issued', className: 'bg-success-500/10 text-success-500' },
  in_inspection: { label: 'In inspection', className: 'bg-success-500/10 text-success-500' },
  passed: { label: 'Passed', className: 'bg-success-500/10 text-success-500' },
  closed: { label: 'Closed', className: 'bg-bg-tertiary text-text-secondary' },
  rejected: { label: 'Rejected', className: 'bg-danger/10 text-danger' },
  withdrawn: { label: 'Withdrawn', className: 'bg-bg-tertiary text-text-secondary' },
  expired: { label: 'Expired', className: 'bg-danger/10 text-danger' },
};

export const INSPECTION_STATUS_LABELS: Record<InspectionStatus, string> = {
  requested: 'Requested',
  scheduled: 'Scheduled',
  passed: 'Passed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const INSPECTION_KIND_LABELS: Record<InspectionKind, string> = {
  rough: 'Rough-in',
  final: 'Final',
  other: 'Other',
};

export const MISSING_INPUT_LABELS: Record<string, string> = {
  authority: 'Choose the permitting authority (AHJ)',
  scope: 'Describe the scope of work (20+ characters)',
  address: 'Job site address',
  owner_name: 'Property owner name',
  contractor_license: 'Contractor license number',
  job_valuation: 'Job valuation',
};
/** Mirrors permit_missing_inputs() in SQL — total number of readiness checks. */
export const READINESS_CHECKS = Object.keys(MISSING_INPUT_LABELS).length;

/** Happy-path pipeline shown as a tracker. Side exits (rejected / withdrawn / expired) are shown as a badge. */
export const PIPELINE_STAGES: { status: PermitStatus; label: string }[] = [
  { status: 'draft', label: 'Prepare' },
  { status: 'ready_to_file', label: 'Ready' },
  { status: 'submitted', label: 'Filed' },
  { status: 'in_review', label: 'Review' },
  { status: 'issued', label: 'Issued' },
  { status: 'in_inspection', label: 'Inspection' },
  { status: 'passed', label: 'Passed' },
  { status: 'closed', label: 'Closed' },
];

/** Terminal states: no further work expected. */
export const INACTIVE_STATUSES = new Set<PermitStatus>([
  'closed',
  'withdrawn',
  'rejected',
  'expired',
]);

// ---------------------------------------------------------------------------
// State machine — mirrors permit_transition_allowed() in SQL
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<PermitStatus, PermitStatus[]> = {
  draft: ['ready_to_file', 'withdrawn'],
  ready_to_file: ['draft', 'submitted', 'withdrawn'],
  submitted: ['in_review', 'corrections_required', 'issued', 'rejected', 'withdrawn'],
  in_review: ['corrections_required', 'issued', 'rejected', 'withdrawn'],
  corrections_required: ['submitted', 'withdrawn'],
  issued: ['in_inspection', 'expired', 'withdrawn'],
  in_inspection: ['passed', 'expired'],
  passed: ['closed'],
  closed: [],
  rejected: ['draft'],
  withdrawn: [],
  expired: ['ready_to_file'],
};

export function canTransition(from: PermitStatus, to: PermitStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface PermitAction {
  to: PermitStatus;
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
}

const ACTION_LABELS: Partial<Record<PermitStatus, Omit<PermitAction, 'to'>>> = {
  draft: { label: 'Back to draft', tone: 'neutral' },
  ready_to_file: { label: 'Mark ready to file', tone: 'primary' },
  submitted: { label: 'Mark submitted', tone: 'primary' },
  in_review: { label: 'Mark in review', tone: 'neutral' },
  corrections_required: { label: 'Corrections requested', tone: 'neutral' },
  issued: { label: 'Mark issued', tone: 'primary' },
  passed: { label: 'Mark passed', tone: 'primary' },
  closed: { label: 'Close permit', tone: 'primary' },
  rejected: { label: 'Rejected', tone: 'danger' },
  withdrawn: { label: 'Withdraw', tone: 'danger' },
  expired: { label: 'Mark expired', tone: 'danger' },
};

/** Actions a user can take from the current status (in_inspection is entered by adding an inspection). */
export function nextActions(status: PermitStatus): PermitAction[] {
  return TRANSITIONS[status]
    .filter((to) => to !== 'in_inspection')
    .map((to) => {
      const base = ACTION_LABELS[to] ?? { label: to, tone: 'neutral' as const };
      // Re-filing after corrections reads better than "Mark submitted".
      if (status === 'corrections_required' && to === 'submitted') {
        return { to, label: 'Resubmit', tone: 'primary' as const };
      }
      if (status === 'rejected' && to === 'draft') {
        return { to, label: 'Start over', tone: 'primary' as const };
      }
      if (status === 'expired' && to === 'ready_to_file') {
        return { to, label: 'Renew', tone: 'primary' as const };
      }
      return { to, ...base };
    })
    .sort((a, b) => Number(b.tone === 'primary') - Number(a.tone === 'primary'));
}

/** Client-side mirror of permit_missing_inputs(); the server is still the authority. */
export function missingInputs(
  app: Pick<PermitApplication, 'authority_id' | 'scope_description' | 'application_data'>,
  jobAddress: string | null | undefined,
): string[] {
  const data = app.application_data ?? {};
  const blank = (v: unknown) => typeof v !== 'string' || v.trim() === '';
  const missing: string[] = [];
  if (!app.authority_id) missing.push('authority');
  if ((app.scope_description ?? '').trim().length < 20) missing.push('scope');
  if (blank(jobAddress)) missing.push('address');
  if (blank(data.owner_name)) missing.push('owner_name');
  if (blank(data.contractor_license)) missing.push('contractor_license');
  if (blank(data.job_valuation)) missing.push('job_valuation');
  return missing;
}

export function readinessScore(missingCount: number): number {
  return Math.round(((READINESS_CHECKS - missingCount) / READINESS_CHECKS) * 100);
}

// ---------------------------------------------------------------------------
// Inference helpers (deterministic — no AI)
// ---------------------------------------------------------------------------

const WORK_TYPE_TO_PERMIT: Record<string, PermitType> = {
  electrical_service: 'electrical',
  electrical_new: 'electrical',
  ev_charger: 'electrical',
  generator: 'electrical',
  electrical_repair: 'electrical',
  water_heater: 'plumbing',
  plumbing_repipe: 'plumbing',
  plumbing_drain: 'plumbing',
  plumbing_fixture: 'plumbing',
  gas_work: 'gas',
  hvac_replace: 'mechanical',
  hvac_new: 'mechanical',
  ductwork: 'mechanical',
  refrigerant: 'mechanical',
};

/** Permit types worth starting, from the compliance review's detected work types + the job's service text. */
export function inferPermitTypes(
  review: Pick<ComplianceReview, 'work_types' | 'permit_likelihood'> | null,
  serviceText: string | null | undefined,
): PermitType[] {
  const out = new Set<PermitType>();
  if (
    review &&
    (review.permit_likelihood === 'likely_required' ||
      review.permit_likelihood === 'possibly_required')
  ) {
    for (const w of review.work_types ?? []) {
      const t = WORK_TYPE_TO_PERMIT[w];
      if (t) out.add(t);
    }
  }
  if (/\broof(ing|er)?\b/i.test(serviceText ?? '')) out.add('roofing');
  return [...out];
}

const normalize = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Best directory match for a job's jurisdiction: city+state > county/state > state. Verified entries win ties. */
export function suggestAuthority(
  authorities: PermitAuthority[],
  jurisdiction: { city?: string | null; state?: string | null } | null | undefined,
): PermitAuthority | null {
  const city = normalize(jurisdiction?.city);
  const state = normalize(jurisdiction?.state);
  if (!state && !city) return null;
  let best: { a: PermitAuthority; score: number } | null = null;
  for (const a of authorities) {
    if (state && normalize(a.state) && normalize(a.state) !== state) continue;
    let score = 0;
    if (city && normalize(a.city) === city) score += 4;
    else if (normalize(a.city)) continue; // a different city's office
    if (state && normalize(a.state) === state) score += 2;
    if (a.verified) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { a, score };
  }
  return best?.a ?? null;
}

/** Only http(s) links are ever rendered as hrefs. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Filed but no movement for longer than the authority's typical turnaround (default 10 days). */
export function isFollowUpDue(
  app: Pick<PermitApplication, 'status' | 'submitted_at' | 'updated_at' | 'next_follow_up_at'>,
  turnaroundDays: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (app.status !== 'submitted' && app.status !== 'in_review') return false;
  if (app.next_follow_up_at) return new Date(`${app.next_follow_up_at}T00:00:00`).getTime() <= now;
  const base = app.submitted_at ?? app.updated_at;
  const days = turnaroundDays ?? 10;
  return now - new Date(base).getTime() > days * 86_400_000;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function rpcMessage(error: { message?: string } | null, fallback: string): string {
  const m = error?.message ?? '';
  // Our RPCs raise short, user-safe messages; anything else gets the generic fallback.
  return m &&
    m.length < 160 &&
    !/relation|column|function|syntax|permission denied|violates|invalid input/i.test(m)
    ? m
    : fallback;
}

async function functionErrorMessage(error: unknown, fallback: string): Promise<string> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (typeof Response !== 'undefined' && ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return fallback;
}

export async function fetchJobPermits(jobId: string): Promise<PermitApplication[]> {
  const { data, error } = await supabase
    .from('permit_applications')
    .select('*')
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as PermitApplication[];
}

export async function fetchAllPermits(): Promise<PermitApplicationWithJob[]> {
  const { data, error } = await supabase
    .from('permit_applications')
    .select('*, jobs:job_id (customer_name, service_type, address)')
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as unknown as PermitApplicationWithJob[];
}

export async function fetchPermitEvents(applicationId: string): Promise<PermitEvent[]> {
  const { data, error } = await supabase
    .from('permit_application_events')
    .select('id, event_type, from_status, to_status, note, created_at')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data ?? []) as PermitEvent[];
}

export async function fetchPermitInspections(applicationId: string): Promise<PermitInspection[]> {
  const { data, error } = await supabase
    .from('permit_inspections')
    .select('*')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as PermitInspection[];
}

export async function fetchPermitAuthorities(): Promise<PermitAuthority[]> {
  const { data, error } = await supabase
    .from('permit_authorities')
    .select('*')
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as PermitAuthority[];
}

export type AuthorityInput = Omit<PermitAuthority, 'id' | 'verified_at'>;

export async function saveAuthority(input: AuthorityInput, id?: string): Promise<PermitAuthority> {
  const row = {
    ...input,
    name: input.name.trim(),
    verified_at: input.verified ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  const q = id
    ? supabase.from('permit_authorities').update(row).eq('id', id)
    : supabase.from('permit_authorities').insert(row);
  const { data, error } = await q.select('*').single();
  if (error) throw new Error(rpcMessage(error, 'Could not save this authority.'));
  return data as PermitAuthority;
}

export async function deleteAuthority(id: string): Promise<void> {
  const { error } = await supabase.from('permit_authorities').delete().eq('id', id);
  if (error) throw new Error(rpcMessage(error, 'Could not delete this authority.'));
}

export async function createPermitApplication(args: {
  jobId: string;
  permitType: PermitType;
  authorityId?: string | null;
  scope?: string | null;
  reviewId?: string | null;
  quoteId?: string | null;
}): Promise<PermitApplication> {
  const { data, error } = await supabase.rpc('create_permit_application', {
    p_job_id: args.jobId,
    p_permit_type: args.permitType,
    p_authority_id: args.authorityId ?? null,
    p_scope: args.scope ?? null,
    p_form_name: null,
    p_review_id: args.reviewId ?? null,
    p_quote_id: args.quoteId ?? null,
  });
  if (error) throw new Error(rpcMessage(error, 'Could not start the permit application.'));
  return data as PermitApplication;
}

export type PermitPatch = Partial<{
  authority_id: string | null;
  form_name: string | null;
  scope_description: string | null;
  application_data: Record<string, string>;
  fee_amount: number | null;
  fee_paid: boolean;
  reference_number: string | null;
  permit_number: string | null;
  expires_at: string | null;
  next_follow_up_at: string | null;
}>;

export async function updatePermitApplication(
  id: string,
  patch: PermitPatch,
): Promise<PermitApplication> {
  const { data, error } = await supabase.rpc('update_permit_application', {
    p_id: id,
    p_patch: patch,
  });
  if (error) throw new Error(rpcMessage(error, 'Could not save this update.'));
  return data as PermitApplication;
}

export async function transitionPermitApplication(
  id: string,
  to: PermitStatus,
  note?: string,
): Promise<PermitApplication> {
  const { data, error } = await supabase.rpc('transition_permit_application', {
    p_id: id,
    p_to: to,
    p_note: note?.trim() || null,
  });
  if (error) throw new Error(rpcMessage(error, 'Could not change the permit status.'));
  return data as PermitApplication;
}

export async function addPermitInspection(args: {
  applicationId: string;
  kind: InspectionKind;
  label?: string;
  scheduledFor?: string | null;
}): Promise<PermitInspection> {
  const { data, error } = await supabase.rpc('add_permit_inspection', {
    p_application_id: args.applicationId,
    p_kind: args.kind,
    p_label: args.label?.trim() || null,
    p_scheduled_for: args.scheduledFor || null,
  });
  if (error) throw new Error(rpcMessage(error, 'Could not add the inspection.'));
  return data as PermitInspection;
}

export async function recordInspectionResult(args: {
  inspectionId: string;
  status: Exclude<InspectionStatus, 'requested'>;
  note?: string;
  inspector?: string;
  scheduledFor?: string | null;
}): Promise<PermitInspection> {
  const { data, error } = await supabase.rpc('record_permit_inspection_result', {
    p_inspection_id: args.inspectionId,
    p_status: args.status,
    p_note: args.note?.trim() || null,
    p_inspector: args.inspector?.trim() || null,
    p_scheduled_for: args.scheduledFor || null,
  });
  if (error) throw new Error(rpcMessage(error, 'Could not save the inspection result.'));
  return data as PermitInspection;
}

export async function fetchPermitCloseStatus(jobId: string): Promise<PermitCloseStatus> {
  const { data, error } = await supabase.rpc('permit_close_status', { p_job_id: jobId });
  if (error) throw new Error(rpcMessage(error, 'Could not check permit status.'));
  return data as PermitCloseStatus;
}

/** Asks the agent to prepare a draft packet (scope text, document checklist, questions) for an application. */
export async function preparePermitPacket(applicationId: string): Promise<AgentPacket> {
  const { data, error } = await supabase.functions.invoke('permit-transaction-agent', {
    body: { action: 'prepare', applicationId },
  });
  if (error) {
    throw new Error(
      await functionErrorMessage(
        error,
        'Could not reach the permit agent. Check your connection and try again.',
      ),
    );
  }
  if (data?.error) throw new Error(String(data.error));
  return data as AgentPacket;
}

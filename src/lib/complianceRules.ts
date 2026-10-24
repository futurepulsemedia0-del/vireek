/**
 * Regulation-as-code compliance engine — client data layer.
 *
 * NOT LEGAL ADVICE. Rule packs are a compliance aid; every rule version must be
 * reviewed by qualified counsel before it is approved and enforced.
 *
 * The dashboard simulator imports the exact engine the edge functions run
 * (supabase/functions/_shared/compliance-rules/engine.ts). All writes go through
 * SECURITY DEFINER RPCs in 20271110000000_compliance_rule_packs.sql, which scope
 * to the account owner and write audit_log rows.
 */

import { supabase } from '@/lib/supabase';
import type { UserPermissions } from '@/contexts/AuthContext';
import {
  evaluate,
  selectEffective,
  timelineOf,
  validateVersionDraft,
  type Timeline,
  type VersionDraft,
} from '../../supabase/functions/_shared/compliance-rules/engine';
import { STATE_NAMES } from '../../supabase/functions/_shared/compliance-rules/jurisdiction';
import type {
  ConsentState,
  ConsentType,
  EvalContext,
  EvaluationResult,
  Finding,
  RuleKind,
  RuleVersion,
  Severity,
  Surface,
  VersionStatus,
} from '../../supabase/functions/_shared/compliance-rules/types';

export { evaluate, selectEffective, timelineOf, validateVersionDraft, STATE_NAMES };
export type { ConsentState, ConsentType, EvalContext, EvaluationResult, Finding, RuleKind, RuleVersion, Severity, Surface, Timeline, VersionDraft, VersionStatus };

export const LEGAL_DISCLAIMER =
  'Compliance rules are a starting point, not legal advice. Every rule must be reviewed by a qualified attorney before it is relied on, and laws change. Vireek only enforces rules that staff have approved after legal review.';

export const CONSENT_PAGE_SIZE = 25;

export const KIND_LABELS: Record<RuleKind, string> = {
  recording_consent: 'Call recording consent',
  ai_disclosure: 'AI disclosure',
  quiet_hours: 'Contact hours',
  consent_required: 'Consent required',
  license_display: 'License display',
  rescission: 'Right to cancel',
  required_notice: 'Required notice',
  price_cap: 'Price cap',
};

export const SURFACE_LABELS: Record<Surface, string> = {
  call: 'Calls', sms: 'Texts', email: 'Emails', quote: 'Quotes', contract: 'Contracts',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  block: 'Blocks', require: 'Required action', warn: 'Warning', info: 'Info',
};

export const STATUS_LABELS: Record<VersionStatus, string> = {
  draft: 'Draft', in_review: 'In review', approved: 'Approved', rejected: 'Changes requested', retired: 'Retired',
};

export const CONSENT_TYPE_LABELS: Record<ConsentType, string> = {
  call_recording: 'Call recording',
  marketing_sms: 'Marketing texts',
  marketing_email: 'Marketing email',
  data_processing: 'Data processing',
  marketing_call: 'Marketing calls',
  ai_voice: 'AI-voice calls',
};

export const CONSENT_SOURCE_LABELS: Record<string, string> = {
  ivr_verbal: 'Verbal (call)', web_form: 'Web form', manual: 'Entered manually', import: 'Imported', sms_reply: 'Text reply',
};

export const US_STATE_OPTIONS: Array<{ code: string; name: string }> = Object.entries(STATE_NAMES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

export type ComplianceErrorCode = 'forbidden' | 'not_found' | 'invalid' | 'self_review' | 'open_version' | 'effective_conflict' | 'unknown';

export class ComplianceError extends Error {
  readonly code: ComplianceErrorCode;
  constructor(code: ComplianceErrorCode, message: string) {
    super(message);
    this.name = 'ComplianceError';
    this.code = code;
  }
}

/** Strips the SQL prefix so validation text reads naturally in the UI. */
function afterPrefix(m: string, prefix: string): string {
  const i = m.indexOf(prefix);
  return (i >= 0 ? m.slice(i + prefix.length) : m).replace(/^\s*:?\s*/, '').trim();
}

export function toComplianceError(error: { message?: string; code?: string }): ComplianceError {
  const m = error.message ?? '';
  if (m.includes('compliance_self_review')) return new ComplianceError('self_review', 'A different reviewer must approve your draft.');
  if (m.includes('compliance_open_version_exists')) {
    return new ComplianceError('open_version', 'This rule already has an open version. Finish or discard it first.');
  }
  if (m.includes('compliance_effective_conflict')) {
    return new ComplianceError('effective_conflict', afterPrefix(m, 'compliance_effective_conflict'));
  }
  if (m.includes('compliance_invalid')) return new ComplianceError('invalid', afterPrefix(m, 'compliance_invalid'));
  if (m.includes('compliance_immutable')) return new ComplianceError('invalid', afterPrefix(m, 'compliance_immutable'));
  if (m.includes('compliance_not_found') || error.code === 'P0002') return new ComplianceError('not_found', 'That record no longer exists.');
  if (m.includes('compliance_forbidden') || error.code === '42501') {
    return new ComplianceError('forbidden', "You don't have permission to do that.");
  }
  return new ComplianceError('unknown', 'Something went wrong. Please try again.');
}

/** Owner, or a team member with business-profile access. Mirrors compliance_can_manage() in SQL. */
export function canManageCompliance(isOwner: boolean, permissions: Pick<UserPermissions, 'can_edit_business_profile'>): boolean {
  return isOwner || permissions.can_edit_business_profile === true;
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw toComplianceError(error);
  return data as T;
}

// ---------------------------------------------------------------------------
// Owner-facing
// ---------------------------------------------------------------------------

export interface LicenseEntry { state: string; number: string; trade?: string | null; expiresOn?: string | null }
export interface ComplianceProfile { business_state: string | null; licenses: LicenseEntry[]; acknowledged_at: string | null }

export async function fetchCatalog(): Promise<RuleVersion[]> {
  return (await rpc<RuleVersion[] | null>('compliance_catalog')) ?? [];
}

export async function fetchProfile(accountOwnerId: string): Promise<ComplianceProfile | null> {
  const { data, error } = await supabase
    .from('compliance_profiles')
    .select('business_state, licenses, acknowledged_at')
    .eq('user_id', accountOwnerId)
    .maybeSingle();
  if (error) throw toComplianceError(error);
  return data ? { ...data, licenses: Array.isArray(data.licenses) ? (data.licenses as LicenseEntry[]) : [] } : null;
}

export async function saveProfile(state: string | null, licenses: LicenseEntry[], acknowledge = false): Promise<void> {
  await rpc<void>('compliance_save_profile', { p_state: state, p_licenses: licenses, p_acknowledge: acknowledge });
}

export interface ConsentRow {
  id: string;
  contact_phone: string | null;
  contact_email: string | null;
  consent_type: ConsentType;
  granted: boolean;
  source: string;
  notes: string | null;
  expires_at: string | null;
  created_at: string;
  expired: boolean;
}
export interface ConsentHistoryRow { id: string; granted: boolean; source: string; notes: string | null; created_at: string }

export async function fetchConsents(type: ConsentType | null, search: string, offset: number): Promise<{ total: number; rows: ConsentRow[] }> {
  const res = await rpc<{ total: number; rows: ConsentRow[] } | null>('compliance_consent_current', {
    p_type: type, p_search: search.trim() || null, p_limit: CONSENT_PAGE_SIZE, p_offset: offset,
  });
  return res ?? { total: 0, rows: [] };
}

export async function fetchConsentHistory(type: ConsentType, phone: string | null, email: string | null): Promise<ConsentHistoryRow[]> {
  return (await rpc<ConsentHistoryRow[] | null>('compliance_consent_history', { p_type: type, p_phone: phone, p_email: email })) ?? [];
}

export interface RecordConsentInput {
  type: ConsentType; granted: boolean; phone?: string; email?: string; source?: string; notes?: string;
}
export async function recordConsent(i: RecordConsentInput): Promise<string> {
  return rpc<string>('compliance_record_consent', {
    p_type: i.type, p_granted: i.granted, p_phone: i.phone?.trim() || null, p_email: i.email?.trim() || null,
    p_source: i.source ?? 'manual', p_notes: i.notes?.trim() || null, p_customer_id: null,
  });
}

/** Recent decisions, for the "decision log" list. */
export interface EvaluationLogRow {
  id: string; surface: Surface; purpose: string | null; outcome: EvaluationResult['outcome'];
  counterparty_state: string | null; summary: Array<{ rule: string; jurisdiction: string; status: string; message: string }>; created_at: string;
}
export async function fetchEvaluationLog(accountOwnerId: string, limit = 20): Promise<EvaluationLogRow[]> {
  const { data, error } = await supabase
    .from('compliance_evaluations')
    .select('id, surface, purpose, outcome, counterparty_state, summary, created_at')
    .eq('user_id', accountOwnerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw toComplianceError(error);
  return (data ?? []) as EvaluationLogRow[];
}

// ---------------------------------------------------------------------------
// Staff review workflow
// ---------------------------------------------------------------------------

export type StaffRole = 'author' | 'reviewer' | 'admin';

export interface StaffVersion extends RuleVersion {
  packName: string;
  authoredByEmail: string | null;
  authoredBy: string | null;
  submittedAt: string | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
}

export interface ReviewEvent {
  id: number; action: string; fromStatus: string | null; toStatus: string | null; notes: string | null;
  actorEmail: string | null; selfReview: boolean; createdAt: string;
}

export type TransitionAction = 'submit' | 'withdraw' | 'approve' | 'reject' | 'retire' | 'discard';

export async function fetchStaffRole(): Promise<StaffRole | null> {
  const { data, error } = await supabase.rpc('compliance_staff_role');
  if (error) return null;
  return data === 'author' || data === 'reviewer' || data === 'admin' ? data : null;
}

export async function fetchStaffVersions(): Promise<StaffVersion[]> {
  return (await rpc<StaffVersion[] | null>('compliance_staff_versions')) ?? [];
}
export async function fetchReviewEvents(versionId: string): Promise<ReviewEvent[]> {
  return (await rpc<ReviewEvent[] | null>('compliance_staff_events', { p_version_id: versionId })) ?? [];
}
export async function transitionVersion(versionId: string, action: TransitionAction, notes?: string, legalReviewer?: string): Promise<string> {
  return rpc<string>('compliance_staff_transition', {
    p_version_id: versionId, p_action: action, p_notes: notes?.trim() || null, p_legal_reviewer: legalReviewer?.trim() || null,
  });
}

export interface DraftInput extends VersionDraft {
  versionId?: string;
  packSlug: string;
  packName?: string;
  ruleKey: string;
}
export async function saveDraft(d: DraftInput): Promise<string> {
  return rpc<string>('compliance_staff_save_draft', { p: d });
}

/** Who may do what in the review queue (the database enforces the same rules). */
export function allowedActions(v: Pick<StaffVersion, 'status' | 'authoredBy'>, role: StaffRole | null, userId: string | null): TransitionAction[] {
  if (!role) return [];
  const mine = v.authoredBy !== null && v.authoredBy === userId;
  const reviewer = role === 'reviewer' || role === 'admin';
  const out: TransitionAction[] = [];
  if (v.status === 'draft' || v.status === 'rejected') out.push('submit');
  if (v.status === 'draft' && (mine || role === 'admin')) out.push('discard');
  if (v.status === 'in_review') {
    out.push('withdraw');
    if (reviewer && (!mine || role === 'admin')) out.push('approve');
    if (reviewer) out.push('reject');
  }
  if (v.status === 'approved' && reviewer) out.push('retire');
  return out;
}

// ---------------------------------------------------------------------------
// Pure display helpers
// ---------------------------------------------------------------------------

export function formatJurisdiction(code: string): string {
  if (code === 'US') return 'Federal';
  return STATE_NAMES[code.slice(3)] ?? code;
}

export function timelineLabel(t: Timeline): string {
  return t === 'active' ? 'In force' : t === 'upcoming' ? 'Upcoming' : t === 'expired' ? 'Superseded' : 'Not in force';
}

/** Today's date in the given timezone as YYYY-MM-DD (matches how the engine resolves effective dates). */
export function todayKey(timezone?: string | null, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : now.toISOString().slice(0, 10);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** Newest version per rule, in-force first — what the owner-facing rules list shows. */
export function groupCatalog(catalog: RuleVersion[], dateKey: string): Array<{ key: string; current: RuleVersion; timeline: Timeline; history: RuleVersion[] }> {
  const byRule = new Map<string, RuleVersion[]>();
  for (const v of catalog) {
    const k = `${v.jurisdiction}|${v.ruleKey}`;
    byRule.set(k, [...(byRule.get(k) ?? []), v]);
  }
  const rank: Record<Timeline, number> = { active: 0, upcoming: 1, expired: 2, inactive: 3 };
  return [...byRule.entries()]
    .map(([key, vs]) => {
      const sorted = [...vs].sort((a, b) => b.version - a.version);
      const active = sorted.find((v) => timelineOf(v, dateKey) === 'active');
      const current = active ?? sorted[0];
      return { key, current, timeline: timelineOf(current, dateKey), history: sorted.filter((v) => v.id !== current.id) };
    })
    .sort((a, b) => rank[a.timeline] - rank[b.timeline] || a.current.jurisdiction.localeCompare(b.current.jurisdiction) || a.current.title.localeCompare(b.current.title));
}

export function maskPhone(p: string | null): string {
  if (!p) return '—';
  const d = p.replace(/\D/g, '');
  return d.length >= 4 ? `•••• ${d.slice(-4)}` : p;
}

export function contactLabel(r: Pick<ConsentRow, 'contact_phone' | 'contact_email'>): string {
  return r.contact_phone ?? r.contact_email ?? '—';
}

/** Simulator form → engine context. Pure so it can be unit-tested. */
export interface SimulatorForm {
  surface: Surface;
  purpose: 'marketing' | 'service' | 'emergency';
  customerState: string;
  localHour: string; // "HH:MM" customer-local
  timezone: string;
  weekdayOffset: number; // days from today
  aiVoice: boolean;
  disclosureGiven: boolean;
  consent: Partial<Record<ConsentType, ConsentState>>;
  saleLocation: 'customer_home' | 'business_premises' | 'phone' | 'online';
  totalDollars: string;
  baselineDollars: string;
  emergencyDeclared: boolean;
  emergencyRepair: boolean;
  waiverSigned: boolean;
  licenseShown: boolean;
  noticeIncluded: boolean;
}

export function formToContext(f: SimulatorForm, profile: ComplianceProfile | null, now: Date = new Date()): EvalContext {
  const dollars = (v: string): number | undefined => {
    const n = Number(v.replace(/[$,\s]/g, ''));
    return v.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : undefined;
  };
  // Pick a concrete instant: today + offset at the chosen local wall-clock time in the chosen zone.
  const [hh, mm] = f.localHour.split(':').map(Number);
  const base = new Date(now.getTime() + f.weekdayOffset * 86_400_000);
  const day = todayKey(f.timezone, base);
  const at = wallClockToInstant(day, Number.isFinite(hh) ? hh : 12, Number.isFinite(mm) ? mm : 0, f.timezone) ?? now;
  const isDoc = f.surface === 'quote' || f.surface === 'contract';
  return {
    surface: f.surface, purpose: f.purpose, at,
    businessState: profile?.business_state ?? null, businessTimezone: f.timezone, counterpartyTimezone: f.timezone,
    counterpartyState: f.customerState || null, counterpartyStateBasis: f.customerState ? 'explicit' : 'unknown',
    aiVoice: f.aiVoice, disclosureGiven: f.disclosureGiven, consent: f.consent,
    licenses: profile?.licenses ?? [],
    document: isDoc
      ? {
          saleLocation: f.saleLocation, totalCents: dollars(f.totalDollars), baselinePriceCents: dollars(f.baselineDollars),
          emergencyDeclared: f.emergencyDeclared, isEmergencyRepair: f.emergencyRepair, emergencyWaiverSigned: f.waiverSigned,
          licenseNumberShown: f.licenseShown, cancellationNoticePresent: f.noticeIncluded, signedAt: at,
        }
      : f.surface === 'sms' || f.surface === 'email' || f.surface === 'call'
        ? { noticesPresent: f.noticeIncluded ? ['sms-opt-out'] : [] }
        : undefined,
  };
}

/** Wall-clock (YYYY-MM-DD, h, m) in an IANA zone → UTC instant; null when the zone is invalid. */
export function wallClockToInstant(dateKey: string, h: number, m: number, timezone: string): Date | null {
  const [y, mo, d] = dateKey.split('-').map(Number);
  if (![y, mo, d].every(Number.isFinite)) return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const wall = Date.UTC(y, mo - 1, d, h, m, 0);
    let guess = wall;
    for (let i = 0; i < 3; i++) {
      const p: Record<string, string> = {};
      for (const part of fmt.formatToParts(new Date(guess))) p[part.type] = part.value;
      const seen = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), 0);
      const diff = wall - seen;
      if (diff === 0) break;
      guess += diff;
    }
    return new Date(guess);
  } catch {
    return null;
  }
}

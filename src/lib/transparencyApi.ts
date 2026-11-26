// Supabase access for transparency reports and the public AI incident log.
// Staff functions are enforced server-side (RLS + SECURITY DEFINER staff checks); the StaffRoute gate is a convenience.
// The two public functions return published rows only. Errors carry a `kind` the page translates.
import { supabase } from '@/lib/supabase';
import {
  toPublicIncident, toPublicReport, toStaffReport,
  type EntryStatus, type PublicIncident, type PublicReport, type StaffReport,
} from '@/lib/transparencyReport';

export type TransparencyErrorKind = 'forbidden' | 'redaction' | 'gate' | 'immutable' | 'invalid' | 'generic';

export class TransparencyApiError extends Error {
  readonly kind: TransparencyErrorKind;
  readonly rule?: string;
  constructor(kind: TransparencyErrorKind, rule?: string) {
    super(kind);
    this.name = 'TransparencyApiError';
    this.kind = kind;
    this.rule = rule;
  }
}

interface DbError { message?: string; code?: string }

function fail(error: DbError): never {
  const msg = error.message ?? '';
  const rule = /^redaction:([a-z_]+):/.exec(msg)?.[1];
  switch (error.code) {
    case '42501': throw new TransparencyApiError(msg.includes('cannot be') || msg.includes('only') || msg.includes('immutable') ? 'immutable' : 'forbidden');
    case 'PGRST116': throw new TransparencyApiError('forbidden');
    case '22023': throw new TransparencyApiError(rule ? 'redaction' : 'invalid', rule);
    case '23514': throw new TransparencyApiError('gate');
    case '23505': throw new TransparencyApiError('invalid');
    default: throw new TransparencyApiError('generic');
  }
}

const REPORT_COLUMNS = 'id, period_label, period_start, period_end, status, suppress_below, metrics, compiled_at, intro_text, reporting_rules_text, corrections_text, counsel_approved_on, published_at';
const ENTRY_COLUMNS = 'id, public_ref, incident_id, incident_type, severity, occurred_on, title, what_happened, impact, what_we_did, correction_note, status, redaction_checked_on, counsel_approved_on, published_at, created_at';

// ------------------------------------------------------------------------------------- public

export async function fetchPublicReports(): Promise<PublicReport[]> {
  const { data, error } = await supabase.rpc('get_public_transparency_reports');
  if (error) fail(error);
  return Array.isArray(data) ? (data as Record<string, unknown>[]).map(toPublicReport) : [];
}

export async function fetchPublicIncidentLog(): Promise<PublicIncident[]> {
  const { data, error } = await supabase.rpc('get_public_ai_incident_log');
  if (error) fail(error);
  return Array.isArray(data) ? (data as Record<string, unknown>[]).map(toPublicIncident) : [];
}

// ------------------------------------------------------------------------------------- staff: reports

export async function listReports(): Promise<StaffReport[]> {
  const { data, error } = await supabase.from('transparency_reports').select(REPORT_COLUMNS).order('period_start', { ascending: false }).limit(50);
  if (error) fail(error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toStaffReport);
}

export async function createReport(periodLabel: string, suppressBelow: number | null): Promise<string> {
  const { data, error } = await supabase.rpc('transparency_report_create', { p_period_label: periodLabel, p_suppress_below: suppressBelow });
  if (error) fail(error);
  return data as string;
}

export async function refreshReport(id: string): Promise<void> {
  const { error } = await supabase.rpc('transparency_report_refresh', { p_id: id });
  if (error) fail(error);
}

export interface ReportPatch {
  status?: StaffReport['status'];
  suppressBelow?: number | null;
  introText?: string;
  reportingRulesText?: string;
  correctionsText?: string;
  counselApprovedOn?: string | null;
}

export async function updateReport(id: string, patch: ReportPatch): Promise<StaffReport> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.suppressBelow !== undefined) row.suppress_below = patch.suppressBelow;
  if (patch.introText !== undefined) row.intro_text = patch.introText;
  if (patch.reportingRulesText !== undefined) row.reporting_rules_text = patch.reportingRulesText;
  if (patch.correctionsText !== undefined) row.corrections_text = patch.correctionsText;
  if (patch.counselApprovedOn !== undefined) row.counsel_approved_on = patch.counselApprovedOn;
  if (Object.keys(row).length === 0) throw new TransparencyApiError('invalid');
  const { data, error } = await supabase.from('transparency_reports').update(row).eq('id', id).select(REPORT_COLUMNS).single();
  if (error) fail(error);
  return toStaffReport(data as unknown as Record<string, unknown>);
}

// ------------------------------------------------------------------------------------- staff: public incident entries

export interface StaffEntry {
  id: string;
  publicRef: string;
  incidentId: string | null;
  incidentType: string;
  severity: string;
  occurredOn: string;
  title: string;
  whatHappened: string;
  impact: string;
  whatWeDid: string;
  correctionNote: string;
  status: EntryStatus;
  redactionCheckedOn: string | null;
  counselApprovedOn: string | null;
  publishedAt: string | null;
}

export interface EntryDraft {
  incidentId: string | null;
  incidentType: string;
  severity: string;
  occurredOn: string;
  title: string;
  whatHappened: string;
  impact: string;
  whatWeDid: string;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const sn = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function toEntry(r: Record<string, unknown>): StaffEntry {
  return {
    id: s(r.id), publicRef: s(r.public_ref), incidentId: sn(r.incident_id), incidentType: s(r.incident_type), severity: s(r.severity),
    occurredOn: s(r.occurred_on), title: s(r.title), whatHappened: s(r.what_happened), impact: s(r.impact), whatWeDid: s(r.what_we_did),
    correctionNote: s(r.correction_note), status: s(r.status) as EntryStatus, redactionCheckedOn: sn(r.redaction_checked_on),
    counselApprovedOn: sn(r.counsel_approved_on), publishedAt: sn(r.published_at),
  };
}

export async function listEntries(): Promise<StaffEntry[]> {
  const { data, error } = await supabase.from('ai_incident_public_entries').select(ENTRY_COLUMNS).order('occurred_on', { ascending: false }).limit(200);
  if (error) fail(error);
  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toEntry);
}

export async function createEntry(d: EntryDraft): Promise<StaffEntry> {
  const { data, error } = await supabase.from('ai_incident_public_entries').insert({
    incident_id: d.incidentId, incident_type: d.incidentType, severity: d.severity, occurred_on: d.occurredOn,
    title: d.title.trim(), what_happened: d.whatHappened.trim(), impact: d.impact.trim(), what_we_did: d.whatWeDid.trim(),
  }).select(ENTRY_COLUMNS).single();
  if (error) fail(error);
  return toEntry(data as unknown as Record<string, unknown>);
}

export interface EntryPatch extends Partial<EntryDraft> {
  status?: EntryStatus;
  redactionCheckedOn?: string | null;
  counselApprovedOn?: string | null;
  correctionNote?: string;
}

export async function updateEntry(id: string, p: EntryPatch): Promise<StaffEntry> {
  const row: Record<string, unknown> = {};
  if (p.incidentType !== undefined) row.incident_type = p.incidentType;
  if (p.severity !== undefined) row.severity = p.severity;
  if (p.occurredOn !== undefined) row.occurred_on = p.occurredOn;
  if (p.title !== undefined) row.title = p.title.trim();
  if (p.whatHappened !== undefined) row.what_happened = p.whatHappened.trim();
  if (p.impact !== undefined) row.impact = p.impact.trim();
  if (p.whatWeDid !== undefined) row.what_we_did = p.whatWeDid.trim();
  if (p.status !== undefined) row.status = p.status;
  if (p.redactionCheckedOn !== undefined) row.redaction_checked_on = p.redactionCheckedOn;
  if (p.counselApprovedOn !== undefined) row.counsel_approved_on = p.counselApprovedOn;
  if (p.correctionNote !== undefined) row.correction_note = p.correctionNote;
  if (Object.keys(row).length === 0) throw new TransparencyApiError('invalid');
  const { data, error } = await supabase.from('ai_incident_public_entries').update(row).eq('id', id).select(ENTRY_COLUMNS).single();
  if (error) fail(error);
  return toEntry(data as unknown as Record<string, unknown>);
}

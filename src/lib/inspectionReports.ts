// Client API for Inspection Reports (/dashboard/inspection-reports and the
// public /inspection/:token page).
// Backend: supabase/functions/inspection-reports (staff, authenticated, scoped
// to the account owner) and supabase/functions/inspection-report-public
// (customer share link). Pure rules live in the shared engine so client and
// server can never disagree. Schema: 20270403000000_inspection_reports.sql.

import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import type { UserPermissions } from '@/contexts/AuthContext';
import {
  checklistProgress,
  isPdfStale,
  shareState,
  RESULT_LABEL,
  STATUS_LABEL,
  type ChecklistItem,
  type EvidenceSummary,
  type OverallResult,
  type ReportPhoto,
  type ReportStatus,
} from '../../supabase/functions/_shared/inspection/reportEngine';

export { checklistProgress, isPdfStale, shareState, RESULT_LABEL, STATUS_LABEL };
export type { ChecklistItem, EvidenceSummary, OverallResult, ReportPhoto, ReportStatus };

export const PDF_BUCKET = 'inspection-reports';
export const TITLE_MAX = 200;
export const SUMMARY_MAX = 4000;
export const CAPTION_MAX = 200;

export interface ReportListRow {
  id: string;
  job_id: string;
  report_number: string;
  title: string;
  status: ReportStatus;
  overall_result: OverallResult | null;
  customer_name: string;
  address: string | null;
  service_type: string | null;
  inspected_at: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  signed_at: string | null;
  share_enabled: boolean;
  share_expires_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  pdf_path: string | null;
  pdf_generated_at: string | null;
}

export interface ReportFull extends ReportListRow {
  customer_id: string | null;
  summary: string | null;
  checklist: ChecklistItem[];
  photos: ReportPhoto[];
  evidence: EvidenceSummary | null;
  customer_email: string | null;
  customer_phone: string | null;
  inspector_name: string | null;
  share_token: string;
}

export interface PhotoWithUrl extends ReportPhoto {
  url: string | null;
}

export interface SignatureInfo {
  id: string;
  status: string;
  sent_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  signers: { name: string; role: string; status: string; signed_at: string | null }[];
}

export interface ReportDetail {
  report: ReportFull;
  photos: PhotoWithUrl[];
  signature: SignatureInfo | null;
  pdfUrl: string | null;
  businessName: string | null;
  existing?: boolean;
}

export interface JobOption {
  id: string;
  customer_name: string;
  service_type: string | null;
  address: string | null;
  job_status: string;
  scheduled_datetime: string | null;
  report_id: string | null;
}

export interface PublicReport {
  report: {
    report_number: string;
    title: string;
    status: ReportStatus;
    overall_result: OverallResult | null;
    summary: string | null;
    checklist: ChecklistItem[];
    evidence: { verdict: EvidenceSummary['verdict']; summary: string | null } | null;
    customer_name: string;
    address: string | null;
    service_type: string | null;
    inspector_name: string | null;
    inspected_at: string;
    signed_at: string | null;
    share_expires_at: string | null;
  };
  businessName: string | null;
  photos: { section: ReportPhoto['section']; caption: string; url: string | null }[];
  pdfUrl: string | null;
  signature: { status: string; signers: { name: string; role: string; status: string; signed_at: string | null }[] } | null;
}

export type PublicReportResult = { ok: true; data: PublicReport } | { ok: false; reason: 'not_found' | 'expired' | 'error' };

/** Same rule as the dashboard nav + the edge function: owner, or can_view_all_jobs. */
export function canManageInspectionReports(isOwner: boolean, permissions: UserPermissions): boolean {
  return isOwner || permissions.can_view_all_jobs === true;
}

export function getShareUrl(token: string): string {
  return `${window.location.origin}/inspection/${token}`;
}

export const SECTION_LABEL: Record<ReportPhoto['section'], string> = {
  before: 'Before',
  after: 'After',
  evidence: 'Field evidence',
};

export const VERDICT_LABEL: Record<EvidenceSummary['verdict'], string> = {
  pass: 'Passed',
  needs_attention: 'Needs attention',
  fail: 'Failed',
};

export const SHARE_STATE_LABEL = {
  unpublished: 'Not shared',
  active: 'Link active',
  disabled: 'Link disabled',
  expired: 'Link expired',
  voided: 'Voided',
} as const;

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------------------------------------------------------------
// transport
// ---------------------------------------------------------------

async function errorMessage(error: unknown, fallback: string): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    const body = (await error.context.json().catch(() => null)) as { detail?: string; error?: string } | null;
    if (body?.detail) return body.detail;
  }
  return fallback;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('inspection-reports', { body });
  if (error) throw new Error(await errorMessage(error, 'Could not reach the reports service. Check your connection and try again.'));
  if (data?.error) throw new Error(String(data.detail ?? data.error));
  return data as T;
}

export const listReports = async () => (await call<{ reports: ReportListRow[] }>({ action: 'list' })).reports;
export const listJobOptions = async (q: string) => (await call<{ jobs: JobOption[] }>({ action: 'jobs', q })).jobs;
export const getReport = (id: string) => call<ReportDetail>({ action: 'get', id });
export const createReport = (jobId: string) => call<ReportDetail>({ action: 'create', jobId });

export interface UpdateReportInput {
  id: string;
  title: string;
  summary: string;
  overallResult: OverallResult | null;
  photos: { path: string; caption: string; include: boolean }[];
}
export const updateReport = (input: UpdateReportInput) => call<ReportDetail>({ action: 'update', ...input });

export const publishReport = (id: string, expiresInDays: number) => call<ReportDetail>({ action: 'publish', id, expiresInDays });
export const updateShareSettings = (id: string, patch: { enabled?: boolean; expiresInDays?: number; rotate?: boolean }) =>
  call<ReportDetail>({ action: 'share_settings', id, ...patch });
export const cancelSignatureRequest = (id: string) => call<ReportDetail>({ action: 'cancel_signature', id });
export const voidReport = (id: string) => call<ReportDetail>({ action: 'void', id });
export const deleteReport = (id: string) => call<{ deleted: boolean }>({ action: 'delete', id });

/** Uploads a generated PDF through a signed upload URL, then records it on the report. */
export async function uploadReportPdf(id: string, pdf: Blob): Promise<ReportDetail> {
  const target = await call<{ path: string; token: string }>({ action: 'pdf_upload_url', id });
  const { error } = await supabase.storage.from(PDF_BUCKET).uploadToSignedUrl(target.path, target.token, pdf, { contentType: 'application/pdf' });
  if (error) throw new Error('Could not upload the PDF. Please try again.');
  return call<ReportDetail>({ action: 'pdf_attach', id, path: target.path });
}

export async function fetchPublicReport(token: string): Promise<PublicReportResult> {
  const { data, error } = await supabase.functions.invoke('inspection-report-public', { body: { token } });
  if (error) {
    const status = error instanceof FunctionsHttpError ? error.context.status : 0;
    if (status === 404) return { ok: false, reason: 'not_found' };
    if (status === 410) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'error' };
  }
  if (!data?.report) return { ok: false, reason: 'not_found' };
  return { ok: true, data: data as PublicReport };
}

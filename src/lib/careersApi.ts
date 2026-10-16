/**
 * Careers / hiring - data access.
 * Public reads only ever see OPEN postings (RLS). Applications are created exclusively through the
 * submit_job_application RPC. Everything staff-side is enforced by RLS (is_vireek_staff).
 */

import { supabase } from '@/lib/supabase';
import type {
  ApplicationFormValues,
  ApplicationStatus,
  JobApplication,
  JobPosting,
  PostingPayload,
  PostingStats,
  PostingStatus,
} from '@/lib/careers';

const POSTING_COLUMNS =
  'id, slug, title, department, location, location_type, employment_type, summary, description, responsibilities, requirements, salary_min, salary_max, salary_currency, salary_period, status, published_at, closed_at, created_at, updated_at';
const APPLICATION_COLUMNS =
  'id, posting_id, full_name, email, phone, location, linkedin_url, portfolio_url, resume_url, cover_note, referral_source, status, rating, staff_notes, created_at, updated_at';

interface PgError {
  code?: string;
  message: string;
}

function toError(error: PgError, fallback: string): Error {
  if (error.code === '23505') return new Error('A posting with that URL slug already exists.');
  if (error.code === '42501') return new Error("You don't have permission to do that.");
  if (error.code === '22023') return new Error(error.message);
  return new Error(fallback);
}

// ---------- Public ----------

export async function fetchOpenPostings(): Promise<JobPosting[]> {
  const { data, error } = await supabase
    .from('job_postings')
    .select(POSTING_COLUMNS)
    .eq('status', 'open')
    .order('published_at', { ascending: false });
  if (error) throw toError(error, 'Could not load open roles.');
  return (data as unknown as JobPosting[]) ?? [];
}

export async function fetchOpenPostingBySlug(slug: string): Promise<JobPosting | null> {
  const { data, error } = await supabase
    .from('job_postings')
    .select(POSTING_COLUMNS)
    .eq('slug', slug)
    .eq('status', 'open')
    .maybeSingle();
  if (error) throw toError(error, 'Could not load this role.');
  return (data as unknown as JobPosting | null) ?? null;
}

const orNull = (v: string): string | null => (v.trim() === '' ? null : v.trim());

export async function submitApplication(slug: string, values: ApplicationFormValues): Promise<void> {
  const { error } = await supabase.rpc('submit_job_application', {
    p_slug: slug,
    p_full_name: values.fullName.trim(),
    p_email: values.email.trim(),
    p_phone: orNull(values.phone),
    p_location: orNull(values.location),
    p_linkedin_url: orNull(values.linkedinUrl),
    p_portfolio_url: orNull(values.portfolioUrl),
    p_resume_url: orNull(values.resumeUrl),
    p_cover_note: orNull(values.coverNote),
    p_referral_source: orNull(values.referralSource),
    p_consent: values.consent,
    p_website: values.website,
  });
  if (error) {
    // Our RPC raises user-safe messages with these codes; anything else gets a generic message.
    if (error.code && ['22023', 'P0002', '54000'].includes(error.code)) throw new Error(error.message);
    throw new Error('We could not submit your application. Please try again.');
  }
}

// ---------- Staff ----------

export async function fetchAllPostings(): Promise<JobPosting[]> {
  const { data, error } = await supabase
    .from('job_postings')
    .select(POSTING_COLUMNS)
    .order('created_at', { ascending: false });
  if (error) throw toError(error, 'Could not load postings.');
  return (data as unknown as JobPosting[]) ?? [];
}

export async function fetchPostingStats(): Promise<Record<string, PostingStats>> {
  const { data, error } = await supabase
    .from('job_posting_stats')
    .select('posting_id, applicants_total, applicants_new');
  if (error) throw toError(error, 'Could not load applicant counts.');
  const map: Record<string, PostingStats> = {};
  for (const row of (data as unknown as PostingStats[]) ?? []) map[row.posting_id] = row;
  return map;
}

export async function createPosting(payload: PostingPayload): Promise<JobPosting> {
  const { data, error } = await supabase.from('job_postings').insert(payload).select(POSTING_COLUMNS).single();
  if (error) throw toError(error, 'Could not create this posting.');
  return data as unknown as JobPosting;
}

export async function updatePosting(id: string, payload: Partial<PostingPayload>): Promise<JobPosting> {
  const { data, error } = await supabase
    .from('job_postings')
    .update(payload)
    .eq('id', id)
    .select(POSTING_COLUMNS)
    .single();
  if (error) throw toError(error, 'Could not update this posting.');
  return data as unknown as JobPosting;
}

export async function setPostingStatus(id: string, status: PostingStatus): Promise<JobPosting> {
  const { data, error } = await supabase
    .from('job_postings')
    .update({ status })
    .eq('id', id)
    .select(POSTING_COLUMNS)
    .single();
  if (error) throw toError(error, 'Could not change the posting status.');
  return data as unknown as JobPosting;
}

export async function deletePosting(id: string): Promise<void> {
  const { data, error } = await supabase.from('job_postings').delete().eq('id', id).select('id');
  if (error) throw toError(error, 'Could not delete this posting.');
  if (!data || data.length === 0) throw new Error("You don't have permission to delete this posting.");
}

export async function fetchApplications(postingId: string): Promise<JobApplication[]> {
  const { data, error } = await supabase
    .from('job_applications')
    .select(APPLICATION_COLUMNS)
    .eq('posting_id', postingId)
    .order('created_at', { ascending: false });
  if (error) throw toError(error, 'Could not load applicants.');
  return (data as unknown as JobApplication[]) ?? [];
}

export interface ApplicationPatch {
  status?: ApplicationStatus;
  rating?: number | null;
  staff_notes?: string | null;
}

export async function updateApplication(id: string, patch: ApplicationPatch): Promise<JobApplication> {
  const { data, error } = await supabase
    .from('job_applications')
    .update(patch)
    .eq('id', id)
    .select(APPLICATION_COLUMNS)
    .single();
  if (error) throw toError(error, 'Could not update this applicant.');
  return data as unknown as JobApplication;
}

export async function deleteApplication(id: string): Promise<void> {
  const { data, error } = await supabase.from('job_applications').delete().eq('id', id).select('id');
  if (error) throw toError(error, 'Could not delete this applicant.');
  if (!data || data.length === 0) throw new Error("You don't have permission to delete this applicant.");
}

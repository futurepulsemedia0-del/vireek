import { supabase } from '@/lib/supabase';
import {
  DEFAULT_SETTINGS,
  type JobSummary,
  type JobSummarySettings,
  type SummaryChannel,
  type SummaryDraft,
  type SummaryStatus,
} from '@/lib/jobSummaries';

/** Every query is scoped to the ACCOUNT OWNER's id (teamMember.account_owner_id for staff), on top of RLS. */
export async function fetchSummaryForJob(jobId: string, ownerId: string): Promise<JobSummary | null> {
  const { data, error } = await supabase.from('job_summaries').select('*').eq('job_id', jobId).eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return (data as JobSummary | null) ?? null;
}

export async function fetchSummaries(ownerId: string, statuses: SummaryStatus[], limit = 100): Promise<JobSummary[]> {
  const { data, error } = await supabase
    .from('job_summaries')
    .select('*')
    .eq('user_id', ownerId)
    .in('status', statuses)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as JobSummary[];
}

export async function saveSummaryDraft(ownerId: string, id: string, draft: SummaryDraft): Promise<JobSummary> {
  const { data, error } = await supabase.from('job_summaries').update(draft).eq('id', id).eq('user_id', ownerId).select('*').single();
  if (error) throw error;
  return data as JobSummary;
}

export type EngineResult<T = Record<string, unknown>> = { ok: true; data: T } | { ok: false; error: string; code?: string };

async function invokeEngine<T>(body: Record<string, unknown>): Promise<EngineResult<T>> {
  const { data, error } = await supabase.functions.invoke('job-summary-engine', { body });
  if (error) {
    let message = error.message;
    let code: string | undefined;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) {
        const b = await ctx.json();
        message = b?.detail || b?.error || message;
        code = b?.error;
      }
    } catch {
      /* keep the generic message */
    }
    return { ok: false, error: message, code };
  }
  if (data?.error) return { ok: false, error: data.detail || data.error, code: data.error };
  return { ok: true, data: data as T };
}

export const generateSummary = (jobId: string) => invokeEngine<{ summary: JobSummary }>({ action: 'generate', jobId });
export const sendSummary = (summaryId: string, opts: { channel?: SummaryChannel; resend?: boolean } = {}) =>
  invokeEngine<{ status: string; channel: string | null; error: string | null; summary: JobSummary }>({ action: 'send', summaryId, ...opts });
export const publishSummary = (summaryId: string) => invokeEngine<{ summary: JobSummary }>({ action: 'publish', summaryId });
export const holdSummary = (summaryId: string) => invokeEngine<{ summary: JobSummary }>({ action: 'hold', summaryId });
export const skipSummary = (summaryId: string) => invokeEngine<{ summary: JobSummary }>({ action: 'skip', summaryId });

// ---- settings ----
export async function fetchSettings(ownerId: string): Promise<JobSummarySettings> {
  const { data, error } = await supabase.from('job_summary_settings').select('*').eq('user_id', ownerId).maybeSingle();
  if (error) throw error;
  return { ...DEFAULT_SETTINGS, ...((data as Partial<JobSummarySettings> | null) ?? {}) };
}

export async function saveSettings(ownerId: string, s: JobSummarySettings): Promise<JobSummarySettings> {
  const payload = {
    user_id: ownerId,
    auto_generate: s.auto_generate,
    auto_send: s.auto_generate && s.auto_send,
    review_window_minutes: s.review_window_minutes,
    channel: s.channel,
    ai_polish: s.ai_polish,
    include_photos: s.include_photos,
    include_parts: s.include_parts,
    include_warranty: s.include_warranty,
    include_tips: s.include_tips,
    max_photos: s.max_photos,
    labor_warranty_days: s.labor_warranty_days,
    parts_warranty_note: s.parts_warranty_note?.trim() || null,
    default_service_interval_months: s.default_service_interval_months,
    custom_tips: s.custom_tips.map((t) => t.trim()).filter(Boolean),
    sms_body: s.sms_body.trim(),
    email_subject: s.email_subject.trim(),
    timezone: s.timezone,
  };
  const { data, error } = await supabase.from('job_summary_settings').upsert(payload, { onConflict: 'user_id' }).select('*').single();
  if (error) throw error;
  return { ...DEFAULT_SETTINGS, ...(data as Partial<JobSummarySettings>) };
}

// ---- photo previews for staff (RLS: account members can sign job-photos; legacy bucket is public) ----
export async function signStaffPhotoUrls(photos: { bucket: string; path: string }[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const gallery = photos.filter((p) => p.bucket === 'job-photos').map((p) => p.path);
  if (gallery.length) {
    const { data } = await supabase.storage.from('job-photos').createSignedUrls(gallery, 3600);
    for (const row of data ?? []) if (row.signedUrl && row.path) out[`job-photos/${row.path}`] = row.signedUrl;
  }
  for (const p of photos.filter((x) => x.bucket === 'job-room-photos')) {
    out[`job-room-photos/${p.path}`] = supabase.storage.from('job-room-photos').getPublicUrl(p.path).data.publicUrl;
  }
  return out;
}

/** Photos of a job from the gallery, so staff can swap which ones appear. */
export async function fetchJobGalleryPhotos(jobId: string, ownerId: string) {
  const { data, error } = await supabase
    .from('job_photos')
    .select('storage_path,kind,caption')
    .eq('job_id', jobId)
    .eq('user_id', ownerId)
    .neq('kind', 'other')
    .order('taken_at', { ascending: true })
    .limit(60);
  if (error) throw error;
  return (data ?? []) as { storage_path: string; kind: 'before' | 'after' | 'progress'; caption: string | null }[];
}

// ---- public (anon) ----
export interface PublicSummary {
  business_name: string | null;
  business_phone: string | null;
  headline: string;
  intro: string;
  work_summary: string;
  work_items: string[];
  parts: { name: string; quantity: number }[];
  warranty: { label: string; expires_on: string | null; note: string | null }[];
  maintenance_tips: string[];
  next_service_date: string | null;
  next_service_note: string | null;
  technician_first_name: string | null;
  service_type: string | null;
  service_date: string | null;
  sent_at: string;
  updated_at: string | null;
  photos: { url: string; kind: 'before' | 'after' | 'progress'; caption: string | null }[];
}

export async function fetchPublicSummary(token: string): Promise<{ ok: true; summary: PublicSummary } | { ok: false; reason: 'not_found' | 'error' }> {
  const { data, error } = await supabase.functions.invoke('job-summary-public', { body: { token } });
  if (error) {
    const status = (error as { context?: Response }).context?.status;
    return { ok: false, reason: status === 404 ? 'not_found' : 'error' };
  }
  if (!data?.summary) return { ok: false, reason: 'not_found' };
  return { ok: true, summary: data.summary as PublicSummary };
}

export interface PortalSummaryItem {
  token: string;
  headline: string;
  service_type: string | null;
  service_date: string | null;
  sent_at: string;
  first_item: string | null;
}

export async function fetchPortalSummaries(portalToken: string): Promise<PortalSummaryItem[]> {
  const { data, error } = await supabase.rpc('get_portal_job_summaries', { p_token: portalToken });
  if (error || !Array.isArray(data)) return [];
  return data as PortalSummaryItem[];
}

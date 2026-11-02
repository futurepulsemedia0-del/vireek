import { supabase } from '@/lib/supabase';
import type { FeedbackCategory, SurveyRequest } from '@/lib/feedback/events';
import type { FeedbackContext } from '@/lib/feedback/context';

export const SCREENSHOT_BUCKET = 'feedback-screenshots';

export interface SubmitResult { ok: boolean; trackingCode?: string; reason?: string; duplicate?: boolean }
export interface MyFeedbackItem {
  id: string; tracking_code: string; category: FeedbackCategory; message: string; status: string;
  public_note: string | null; anonymous: boolean; has_screenshot: boolean; created_at: string;
  events: { status: string; note: string | null; at: string }[];
}
export interface FeedbackPrivacy { never_ask: boolean; anonymous_default: boolean; snoozed_until: string | null }
export interface YouAsked { id: string; title: string; body: string; href: string | null; published_at: string }

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export async function uploadScreenshot(userId: string, blob: Blob): Promise<string> {
  const ext = blob.type === 'image/jpeg' ? 'jpg' : 'png';
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(SCREENSHOT_BUCKET).upload(path, blob, { contentType: blob.type, upsert: false });
  if (error) throw error;
  return path;
}

export async function submitFeedback(input: {
  category: FeedbackCategory; message: string; context: FeedbackContext | Record<string, never>;
  anonymous: boolean; contactOk: boolean; screenshotPath: string | null;
}): Promise<SubmitResult> {
  const d = await rpc<{ ok?: boolean; tracking_code?: string; reason?: string; duplicate?: boolean }>('submit_product_feedback', {
    p_category: input.category, p_message: input.message, p_context: input.context,
    p_anonymous: input.anonymous, p_contact_ok: input.contactOk, p_screenshot_path: input.screenshotPath,
  });
  return { ok: d.ok === true, trackingCode: d.tracking_code, reason: d.reason, duplicate: d.duplicate };
}

export const listMyFeedback = () => rpc<MyFeedbackItem[]>('my_feedback_list', { p_limit: 100 });
export const getFeedbackPrivacy = () => rpc<FeedbackPrivacy>('get_feedback_privacy');
export const setFeedbackPrivacy = (p: { neverAsk?: boolean; anonymousDefault?: boolean }) =>
  rpc<FeedbackPrivacy>('set_feedback_privacy', { p_never_ask: p.neverAsk ?? null, p_anonymous_default: p.anonymousDefault ?? null });
export const exportMyFeedbackData = () => rpc<Record<string, unknown>>('export_my_feedback_data');
export const listYouAskedWeBuilt = (limit = 5) => rpc<YouAsked[]>('list_you_asked_we_built', { p_limit: limit });

export async function deleteMyFeedbackData(): Promise<{ feedback: number; survey_responses: number }> {
  const d = await rpc<{ feedback: number; survey_responses: number; screenshot_paths: string[] }>('delete_my_feedback_data');
  if (d.screenshot_paths?.length) {
    await supabase.storage.from(SCREENSHOT_BUCKET).remove(d.screenshot_paths).catch(() => undefined);
  }
  return { feedback: d.feedback, survey_responses: d.survey_responses };
}

export async function claimSurvey(r: SurveyRequest): Promise<boolean> {
  try {
    const d = await rpc<{ ok?: boolean }>('survey_claim', { p_type: r.type, p_trigger: r.trigger, p_subject: r.subject ?? null });
    return d.ok === true;
  } catch { return false; }
}
export const respondSurvey = (r: SurveyRequest, score: number, comment: string, contactOk: boolean) =>
  rpc<{ ok?: boolean; reason?: string }>('survey_respond', {
    p_type: r.type, p_trigger: r.trigger, p_subject: r.subject ?? null, p_score: score, p_comment: comment || null, p_contact_ok: contactOk,
  });
export const dismissSurvey = (r: SurveyRequest, action: 'dismissed' | 'snoozed' | 'never', days = 30) =>
  rpc('survey_dismiss', { p_type: r.type, p_trigger: r.trigger, p_subject: r.subject ?? null, p_action: action, p_days: days }).catch(() => undefined);

export const HELP_REASONS = [
  { id: 'inaccurate', label: 'Inaccurate' }, { id: 'unclear', label: 'Hard to follow' }, { id: 'incomplete', label: 'Missing steps' },
  { id: 'outdated', label: 'Out of date' }, { id: 'not_found', label: 'Not what I searched for' }, { id: 'other', label: 'Something else' },
] as const;
export type HelpReason = (typeof HELP_REASONS)[number]['id'];

export async function setHelpFeedbackReason(slug: string, visitorId: string, reason: HelpReason): Promise<void> {
  await supabase.rpc('set_help_feedback_reason', { p_slug: slug, p_visitor_id: visitorId, p_reason: reason });
}
export async function logHelpSearchMiss(query: string): Promise<void> {
  await supabase.rpc('log_help_search_miss', { p_query: query });
}

// ---- staff (every RPC re-checks is_vireek_staff server-side) ----
export const staffRpc = <T,>(fn: string, args?: Record<string, unknown>) => rpc<T>(fn, args);

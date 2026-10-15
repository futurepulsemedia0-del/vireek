import { supabase } from '@/lib/supabase';
import type {
  CaseStatus,
  RecoveryCase,
  SurveyInvitation,
  SurveyTemplate,
  SurveyTemplateInput,
} from '@/lib/surveys';

/**
 * Surveys data access. Every query is explicitly scoped to the ACCOUNT OWNER's
 * id (`ownerId`) — for a team member that is `teamMember.account_owner_id`, not
 * their own user id — in addition to the RLS policies, which enforce the same
 * boundary server-side via get_account_owner_id().
 */

/** Hard cap on rows pulled for analytics; the page tells the user when it is hit. */
export const INVITATION_FETCH_LIMIT = 5000;

const INVITATION_COLUMNS =
  'id,user_id,template_id,job_id,technician_id,template_name,survey_type,channel,customer_name,customer_phone,customer_email,service_type,status,trigger_source,sent_at,channel_used,delivery_error,score,comment,responded_at,low_score_threshold,created_at';

export async function fetchTemplates(ownerId: string): Promise<SurveyTemplate[]> {
  const { data, error } = await supabase
    .from('survey_templates')
    .select('*')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as SurveyTemplate[];
}

export async function createTemplate(ownerId: string, input: SurveyTemplateInput): Promise<SurveyTemplate> {
  const { data, error } = await supabase
    .from('survey_templates')
    .insert({ ...normalize(input), user_id: ownerId })
    .select('*')
    .single();
  if (error) throw error;
  return data as SurveyTemplate;
}

export async function updateTemplate(
  ownerId: string,
  id: string,
  patch: Partial<SurveyTemplateInput>,
): Promise<SurveyTemplate> {
  const { data, error } = await supabase
    .from('survey_templates')
    .update(patch.name !== undefined ? normalize(patch as SurveyTemplateInput) : patch)
    .eq('id', id)
    .eq('user_id', ownerId)
    .select('*')
    .single();
  if (error) throw error;
  return data as SurveyTemplate;
}

export async function deleteTemplate(ownerId: string, id: string): Promise<void> {
  const { error } = await supabase.from('survey_templates').delete().eq('id', id).eq('user_id', ownerId);
  if (error) throw error;
}

function normalize(input: SurveyTemplateInput): SurveyTemplateInput {
  return {
    ...input,
    name: input.name.trim(),
    question: input.question.trim(),
    follow_up_question: input.follow_up_question?.trim() ? input.follow_up_question.trim() : null,
    thank_you_message: input.thank_you_message.trim(),
    sms_body: input.sms_body.trim(),
    email_subject: input.email_subject.trim(),
  };
}

/** Invitations created on/after `sinceIso`, newest first (capped at INVITATION_FETCH_LIMIT). */
export async function fetchInvitations(ownerId: string, sinceIso: string): Promise<SurveyInvitation[]> {
  const { data, error } = await supabase
    .from('survey_invitations')
    .select(INVITATION_COLUMNS)
    .eq('user_id', ownerId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })
    .limit(INVITATION_FETCH_LIMIT);
  if (error) throw error;
  return (data ?? []) as SurveyInvitation[];
}

export async function fetchCases(ownerId: string): Promise<RecoveryCase[]> {
  const { data, error } = await supabase
    .from('survey_recovery_cases')
    .select('*')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as RecoveryCase[];
}

export async function updateCase(
  ownerId: string,
  id: string,
  patch: { status: CaseStatus; resolution_note?: string | null },
): Promise<RecoveryCase> {
  const { data, error } = await supabase
    .from('survey_recovery_cases')
    .update({
      status: patch.status,
      ...(patch.resolution_note !== undefined ? { resolution_note: patch.resolution_note?.trim() || null } : {}),
    })
    .eq('id', id)
    .eq('user_id', ownerId)
    .select('*')
    .single();
  if (error) throw error;
  return data as RecoveryCase;
}

export async function fetchTechnicianNames(ownerId: string): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id,member_name,member_email')
    .eq('account_owner_id', ownerId);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const m of (data ?? []) as { id: string; member_name: string | null; member_email: string }[]) {
    out[m.id] = m.member_name?.trim() || m.member_email;
  }
  return out;
}

export interface CompletedJobOption {
  id: string;
  customer_name: string;
  service_type: string | null;
  completed_at: string | null;
}

/** Recently completed jobs for the "send a survey now" picker. */
export async function fetchRecentCompletedJobs(ownerId: string): Promise<CompletedJobOption[]> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('jobs')
    .select('id,customer_name,service_type,completed_at')
    .eq('user_id', ownerId)
    .eq('job_status', 'completed')
    .gte('completed_at', since)
    .order('completed_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as CompletedJobOption[];
}

export type SendNowResult =
  | { ok: true; status: 'sent' | 'queued'; channel: string | null }
  | { ok: false; error: string };

/** Sends a survey for one job immediately, through the same compliant (A2P/opt-out) path as auto-send. */
export async function sendSurveyNow(templateId: string, jobId: string): Promise<SendNowResult> {
  const { data, error } = await supabase.functions.invoke('survey-dispatcher', {
    body: { action: 'send_now', templateId, jobId },
  });
  if (error) {
    let message = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx) {
        const body = await ctx.json();
        message = body?.detail || body?.error || message;
      }
    } catch {
      /* keep the generic message */
    }
    return { ok: false, error: message };
  }
  if (data?.error) return { ok: false, error: data.detail || data.error };
  return { ok: true, status: data?.status === 'sent' ? 'sent' : 'queued', channel: data?.channel ?? null };
}

// ---------------------------------------------------------------------------
// Public (anon) survey response — used by /s/:token
// ---------------------------------------------------------------------------

export interface PublicSurvey {
  survey_type: 'nps' | 'csat';
  question: string;
  follow_up_question: string | null;
  thank_you_message: string;
  business_name: string | null;
  customer_first_name: string;
  already_responded: boolean;
  expired: boolean;
}

export async function fetchPublicSurvey(token: string): Promise<PublicSurvey | null> {
  const { data, error } = await supabase.rpc('get_survey_for_response', { p_token: token });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : null;
  return (row as PublicSurvey | undefined) ?? null;
}

export type SubmitOutcome = 'ok' | 'not_found' | 'already_responded' | 'expired' | 'invalid_score';

export async function submitPublicSurvey(token: string, score: number, comment: string): Promise<SubmitOutcome> {
  const { data, error } = await supabase.rpc('submit_survey_response', {
    p_token: token,
    p_score: score,
    p_comment: comment,
  });
  if (error) throw error;
  return data as SubmitOutcome;
}

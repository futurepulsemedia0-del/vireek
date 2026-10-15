import { supabase } from '@/lib/supabase';
import {
  normalizeStats,
  normalizeTemplate,
  normalizeTemplates,
  type MessageTemplate,
  type ReviewAction,
  type TemplateDraft,
  type TemplateStats,
} from '@/lib/messageTemplates';

/**
 * Data access for /dashboard/templates. Every read is scoped to the account owner (accountOwnerId) on top of
 * RLS; status changes go through the review_message_template() RPC, never through a direct UPDATE.
 * Schema + rules: supabase/migrations/20270501000000_message_templates.sql.
 */

const COLUMNS =
  'id, user_id, name, channel, category, subject, body, status, review_note, created_by, submitted_at, reviewed_by, reviewed_at, created_at, updated_at';

export class TemplateConflictError extends Error {
  constructor() {
    super('This template changed or is no longer available. Reload to see the latest version.');
    this.name = 'TemplateConflictError';
  }
}

function payload(draft: TemplateDraft) {
  return {
    name: draft.name.trim(),
    channel: draft.channel,
    category: draft.category,
    subject: draft.channel === 'email' ? draft.subject.trim() : null,
    body: draft.body,
  };
}

function requireTemplate(data: unknown): MessageTemplate {
  const row = normalizeTemplate(data);
  if (!row) throw new Error('Unexpected response from the server.');
  return row;
}

export async function fetchMessageTemplates(accountOwnerId: string): Promise<MessageTemplate[]> {
  const { data, error } = await supabase
    .from('message_templates')
    .select(COLUMNS)
    .eq('user_id', accountOwnerId)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return normalizeTemplates(data);
}

export async function fetchTemplateStats(): Promise<Record<string, TemplateStats>> {
  const { data, error } = await supabase.rpc('get_message_template_stats');
  if (error) throw error;
  return normalizeStats(data);
}

export async function createMessageTemplate(accountOwnerId: string, draft: TemplateDraft): Promise<MessageTemplate> {
  const { data, error } = await supabase
    .from('message_templates')
    .insert({ user_id: accountOwnerId, ...payload(draft) })
    .select(COLUMNS)
    .single();
  if (error) throw error;
  return requireTemplate(data);
}

/** Optimistic concurrency: the update only applies if nobody changed the row since `expectedUpdatedAt`. */
export async function updateMessageTemplate(
  id: string,
  accountOwnerId: string,
  expectedUpdatedAt: string,
  draft: TemplateDraft,
): Promise<MessageTemplate> {
  const { data, error } = await supabase
    .from('message_templates')
    .update(payload(draft))
    .eq('id', id)
    .eq('user_id', accountOwnerId)
    .eq('updated_at', expectedUpdatedAt)
    .select(COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new TemplateConflictError();
  return requireTemplate(data);
}

export async function reviewMessageTemplate(id: string, action: ReviewAction, note?: string): Promise<MessageTemplate> {
  const { data, error } = await supabase.rpc('review_message_template', {
    p_template_id: id,
    p_action: action,
    p_note: note?.trim() ? note.trim() : null,
  });
  if (error) throw error;
  return requireTemplate(data);
}

/** Call from any sender (workflow step, dispatch, manual send) after an approved template is actually used. */
export async function recordMessageTemplateUse(id: string, source = 'manual'): Promise<void> {
  const { error } = await supabase.rpc('record_message_template_use', { p_template_id: id, p_source: source });
  if (error) throw error;
}

/** Turns any thrown value into a message that is safe and useful to show in a toast. */
export function describeTemplateError(err: unknown): string {
  if (err instanceof TemplateConflictError) return err.message;
  const e = err as { code?: string; message?: string } | null;
  const code = e?.code ?? '';
  const message = typeof e?.message === 'string' ? e.message : '';
  if (code === '23505') return 'You already have an active template with this name for this channel.';
  if (code === '23514') return 'This template breaks a length rule. Text messages are limited to 1,600 characters.';
  if (code === '42501') return /row-level security/i.test(message) ? 'You do not have permission to do that.' : message || 'You do not have permission to do that.';
  if (['P0001', '22023', '55000', 'P0002'].includes(code) && message) return message;
  return 'Something went wrong. Please try again.';
}

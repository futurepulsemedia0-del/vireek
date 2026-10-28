import { supabase } from '@/lib/supabase';
import {
  UUID_RE,
  lienWaiverError,
  parsePublicLienWaiver,
  type LienWaiver,
  type LienWaiverEvent,
  type LienWaiverTemplate,
  type PublicLienWaiver,
  type SignatureMethod,
  type WaiverType,
} from '@/lib/lienWaivers';

// Lien Waivers data layer. Reads are scoped to the account owner (`user_id = ownerId`) on top of RLS.
// ALL writes go through SECURITY DEFINER RPCs (the tables have no client write policies; drafts can be deleted).

type Res<T> = { data: T | null; error: { message: string } | null };

async function rpc<T>(fn: string, args: Record<string, unknown>, fallback: string): Promise<T> {
  const res = (await supabase.rpc(fn, args)) as Res<T>;
  if (res.error) throw new Error(lienWaiverError(res.error, fallback));
  return res.data as T;
}

function unwrap<T>(res: Res<T>, fallback: string): T {
  if (res.error) throw new Error(lienWaiverError(res.error, fallback));
  return res.data as T;
}

export async function fetchProjectWaivers(ownerId: string, projectId: string): Promise<LienWaiver[]> {
  return unwrap(
    (await supabase.from('lien_waivers').select('*').eq('user_id', ownerId).eq('project_id', projectId).order('created_at', { ascending: false }).limit(1000)) as Res<LienWaiver[]>,
    'Could not load lien waivers.',
  ) ?? [];
}

export async function fetchWaiverEvents(ownerId: string, waiverId: string): Promise<LienWaiverEvent[]> {
  return unwrap(
    (await supabase.from('lien_waiver_events').select('*').eq('user_id', ownerId).eq('waiver_id', waiverId).order('created_at', { ascending: true }).limit(200)) as Res<LienWaiverEvent[]>,
    'Could not load the history.',
  ) ?? [];
}

export async function fetchTemplates(ownerId: string): Promise<LienWaiverTemplate[]> {
  const rows = unwrap(
    (await supabase.from('lien_waiver_templates').select('*').or(`user_id.is.null,user_id.eq.${ownerId}`).limit(1000)) as Res<LienWaiverTemplate[]>,
    'Could not load the waiver forms.',
  );
  return rows ?? [];
}

export function createWaiver(payload: Record<string, unknown>): Promise<string> {
  return rpc<string>('save_lien_waiver', { p_id: null, p_payload: payload }, 'Could not create the waiver.');
}

export function updateWaiver(id: string, payload: Record<string, unknown>): Promise<string> {
  return rpc<string>('save_lien_waiver', { p_id: id, p_payload: payload }, 'Could not save the waiver.');
}

export async function sendWaiver(id: string, days: number, paymentConfirmed: boolean): Promise<{ token: string; expires_at: string }> {
  return rpc<{ token: string; expires_at: string }>('send_lien_waiver', { p_id: id, p_expires_in_days: days, p_payment_confirmed: paymentConfirmed }, 'Could not send the waiver.');
}

export async function signWaiverStaff(id: string, name: string, title: string, method: Exclude<SignatureMethod, 'online'>, paymentConfirmed: boolean): Promise<void> {
  await rpc<unknown>('sign_lien_waiver_staff', { p_id: id, p_signer_name: name, p_signer_title: title || null, p_method: method, p_payment_confirmed: paymentConfirmed }, 'Could not record the signature.');
}

export async function voidWaiver(id: string, reason: string): Promise<void> {
  await rpc<unknown>('void_lien_waiver', { p_id: id, p_reason: reason }, 'Could not void the waiver.');
}

export async function deleteDraftWaiver(ownerId: string, id: string): Promise<void> {
  const res = (await supabase.from('lien_waivers').delete().eq('id', id).eq('user_id', ownerId).eq('status', 'draft')) as Res<unknown>;
  if (res.error) throw new Error(lienWaiverError(res.error, 'Could not delete the draft.'));
}

export async function saveTemplate(t: { state: string; type: WaiverType; title: string; body: string; statuteRef: string; requiresNotary: boolean }): Promise<void> {
  await rpc<unknown>('save_lien_waiver_template', {
    p_state: t.state, p_type: t.type, p_title: t.title, p_body: t.body, p_statute_ref: t.statuteRef || null, p_requires_notary: t.requiresNotary,
  }, 'Could not save the wording.');
}

export async function resetTemplate(state: string, type: WaiverType): Promise<void> {
  await rpc<unknown>('reset_lien_waiver_template', { p_state: state, p_type: type }, 'Could not reset the wording.');
}

/** Emails the signing link (request) or the signed copy (copy). The "Copy link" button works without this function. */
export async function emailWaiver(waiverId: string, kind: 'request' | 'copy', to?: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke('lien-waiver-email', { body: { waiver_id: waiverId, kind, to: to || undefined } });
  if (error) throw new Error('Email is not available right now. Copy the link and send it yourself.');
  if (data && typeof data === 'object' && 'error' in data && data.error) throw new Error(String((data as { error: unknown }).error));
}

// ---- public (token) ----

export async function fetchPublicWaiver(token: string): Promise<PublicLienWaiver | null> {
  if (!UUID_RE.test(token)) return null;
  try {
    const { data, error } = await supabase.rpc('get_lien_waiver_for_token', { p_token: token });
    if (error) return null;
    return parsePublicLienWaiver(data);
  } catch {
    return null;
  }
}

export async function recordPublicView(token: string): Promise<void> {
  if (!UUID_RE.test(token)) return;
  try {
    await supabase.rpc('record_lien_waiver_view', { p_token: token });
  } catch {
    /* a failed view ping must never block the signer */
  }
}

export async function respondPublic(token: string, decision: 'signed' | 'declined', name: string, title: string, note: string): Promise<void> {
  await rpc<unknown>('respond_to_lien_waiver_by_token', { p_token: token, p_decision: decision, p_name: name, p_title: title || null, p_note: note || null },
    'We couldn’t record your response. Please try again.');
}

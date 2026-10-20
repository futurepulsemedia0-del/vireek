import { supabase } from '@/lib/supabase';
import { buildPhotoPath, extractPortalToken, validatePhotoFile, PHOTO_MAX_COUNT } from './format';
import type {
  AssistantMessage,
  BusinessDetail,
  ConsentEvent,
  HomeOverview,
  ShareScopes,
} from './types';

export type HomeownerErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'rate_limited'
  | 'invalid'
  | 'network'
  | 'unknown';

export class HomeownerApiError extends Error {
  readonly code: HomeownerErrorCode;
  constructor(code: HomeownerErrorCode, message: string) {
    super(message);
    this.name = 'HomeownerApiError';
    this.code = code;
  }
}

const GENERIC = 'Something went wrong. Please try again.';

function fromDbError(error: { code?: string; message?: string }): HomeownerApiError {
  switch (error.code) {
    case '28000':
    case 'PGRST301':
      return new HomeownerApiError('unauthenticated', 'Please sign in again.');
    case '42501':
      return new HomeownerApiError('forbidden', 'This isn’t available to you.');
    case '54000':
      return new HomeownerApiError('rate_limited', 'Too many attempts. Please wait a while and try again.');
    case '22023':
    case '22001':
    case '23514':
      return new HomeownerApiError('invalid', error.message || 'Please check what you entered.');
    default:
      return new HomeownerApiError('unknown', GENERIC);
  }
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  let result;
  try {
    result = await supabase.rpc(fn, args);
  } catch {
    throw new HomeownerApiError('network', 'Network problem. Check your connection and try again.');
  }
  if (result.error) throw fromDbError(result.error);
  return result.data as T;
}

async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  let result;
  try {
    result = await supabase.functions.invoke(name, { body });
  } catch {
    throw new HomeownerApiError('network', 'Network problem. Check your connection and try again.');
  }
  if (result.error) {
    let message = GENERIC;
    let status: number | undefined;
    try {
      const res = (result.error as { context?: Response }).context;
      status = res?.status;
      const json = (await res?.json()) as { error?: string } | undefined;
      if (json?.error) message = String(json.error);
    } catch {
      /* keep generic message */
    }
    const code: HomeownerErrorCode =
      status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : 'unknown';
    throw new HomeownerApiError(code, message);
  }
  return result.data as T;
}

// ---------------------------------------------------------------- auth

export async function requestOtp(phoneE164: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({ phone: phoneE164, options: { shouldCreateUser: true } });
  if (error) {
    const rate = /rate|too many|seconds/i.test(error.message);
    throw new HomeownerApiError(
      rate ? 'rate_limited' : 'invalid',
      rate ? 'Please wait a moment before requesting another code.' : 'We couldn’t send a code to that number.',
    );
  }
}

export async function verifyOtp(phoneE164: string, token: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ phone: phoneE164, token, type: 'sms' });
  if (error) throw new HomeownerApiError('invalid', 'That code is incorrect or has expired.');
}

export async function signOutHomeowner(): Promise<void> {
  await supabase.auth.signOut();
}

// ---------------------------------------------------------------- reads

export const bootstrap = () => rpc<{ discovered: number }>('homeowner_bootstrap');
export const fetchOverview = () => rpc<HomeOverview>('homeowner_get_overview');
export const fetchBusiness = (linkId: string) => rpc<BusinessDetail>('homeowner_get_business', { p_link_id: linkId });

export async function fetchConsentHistory(): Promise<ConsentEvent[]> {
  const { data, error } = await supabase
    .from('homeowner_consent_events')
    .select('id, event_type, detail, created_at')
    .neq('event_type', 'link_attempt')
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw fromDbError(error);
  return (data ?? []) as ConsentEvent[];
}

// ---------------------------------------------------------------- sharing

export function setSharing(linkId: string, scopes: ShareScopes): Promise<void> {
  return rpc<void>('homeowner_set_link_sharing', {
    p_link_id: linkId,
    p_jobs: scopes.jobs,
    p_invoices: scopes.invoices,
    p_equipment: scopes.equipment,
    p_documents: scopes.documents,
    p_health: scopes.health,
  });
}

export const revokeLink = (linkId: string) => rpc<void>('homeowner_revoke_link', { p_link_id: linkId });

/** Returns the new (pending) link id, or null when the link is unknown / not enabled by that business. */
export async function linkByPortalLink(input: string): Promise<string | null> {
  const token = extractPortalToken(input);
  if (!token) throw new HomeownerApiError('invalid', 'That doesn’t look like a Vireek portal link.');
  return rpc<string | null>('homeowner_link_by_portal_token', { p_token: token });
}

export const updateSettings = (s: { fullName?: string | null; language?: string | null; aiEnabled?: boolean | null }) =>
  rpc<void>('homeowner_update_settings', {
    p_full_name: s.fullName ?? null,
    p_language: s.language ?? null,
    p_ai_enabled: s.aiEnabled ?? null,
  });

// ---------------------------------------------------------------- service request

export async function submitServiceRequest(input: {
  linkId: string;
  userId: string;
  serviceType: string;
  message: string;
  files: File[];
}): Promise<string> {
  if (input.files.length > PHOTO_MAX_COUNT) {
    throw new HomeownerApiError('invalid', `You can attach up to ${PHOTO_MAX_COUNT} photos.`);
  }
  for (const f of input.files) {
    const problem = validatePhotoFile(f);
    if (problem) throw new HomeownerApiError('invalid', problem);
  }

  const uploaded: string[] = [];
  try {
    for (const f of input.files) {
      const path = buildPhotoPath(input.userId, f);
      const { error } = await supabase.storage
        .from('homeowner-uploads')
        .upload(path, f, { contentType: f.type, upsert: false, cacheControl: '3600' });
      if (error) throw new HomeownerApiError('unknown', 'A photo failed to upload. Please try again.');
      uploaded.push(path);
    }
    return await rpc<string>('homeowner_submit_service_request', {
      p_link_id: input.linkId,
      p_service_type: input.serviceType,
      p_message: input.message,
      p_photo_paths: uploaded,
    });
  } catch (err) {
    if (uploaded.length) {
      try {
        await supabase.storage.from('homeowner-uploads').remove(uploaded);
      } catch {
        /* best effort cleanup */
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------- documents / assistant / privacy

export async function getDocumentUrl(linkId: string, documentId: string): Promise<string> {
  const res = await invoke<{ url: string }>('homeowner-document-url', { link_id: linkId, document_id: documentId });
  return res.url;
}

export async function askAssistant(input: {
  message: string;
  linkId?: string | null;
  history: AssistantMessage[];
}): Promise<{ answer: string; providers: string[] }> {
  return invoke('homeowner-assistant', {
    message: input.message,
    link_id: input.linkId ?? null,
    history: input.history,
  });
}

export const exportMyData = () => rpc<Record<string, unknown>>('homeowner_export_my_data');

export async function deleteAccount(): Promise<void> {
  await invoke('homeowner-delete-account', {});
  try {
    await supabase.auth.signOut();
  } catch {
    /* the account is already gone; local session cleanup is best effort */
  }
}

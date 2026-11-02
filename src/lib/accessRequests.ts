import { supabase } from '@/lib/supabase';

export type AccessRequestStatus = 'pending' | 'approved' | 'dismissed';

export interface AccessRequest {
  id: string;
  requester_id: string;
  requester_name: string | null;
  area: string;
  path: string;
  message: string | null;
  status: AccessRequestStatus;
  created_at: string;
}

export const MAX_ACCESS_MESSAGE = 500;
const COLUMNS = 'id, requester_id, requester_name, area, path, message, status, created_at';

/** Only same-origin app paths are ever stored. */
export function sanitizePath(raw: string): string | null {
  const p = raw.split('#')[0] ?? '';
  return p.startsWith('/') && !p.startsWith('//') && p.length <= 300 ? p : null;
}

export async function findMyPendingRequest(path: string): Promise<AccessRequest | null> {
  const safe = sanitizePath(path);
  if (!safe) return null;
  const { data, error } = await supabase
    .from('access_requests')
    .select(COLUMNS)
    .eq('path', safe)
    .eq('status', 'pending')
    .maybeSingle();
  if (error) return null;
  return (data as unknown as AccessRequest | null) ?? null;
}

export type RequestAccessResult = { ok: true } | { ok: false; reason: 'invalid-path' | 'duplicate' | 'failed' };

export async function requestAccess(input: { path: string; area: string; message?: string; name?: string | null }): Promise<RequestAccessResult> {
  const path = sanitizePath(input.path);
  if (!path) return { ok: false, reason: 'invalid-path' };
  const message = input.message?.trim().slice(0, MAX_ACCESS_MESSAGE) || null;
  const { error } = await supabase.from('access_requests').insert({
    path,
    area: input.area.slice(0, 64),
    message,
    requester_name: input.name?.slice(0, 120) ?? null,
  });
  if (!error) return { ok: true };
  return { ok: false, reason: error.code === '23505' ? 'duplicate' : 'failed' };
}

/** Reviewers only (RLS returns just the caller's own rows to everyone else). */
export async function listPendingForReview(): Promise<AccessRequest[]> {
  const { data, error } = await supabase
    .from('access_requests')
    .select(COLUMNS)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data as unknown as AccessRequest[];
}

export async function resolveAccessRequest(id: string, status: Exclude<AccessRequestStatus, 'pending'>): Promise<boolean> {
  const { error } = await supabase.from('access_requests').update({ status }).eq('id', id);
  return !error;
}

export async function reportBrokenLink(path: string, referrer: string | null): Promise<boolean> {
  const safe = sanitizePath(path);
  if (!safe) return false;
  const { error } = await supabase.rpc('report_broken_link', { p_path: safe, p_referrer: referrer });
  return !error;
}

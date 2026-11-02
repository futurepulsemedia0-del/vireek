import type { ApiError } from './types';

const BASE = `${(import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''}/functions/v1/audit-api`;

export class AuditApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** POST {action, ...body}. Tokens travel in the body (never in a URL we send), and nothing is cached. */
export async function auditCall<T>(action: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }), signal, cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    throw new AuditApiError(0, 'network', 'We could not reach the server. Check your connection and try again.');
  }
  const json = (await res.json().catch(() => ({}))) as T & ApiError;
  if (!res.ok) throw new AuditApiError(res.status, json.error ?? 'error', json.message ?? 'Something went wrong. Please try again.');
  return json;
}

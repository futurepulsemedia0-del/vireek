// src/lib/dsarApi.ts
//
// Network layer for the public /data-request flow. Talks to the
// `dsar-request` edge function with the anon key (the endpoint is public by
// design — identity is proven by the emailed one-time code, not a session).
// Uses fetch rather than supabase.functions.invoke so non-2xx responses keep
// their JSON body (field errors, attempts left) and status code.

import type { DsarFormValues, DsarKind, DsarOutcome } from '@/lib/dsar';

const baseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export class DsarApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly fieldErrors?: Record<string, string>,
    readonly attemptsLeft?: number,
  ) {
    super(message);
    this.name = 'DsarApiError';
  }
}

async function call<T>(payload: Record<string, unknown>): Promise<T> {
  if (!baseUrl || !anonKey) {
    throw new DsarApiError('This form is temporarily unavailable.', 'not_configured', 503);
  }
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/functions/v1/dsar-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new DsarApiError('Network error. Check your connection and try again.', 'network', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    throw new DsarApiError(
      data?.message ?? 'Something went wrong. Please try again.',
      data?.code ?? 'server_error',
      res.status,
      data?.fieldErrors,
      data?.attemptsLeft,
    );
  }
  return data as T;
}

export interface SubmitResult { requestId: string; reference: string; resendAfterSeconds: number }
export interface VerifyResult { reference: string; kind: DsarKind; dueAt: string; outcome: DsarOutcome }

/** `website` is the honeypot: real users never fill it, bots usually do. */
export function submitDsar(values: DsarFormValues, honeypot: string): Promise<SubmitResult> {
  return call<SubmitResult>({
    action: 'submit',
    kind: values.kind,
    email: values.email.trim(),
    fullName: values.fullName.trim(),
    relationship: values.relationship,
    region: values.region,
    details: values.details.trim(),
    confirmed: values.confirmed,
    website: honeypot,
  });
}

export const verifyDsar = (requestId: string, email: string, code: string) =>
  call<VerifyResult>({ action: 'verify', requestId, email: email.trim(), code });

export const resendDsarCode = (requestId: string, email: string) =>
  call<{ resendAfterSeconds: number }>({ action: 'resend', requestId, email: email.trim() });

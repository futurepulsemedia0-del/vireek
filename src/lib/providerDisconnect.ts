// src/lib/providerDisconnect.ts
//
// Client-side contract for the `provider-disconnect` edge function. Pure (no React, no Supabase import) so it can be
// unit-tested; the UI passes in `supabase.functions.invoke`.

export type DisconnectableProvider =
  | 'jobber'
  | 'service_titan'
  | 'housecall_pro'
  | 'hubspot'
  | 'google_calendar'
  | 'google_business_profile';

export type InvokeFn = (name: string, options: { body: unknown }) => Promise<{ data: unknown; error: unknown }>;

export type DisconnectResult = { ok: true; revoked: boolean | null } | { ok: false; message: string };

const GENERIC_ERROR = 'Could not disconnect. Please try again.';

/** supabase-js returns `error.context` (a Response) for non-2xx replies; the useful message is in its JSON body. */
async function messageFrom(data: unknown, error: unknown): Promise<string> {
  const fromData = (data as { error?: unknown } | null)?.error;
  if (typeof fromData === 'string' && fromData) return fromData;
  const ctx = (error as { context?: { json?: () => Promise<unknown> } } | null)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body = (await ctx.json()) as { error?: unknown } | null;
      if (typeof body?.error === 'string' && body.error) return body.error;
    } catch {
      /* fall through */
    }
  }
  return GENERIC_ERROR;
}

export async function disconnectProvider(
  invoke: InvokeFn,
  provider: DisconnectableProvider,
  deleteImportedData = false,
): Promise<DisconnectResult> {
  try {
    const { data, error } = await invoke('provider-disconnect', { body: { provider, delete_imported_data: deleteImportedData } });
    const ok = (data as { ok?: unknown } | null)?.ok === true;
    if (error || !ok) return { ok: false, message: await messageFrom(data, error) };
    const revoked = (data as { revoked?: unknown }).revoked;
    return { ok: true, revoked: typeof revoked === 'boolean' ? revoked : null };
  } catch {
    return { ok: false, message: GENERIC_ERROR };
  }
}

/**
 * Honest follow-up for the user. Vireek only revokes at Google; for every other provider the user should also remove
 * the app on the provider's side (we have no verified remote-revocation endpoint for them).
 */
export function followUpNote(providerLabel: string, provider: DisconnectableProvider, revoked: boolean | null): string | null {
  if (provider === 'google_calendar' || provider === 'google_business_profile') {
    return revoked === true ? null : 'Google did not confirm the revocation. You can also remove Vireek at myaccount.google.com/permissions.';
  }
  return `Vireek no longer holds your ${providerLabel} credentials. To fully revoke access, also remove Vireek from your ${providerLabel} connected apps.`;
}

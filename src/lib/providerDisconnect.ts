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

export type RevocationOutcome = 'revoked' | 'failed' | 'unsupported' | 'no_credentials';

export interface DisconnectSuccess {
  ok: true;
  /** true = provider confirmed, false = attempted but not confirmed, null = nothing to attempt / unsupported. */
  revoked: boolean | null;
  revocation: RevocationOutcome;
  /** True when the user must still remove the credential / app at the provider. */
  manualActionRequired: boolean;
}

export type DisconnectResult = DisconnectSuccess | { ok: false; message: string };

const OUTCOMES: readonly RevocationOutcome[] = ['revoked', 'failed', 'unsupported', 'no_credentials'];

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
    const d = data as { revoked?: unknown; revocation?: unknown; manual_action_required?: unknown };
    const revoked = typeof d.revoked === 'boolean' ? d.revoked : null;
    // Older deployments of the edge function only return `revoked`; derive the rest so the UI stays honest.
    const revocation = OUTCOMES.includes(d.revocation as RevocationOutcome)
      ? (d.revocation as RevocationOutcome)
      : revoked === true
        ? 'revoked'
        : revoked === false
          ? 'failed'
          : 'unsupported';
    const manualActionRequired = typeof d.manual_action_required === 'boolean' ? d.manual_action_required : revoked !== true;
    return { ok: true, revoked, revocation, manualActionRequired };
  } catch {
    return { ok: false, message: GENERIC_ERROR };
  }
}

const GOOGLE = 'https://myaccount.google.com/permissions';

/**
 * Honest follow-up shown after a disconnect. Vireek has already deleted its own copy of the credentials; this says
 * what, if anything, the user still has to do at the provider. Based on the provider's documented capabilities:
 *  - Google / Jobber: Vireek revokes remotely; a note is only shown when the provider did not confirm.
 *  - HubSpot: only the refresh token can be deleted remotely; the app stays installed until the user removes it.
 *  - ServiceTitan / Housecall Pro: no documented revocation endpoint; the user deletes the credential themselves.
 */
export function followUpNote(
  providerLabel: string,
  provider: DisconnectableProvider,
  outcome: Pick<DisconnectSuccess, 'revoked' | 'revocation' | 'manualActionRequired'>,
): string | null {
  const confirmed = outcome.revocation === 'revoked';
  switch (provider) {
    case 'google_calendar':
    case 'google_business_profile':
      return confirmed ? null : `Google did not confirm the revocation. You can also remove Vireek at ${GOOGLE.replace('https://', '')}.`;
    case 'jobber':
      return confirmed ? null : `${providerLabel} did not confirm the disconnect. To fully revoke access, also remove Vireek from your ${providerLabel} connected apps.`;
    case 'hubspot':
      return confirmed
        ? `${providerLabel} invalidated Vireek's refresh token. To uninstall the app completely, also remove Vireek from your ${providerLabel} connected apps.`
        : `${providerLabel} did not confirm the revocation. To fully revoke access, remove Vireek from your ${providerLabel} connected apps.`;
    case 'service_titan':
      return `Vireek no longer holds your ${providerLabel} credentials. ${providerLabel} has no remote revocation, so also delete the API application credentials in ${providerLabel}.`;
    case 'housecall_pro':
      return `Vireek no longer holds your ${providerLabel} API key. ${providerLabel} has no remote revocation, so also delete the key in ${providerLabel} (My Apps → API Key Management).`;
    default:
      return outcome.manualActionRequired
        ? `Vireek no longer holds your ${providerLabel} credentials. To fully revoke access, also remove Vireek from your ${providerLabel} connected apps.`
        : null;
  }
}

/**
 * Microsoft 365 / Outlook calendar sync — client-side types and pure helpers.
 * No network or Supabase imports here so everything is trivially testable.
 */

export type MicrosoftCalendarScope = 'office' | 'technician';

export interface MicrosoftCalendarConnection {
  id: string;
  scope: MicrosoftCalendarScope;
  team_member_id: string | null;
  user_id: string;
  ms_email: string | null;
  status: 'connected' | 'error' | 'disconnected';
  last_synced_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  consecutive_failures: number;
  connected_at: string;
  team_member?: { member_name: string | null; member_email: string | null } | null;
}

export type ConnectionTone = 'ok' | 'warn' | 'error';

export interface ConnectionDescription {
  tone: ConnectionTone;
  label: string;
  detail: string;
}

/** Redirect `reason` codes written by microsoft-calendar-oauth-callback. */
const OAUTH_REASON_COPY: Record<string, string> = {
  access_denied: 'Microsoft sign-in was cancelled. Connect again whenever you are ready.',
  admin_consent_required:
    'Your organization requires an administrator to approve Vireek first. Ask your Microsoft 365 admin to grant consent, then try again.',
  not_authorized: 'Your Vireek role does not allow connecting this calendar.',
  invalid_state: 'The connection link expired. Please start again.',
  missing_code_or_state: 'Microsoft did not return a valid response. Please try again.',
  no_refresh_token: 'Microsoft did not grant ongoing access. Please try again and accept all permissions.',
  calendar_unavailable: 'No calendar was found on that Microsoft account (is a mailbox licensed?).',
};

export function oauthReasonMessage(reason: string | null | undefined): string {
  return (reason && OAUTH_REASON_COPY[reason]) || 'Could not connect Microsoft 365 — please try again.';
}

export function formatRelativeSync(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'Not synced yet';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Not synced yet';
  const sec = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (sec < 60) return 'Synced just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `Synced ${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Synced ${hr} h ago`;
  return `Synced ${Math.floor(hr / 24)} d ago`;
}

export function describeConnection(
  c: Pick<MicrosoftCalendarConnection, 'status' | 'last_synced_at' | 'last_error_code' | 'consecutive_failures'>,
  now: Date = new Date(),
): ConnectionDescription {
  if (c.status === 'error') {
    const revoked = c.last_error_code === 'token_revoked' || c.last_error_code === 'provider_auth_failed';
    return {
      tone: 'error',
      label: 'Needs reconnect',
      detail: revoked
        ? 'Microsoft access was revoked or expired. Reconnect to resume syncing.'
        : 'Syncing stopped after repeated errors. Reconnect to resume.',
    };
  }
  if (c.status === 'disconnected') return { tone: 'warn', label: 'Disconnected', detail: 'Not syncing.' };
  if (c.consecutive_failures > 0) {
    return { tone: 'warn', label: 'Retrying', detail: `Last attempt failed (${c.consecutive_failures}). Vireek will retry automatically.` };
  }
  return { tone: 'ok', label: 'Connected', detail: formatRelativeSync(c.last_synced_at, now) };
}

export function connectionTitle(c: Pick<MicrosoftCalendarConnection, 'scope' | 'team_member'>): string {
  if (c.scope === 'office') return 'Office calendar';
  return c.team_member?.member_name?.trim() || c.team_member?.member_email || 'Technician calendar';
}

/** Office first, then technicians alphabetically. */
export function sortConnections<T extends Pick<MicrosoftCalendarConnection, 'scope' | 'team_member'>>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'office' ? -1 : 1;
    return connectionTitle(a).localeCompare(connectionTitle(b));
  });
}

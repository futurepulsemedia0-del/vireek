/**
 * Integration Recovery — human-readable failure reasons + health helpers.
 * Stores recovery metadata inside integrations.config (jsonb) so no migration
 * is required. Backend/OAuth workers should write the same shape when a
 * token expires or a provider webhook fails.
 */

import type { Integration } from '@/lib/supabase';

export type IntegrationErrorCode =
  | 'token_expired'
  | 'token_revoked'
  | 'refresh_failed'
  | 'provider_unreachable'
  | 'provider_auth_failed'
  | 'scope_missing'
  | 'webhook_delivery_failed'
  | 'webhook_invalid_url'
  | 'rate_limited'
  | 'account_suspended'
  | 'manual_disconnect'
  | 'unknown';

export interface IntegrationFailureMeta {
  error_code: IntegrationErrorCode;
  error_message?: string;
  failed_at?: string; // ISO
  /** Optional provider HTTP status or internal code */
  provider_status?: number | string;
  /** Hint written by the worker, e.g. "Re-authorize Google Calendar" */
  recovery_hint?: string;
}

export interface IntegrationHealth {
  status: Integration['status'];
  isHealthy: boolean;
  /** Needs user action (error, or disconnected with a non-manual reason) */
  needsRecovery: boolean;
  failure: IntegrationFailureMeta | null;
  title: string;
  detail: string;
  primaryActionLabel: string;
}

const REASON_COPY: Record<
  IntegrationErrorCode,
  { title: string; detail: string; action: string }
> = {
  token_expired: {
    title: 'Access expired',
    detail:
      'The connection token expired. Reconnect to grant access again — no data was deleted.',
    action: 'Reconnect',
  },
  token_revoked: {
    title: 'Access revoked',
    detail:
      'Access was revoked in the other app (or by an admin). Reconnect to restore the link.',
    action: 'Reconnect',
  },
  refresh_failed: {
    title: 'Could not refresh access',
    detail:
      'We could not renew the connection automatically. Re-authorize to continue syncing.',
    action: 'Re-authorize',
  },
  provider_unreachable: {
    title: 'Provider unreachable',
    detail:
      'The other service did not respond. This is often temporary — retry, or reconnect if it keeps failing.',
    action: 'Retry connection',
  },
  provider_auth_failed: {
    title: 'Authentication failed',
    detail:
      'The provider rejected our credentials. Reconnect with an account that still has access.',
    action: 'Reconnect',
  },
  scope_missing: {
    title: 'Missing permissions',
    detail:
      'Required permissions were not granted (or were removed). Reconnect and approve all requested scopes.',
    action: 'Fix permissions',
  },
  webhook_delivery_failed: {
    title: 'Webhook delivery failed',
    detail:
      'Your endpoint returned an error or timed out. Check the URL, TLS certificate, and that it accepts POST JSON.',
    action: 'Fix webhook',
  },
  webhook_invalid_url: {
    title: 'Invalid webhook URL',
    detail: 'The saved URL is empty or not a valid HTTPS endpoint. Update it and save again.',
    action: 'Update URL',
  },
  rate_limited: {
    title: 'Rate limited by provider',
    detail:
      'The other service temporarily limited requests. Wait a few minutes, then retry the connection.',
    action: 'Retry',
  },
  account_suspended: {
    title: 'Provider account issue',
    detail:
      'The connected account appears suspended or locked on the provider side. Resolve it there, then reconnect here.',
    action: 'Reconnect',
  },
  manual_disconnect: {
    title: 'Disconnected',
    detail: 'You disconnected this integration. Connect again whenever you are ready.',
    action: 'Connect',
  },
  unknown: {
    title: 'Connection problem',
    detail: 'Something went wrong with this integration. Reconnect to restore it.',
    action: 'Reconnect',
  },
};

export function parseFailureMeta(config: Record<string, unknown> | null | undefined): IntegrationFailureMeta | null {
  if (!config || typeof config !== 'object') return null;
  const code = config.error_code ?? config.errorCode;
  if (typeof code !== 'string' || !code) {
    // Legacy: only a free-text message
    const msg = config.error_message ?? config.last_error ?? config.error;
    if (typeof msg === 'string' && msg.trim()) {
      return {
        error_code: 'unknown',
        error_message: msg.trim(),
        failed_at: typeof config.failed_at === 'string' ? config.failed_at : undefined,
      };
    }
    return null;
  }
  return {
    error_code: (code as IntegrationErrorCode) in REASON_COPY ? (code as IntegrationErrorCode) : 'unknown',
    error_message: typeof config.error_message === 'string' ? config.error_message : undefined,
    failed_at: typeof config.failed_at === 'string' ? config.failed_at : undefined,
    provider_status: (config.provider_status ?? config.providerStatus) as number | string | undefined,
    recovery_hint: typeof config.recovery_hint === 'string' ? config.recovery_hint : undefined,
  };
}

export function getIntegrationHealth(row: Integration | undefined | null): IntegrationHealth {
  if (!row) {
    return {
      status: 'disconnected',
      isHealthy: false,
      needsRecovery: false,
      failure: null,
      title: 'Not connected',
      detail: 'Connect this integration to start syncing.',
      primaryActionLabel: 'Connect',
    };
  }

  const failure = parseFailureMeta(row.config);

  if (row.status === 'connected') {
    return {
      status: 'connected',
      isHealthy: true,
      needsRecovery: false,
      failure: null,
      title: 'Connected',
      detail: 'Working normally.',
      primaryActionLabel: 'Disconnect',
    };
  }

  if (row.status === 'error') {
    const code = failure?.error_code ?? 'unknown';
    const copy = REASON_COPY[code];
    return {
      status: 'error',
      isHealthy: false,
      needsRecovery: true,
      failure: failure ?? { error_code: 'unknown' },
      title: copy.title,
      detail: copy.detail,
      primaryActionLabel: copy.action,
    };
  }

  // row.status === 'disconnected'
  // Distinguish a user-initiated disconnect (quiet, no recovery banner)
  // from an automatic one caused by a real failure (needs recovery).
  if (failure && failure.error_code !== 'manual_disconnect') {
    const copy = REASON_COPY[failure.error_code];
    return {
      status: 'disconnected',
      isHealthy: false,
      needsRecovery: true,
      failure,
      title: copy.title,
      detail: copy.detail,
      primaryActionLabel: copy.action,
    };
  }

  const copy = REASON_COPY.manual_disconnect;
  return {
    status: 'disconnected',
    isHealthy: false,
    needsRecovery: false,
    failure: failure ?? null,
    title: copy.title,
    detail: copy.detail,
    primaryActionLabel: copy.action,
  };
}

/** Integrations whose current health needs user action (error, or an auto-disconnect). */
export function listUnhealthyIntegrations(integrations: Integration[]): Integration[] {
  return integrations.filter((row) => getIntegrationHealth(row).needsRecovery);
}

/** "5m ago" / "3h ago" / "2d ago" style relative time for a failure timestamp. */
export function formatFailedAt(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;

  return date.toLocaleDateString();
}

/**
 * Returns a copy of an integration's config with all failure-tracking keys
 * (current and legacy field names) stripped — used when reconnecting or
 * successfully saving, so stale error state doesn't linger.
 */
export function clearFailureConfig(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {};
  const next = { ...config };
  delete next.error_code;
  delete next.errorCode;
  delete next.error_message;
  delete next.last_error;
  delete next.error;
  delete next.failed_at;
  delete next.provider_status;
  delete next.providerStatus;
  delete next.recovery_hint;
  return next;
}

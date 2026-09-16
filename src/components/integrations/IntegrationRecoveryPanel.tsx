import { AlertCircle, RefreshCw, Loader2 } from 'lucide-react';
import type { Integration } from '@/lib/supabase';
import {
  formatFailedAt,
  getIntegrationHealth,
} from '@/lib/integrationRecovery';

interface Props {
  row: Integration | undefined;
  integrationName: string;
  recovering: boolean;
  onRecover: () => void;
}

/**
 * Inline recovery block shown on a card when status is error
 * (or disconnected with an automatic failure reason).
 */
export function IntegrationRecoveryPanel({
  row,
  integrationName,
  recovering,
  onRecover,
}: Props) {
  const health = getIntegrationHealth(row);
  if (!health.needsRecovery) return null;

  const when = formatFailedAt(health.failure?.failed_at ?? undefined);

  return (
    <div className="mt-3 rounded-xl border border-danger-500/30 bg-danger-500/5 px-3 py-3">
      <div className="flex items-start gap-2.5">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-danger-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">{health.title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">{health.detail}</p>
          {when && (
            <p className="mt-1 text-[11px] text-text-secondary/70">Detected {when}</p>
          )}
          {health.failure?.error_code && health.failure.error_code !== 'unknown' && (
            <p className="mt-1 font-mono text-[10px] text-text-secondary/60">
              code: {health.failure.error_code}
              {health.failure.provider_status != null
                ? ` · provider: ${health.failure.provider_status}`
                : ''}
            </p>
          )}
          <button
            type="button"
            onClick={onRecover}
            disabled={recovering}
            className="focus-ring mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {recovering ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            {recovering ? `Fixing ${integrationName}…` : health.primaryActionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

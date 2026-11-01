import { RefreshCw, WifiOff } from 'lucide-react';
import { useTrustT } from '@/hooks/useTrustT';
import { relativeAge, type FreshnessDecision } from '@/lib/trust/freshness';

interface Props {
  lastUpdatedAt: number | null;
  now: number;
  decision: FreshnessDecision;
  refreshing: boolean;
  onRefresh: () => void;
  className?: string;
}

/** "Updated 2 min ago" + refresh control + a subtle stale badge (never colour-only: icon + text). */
export function FreshnessBadge({ lastUpdatedAt, now, decision, refreshing, onRefresh, className = '' }: Props) {
  const { t, language } = useTrustT();
  let when = t('fresh.justNow');
  if (lastUpdatedAt != null) {
    const a = relativeAge(lastUpdatedAt, now);
    if (!a.justNow) when = new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(a.value, a.unit);
  }
  const staleText = decision.reason ? t(`fresh.${decision.reason}`) : '';

  return (
    <div className={`inline-flex flex-wrap items-center gap-2 text-xs text-text-secondary ${className}`}>
      <span>{lastUpdatedAt == null ? '' : t('fresh.updated', { when })}</span>
      {decision.stale && (
        <span role="status" title={staleText} className="inline-flex items-center gap-1 rounded-full bg-warning-500/10 px-2 py-0.5 font-medium text-warning-500">
          {decision.reason === 'offline' && <WifiOff size={12} aria-hidden="true" />}
          {t('fresh.stale')}
          <span className="sr-only"> — {staleText}</span>
        </span>
      )}
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        aria-label={refreshing ? t('fresh.refreshing') : t('fresh.refresh')}
        className="focus-ring rounded-md p-1 text-text-secondary hover:text-text-primary disabled:opacity-60"
      >
        <RefreshCw size={14} className={refreshing ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
      </button>
    </div>
  );
}

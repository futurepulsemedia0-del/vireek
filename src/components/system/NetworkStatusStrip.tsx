import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, CloudOff, Gauge, Loader2, RefreshCw, X } from 'lucide-react';
import { useConnectivity } from '@/contexts/ConnectivityContext';
import { useNetState, useSlowConnection, useSyncSnapshot } from '@/hooks/useNetState';
import { pickStrip, RECOVERED_FLASH_MS, type StripKind } from '@/lib/net/netState';

const ICON: Record<StripKind, typeof Gauge> = {
  degraded: CloudOff,
  slow: Loader2,
  syncing: RefreshCw,
  recovered: CheckCircle2,
  dataSaver: Gauge,
};

/**
 * Floating (never layout-shifting) status for client-observed network trouble.
 * Offline / maintenance / server-reported degraded mode keep their existing banners.
 */
export function NetworkStatusStrip() {
  const { t } = useTranslation();
  const { isOnline, mode } = useConnectivity();
  const net = useNetState();
  const slowConnection = useSlowConnection();
  const { pending, syncing } = useSyncSnapshot();
  const [dataSaverDismissed, setDataSaverDismissed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (net.recoveredAt === null) return;
    setNow(Date.now());
    const id = window.setTimeout(() => setNow(Date.now()), RECOVERED_FLASH_MS + 50);
    return () => window.clearTimeout(id);
  }, [net.recoveredAt]);

  if (!isOnline || mode === 'maintenance' || mode === 'degraded') return null;
  const kind = pickStrip({ net, now, slowConnection, syncing, pending, dataSaverDismissed });
  if (!kind) return null;

  const Icon = ICON[kind];
  const text =
    kind === 'syncing'
      ? { title: t('net.pending', { count: pending }), body: t('net.syncing') }
      : kind === 'recovered'
        ? { title: t('net.recovered'), body: '' }
        : kind === 'dataSaver'
          ? { title: t('net.dataSaver'), body: '' }
          : { title: t(`net.${kind}.title`), body: t(`net.${kind}.body`) };
  const spin = kind === 'slow' || kind === 'syncing' ? 'motion-safe:animate-spin' : '';

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[90] flex justify-center px-3">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-primary shadow-card dark:shadow-card-dark"
      >
        <Icon size={16} aria-hidden="true" className={`mt-0.5 shrink-0 text-warning-500 ${spin}`} />
        <div className="min-w-0">
          <p className="font-semibold">{text.title}</p>
          {text.body ? <p className="text-text-secondary">{text.body}</p> : null}
        </div>
        {kind === 'dataSaver' ? (
          <button
            type="button"
            onClick={() => setDataSaverDismissed(true)}
            aria-label={t('net.update.later')}
            className="focus-ring -me-1 ms-1 shrink-0 rounded-md p-1 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

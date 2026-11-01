import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { applyServiceWorkerUpdate, SW_UPDATE_EVENT } from '@/lib/pwa/swUpdate';

/** "A new version is available" prompt. Never reloads on its own, so no work is lost. */
export function UpdatePrompt() {
  const { t } = useTranslation();
  const [worker, setWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    const onUpdate = (e: Event) => setWorker((e as CustomEvent<ServiceWorker>).detail);
    window.addEventListener(SW_UPDATE_EVENT, onUpdate);
    return () => window.removeEventListener(SW_UPDATE_EVENT, onUpdate);
  }, []);

  if (!worker) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[95] flex justify-center px-3 pb-[env(safe-area-inset-bottom)]">
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-auto flex max-w-md flex-wrap items-center gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-primary shadow-card dark:shadow-card-dark"
      >
        <RefreshCw size={16} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="font-medium">{t('net.update.title')}</span>
        <div className="ms-auto flex gap-2">
          <button
            type="button"
            onClick={() => setWorker(null)}
            className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-text-primary hover:bg-bg-tertiary"
          >
            {t('net.update.later')}
          </button>
          <button
            type="button"
            onClick={() => applyServiceWorkerUpdate(worker)}
            className="focus-ring rounded-lg bg-cta px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
          >
            {t('net.update.action')}
          </button>
        </div>
      </div>
    </div>
  );
}

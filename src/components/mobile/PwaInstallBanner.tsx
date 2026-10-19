import { useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePwaInstall } from '@/hooks/usePwaInstall';
import { tapHaptic } from '@/lib/pwa/tapHaptic';

export function PwaInstallBanner() {
  const { t } = useTranslation('dashboard');
  const { visible, canPrompt, install, dismiss } = usePwaInstall();
  const [showSteps, setShowSteps] = useState(false);

  if (!visible) return null;

  const onPrimary = () => {
    tapHaptic();
    if (canPrompt) void install();
    else setShowSteps((v) => !v); // iOS: no prompt API, show instructions
  };

  return (
    <section
      aria-label={t('pwa.install.title', { defaultValue: 'Install Vireek' })}
      className="mb-4 flex items-start gap-3 rounded-2xl border border-border bg-bg-secondary p-4 shadow-sm lg:hidden print:hidden"
    >
      <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
        <Download size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-primary">
          {t('pwa.install.title', { defaultValue: 'Install Vireek' })}
        </p>
        <p className="mt-0.5 text-sm text-text-secondary">
          {t('pwa.install.body', {
            defaultValue: 'Add Vireek to your home screen for one-tap access, full-screen use and offline support.',
          })}
        </p>
        {showSteps && !canPrompt && (
          <p className="mt-2 flex items-start gap-2 rounded-xl bg-bg-tertiary px-3 py-2 text-sm text-text-primary">
            <Share size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
            <span>
              {t('pwa.install.iosSteps', {
                defaultValue: 'Tap the Share button, then choose “Add to Home Screen”.',
              })}
            </span>
          </p>
        )}
        <button
          type="button"
          onClick={onPrimary}
          className="focus-ring mt-3 inline-flex min-h-12 touch-manipulation items-center justify-center rounded-xl bg-accent px-5 text-sm font-semibold text-white transition active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          {canPrompt
            ? t('pwa.install.cta', { defaultValue: 'Install' })
            : t('pwa.install.howTo', { defaultValue: 'How to install' })}
        </button>
      </div>
      <button
        type="button"
        onClick={() => dismiss()}
        aria-label={t('pwa.install.dismiss', { defaultValue: 'Not now' })}
        className="focus-ring -mr-1 -mt-1 flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl text-text-secondary hover:text-text-primary"
      >
        <X size={18} aria-hidden="true" />
      </button>
    </section>
  );
}

import { useId, useState } from 'react';
import { Download, Share, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePwaInstall } from '@/hooks/usePwaInstall';
import { getStoreLinks } from '@/lib/appLinks';
import { tapHaptic } from '@/lib/pwa/tapHaptic';

export type AppInstallCtaVariant = 'compact' | 'banner';

interface Props {
  variant?: AppInstallCtaVariant;
  className?: string;
}

const PILL =
  'focus-ring inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3.5 text-sm font-medium text-text-secondary transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-accent/40 hover:text-accent motion-reduce:transition-none motion-reduce:hover:translate-y-0';
const SOLID =
  'focus-ring inline-flex min-h-12 touch-manipulation items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-on-accent transition hover:brightness-110 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100';

export function AppInstallCta({ variant = 'compact', className = '' }: Props) {
  const { t } = useTranslation();
  const { installed, canPrompt, ios, install } = usePwaInstall();
  const [showSteps, setShowSteps] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const stepsId = useId();

  // نصب‌شده، داخل اپ Capacitor، یا همین الان قبول کرده: چیزی نشان نده.
  if (installed || accepted) return null;

  const stepsVisible = showSteps && !canPrompt;

  const onInstall = async () => {
    tapHaptic();
    if (canPrompt) {
      const outcome = await install();
      if (outcome === 'accepted') setAccepted(true);
      else if (outcome === 'unavailable') setShowSteps(true);
      return;
    }
    setShowSteps((v) => !v); // iOS و مرورگرهای بدون prompt: راهنمای دستی
  };

  const stepsText = ios
    ? t('appInstall.stepsIos', { defaultValue: 'Tap the Share button, then choose “Add to Home Screen”.' })
    : t('appInstall.stepsOther', {
        defaultValue: 'Open your browser menu, then choose “Install app” or “Add to Home screen”.',
      });

  const steps = stepsVisible ? (
    <p
      id={stepsId}
      role="status"
      className="mt-3 flex items-start gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
    >
      <Share size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <span>{stepsText}</span>
    </p>
  ) : null;

  const storeLinks = getStoreLinks().map((link) => (
    <a
      key={link.id}
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('appInstall.storeAria', {
        defaultValue: 'Download Vireek on {{store}}',
        store: link.label,
      })}
      className={PILL}
    >
      <Smartphone size={16} aria-hidden="true" />
      {link.label}
    </a>
  ));

  const buttonA11y = {
    'aria-expanded': canPrompt ? undefined : showSteps,
    'aria-controls': stepsVisible ? stepsId : undefined,
  };

  if (variant === 'banner') {
    return (
      <section
        aria-label={t('appInstall.title', { defaultValue: 'Take Sarah with you' })}
        className={`flex flex-col gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:flex-row sm:items-center print:hidden ${className}`}
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Smartphone size={22} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-text-primary">
            {t('appInstall.title', { defaultValue: 'Take Sarah with you' })}
          </h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            {t('appInstall.body', {
              defaultValue: 'Missed calls, bookings, and live alerts on your phone. Works on iPhone and Android.',
            })}
          </p>
          {steps}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void onInstall()} className={SOLID} {...buttonA11y}>
            <Download size={16} aria-hidden="true" />
            {t('appInstall.install', { defaultValue: 'Install app' })}
          </button>
          {storeLinks}
        </div>
      </section>
    );
  }

  return (
    <div className={`print:hidden ${className}`}>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void onInstall()} className={PILL} {...buttonA11y}>
          <Smartphone size={16} aria-hidden="true" />
          {t('appInstall.get', { defaultValue: 'Get the app' })}
        </button>
        {storeLinks}
      </div>
      {steps}
    </div>
  );
}

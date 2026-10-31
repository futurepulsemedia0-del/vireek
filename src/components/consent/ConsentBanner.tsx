import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useConsentT } from '@/i18n/consentNamespace';

interface Props {
  onAcceptAll: () => void;
  onReject: () => void;
  onCustomize: () => void;
}

/**
 * First-layer banner. Non-modal on purpose: it never blocks content or traps focus.
 * Fixed positioning => zero layout shift. Accept and Reject are identical in size, style and contrast.
 */
export function ConsentBanner({ onAcceptAll, onReject, onCustomize }: Props) {
  const { t } = useConsentT();
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true));
    // Move focus in only if the visitor has not already focused something (never steal from a form).
    if (document.activeElement === document.body || document.activeElement === null) {
      ref.current?.focus({ preventScroll: true });
    }
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby="consent-banner-title"
      aria-describedby="consent-banner-desc"
      tabIndex={-1}
      className={`fixed inset-x-0 bottom-0 z-[70] max-h-[85vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-text-primary shadow-card outline-none transition duration-300 ease-out motion-reduce:transition-none sm:inset-x-auto sm:bottom-6 sm:start-6 sm:w-[28rem] sm:rounded-2xl ${
        shown ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
      }`}
    >
      <div className="flex items-center gap-2">
        <ShieldCheck size={18} className="text-accent" aria-hidden="true" />
        <h2 id="consent-banner-title" className="text-base font-semibold">
          {t('banner.title')}
        </h2>
      </div>
      <p id="consent-banner-desc" className="mt-2 text-sm leading-relaxed text-text-secondary">
        {t('banner.body')}
      </p>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button type="button" variant="secondary" size="md" onClick={onAcceptAll}>
          {t('banner.accept')}
        </Button>
        <Button type="button" variant="secondary" size="md" onClick={onReject}>
          {t('banner.reject')}
        </Button>
      </div>
      <Button type="button" variant="ghost" size="md" className="mt-2 w-full" onClick={onCustomize}>
        {t('banner.customize')}
      </Button>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <Link to="/privacy" className="focus-ring inline-flex min-h-[44px] items-center rounded text-accent underline-offset-2 hover:underline">
          {t('banner.privacy')}
        </Link>
        <Link to="/cookies" className="focus-ring inline-flex min-h-[44px] items-center rounded text-accent underline-offset-2 hover:underline">
          {t('banner.cookies')}
        </Link>
      </div>
    </div>
  );
}

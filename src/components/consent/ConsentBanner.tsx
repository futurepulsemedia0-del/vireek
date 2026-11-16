import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useConsentT } from '@/i18n/consentNamespace';

interface Props {
  /** True during the exit animation (the manager unmounts the banner right after). */
  leaving: boolean;
  onAcceptAll: () => void;
  onReject: () => void;
  onCustomize: () => void;
  /** X button or Escape: NOT a consent decision. Optional cookies stay off. */
  onDismiss: () => void;
}

/**
 * First-layer banner. Non-modal on purpose: it never blocks content, never traps focus and never
 * takes focus on its own (the manager announces it through a polite live region instead).
 * Fixed positioning => zero layout shift. Accept and Reject share one component, variant, size and
 * grid cell, so they are identical in size, style and contrast. Customize is a clearly visible third option.
 */
export function ConsentBanner({ leaving, onAcceptAll, onReject, onCustomize, onDismiss }: Props) {
  const { t } = useConsentT();
  const ref = useRef<HTMLElement>(null);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Publish the banner height so floating launchers can lift themselves (see "Cookie banner" in index.css).
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--vk-consent-h', `${Math.ceil(el.getBoundingClientRect().height) + 16}px`);
    publish();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--vk-consent-h');
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onDismiss();
  };

  const visible = entered && !leaving;

  return (
    <section
      ref={ref}
      id="consent-banner"
      aria-label={t('banner.region')}
      aria-describedby="consent-banner-desc"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={`fixed inset-x-0 bottom-0 z-[70] max-h-[45dvh] overflow-y-auto overscroll-contain rounded-t-2xl border border-b-0 border-border bg-bg-secondary px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3 text-text-primary shadow-card-hover outline-none transition duration-300 ease-out motion-reduce:transition-none dark:shadow-card-hover-dark sm:inset-x-auto sm:bottom-6 sm:start-6 sm:max-h-[calc(100dvh-3rem)] sm:w-[26rem] sm:rounded-2xl sm:border-b sm:p-5 print:hidden ${
        visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0'
      }`}
    >
      <div aria-hidden="true" className="mx-auto mb-3 h-1 w-9 rounded-full bg-border-strong sm:hidden" />
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <ShieldCheck size={18} aria-hidden="true" />
        </span>
        <h2 id="consent-banner-title" className="min-w-0 flex-1 pt-1.5 text-base font-semibold leading-snug">
          {t('banner.title')}
        </h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('banner.close')}
          className="focus-ring -me-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary motion-reduce:transition-none"
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <p id="consent-banner-desc" className="mt-2 text-sm leading-relaxed text-text-secondary">
        {t('banner.body')}
      </p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Button type="button" variant="secondary" size="md" fullWidth onClick={onAcceptAll}>
          {t('banner.accept')}
        </Button>
        <Button type="button" variant="secondary" size="md" fullWidth onClick={onReject}>
          {t('banner.reject')}
        </Button>
      </div>
      <Button type="button" variant="ghost" size="md" fullWidth className="mt-2" onClick={onCustomize}>
        {t('banner.customize')}
      </Button>
      <div className="mt-2 flex flex-wrap gap-x-4 text-xs">
        <Link to="/privacy" className="focus-ring inline-flex min-h-[44px] items-center rounded text-accent underline-offset-2 hover:underline">
          {t('banner.privacy')}
        </Link>
        <Link to="/cookies" className="focus-ring inline-flex min-h-[44px] items-center rounded text-accent underline-offset-2 hover:underline">
          {t('banner.cookies')}
        </Link>
      </div>
    </section>
  );
}

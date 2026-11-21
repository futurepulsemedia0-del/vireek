import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, X } from 'lucide-react';
import { motionClass, pressable } from '@/lib/ui/interaction';
import { useConsentT } from '@/i18n/consentNamespace';

// Accept and Reject MUST render from the SAME class string: equal size, colour and contrast (asserted in ConsentManager.test.tsx).
const CHOICE_BASE = `focus-ring inline-flex min-h-touch w-full items-center justify-center rounded-control px-4 py-3 text-center text-sm font-semibold leading-tight ${motionClass} ${pressable}`;
const CHOICE_EQUAL = `${CHOICE_BASE} bg-on-inverse text-surface-inverse hover:brightness-90`;
const CHOICE_OUTLINE = `${CHOICE_BASE} border border-border-inverse text-on-inverse hover:brightness-125`;

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
  const show = visible ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0';
  const BTN = `focus-ring inline-flex min-h-touch w-full items-center justify-center rounded-control px-4 py-2.5 text-center text-sm font-semibold leading-tight ${motionClass} ${pressable}`;
  const linkCls = 'focus-ring inline-flex min-h-touch items-center rounded underline underline-offset-2 transition-colors motion-reduce:transition-none';
  const legal = (tone: string) => (
    <>
      <Link to="/privacy" className={`${linkCls} ${tone}`}>{t('banner.privacy')}</Link>
      <Link to="/cookies" className={`${linkCls} ${tone}`}>{t('banner.cookies')}</Link>
    </>
  );
  const common = {
    ref,
    id: 'consent-banner',
    'aria-label': t('banner.region'),
    'aria-describedby': 'consent-banner-desc',
    tabIndex: -1,
    onKeyDown,
  } as const;

  const BTN_EQUAL = `${BTN} bg-text-primary text-bg-primary hover:opacity-90`;
  return (
    <section
      {...common}
      className={`fixed inset-x-3 bottom-3 z-[70] max-h-[60dvh] overflow-y-auto overscroll-contain rounded-overlay border border-border bg-bg-primary/90 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-text-primary shadow-elevation-4 outline-none backdrop-blur-xl transition duration-300 ease-out motion-reduce:transition-none sm:inset-x-auto sm:bottom-6 sm:start-6 sm:w-[24rem] print:hidden ${show}`}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-inset bg-gradient-to-br from-brand-from to-brand-to text-on-brand">
          <ShieldCheck size={16} aria-hidden="true" />
        </span>
        <h2 id="consent-banner-title" className="min-w-0 flex-1 text-[0.95rem] font-semibold tracking-tight">{t('banner.title')}</h2>
        <button type="button" onClick={onDismiss} aria-label={t('banner.close')} className="focus-ring -me-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-text-muted transition-colors hover:text-text-primary motion-reduce:transition-none">
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <p id="consent-banner-desc" className="mt-2 text-[0.8125rem] leading-relaxed text-text-secondary">{t('banner.body')}</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={onAcceptAll} className={BTN_EQUAL}>{t('banner.accept')}</button>
        <button type="button" onClick={onReject} className={BTN_EQUAL}>{t('banner.reject')}</button>
      </div>
      <button type="button" onClick={onCustomize} className={`${BTN} mt-2 border border-border text-text-primary hover:bg-bg-tertiary`}>{t('banner.customize')}</button>
      <div className="mt-1 flex flex-wrap gap-x-4 text-xs">{legal('text-text-muted hover:text-text-primary')}</div>
    </section>
  );
}

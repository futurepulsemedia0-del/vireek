import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useConsentT } from '@/i18n/consentNamespace';
import { CONSENT_CATEGORIES, type ConsentCategory, type ConsentChoices } from '@/lib/consent/engine';
import { useConsent } from '@/lib/consent/useConsent';

type CardKey = 'essential' | ConsentCategory;
const CARDS: readonly CardKey[] = ['essential', ...CONSENT_CATEGORIES];
const DETAIL_FIELDS = ['collected', 'purpose', 'retention', 'recipients', 'storage'] as const;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  onClose: (saved: boolean) => void;
}

function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="focus-ring relative inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        aria-hidden="true"
        className={`relative block h-7 w-12 rounded-full border border-border transition-colors duration-200 motion-reduce:transition-none ${
          checked ? 'bg-accent' : 'bg-bg-tertiary'
        }`}
      >
        <span
          className={`absolute top-0.5 block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none start-0.5 ${
            checked ? 'ltr:translate-x-5 rtl:-translate-x-5' : ''
          }`}
        />
      </span>
    </button>
  );
}

export default function PreferenceCenter({ onClose }: Props) {
  const { t, language } = useConsentT();
  const consent = useConsent();
  const uid = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [choices, setChoices] = useState<ConsentChoices>({ ...consent.choices });
  const [open, setOpen] = useState<Partial<Record<CardKey, boolean>>>({});
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const optedOut = consent.signals.gpc || consent.signals.dnt;

  // Modal behavior: initial focus, Tab trap, Esc, scroll lock.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    panel.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.documentElement.style.overflow = previousOverflow;
    };
  }, []);

  const savedAt =
    consent.record && !consent.needsPrompt
      ? (() => {
          try {
            return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(consent.record.timestamp),
            );
          } catch {
            return consent.record.timestamp;
          }
        })()
      : null;

  const finish = (action: () => void) => {
    action();
    onClose(true);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-black/50 sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose(false);
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={`${uid}-desc`}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-bg-secondary text-text-primary shadow-card outline-none sm:max-w-xl sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 id={`${uid}-title`} className="text-lg font-semibold">
              {t('center.title')}
            </h2>
            <p id={`${uid}-desc`} className="mt-1 text-sm text-text-secondary">
              {t('center.intro')}
            </p>
            <p className="mt-2 text-xs text-text-secondary">
              {savedAt ? t('center.lastSaved', { date: savedAt }) : t('center.neverSaved')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onClose(false)}
            aria-label={t('center.close')}
            className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border text-text-secondary hover:text-text-primary"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {CARDS.map((key) => {
            const isEssential = key === 'essential';
            const locked = key === 'marketing' && optedOut;
            const checked = isEssential ? true : locked ? false : choices[key];
            const expanded = open[key] === true;
            const title = t(`categories.${key}.title`);
            return (
              <section key={key} className="rounded-xl border border-border bg-bg-primary p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold">{title}</h3>
                    <p className="mt-1 text-sm text-text-secondary">{t(`categories.${key}.summary`)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-xs font-medium text-text-secondary">
                      {isEssential ? t('center.alwaysOn') : checked ? t('center.on') : t('center.off')}
                    </span>
                    <Switch
                      checked={checked}
                      disabled={isEssential || locked}
                      label={title}
                      onChange={(next) => !isEssential && setChoices((c) => ({ ...c, [key]: next }))}
                    />
                  </div>
                </div>
                {locked && <p className="mt-2 text-xs text-text-secondary">{t('center.signalLocked')}</p>}
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={`${uid}-${key}-details`}
                  onClick={() => setOpen((o) => ({ ...o, [key]: !expanded }))}
                  className="focus-ring mt-2 inline-flex min-h-[44px] items-center gap-1 rounded text-sm font-medium text-accent"
                >
                  {expanded ? t('center.hideDetails') : t('center.showDetails')}
                  <ChevronDown
                    size={16}
                    aria-hidden="true"
                    className={`transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`}
                  />
                </button>
                {expanded && (
                  <dl id={`${uid}-${key}-details`} className="mt-1 space-y-2 text-sm">
                    {DETAIL_FIELDS.map((field) => (
                      <div key={field}>
                        <dt className="font-medium">{t(`center.label.${field}`)}</dt>
                        <dd className="text-text-secondary">{t(`categories.${key}.${field}`)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>
            );
          })}
        </div>

        <div className="border-t border-border px-5 py-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button type="button" variant="secondary" onClick={() => finish(consent.acceptAll)}>
              {t('center.acceptAll')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => finish(consent.rejectNonEssential)}>
              {t('center.rejectAll')}
            </Button>
          </div>
          <Button
            type="button"
            variant="primary"
            className="mt-2 w-full"
            onClick={() => finish(() => consent.saveChoices(optedOut ? { ...choices, marketing: false } : choices))}
          >
            {t('center.save')}
          </Button>
          <div className="mt-2 flex flex-wrap gap-x-4 text-xs">
            <Link to="/privacy" className="focus-ring inline-flex min-h-[44px] items-center rounded text-accent hover:underline">
              {t('banner.privacy')}
            </Link>
            <Link to="/cookies" className="focus-ring inline-flex min-h-[44px] items-center rounded text-accent hover:underline">
              {t('banner.cookies')}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

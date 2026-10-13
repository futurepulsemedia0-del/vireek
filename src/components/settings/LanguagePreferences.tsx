import { useMemo } from 'react';
import { Check, Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAccessibility } from '@/contexts/AccessibilityContext';
import { useDirection } from '@/hooks/useDirection';
import { useFormat } from '@/hooks/useFormat';
import { LANGUAGES, type LanguageCode } from '@/lib/i18n';

/* ------------------------------------------------------------------ */
/*  Account → Language & region                                        */
/*                                                                      */
/*  Writes to the SAME language state the header switcher and the      */
/*  Accessibility widget use (useAccessibility), so there is still one */
/*  source of truth. Selecting a language flips <html lang/dir>,       */
/*  loads that language's dashboard strings, and re-formats dates,     */
/*  numbers and currency — instantly, no reload.                       */
/* ------------------------------------------------------------------ */

export function LanguagePreferences({ className = '' }: { className?: string }) {
  const { t } = useTranslation('dashboard');
  const { language, setLanguage } = useAccessibility();
  const { isRtl } = useDirection();
  const f = useFormat();

  const now = useMemo(() => new Date(), []);

  const previews = [
    { label: t('account.language.previewDate'), value: f.date(now, 'long') },
    { label: t('account.language.previewNumber'), value: f.number(1234567.89) },
    { label: t('account.language.previewCurrency'), value: f.currency(12480, 'USD') },
    { label: t('account.language.previewPercent'), value: f.percent(0.684) },
  ];

  return (
    <section
      aria-labelledby="language-region-title"
      className={`rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark ${className}`}
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary">
          <Languages size={18} aria-hidden="true" />
        </span>
        <div>
          <h2 id="language-region-title" className="text-base font-semibold text-text-primary">
            {t('account.language.title')}
          </h2>
          <p className="text-xs text-text-secondary">{t('account.language.subtitle')}</p>
        </div>
      </div>

      <fieldset className="mt-5">
        <legend className="sr-only">{t('account.language.groupLabel')}</legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {LANGUAGES.map((lang) => {
            const selected = lang.code === language;
            return (
              <label key={lang.code} className="relative block cursor-pointer">
                <input
                  type="radio"
                  name="dashboard-language"
                  value={lang.code}
                  checked={selected}
                  onChange={() => setLanguage(lang.code as LanguageCode)}
                  className="peer sr-only"
                />
                <span
                  className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 text-sm transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
                    selected
                      ? 'border-accent/40 bg-accent/10 text-accent'
                      : 'border-border bg-bg-primary text-text-primary hover:bg-bg-tertiary'
                  }`}
                >
                  <span aria-hidden="true">{lang.flag}</span>
                  <span className="flex-1 font-medium" lang={lang.code} dir={lang.direction}>
                    {lang.nativeName}
                  </span>
                  {lang.direction === 'rtl' && (
                    <span className="rounded-md bg-bg-tertiary px-1.5 py-0.5 text-[0.625rem] font-semibold text-text-secondary">
                      {t('account.language.rtlBadge')}
                    </span>
                  )}
                  {selected && <Check size={16} aria-hidden="true" />}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {isRtl && <p className="mt-3 text-xs text-text-secondary">{t('account.language.rtlNote')}</p>}

      <div className="mt-5 rounded-xl border border-border/60 bg-bg-primary p-4">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-secondary/70">
          {t('account.language.preview')}
        </p>
        <dl className="grid gap-3 sm:grid-cols-2">
          {previews.map((p) => (
            <div key={p.label}>
              <dt className="text-xs text-text-secondary">{p.label}</dt>
              <dd className="mt-0.5 text-sm font-medium text-text-primary">
                <bdi>{p.value}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

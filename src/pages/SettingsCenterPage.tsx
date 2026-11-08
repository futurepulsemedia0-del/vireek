import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Search } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SETTINGS_REGISTRY, groupSettings, searchSettings, visibleSettings } from '@/lib/settingsRegistry';
import { useSettingsCenterT } from '@/i18n/settingsCenterNamespace';

export function SettingsCenterPage() {
  const { t } = useSettingsCenterT();
  const { isOwner, permissions } = useAuth();
  const [query, setQuery] = useState('');
  const uid = useId();

  const entries = useMemo(() => {
    const allowed = visibleSettings(SETTINGS_REGISTRY, { isOwner, canEditBusinessProfile: permissions.can_edit_business_profile === true });
    return searchSettings(allowed, query, (id) => t(`items.${id}`));
  }, [isOwner, permissions.can_edit_business_profile, query, t]);
  const groups = useMemo(() => groupSettings(entries), [entries]);

  return (
    <DashboardLayout activeLabel="Settings Center">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t('subtitle')}</p>
      </div>

      <div className="relative mb-6 max-w-md">
        <label htmlFor={`${uid}-q`} className="sr-only">{t('searchLabel')}</label>
        <Search size={16} aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-text-secondary" />
        <input
          id={`${uid}-q`}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          className="min-h-[44px] w-full rounded-xl border border-border bg-bg-secondary ps-9 pe-3 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>

      <p role="status" aria-live="polite" className="sr-only">{t('results', { count: entries.length })}</p>

      {entries.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-12 text-center text-sm text-text-secondary">
          {t('noResults', { query })}
        </p>
      ) : (
        <div className="space-y-8">
          {groups.map(({ group, items }) => (
            <section key={group} aria-labelledby={`${uid}-${group}`}>
              <h2 id={`${uid}-${group}`} className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">{t(`groups.${group}`)}</h2>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((e) => (
                  <li key={e.id}>
                    <Link
                      to={e.href}
                      className="flex min-h-[48px] items-center justify-between gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="truncate">{t(`items.${e.id}`)}</span>
                      <ChevronRight size={16} aria-hidden="true" className="shrink-0 text-text-secondary rtl:rotate-180" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}

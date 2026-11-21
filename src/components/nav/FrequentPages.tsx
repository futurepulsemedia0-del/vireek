import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  loadStore, normalizeHref, recordVisit, saveStore, topFrequent, type FrequentStore,
} from '@/lib/navFrequent';

interface Props<T extends { href: string }> {
  /** Only pages the person can already see in the menu (permissions, audience, simple mode already applied). */
  candidates: readonly T[];
  userId: string | null | undefined;
  pathname: string;
  /** Renders one menu row; the parent passes its own NavLink so active state, badges and drawer-close stay identical. */
  renderItem: (item: T) => ReactNode;
}

/** The few pages this person opens most, shown above the sections of the main menu. Renders nothing until a habit exists. */
export function FrequentPages<T extends { href: string }>({ candidates, userId, pathname, renderItem }: Props<T>) {
  const { t } = useTranslation('dashboard');
  const allowed = useMemo(() => new Set(candidates.map((c) => normalizeHref(c.href))), [candidates]);
  const [store, setStore] = useState<FrequentStore>(() => loadStore(userId));

  useEffect(() => {
    setStore(loadStore(userId));
  }, [userId]);

  useEffect(() => {
    setStore((prev) => {
      const next = recordVisit(prev, pathname, allowed, Date.now());
      if (next !== prev) saveStore(userId, next);
      return next;
    });
  }, [pathname, allowed, userId]);

  const items = useMemo(() => {
    const byHref = new Map(candidates.map((c) => [normalizeHref(c.href), c]));
    return topFrequent(store, allowed, Date.now())
      .map((h) => byHref.get(h))
      .filter((c): c is T => Boolean(c));
  }, [store, allowed, candidates]);

  if (items.length === 0) return null;
  return (
    <section aria-labelledby="nav-frequent" className="mt-3">
      <h2 id="nav-frequent" className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-muted">
        {t('nav.frequent', { defaultValue: 'Frequent' })}
      </h2>
      <div className="flex flex-col gap-0.5">
        {items.map((item) => (
          <div key={item.href}>{renderItem(item)}</div>
        ))}
      </div>
    </section>
  );
}

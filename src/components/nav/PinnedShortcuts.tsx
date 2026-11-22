import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ListChecks } from 'lucide-react';
import { Icon } from '@/components/ui/Icon';

interface Props<T extends { href: string }> {
  /** Already resolved, permission-filtered and ordered by the person. Renders nothing when empty. */
  items: readonly T[];
  /** The sidebar's own row renderer, so active state, badges and drawer-close behave exactly like every other row. */
  renderItem: (item: T) => ReactNode;
}

/** The pages this person chose to keep at the top of the menu (Stripe-style "Shortcuts"). Edited in the Navigation Center. */
export function PinnedShortcuts<T extends { href: string }>({ items, renderItem }: Props<T>) {
  const { t } = useTranslation('dashboard');
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="nav-shortcuts" className="mt-3">
      <div className="flex items-center justify-between pe-1">
        <h2 id="nav-shortcuts" className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-muted">
          {t('nav.shortcuts.title', { defaultValue: 'Shortcuts' })}
        </h2>
        <Link
          to="/dashboard/navigation"
          aria-label={t('nav.shortcuts.edit', { defaultValue: 'Edit shortcuts' })}
          title={t('nav.shortcuts.edit', { defaultValue: 'Edit shortcuts' })}
          className="focus-ring hit-area relative mb-1 rounded-md p-1 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
        >
          <Icon icon={ListChecks} size="micro" />
        </Link>
      </div>
      <div className="flex flex-col gap-0.5">
        {items.map((item) => (
          <div key={item.href}>{renderItem(item)}</div>
        ))}
      </div>
    </section>
  );
}

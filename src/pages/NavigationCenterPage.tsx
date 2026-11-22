import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Pin, PinOff, Search, X } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyNote } from '@/components/ui/EmptyNote';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useNavPrefs } from '@/hooks/useNavPrefs';
import { useVisibleNavItems } from '@/hooks/useVisibleNavItems';
import { MAX_PINNED, isPinned, visiblePinned } from '@/lib/navPrefs';
import { normalizeHref } from '@/lib/navFrequent';
import { navLabelKey } from '@/lib/navLabel';
import { PILLARS, plainLabel, searchTerms } from '@/lib/surface/surface';
import type { PillarId } from '@/lib/surface/surface';
import { groupByHub } from '@/lib/surface/navHubs';
import { navIcon } from '@/lib/surface/navIcons';

type Tab = 'all' | PillarId;

/**
 * Navigation Center — every page the signed-in person can open, in one searchable place, plus their menu shortcuts.
 *
 * Nothing is hidden here: simple mode and the Labs toggle only trim the SIDEBAR; this page always lists everything the
 * person's role, plan and feature flags allow (the same gates as the sidebar). Pinning only adds a shortcut.
 */
export function NavigationCenterPage() {
  const { t } = useTranslation('dashboard');
  const { user } = useAuth();
  const { toast } = useToast();
  const { prefs, toggle, move, clear } = useNavPrefs(user?.id);
  const { groups, total } = useVisibleNavItems();
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const searchId = useId();

  const label = (text: string) => t(navLabelKey(text), { defaultValue: text });
  const pillarTitle = (id: PillarId) => t(`nav.pillars.${id}`, { defaultValue: PILLARS.find((p) => p.id === id)?.label ?? id });

  const { allowed, byHref } = useMemo(() => {
    const map = new Map<string, (typeof groups)[number]['items'][number]>();
    for (const g of groups) for (const item of g.items) map.set(normalizeHref(item.href), item);
    return { allowed: new Set(map.keys()) as ReadonlySet<string>, byHref: map };
  }, [groups]);

  const pinnedItems = useMemo(
    () => visiblePinned(prefs, allowed).flatMap((h) => {
      const item = byHref.get(h);
      return item ? [item] : [];
    }),
    [prefs, allowed, byHref],
  );
  const hiddenPins = prefs.pinned.length - pinnedItems.length;

  const q = query.trim().toLowerCase();
  const matches = (item: { href: string; label: string }) =>
    !q || `${label(plainLabel(item.href, item.label))} ${item.label} ${searchTerms(item.href)} ${item.href}`.toLowerCase().includes(q);

  const visibleSections = useMemo(
    () =>
      groups
        .filter((g) => tab === 'all' || g.pillar === tab)
        .map((g) => ({
          pillar: g.pillar,
          hubs: groupByHub(g.pillar, g.items.filter(matches)),
        }))
        .filter((s) => s.hubs.length > 0),
    // `matches` closes over q and the translated labels, which change with the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, tab, q, t],
  );
  const shown = visibleSections.reduce((n, s) => n + s.hubs.reduce((m, h) => m + h.items.length, 0), 0);

  const onToggle = (href: string, name: string) => {
    const result = toggle(href, allowed);
    if (result.ok) {
      toast(
        result.pinned
          ? t('nav.pin.pinnedToast', { name, defaultValue: '{{name}} added to shortcuts.' })
          : t('nav.pin.unpinnedToast', { name, defaultValue: '{{name}} removed from shortcuts.' }),
        'success',
      );
    } else if (result.reason === 'limit') {
      toast(t('nav.pin.limit', { count: MAX_PINNED, defaultValue: 'You can keep up to {{count}} shortcuts. Remove one to add another.' }), 'warning');
    } else {
      toast(t('nav.pin.unavailable', { defaultValue: 'That page is not available to your role.' }), 'error');
    }
  };

  const tabs: { id: Tab; text: string; count: number }[] = [
    { id: 'all', text: t('nav.center.all', { defaultValue: 'All' }), count: total },
    ...groups.map((g) => ({ id: g.pillar as Tab, text: pillarTitle(g.pillar), count: g.items.length })),
  ];

  return (
    <DashboardLayout activeLabel="Navigation Center">
      <PageHeader
        title={t('nav.center.title', { defaultValue: 'Navigation center' })}
        context={t('nav.center.context', { count: total, defaultValue: 'Every page available to you ({{count}}). Pin the ones you use daily to the top of the menu.' })}
      />

      <div className="space-y-6">
        <Panel
          title={t('nav.shortcuts.title', { defaultValue: 'Shortcuts' })}
          actions={
            <>
              <span className="tabular-nums">{pinnedItems.length}/{MAX_PINNED}</span>
              {prefs.pinned.length > 0 && (
                <Button variant="link" onClick={clear}>
                  {t('nav.pin.clear', { defaultValue: 'Clear all' })}
                </Button>
              )}
            </>
          }
        >
          {pinnedItems.length === 0 ? (
            <EmptyNote>{t('nav.pin.empty', { defaultValue: 'No shortcuts yet. Use the pin button on any page below, or hover a row in the menu.' })}</EmptyNote>
          ) : (
            <ol className="divide-y divide-border" aria-label={t('nav.shortcuts.title', { defaultValue: 'Shortcuts' })}>
              {pinnedItems.map((item, i) => {
                const name = label(plainLabel(item.href, item.label));
                return (
                  <li key={item.href} className="flex items-center gap-3 py-1.5">
                    <Icon icon={navIcon(item.href, item.icon)} size="sm" className="text-text-muted" />
                    <Link to={item.href} className="focus-ring min-w-0 flex-1 truncate rounded text-[13px] text-text-primary hover:underline">{name}</Link>
                    <IconButton density="dense" label={t('nav.pin.moveUp', { name, defaultValue: 'Move {{name}} up' })} icon={ArrowUp} disabled={i === 0} onClick={() => move(item.href, -1)} />
                    <IconButton density="dense" label={t('nav.pin.moveDown', { name, defaultValue: 'Move {{name}} down' })} icon={ArrowDown} disabled={i === pinnedItems.length - 1} onClick={() => move(item.href, 1)} />
                    <IconButton density="dense" label={t('nav.pin.unpin', { name, defaultValue: 'Unpin {{name}} from shortcuts' })} icon={X} onClick={() => onToggle(item.href, name)} />
                  </li>
                );
              })}
            </ol>
          )}
          {hiddenPins > 0 && (
            <p className="mt-2 text-xs text-text-muted">
              {t('nav.pin.hiddenPins', { count: hiddenPins, defaultValue: '{{count}} saved shortcut(s) point to pages your role cannot open right now. They return if access is restored.' })}
            </p>
          )}
        </Panel>

        <div className="space-y-3">
          <div className="relative">
            <label htmlFor={searchId} className="sr-only">{t('nav.center.search', { defaultValue: 'Search all pages' })}</label>
            <Icon icon={Search} size="sm" className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('nav.center.search', { defaultValue: 'Search all pages' })}
              className="focus-ring w-full rounded-lg border border-border bg-bg-primary py-2 pe-3 ps-9 text-[13px] text-text-primary placeholder:text-text-muted"
            />
          </div>

          <div role="group" aria-label={t('nav.center.filterBy', { defaultValue: 'Filter by area' })} className="flex flex-wrap gap-1.5">
            {tabs.map((tb) => (
              <button
                key={tb.id}
                type="button"
                aria-pressed={tab === tb.id}
                onClick={() => setTab(tb.id)}
                className={`focus-ring rounded-md border px-2.5 py-1 text-[13px] transition-colors ${
                  tab === tb.id ? 'border-accent bg-bg-tertiary font-medium text-text-primary' : 'border-border text-text-secondary hover:bg-bg-tertiary/70 hover:text-text-primary'
                }`}
              >
                {tb.text} <span className="tabular-nums text-text-muted">{tb.count}</span>
              </button>
            ))}
          </div>

          <p role="status" aria-live="polite" className="text-xs text-text-muted">
            {t('nav.center.results', { count: shown, defaultValue: '{{count}} pages shown' })}
          </p>
        </div>

        {visibleSections.length === 0 ? (
          <EmptyNote action={{ label: t('nav.center.clearSearch', { defaultValue: 'Clear search' }), onClick: () => { setQuery(''); setTab('all'); } }}>
            {t('nav.noMatches', { defaultValue: 'No pages match your filter.' })}
          </EmptyNote>
        ) : (
          visibleSections.map(({ pillar, hubs }) => (
            <section key={pillar} aria-labelledby={`nc-${pillar}`} className="space-y-3">
              <h2 id={`nc-${pillar}`} className="text-[13px] font-semibold text-text-primary">
                {pillarTitle(pillar)}
                {pillar === 'labs' && <span className="ms-2 rounded bg-bg-tertiary px-1.5 text-[11px] font-medium text-text-secondary">Beta</span>}
              </h2>
              {hubs.map(({ hub, items }) => (
                <Panel key={hub.id} flush title={t(`nav.hubs.${hub.id}`, { defaultValue: hub.label })} actions={<span className="tabular-nums">{items.length}</span>}>
                  <ul className="divide-y divide-border">
                    {items.map((item) => {
                      const name = label(plainLabel(item.href, item.label));
                      const pinned = isPinned(prefs, item.href);
                      return (
                        <li key={item.href} className="flex items-center gap-3 px-4 py-1.5">
                          <Icon icon={navIcon(item.href, item.icon)} size="sm" className="text-text-muted" />
                          <Link to={item.href} className="focus-ring min-w-0 flex-1 truncate rounded text-[13px] text-text-primary hover:underline">{name}</Link>
                          <IconButton
                            density="dense"
                            aria-pressed={pinned}
                            label={pinned ? t('nav.pin.unpin', { name, defaultValue: 'Unpin {{name}} from shortcuts' }) : t('nav.pin.pin', { name, defaultValue: 'Pin {{name}} to shortcuts' })}
                            icon={pinned ? PinOff : Pin}
                            className={pinned ? 'text-accent' : ''}
                            onClick={() => onToggle(item.href, name)}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </Panel>
              ))}
            </section>
          ))
        )}
      </div>
    </DashboardLayout>
  );
}

import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DashboardLayout } from '@/components/DashboardNav';
import { PageHeader } from '@/components/ui/PageHeader';
import { Input } from '@/components/ui/Input';
import { useAuth } from '@/contexts/AuthContext';
import { SETTINGS_GROUPS, SETTINGS_REGISTRY, type SettingsEntry } from '@/lib/settings/registry';
import { resolveAccess, type AccessResult } from '@/lib/settings/access';
import { searchSettings } from '@/lib/settings/search';

function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: JSX.Element[] = [];
  let pos = 0;
  ranges.forEach(([s, e], i) => {
    if (s > pos) parts.push(<span key={`t${i}`}>{text.slice(pos, s)}</span>);
    parts.push(<mark key={`m${i}`} className="bg-transparent font-semibold text-text-primary underline decoration-border underline-offset-2">{text.slice(s, e)}</mark>);
    pos = e;
  });
  if (pos < text.length) parts.push(<span key="end">{text.slice(pos)}</span>);
  return <>{parts}</>;
}

function Row({ entry, access, ranges }: { entry: SettingsEntry; access: AccessResult; ranges?: [number, number][] }) {
  const { t } = useTranslation('dashboard');
  const locked = access.state === 'locked';
  const label = t(`settings.hub.entries.${entry.id}.label`, { defaultValue: entry.label });
  const description = t(`settings.hub.entries.${entry.id}.description`, { defaultValue: entry.description });
  const body = (
    <div className="min-w-0 py-3">
      <p className="text-sm font-medium text-text-primary">
        <Highlighted text={label} ranges={label === entry.label ? ranges ?? [] : []} />
      </p>
      <p className="mt-0.5 max-w-prose text-xs text-text-secondary">{description}</p>
      {locked && (
        <p className="mt-1 text-xs text-text-secondary">
          {access.reason === 'owner'
            ? t('settings.hub.lockedOwner', { defaultValue: 'Only Owners can change this.' })
            : t('settings.hub.lockedPermission', { defaultValue: 'Ask an Owner to give you access to this.' })}
        </p>
      )}
    </div>
  );
  // Locked rows stay visible but are not links: the next step is asking an Owner.
  return locked ? (
    <li className="border-t border-border first:border-t-0" aria-disabled="true">{body}</li>
  ) : (
    <li className="border-t border-border first:border-t-0">
      <Link to={entry.route} className="block rounded-sm px-0 hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        {body}
      </Link>
    </li>
  );
}

export function SettingsHubPage() {
  const { t } = useTranslation('dashboard');
  const { isOwner, permissions } = useAuth();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLUListElement>(null);
  const ctx = useMemo(() => ({ isOwner, permissions }), [isOwner, permissions]);

  const visible = useMemo(
    () => SETTINGS_REGISTRY.map((entry) => ({ entry, access: resolveAccess(entry, ctx) })).filter((x) => x.access.state !== 'hidden'),
    [ctx],
  );
  const accessById = useMemo(() => new Map(visible.map((x) => [x.entry.id, x.access])), [visible]);
  const hits = useMemo(
    () => searchSettings(query, visible.map((x) => x.entry)),
    [query, visible],
  );
  const searching = query.trim().length > 0;

  const grouped = SETTINGS_GROUPS.map((g) => ({ g, rows: visible.filter((x) => x.entry.group === g.id) })).filter((x) => x.rows.length > 0);
  const sections = (['personal', 'organization'] as const).map((s) => ({ s, groups: grouped.filter((x) => x.g.section === s) })).filter((x) => x.groups.length > 0);

  return (
    <DashboardLayout activeLabel="Settings">
      <PageHeader
        title={t('settings.hub.title', { defaultValue: 'Settings' })}
        context={t('settings.hub.context', { defaultValue: 'Personal settings apply to you. Organization settings apply to everyone in your business.' })}
      />
      <div role="search" className="mb-6 max-w-md">
        <label htmlFor="settings-search" className="sr-only">{t('settings.hub.searchLabel', { defaultValue: 'Search settings' })}</label>
        <Input
          id="settings-search"
          type="search"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && hits[0] && accessById.get(hits[0].entry.id)?.state === 'allowed') navigate(hits[0].entry.route);
            if (ev.key === 'Escape') setQuery('');
          }}
          placeholder={t('settings.hub.searchPlaceholder', { defaultValue: 'Search settings, for example password or invoice' })}
          aria-describedby="settings-search-status"
          autoComplete="off"
        />
        <p id="settings-search-status" role="status" aria-live="polite" className="mt-1 text-xs text-text-secondary">
          {searching
            ? hits.length === 0
              ? t('settings.hub.noResults', { defaultValue: 'No settings match that search.' })
              : t('settings.hub.resultCount', { count: hits.length, defaultValue: '{{count}} settings found.' })
            : ''}
        </p>
      </div>

      {searching ? (
        <ul ref={listRef} aria-label={t('settings.hub.results', { defaultValue: 'Search results' })} className="max-w-2xl">
          {hits.map((h) => (
            <Row key={h.entry.id} entry={h.entry} access={accessById.get(h.entry.id) ?? { state: 'allowed' }} ranges={h.labelRanges} />
          ))}
        </ul>
      ) : (
        <div className="space-y-10">
          {sections.map(({ s, groups }) => (
            <section key={s} aria-labelledby={`settings-section-${s}`}>
              <h2 id={`settings-section-${s}`} className="mb-4 text-xs font-medium uppercase tracking-wide text-text-secondary">
                {s === 'personal' ? t('settings.hub.personal', { defaultValue: 'Personal' }) : t('settings.hub.organization', { defaultValue: 'Organization' })}
              </h2>
              <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
                {groups.map(({ g, rows }) => (
                  <div key={g.id}>
                    <h3 className="text-sm font-semibold text-text-primary">{t(`settings.hub.groups.${g.id}`, { defaultValue: g.label })}</h3>
                    <ul className="mt-1">
                      {rows.map((r) => <Row key={r.entry.id} entry={r.entry} access={r.access} />)}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </DashboardLayout>
  );
}

export default SettingsHubPage;

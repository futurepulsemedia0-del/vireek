import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CloudLightning, Lock, Siren } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { LiveIndicator } from '@/components/LiveIndicator';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { IncidentDetail, ContactList, StatusBadge } from '@/components/mass-incident/IncidentDetail';
import { EvidencePanel } from '@/components/mass-incident/EvidencePanel';
import { SettingsPanel } from '@/components/mass-incident/SettingsPanel';
import { MASS_INCIDENT_NS } from '@/i18n/massIncidentNamespace';
import { useRealtimeSubscription } from '@/lib/realtime';
import { announce } from '@/lib/a11y/announcer';
import {
  DEFAULT_SETTINGS,
  fetchContacts,
  fetchDirectory,
  fetchIncidents,
  fetchLooseContacts,
  fetchSettings,
  fetchSignals,
  isOpenStatus,
  removeById,
  sortIncidentRows,
  upsertById,
  type ContactRow,
  type DirectoryRow,
  type IncidentRow,
  type SettingsRow,
  type SignalRow,
} from '@/lib/massIncident';

type Tab = 'incidents' | 'evidence' | 'settings';

export function MassIncidentsPage() {
  const { t } = useTranslation(MASS_INCIDENT_NS);
  const { profile, teamMember, isOwner, permissions } = useAuth();

  const canView = isOwner || permissions.can_manage_numbers || permissions.can_view_all_jobs;
  const canManage = isOwner || permissions.can_manage_numbers;
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;

  const [tab, setTab] = useState<Tab>('incidents');
  const [settings, setSettings] = useState<SettingsRow>(DEFAULT_SETTINGS);
  const [incidents, setIncidents] = useState<IncidentRow[]>([]);
  const [loose, setLoose] = useState<ContactRow[]>([]);
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [directory, setDirectory] = useState<DirectoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const contactsRequest = useRef(0);

  const loadAll = useCallback(async (silent: boolean) => {
    if (!canView) return;
    if (!silent) setLoading(true);
    setLoadError(false);
    try {
      const [s, i, l, sig, dir] = await Promise.all([fetchSettings(), fetchIncidents(), fetchLooseContacts(), fetchSignals(), fetchDirectory()]);
      setSettings(s);
      setIncidents(i);
      setLoose(l);
      setSignals(sig);
      setDirectory(dir);
    } catch {
      if (!silent) setLoadError(true);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [canView]);

  useEffect(() => { void loadAll(false); }, [loadAll]);

  const loadContacts = useCallback(async (incidentId: string) => {
    const id = ++contactsRequest.current;
    setContactsLoading(true);
    try {
      const rows = await fetchContacts(incidentId);
      if (id === contactsRequest.current) setContacts(rows);
    } catch {
      if (id === contactsRequest.current) setContacts([]);
    } finally {
      if (id === contactsRequest.current) setContactsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedId) { setContacts([]); return; }
    void loadContacts(selectedId);
  }, [selectedId, loadContacts]);

  const status = useRealtimeSubscription<IncidentRow>({
    channelName: `mass-incidents-${accountOwnerId ?? 'anon'}`,
    table: 'mass_incidents',
    event: '*',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId && canView,
    onChange: (payload) => {
      if (payload.eventType === 'DELETE') {
        const old = payload.old as Partial<IncidentRow>;
        if (old.id) setIncidents((prev) => removeById(prev, old.id as string));
        return;
      }
      const row = payload.new as IncidentRow;
      setIncidents((prev) => upsertById(prev, row));
      if (payload.eventType === 'INSERT') announce(t('title') + ': ' + row.title, 'polite');
      if (row.id === selectedId) void loadContacts(row.id);
    },
  });

  useRealtimeSubscription<ContactRow>({
    channelName: `mass-incident-contacts-${accountOwnerId ?? 'anon'}`,
    table: 'mass_incident_contacts',
    event: 'INSERT',
    filter: accountOwnerId ? `user_id=eq.${accountOwnerId}` : undefined,
    enabled: !!accountOwnerId && canView,
    onChange: () => { void fetchLooseContacts().then(setLoose).catch(() => undefined); if (selectedId) void loadContacts(selectedId); },
  });

  const prev = useRef(status);
  useEffect(() => {
    if (prev.current === 'reconnecting' && status === 'live') void loadAll(true);
    prev.current = status;
  }, [status, loadAll]);

  const sorted = useMemo(() => sortIncidentRows(incidents), [incidents]);
  const selected = useMemo(() => incidents.find((i) => i.id === selectedId) ?? null, [incidents, selectedId]);
  const openCount = useMemo(() => incidents.filter((i) => isOpenStatus(i.status)).length, [incidents]);

  const tabBtn = (id: Tab, label: string) => (
    <button
      type="button" role="tab" id={`mi-tab-${id}`} aria-selected={tab === id} aria-controls={`mi-panel-${id}`} tabIndex={tab === id ? 0 : -1}
      onClick={() => setTab(id)}
      className={`focus-ring rounded-xl px-4 py-2 text-sm font-medium ${tab === id ? 'bg-accent/10 text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
    >
      {label}
    </button>
  );

  const onTabKey = (e: React.KeyboardEvent) => {
    const order: Tab[] = ['incidents', 'evidence', 'settings'];
    const dir = document.documentElement.dir === 'rtl' ? -1 : 1;
    const i = order.indexOf(tab);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const step = (e.key === 'ArrowRight' ? 1 : -1) * dir;
      const next = order[(i + step + order.length) % order.length];
      setTab(next);
      document.getElementById(`mi-tab-${next}`)?.focus();
    }
  };

  if (!canView) {
    return (
      <DashboardLayout>
        <EmptyState icon={Lock} title={t('noPermission')} variant="no-permission" />
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary"><Siren size={22} aria-hidden="true" />{t('title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('tagline')}</p>
        </div>
        <div className="flex items-center gap-3">
          {settings.enabled && <span className="text-sm text-text-secondary">{t('activeCount', { count: openCount })}</span>}
          <LiveIndicator status={status} />
        </div>
      </div>

      {status === 'reconnecting' && <p role="status" className="mb-4 rounded-xl border border-warning-500/30 bg-warning-500/5 px-3 py-2 text-sm text-text-primary">{t('offline')}</p>}

      <div role="tablist" aria-label={t('title')} className="mb-4 flex flex-wrap gap-1" onKeyDown={onTabKey}>
        {tabBtn('incidents', t('tabIncidents'))}
        {tabBtn('evidence', t('tabEvidence'))}
        {tabBtn('settings', t('tabSettings'))}
      </div>

      {loading ? (
        <div role="status" aria-label={t('loading')}><SkeletonCardList count={3} rows={2} /></div>
      ) : loadError ? (
        <EmptyState icon={CloudLightning} title={t('loadFailed')} variant="load-failed" onRetry={() => void loadAll(false)} />
      ) : (
        <FadeIn>
          <div role="tabpanel" id="mi-panel-incidents" aria-labelledby="mi-tab-incidents" hidden={tab !== 'incidents'}>
            {!settings.enabled && sorted.length === 0 ? (
              <EmptyState icon={Siren} title={t('disabledTitle')} description={t('disabledBody')} action={{ label: t('goSettings'), onClick: () => setTab('settings') }} />
            ) : (
              <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <div className={`${selected ? 'hidden lg:block' : ''} min-w-0 space-y-6`}>
                  {sorted.length === 0 ? (
                    <EmptyState icon={Siren} title={t('emptyTitle')} description={t('emptyBody')} />
                  ) : (
                    <ul className="space-y-3" aria-label={t('tabIncidents')}>
                      {sorted.map((i) => (
                        <li key={i.id}>
                          <button
                            type="button" onClick={() => setSelectedId(i.id)} aria-current={i.id === selectedId ? 'true' : undefined}
                            className={`focus-ring w-full rounded-2xl border p-4 text-start transition-colors ${i.id === selectedId ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'}`}
                          >
                            <span className="flex items-start justify-between gap-2">
                              <span className="font-medium text-text-primary">{i.title}</span>
                              <StatusBadge status={i.status} />
                            </span>
                            <span className="mt-1 block text-sm text-text-secondary">
                              {t(`cause_${i.suspected_cause}`)} · {Math.round(i.confidence * 100)}% · {i.member_count}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {loose.length > 0 && (
                    <section aria-labelledby="loose-h">
                      <h2 id="loose-h" className="text-sm font-semibold text-text-primary">{t('looseTitle')} ({loose.length})</h2>
                      <p className="mb-2 text-xs text-text-secondary">{t('looseBody')}</p>
                      <ContactList contacts={loose.slice(0, 20)} canManage={false} />
                    </section>
                  )}
                </div>

                <section className={`${selected ? '' : 'hidden lg:block'} min-w-0 rounded-2xl border border-border bg-bg-secondary`} aria-live="polite">
                  {selected ? (
                    <>
                      <button type="button" onClick={() => setSelectedId(null)} className="focus-ring m-4 mb-0 inline-flex items-center gap-1.5 rounded-lg text-sm text-text-secondary hover:text-text-primary lg:hidden">
                        <ArrowLeft size={15} aria-hidden="true" />{t('tabIncidents')}
                      </button>
                      <IncidentDetail incident={selected} contacts={contacts} contactsLoading={contactsLoading} canManage={canManage} onChanged={() => { void loadAll(true); if (selectedId) void loadContacts(selectedId); }} />
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center px-6 py-20 text-center text-sm text-text-secondary">
                      <Siren size={26} aria-hidden="true" />
                      <p className="mt-3">{t('emptyBody')}</p>
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>

          <div role="tabpanel" id="mi-panel-evidence" aria-labelledby="mi-tab-evidence" hidden={tab !== 'evidence'}>
            <EvidencePanel signals={signals} directory={directory} canManage={canManage} ownerId={accountOwnerId} onChanged={() => void loadAll(true)} />
          </div>

          <div role="tabpanel" id="mi-panel-settings" aria-labelledby="mi-tab-settings" hidden={tab !== 'settings'}>
            <SettingsPanel value={settings} canManage={canManage} onSaved={() => void loadAll(true)} />
          </div>
        </FadeIn>
      )}
    </DashboardLayout>
  );
}

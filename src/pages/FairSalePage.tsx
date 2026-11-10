/**
 * Fair Sale Protocol — /dashboard/fair-sale
 *
 * A self-binding ethics layer. Owners tune thresholds (within platform floors), managers work the
 * second-review queue, anyone on the team can read the immutable protection log. Statutory rules
 * live in Compliance Rules. NOT LEGAL ADVICE.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardCheck, History, Lock, Scale, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { GovernanceTab } from '@/components/fair-sale/GovernanceTab';
import { LogTab } from '@/components/fair-sale/LogTab';
import { ReviewTab } from '@/components/fair-sale/ReviewTab';
import { SettingsTab } from '@/components/fair-sale/SettingsTab';
import { useAuth } from '@/contexts/AuthContext';
import { useFairSaleT } from '@/i18n/fairSaleNamespace';
import { FairSaleError, fetchSettings, type FairSaleConfig } from '@/lib/fairSale';
import { canManageCompliance } from '@/lib/complianceRules';

type Tab = 'settings' | 'review' | 'log' | 'governance';
const TAB_ICONS = { settings: SlidersHorizontal, review: ClipboardCheck, log: History, governance: Scale } as const;
const TABS: Tab[] = ['settings', 'review', 'log', 'governance'];

export function FairSalePage() {
  const { t } = useFairSaleT();
  const { isOwner, permissions } = useAuth();
  const allowed = canManageCompliance(isOwner, permissions);
  const [tab, setTab] = useState<Tab>('settings');
  const [config, setConfig] = useState<FairSaleConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setConfig(await fetchSettings()); } catch (e) { setError(e instanceof FairSaleError ? e.message : t('dash.errors.generic')); }
  }, [t]);
  useEffect(() => { if (allowed) void load(); }, [allowed, load]);

  const tabs = useMemo(() => TABS.map((id) => ({ id, label: t(`dash.tabs.${id}`), Icon: TAB_ICONS[id] })), [t]);

  return (
    <DashboardLayout activeLabel="Fair Sale">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">{t('dash.title')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('dash.intro')}</p>
        </div>
        <p role="note" className="flex gap-2 rounded-xl border border-warning-500/40 bg-warning-500/10 p-3 text-sm text-text-primary">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning-500" aria-hidden /><span>{t('dash.legalNote')}</span>
        </p>
        {!allowed ? (
          <EmptyState icon={Lock} variant="no-permission" title={t('dash.noAccess')} description={t('dash.noAccessHint')} />
        ) : error ? (
          <EmptyState icon={TriangleAlert} variant="load-failed" title={t('dash.loadFailed')} description={error} onRetry={() => void load()} />
        ) : !config ? (
          <SkeletonCardList count={3} rows={3} />
        ) : (
          <>
            <div role="tablist" aria-label={t('dash.tabsLabel')} className="flex flex-wrap gap-1">
              {tabs.map(({ id, label, Icon }) => (
                <button key={id} type="button" role="tab" id={`fs-tab-${id}`} aria-selected={tab === id} aria-controls={`fs-panel-${id}`} onClick={() => setTab(id)}
                  className={`focus-ring inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${tab === id ? 'bg-accent/10 text-accent' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}`}>
                  <Icon className="h-4 w-4" aria-hidden /> {label}
                </button>
              ))}
            </div>
            <div role="tabpanel" id={`fs-panel-${tab}`} aria-labelledby={`fs-tab-${tab}`}>
              {tab === 'settings' && <SettingsTab initial={config} canEdit={allowed} onSaved={setConfig} />}
              {tab === 'review' && <ReviewTab canDecide={allowed} />}
              {tab === 'log' && <LogTab canManage={allowed} />}
              {tab === 'governance' && <GovernanceTab />}
            </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

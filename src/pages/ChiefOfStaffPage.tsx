import { Compass, RefreshCw, ShieldAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { ActivityFeed } from '@/components/chief-of-staff/ActivityFeed';
import { CommandBox } from '@/components/chief-of-staff/CommandBox';
import { ControlsPanel } from '@/components/chief-of-staff/ControlsPanel';
import { CoordinationPanel } from '@/components/chief-of-staff/CoordinationPanel';
import { GoalsPanel } from '@/components/chief-of-staff/GoalsPanel';
import { TopActions } from '@/components/chief-of-staff/TopActions';
import { UsefulnessPanel } from '@/components/chief-of-staff/UsefulnessPanel';
import { useToast } from '@/contexts/ToastContext';
import { useChiefOverview } from '@/hooks/useChiefOverview';
import { useChiefT } from '@/i18n/chiefOfStaffNamespace';
import { useEffect } from 'react';

export function ChiefOfStaffPage() {
  const { t, language } = useChiefT();
  const { toast } = useToast();
  const { state, reload, refresh, refreshing, failedSources, refreshError } = useChiefOverview();

  useEffect(() => {
    if (refreshError) toast(t('states.error.body'), 'error');
  }, [refreshError, toast, t]);

  const header = (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent" aria-hidden="true">
          <Compass size={24} />
        </span>
        <div>
          <h1 className="text-xl font-bold text-text-primary">{t('title')}</h1>
          <p className="text-sm text-text-secondary">{t('subtitle')}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {state.status === 'ready' && (
          <span className="text-xs text-text-secondary">
            {state.data.last_refresh_at
              ? t('asOf', { time: new Intl.DateTimeFormat(language, { timeStyle: 'short', dateStyle: 'short' }).format(new Date(state.data.last_refresh_at)) })
              : t('neverRefreshed')}
          </span>
        )}
        <Button size="sm" variant="secondary" onClick={() => void refresh()} loading={refreshing} loadingLabel={t('refreshing')} disabled={state.status !== 'ready'}>
          <RefreshCw size={14} aria-hidden="true" />
          {t('refresh')}
        </Button>
      </div>
    </div>
  );

  return (
    <DashboardLayout activeLabel="Chief of Staff">
      {header}

      {state.status === 'loading' && (
        <div role="status" aria-label={t('states.loading')}>
          <SkeletonCardList count={3} rows={3} />
        </div>
      )}

      {state.status === 'error' && (
        <EmptyState variant="load-failed" icon={ShieldAlert} title={t('states.error.title')} description={t('states.error.body')} onRetry={() => void reload()} />
      )}

      {state.status === 'forbidden' && (
        <EmptyState variant="no-permission" icon={ShieldAlert} title={t('states.noPermission.title')} description={t('states.noPermission.body')} />
      )}

      {state.status === 'ready' && (
        <>
          {state.data.settings?.kill_switch_active && (
            <div role="alert" className="mb-6 rounded-xl border-2 border-danger bg-bg-secondary p-4 text-sm text-text-primary">
              <p className="font-semibold">{t('killSwitch.bannerOn')}</p>
              {state.data.settings.kill_switch_reason && <p className="mt-1">{t('killSwitch.bannerReason', { reason: state.data.settings.kill_switch_reason })}</p>}
            </div>
          )}

          {failedSources.length > 0 && (
            <p role="status" className="mb-4 text-sm text-text-secondary">{t('sourcesFailed', { sources: failedSources.join(', ') })}</p>
          )}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="space-y-6">
              <GoalsPanel goals={state.data.goals} canAct={state.data.settings?.can_act ?? false} onChanged={() => void reload()} />
              <TopActions recs={state.data.top} moreCount={state.data.more_count} canAct={state.data.settings?.can_act ?? false} onChanged={() => void reload()} />
              <CommandBox />
            </div>
            <div className="space-y-6">
              {state.data.settings && (
                <ControlsPanel settings={state.data.settings} dials={state.data.dials} pendingApprovals={state.data.pending_approvals} onChanged={() => void reload()} />
              )}
              <CoordinationPanel conflicts={state.data.conflicts} suppressed={state.data.suppressed} />
              <ActivityFeed events={state.data.feed} />
              <UsefulnessPanel rows={state.data.usefulness} />
            </div>
          </div>
        </>
      )}
    </DashboardLayout>
  );
}

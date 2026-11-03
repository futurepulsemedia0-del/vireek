import { useCallback, useEffect, useState } from 'react';
import { TriangleAlert as AlertTriangle, Radar } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { ProgressRing } from '@/components/agentReadiness/ProgressRing';
import { ScoreChecklist } from '@/components/agentReadiness/ScoreChecklist';
import { FixCard } from '@/components/agentReadiness/FixCard';
import { HistoryChart } from '@/components/agentReadiness/HistoryChart';
import { formatDateTime } from '@/lib/format';
import { useAgentReadinessT } from '@/i18n/agentReadinessNamespace';
import {
  ackAlert, applyDescriptions, coveragePct, loadActions, loadAlerts, loadHistory, loadLatestScan, loadMonitoring,
  runScan, setMonitoring, skipFix, undoAction,
  type AlertRow, type Fix, type FixAction, type History, type ScanSummary,
} from '@/lib/agentReadiness';

const PAGE = 'Agent Readiness';

export function AgentReadinessPage() {
  const { profile, teamMember, isOwner, permissions, profileLoading } = useAuth();
  const { toast } = useToast();
  const { t } = useAgentReadinessT();
  const ownerId = isOwner ? (profile?.id ?? null) : (teamMember?.account_owner_id ?? null);
  const canManage = isOwner || permissions.can_manage_team || teamMember?.role === 'admin';
  const canView = canManage || permissions.can_edit_business_profile;

  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [scan, setScan] = useState<ScanSummary | null>(null);
  const [actions, setActions] = useState<FixAction[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [history, setHistory] = useState<History | null>(null);
  const [weekly, setWeekly] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const err = (code: string) => t(`errors.${code}`, { defaultValue: t('errors.unknown') });

  const load = useCallback(async () => {
    if (!ownerId) return;
    setStatus('loading');
    try {
      const latest = await loadLatestScan(ownerId);
      const [acts, al, hist, mon] = await Promise.all([
        latest ? loadActions(ownerId, latest.id) : Promise.resolve([]), loadAlerts(ownerId), loadHistory().catch(() => null), loadMonitoring(ownerId),
      ]);
      setScan(latest); setActions(acts); setAlerts(al); setHistory(hist); setWeekly(mon); setStatus('ready');
    } catch { setStatus('error'); }
  }, [ownerId]);

  useEffect(() => { if (canView && ownerId) void load(); }, [canView, ownerId, load]);

  async function scanNow() {
    setBusy('scan');
    const res = await runScan();
    setBusy(null);
    if (!res.ok) { toast(err(res.code), 'error'); return; }
    await load();
  }
  async function approve(fix: Fix, ids: string[]) {
    if (!scan || fix.key !== 'service_descriptions') return;
    setBusy(fix.key);
    const res = await applyDescriptions(scan.id, ids);
    setBusy(null);
    if (!res.ok) { toast(err(res.code), 'error'); return; }
    toast(res.applied > 0 ? t('applied', { count: res.applied }) : t('appliedNone'), res.applied > 0 ? 'success' : 'error');
    if (ownerId) setActions(await loadActions(ownerId, scan.id));
  }
  async function skip(fix: Fix) {
    if (!scan || !ownerId) return;
    setBusy(fix.key);
    const res = await skipFix(scan.id, fix.key);
    setBusy(null);
    if (!res.ok) { toast(err(res.code), 'error'); return; }
    setActions(await loadActions(ownerId, scan.id));
  }
  async function undo(actionId: string) {
    if (!scan || !ownerId) return;
    setBusy(actionId);
    const res = await undoAction(actionId);
    setBusy(null);
    if (!res.ok) { toast(err(res.code), 'error'); return; }
    toast(res.conflicts > 0 ? t('undoneConflicts', { count: res.conflicts }) : t('undone', { count: res.restored }), 'success');
    setActions(await loadActions(ownerId, scan.id));
  }
  async function toggleMonitoring(v: boolean) {
    setBusy('mon');
    const res = await setMonitoring(v);
    setBusy(null);
    if (!res.ok) { toast(err(res.code), 'error'); return; }
    setWeekly(res.weekly_scan);
  }
  async function dismiss(id: string) {
    const res = await ackAlert(id);
    if (res.ok) setAlerts((a) => a.filter((x) => x.id !== id));
    else toast(err(res.code), 'error');
  }

  if (profileLoading) return <DashboardLayout title={PAGE}><SkeletonCardList count={3} rows={3} /></DashboardLayout>;
  if (!canView) return <DashboardLayout title={PAGE}><EmptyState icon={AlertTriangle} title={t('noPermission')} description="" /></DashboardLayout>;

  const date = scan ? formatDateTime(scan.created_at) : '';
  return (
    <DashboardLayout title={PAGE}>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">{t('subtitle')}</p>
        {!canManage && <p className="mt-2 text-xs text-text-secondary">{t('viewOnly')}</p>}
      </header>

      {status === 'loading' && <SkeletonCardList count={4} rows={3} />}
      {status === 'error' && <EmptyState icon={AlertTriangle} title={t('loadError')} description={t('loadErrorHint')} action={{ label: t('retry'), onClick: () => void load() }} />}
      {status === 'ready' && !scan && (
        <EmptyState icon={Radar} title={t('noScanTitle')} description={t('noScanBody')}
          action={canManage ? { label: busy === 'scan' ? t('scanning') : t('runScan'), onClick: () => void scanNow() } : undefined} />
      )}

      {status === 'ready' && scan && (
        <div className="space-y-6">
          <section className="flex flex-wrap items-center gap-6 rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="ar-score">
            <ProgressRing score={scan.score} label={t('scoreLabel')} unknownLabel={t('scoreUnknown')} />
            <div className="min-w-0 flex-1">
              <h2 id="ar-score" className="text-base font-semibold text-text-primary">{t('scoreLabel')}</h2>
              <p className="text-sm text-text-secondary">{t('lastScan', { date })}</p>
              <p className="mt-2 text-xs text-text-secondary">{t('coverage', { pct: coveragePct(scan.coverage) })}</p>
              <p className="mt-1 text-xs text-text-secondary">{t('honesty')}</p>
              <div className="mt-3"><Button size="sm" loading={busy === 'scan'} loadingLabel={t('scanning')} disabled={!canManage} onClick={() => void scanNow()}>{t('rescan')}</Button></div>
            </div>
          </section>

          {alerts.length > 0 && (
            <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="ar-alerts" role="region">
              <h2 id="ar-alerts" className="text-base font-semibold text-text-primary">{t('alertsTitle')}</h2>
              <ul className="mt-3 space-y-2">
                {alerts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 text-sm text-text-primary">
                    <span>{t(`alerts.${a.kind}`, a.detail)}</span>
                    <Button size="xs" variant="ghost" disabled={!canManage} onClick={() => void dismiss(a.id)}>{t('dismiss')}</Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="ar-fixes">
            <h2 id="ar-fixes" className="mb-3 text-base font-semibold text-text-primary">{t('fixesTitle')}</h2>
            {scan.fixes.length === 0 ? <p className="text-sm text-text-secondary">{t('fixesEmpty')}</p> : (
              <div className="space-y-3">
                {scan.fixes.map((f) => (
                  <FixCard key={f.key} fix={f} actions={actions} canManage={canManage} busy={busy === f.key || actions.some((a) => a.id === busy)}
                    onApprove={(fx, ids) => void approve(fx, ids)} onSkip={(fx) => void skip(fx)} onUndo={(id) => void undo(id)} />
                ))}
              </div>
            )}
          </section>

          <ScoreChecklist subscores={scan.subscores} checks={scan.checks} />

          <section className="rounded-2xl border border-border bg-bg-secondary p-5" aria-labelledby="ar-hist">
            <h2 id="ar-hist" className="mb-3 text-base font-semibold text-text-primary">{t('historyTitle')}</h2>
            {history ? <HistoryChart history={history} /> : <p className="text-sm text-text-secondary">{t('historyEmpty')}</p>}
          </section>

          <section className="rounded-2xl border border-border bg-bg-secondary p-5">
            <Switch checked={weekly} onChange={(v) => void toggleMonitoring(v)} label={t('monitoring')} hint={t('monitoringHint')} disabled={!canManage} loading={busy === 'mon'} />
            <p className="mt-2 text-xs text-text-secondary">{t('profileSuspendedNote')}</p>
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}

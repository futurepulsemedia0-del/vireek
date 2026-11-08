import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { ACCESS_LOG_NS } from '@/lib/privacy/i18n';
import {
  AccessLogError, fetchOpenAlerts, fetchStaffAccessTrail, fetchViewerVisibility, setAlertStatus, setViewerVisibility,
  type AccessAlert, type StaffTrailRow,
} from '@/lib/privacy/accessLog';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; alerts: AccessAlert[]; staff: StaffTrailRow[] };

export function SensitiveAccessPage() {
  const { t, i18n } = useTranslation(ACCESS_LOG_NS);
  const { isOwner } = useAuth();
  const { toast } = useToast();
  const [state, setState] = useState<Load>({ kind: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showViewers, setShowViewers] = useState(false);
  const [savingVis, setSavingVis] = useState(false);

  const load = useCallback(async () => {
    try {
      const [alerts, staff, visible] = await Promise.all([fetchOpenAlerts(), fetchStaffAccessTrail(), fetchViewerVisibility()]);
      setShowViewers(visible);
      setState({ kind: 'ready', alerts, staff });
    } catch {
      setState({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    void load();
  }, [isOwner, load]);

  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const errMsg = (e: unknown): string => t(`errors.${e instanceof AccessLogError ? e.kind : 'unknown'}`);

  async function onAlert(id: string, status: 'acknowledged' | 'dismissed') {
    setBusyId(id);
    try {
      await setAlertStatus(id, status);
      await load();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function onVisibility(next: boolean) {
    setSavingVis(true);
    try {
      await setViewerVisibility(next);
      setShowViewers(next);
      toast(t('visibility.saved'), 'success');
    } catch {
      toast(t('visibility.error'), 'error');
    } finally {
      setSavingVis(false);
    }
  }

  if (!isOwner) {
    return (
      <DashboardLayout activeLabel="Settings">
        <p className="rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-16 text-center text-sm text-text-secondary">{t('page.ownerOnly')}</p>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Settings">
      <div className="mb-6"><BackButton fallback="/dashboard/settings" /></div>
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">{t('page.title')}</h1>
      <p className="mt-1 mb-6 max-w-2xl text-sm leading-relaxed text-text-secondary">{t('page.intro')}</p>

      {state.kind === 'loading' && (
        <p role="status" className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {t('history.loading')}
        </p>
      )}
      {state.kind === 'error' && (
        <div role="alert" className="flex items-center gap-2 text-sm text-text-secondary">
          <AlertCircle size={14} aria-hidden="true" /> {t('errors.unknown')}
          <button type="button" onClick={() => { setState({ kind: 'loading' }); void load(); }} className="font-medium text-accent underline focus:outline-none focus:ring-2 focus:ring-accent/40">{t('history.retry')}</button>
        </div>
      )}

      {state.kind === 'ready' && (
        <div className="space-y-8">
          <section aria-labelledby="alerts-title">
            <h2 id="alerts-title" className="mb-3 flex items-center gap-2 text-lg font-semibold text-text-primary"><ShieldAlert size={18} aria-hidden="true" />{t('alerts.title')}</h2>
            {state.alerts.length === 0 ? (
              <p className="text-sm text-text-secondary">{t('alerts.empty')}</p>
            ) : (
              <ul className="space-y-3">
                {state.alerts.map((a) => {
                  const steps = t(`alerts.runbooks.${a.rule}`, { returnObjects: true }) as string[];
                  return (
                    <li key={a.id} className="rounded-2xl border border-border bg-bg-secondary p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-text-primary">{t(`alerts.rules.${a.rule}`)}</p>
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">{t(`alerts.severity.${a.severity}`)} · {t(`alerts.status.${a.status}`)}</span>
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">
                        {t('alerts.observed', { observed: a.observed, threshold: a.threshold })} · <time dateTime={a.createdAt}>{fmt.format(new Date(a.createdAt))}</time>
                      </p>
                      <details className="mt-2">
                        <summary className="cursor-pointer text-sm font-medium text-accent focus:outline-none focus:ring-2 focus:ring-accent/40">{t('alerts.runbook')}</summary>
                        <ol className="mt-2 list-decimal space-y-1 ps-5 text-sm text-text-primary">
                          {Array.isArray(steps) && steps.map((s) => <li key={s}>{s}</li>)}
                        </ol>
                      </details>
                      {a.status === 'open' && (
                        <div className="mt-3 flex gap-2">
                          <button type="button" disabled={busyId === a.id} onClick={() => void onAlert(a.id, 'acknowledged')} className="rounded-xl border border-border px-3 py-1.5 text-sm text-text-primary hover:bg-bg-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60">{t('alerts.acknowledge')}</button>
                          <button type="button" disabled={busyId === a.id} onClick={() => void onAlert(a.id, 'dismissed')} className="rounded-xl border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:opacity-60">{t('alerts.dismiss')}</button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="staff-title">
            <h2 id="staff-title" className="mb-3 flex items-center gap-2 text-lg font-semibold text-text-primary"><ShieldCheck size={18} aria-hidden="true" />{t('staff.title')}</h2>
            {state.staff.length === 0 ? (
              <p className="text-sm text-text-secondary">{t('staff.empty')}</p>
            ) : (
              <ul className="divide-y divide-border rounded-2xl border border-border bg-bg-secondary px-4">
                {state.staff.map((r, i) => (
                  <li key={`${r.occurredAt}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm">
                    <span className="text-text-primary">
                      {t(`staff.events.${r.event}`, { defaultValue: t('staff.events.view') })}
                      {r.assetClass ? ` · ${t(`history.assets.${r.assetClass}`, { defaultValue: r.assetClass })}` : ''}
                      {r.recordCount && r.recordCount > 1 ? ` · ${t('history.records', { count: r.recordCount })}` : ''}
                    </span>
                    <time dateTime={r.occurredAt} className="text-xs text-text-secondary">{fmt.format(new Date(r.occurredAt))}</time>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="vis-title">
            <h2 id="vis-title" className="sr-only">{t('visibility.label')}</h2>
            <label className="flex items-start gap-3 text-sm text-text-primary">
              <input type="checkbox" checked={showViewers} disabled={savingVis} onChange={(e) => void onVisibility(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-border accent-accent focus:ring-2 focus:ring-accent/40" />
              <span>{t('visibility.label')}<span className="mt-0.5 block text-xs text-text-secondary">{t('visibility.hint')}</span></span>
            </label>
          </section>
        </div>
      )}
    </DashboardLayout>
  );
}

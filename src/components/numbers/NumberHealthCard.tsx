import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, ShieldAlert } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { formatDateTime } from '@/lib/format';
import type { PhoneNumber } from '@/lib/phoneNumbers';
import {
  checkNumberHealthNow,
  fetchNumberHealth,
  setRemediationStep,
  viewOf,
  type HealthSeverity,
  type NumberHealthRow,
  type RemediationStepId,
} from '@/lib/numberHealth';
import { NUMBER_HEALTH_NS } from '@/i18n/numberHealthNamespace';

const card = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const btn = 'focus-ring min-h-[44px] rounded-lg px-4 text-sm font-semibold disabled:opacity-60';

const SEVERITY_STYLE: Record<HealthSeverity, string> = {
  ok: 'bg-bg-primary text-text-primary',
  watch: 'bg-warning-subtle text-warning',
  action: 'bg-danger/10 text-danger',
  unknown: 'bg-bg-primary text-text-secondary',
};
const SEVERITY_ICON: Record<HealthSeverity, typeof CheckCircle2> = { ok: CheckCircle2, watch: AlertTriangle, action: ShieldAlert, unknown: HelpCircle };

/**
 * Spam-label status, call-attestation level and a remediation checklist per active number. Values are whatever the
 * connected reputation provider reported; with no provider connected everything reads "Not checked" and no score is shown.
 */
export function NumberHealthCard({ numbers }: { numbers: PhoneNumber[] }) {
  const { t, i18n } = useTranslation(NUMBER_HEALTH_NS);
  const { toast } = useToast();
  const active = numbers.filter((n) => n.status === 'active');
  const key = active.map((n) => n.id).join(',');
  const [rows, setRows] = useState<Map<string, NumberHealthRow> | null>(null);
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const seq = useRef(0);
  const tickLock = useRef(false);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(false);
    try {
      const m = await fetchNumberHealth(key ? key.split(',') : []);
      if (mine === seq.current) setRows(m);
    } catch {
      if (mine === seq.current) setError(true);
    }
  }, [key]);
  useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  const runCheck = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const r = await checkNumberHealthNow();
      toast(r.checked > 0 ? t('checkedCount', { count: r.checked }) : r.skippedRecent > 0 ? t('checkRecent') : t('checkedCount', { count: 0 }), 'success');
      await load();
    } catch {
      toast(t('checkFailed'), 'error');
    } finally {
      setChecking(false);
    }
  };

  const tick = async (numberId: string, step: RemediationStepId, done: boolean) => {
    if (tickLock.current) return;
    tickLock.current = true;
    const before = rows?.get(numberId) ?? null;
    // Optimistic update, rolled back if the server refuses.
    setRows((m) => {
      const next = new Map(m ?? []);
      const cur = next.get(numberId);
      const base: NumberHealthRow = cur ?? { phone_number_id: numberId, provider: 'stub', provider_live: false, spam_label: 'unknown', attestation: 'unknown', label_sources: [], status: 'never', checked_at: null, last_attempt_at: null, consecutive_failures: 0, last_error_code: null, remediation_done: {} };
      next.set(numberId, { ...base, remediation_done: { ...base.remediation_done, [step]: done } });
      return next;
    });
    try {
      const saved = await setRemediationStep(numberId, step, done);
      setRows((m) => { const next = new Map(m ?? []); const cur = next.get(numberId); if (cur) next.set(numberId, { ...cur, remediation_done: saved }); return next; });
    } catch {
      setRows((m) => { const next = new Map(m ?? []); if (before) next.set(numberId, before); else next.delete(numberId); return next; });
      toast(t('remediation.saveFailed'), 'error');
    } finally {
      tickLock.current = false;
    }
  };

  if (active.length === 0) return null;
  const anyLive = [...(rows?.values() ?? [])].some((r) => r.provider_live);
  const fmt = (iso: string) => formatDateTime(iso, undefined, i18n.language);

  return (
    <section className={`${card} mt-4`} aria-labelledby="nh-h">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="nh-h" className="text-base font-semibold text-text-primary">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-text-secondary">{t('intro')}</p>
        </div>
        <button type="button" onClick={() => void runCheck()} disabled={checking || !rows} className={`${btn} border border-border text-text-primary`}>
          {checking ? <><Loader2 className="me-2 inline h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('checking')}</> : t('check')}
        </button>
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-danger">{t('load.error')} <button type="button" onClick={() => void load()} className="focus-ring font-semibold underline">{t('load.retry')}</button></p>}
      {!rows && !error && <p role="status" className="mt-3 text-sm text-text-secondary">{t('load.loading')}</p>}
      {rows && !anyLive && <p role="status" className="mt-3 rounded-lg bg-warning-subtle px-3 py-2 text-xs text-warning">{t('noProvider')}</p>}

      {rows && (
        <ul className="mt-3 space-y-3">
          {active.map((n) => {
            const v = viewOf(rows.get(n.id));
            const r = v.row;
            const Icon = SEVERITY_ICON[v.severity];
            const panelId = `nh-steps-${n.id}`;
            const isOpen = !!open[n.id];
            return (
              <li key={n.id} className="rounded-xl border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0"><span className="block truncate text-sm font-medium text-text-primary">{n.friendly_name || n.phone_number}</span><span className="text-xs text-text-secondary">{n.phone_number}</span></span>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${SEVERITY_STYLE[v.severity]}`}><Icon className="h-3.5 w-3.5" aria-hidden="true" />{t(`severity.${v.severity}`)}</span>
                </div>

                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div><dt className="text-xs font-semibold text-text-secondary">{t('spam.label')}</dt><dd className="text-text-primary">{t(`spam.${r?.spam_label ?? 'unknown'}`)}</dd></div>
                  <div><dt className="text-xs font-semibold text-text-secondary">{t('attestation.label')}</dt><dd className="text-text-primary">{t(`attestation.${r?.attestation ?? 'unknown'}`)}</dd></div>
                </dl>
                {r && r.label_sources.length > 0 && <p className="mt-2 text-xs text-text-secondary">{t('sources', { names: r.label_sources.join(', ') })}</p>}
                <p className="mt-2 text-[11px] text-text-secondary">{r?.checked_at ? t('checkedAt', { time: fmt(r.checked_at) }) : t('never')}</p>
                {v.stale && <p role="status" className="mt-1 text-xs text-warning">{t('stale')}</p>}
                {r?.status === 'error' && r.checked_at && <p role="status" className="mt-1 text-xs text-warning">{t('lastError')}</p>}

                <button type="button" aria-expanded={isOpen} aria-controls={panelId} onClick={() => setOpen((o) => ({ ...o, [n.id]: !o[n.id] }))} className={`${btn} mt-3 w-full border border-border text-text-primary sm:w-auto`}>
                  {isOpen ? t('remediation.hide') : t('remediation.show')} · {t('remediation.progress', { done: v.progress.done, total: v.progress.total })}
                </button>
                {isOpen && (
                  <div id={panelId} className="mt-3">
                    <h3 className="text-xs font-semibold text-text-secondary">{t('remediation.title')}</h3>
                    <ul className="mt-2 space-y-2">
                      {v.steps.map((s) => (
                        <li key={s}>
                          <label className="flex min-h-[44px] items-start gap-3 rounded-lg border border-border p-3 text-sm">
                            <input type="checkbox" className="mt-1 h-5 w-5" checked={r?.remediation_done[s] === true} onChange={(e) => void tick(n.id, s, e.target.checked)} />
                            <span><span className="block font-medium text-text-primary">{t(`steps.${s}.title`)}</span><span className="block text-xs text-text-secondary">{t(`steps.${s}.detail`)}</span></span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

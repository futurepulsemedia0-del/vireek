/**
 * Staff — /staff/dispute-ratio
 * Platform-wide monthly dispute ratio + threshold editor. Route is wrapped in <StaffRoute>;
 * the RPCs re-check profiles.is_staff on the server, so the UI gate is convenience, not security.
 */
import { useCallback, useEffect, useState } from 'react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useDisputeRatioT } from '@/i18n/disputeRatioNamespace';
import { fetchPlatformDisputeRatio, saveThresholds } from '@/lib/disputeRatioApi';
import { formatMonth, formatRatio, levelTone, validateThresholds, type PlatformMonthRow } from '@/lib/disputeRatio';

type Load = { status: 'loading' } | { status: 'forbidden' } | { status: 'error' } | { status: 'ready'; rows: PlatformMonthRow[] };
const TONE_TEXT = { success: 'text-success', warning: 'text-warning', danger: 'text-danger', neutral: 'text-text-secondary' } as const;

export function StaffDisputeRatioPage() {
  const { t, language } = useDisputeRatioT();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [form, setForm] = useState({ scope: 'platform' as 'platform' | 'tenant_default', warning: '0.5', critical: '0.75', minTransactions: '200', verified: false });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoad({ status: 'loading' });
    try {
      const rows = await fetchPlatformDisputeRatio(12);
      setLoad({ status: 'ready', rows });
      const cur = rows[0];
      if (cur) setForm((f) => (f.scope === 'platform' ? { ...f, warning: String(cur.warning_pct), critical: String(cur.critical_pct), minTransactions: String(cur.min_transactions), verified: cur.thresholds_verified } : f));
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      setLoad({ status: code === '42501' ? 'forbidden' : 'error' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = async () => {
    if (busy) return;
    const v = validateThresholds({ warning: form.warning, critical: form.critical, minTransactions: form.minTransactions });
    if (v.error || !v.value) {
      setMsg({ kind: 'err', text: t(v.error === 'minTransactions' ? 'platform.minTransactionsError' : `platform.${v.error ?? 'invalidNumber'}`) });
      return;
    }
    setBusy(true);
    try {
      await saveThresholds({ scope: form.scope, warning: v.value.warning, critical: v.value.critical, minTransactions: v.value.minTransactions, verified: form.verified });
      setMsg({ kind: 'ok', text: t('platform.saved') });
      await refresh();
    } catch {
      setMsg({ kind: 'err', text: t('platform.saveFailed') });
    } finally {
      setBusy(false);
    }
  };

  const rows = load.status === 'ready' ? load.rows : [];
  const verified = rows[0]?.thresholds_verified ?? false;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <header>
          <h1 className="text-xl font-semibold text-text-primary">{t('platform.title')}</h1>
          <p className="text-sm text-text-secondary">{t('platform.subtitle')}</p>
        </header>

        {load.status === 'loading' && <div className="h-40 animate-pulse rounded-2xl bg-bg-tertiary" role="status" aria-label={t('loading')} />}
        {load.status === 'forbidden' && <p className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary" role="alert">{t('platform.forbidden')}</p>}
        {load.status === 'error' && (
          <p className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary" role="alert">
            {t('loadFailed')}{' '}
            <button type="button" onClick={() => void refresh()} className="focus-ring rounded font-medium text-accent hover:underline">{t('retry')}</button>
          </p>
        )}

        {load.status === 'ready' && (
          <>
            {rows.length === 0 ? (
              <p className="rounded-2xl border border-border bg-bg-secondary p-6 text-sm text-text-secondary">{t('empty')}</p>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-border bg-bg-secondary">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-text-secondary">
                      {(['month', 'disputes', 'payments', 'ratio', 'status', 'tenantsWarning', 'tenantsCritical'] as const).map((k) => (
                        <th key={k} scope="col" className="px-4 py-3 text-start font-medium">{t(`platform.${k}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.month} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 text-text-primary">{formatMonth(r.month, language)}</td>
                        <td className="px-4 py-3 text-text-primary" dir="ltr">{r.disputes_count}</td>
                        <td className="px-4 py-3 text-text-primary" dir="ltr">{r.txn_count}</td>
                        <td className={`px-4 py-3 font-medium ${TONE_TEXT[levelTone(r.level)]}`} dir="ltr">{formatRatio(r.ratio_pct, language)}</td>
                        <td className={`px-4 py-3 ${TONE_TEXT[levelTone(r.level)]}`}>{t(`levels.${r.level}`)}</td>
                        <td className="px-4 py-3 text-text-primary" dir="ltr">{r.tenants_warning}</td>
                        <td className="px-4 py-3 text-text-primary" dir="ltr">{r.tenants_critical}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <section className="rounded-2xl border border-border bg-bg-secondary p-6">
              <h2 className="text-sm font-semibold text-text-primary">{t('platform.settings')}</h2>
              <p className={`mt-1 text-xs ${verified ? 'text-text-secondary' : 'text-warning'}`}>{verified ? t('platform.verified') : t('platform.unverified')}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-4">
                <label className="block text-xs">
                  <span className="text-text-secondary">{t('platform.scope.platform')} / {t('platform.scope.tenant_default')}</span>
                  <select value={form.scope} onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value as 'platform' | 'tenant_default' }))} className="focus-ring mt-1 block w-full rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary">
                    <option value="platform">{t('platform.scope.platform')}</option>
                    <option value="tenant_default">{t('platform.scope.tenant_default')}</option>
                  </select>
                </label>
                {(['warning', 'critical', 'minTransactions'] as const).map((k) => (
                  <label key={k} className="block text-xs">
                    <span className="text-text-secondary">{t(`platform.${k}`)}</span>
                    <input value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} inputMode="decimal" dir="ltr" className="focus-ring mt-1 block w-full rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary" />
                  </label>
                ))}
              </div>
              <label className="mt-3 flex items-center gap-2 text-xs text-text-primary">
                <input type="checkbox" checked={form.verified} onChange={(e) => setForm((f) => ({ ...f, verified: e.target.checked }))} />
                {t('platform.markVerified')}
              </label>
              <button type="button" onClick={() => void onSave()} disabled={busy} className="focus-ring mt-4 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                {t('platform.save')}
              </button>
              {msg && <p className={`mt-3 text-xs ${msg.kind === 'err' ? 'text-danger' : 'text-text-secondary'}`} role={msg.kind === 'err' ? 'alert' : 'status'}>{msg.text}</p>}
            </section>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

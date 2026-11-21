import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Settings2, Wallet } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useStoredValueT } from '@/i18n/storedValueNamespace';
import {
  csvFileName,
  dormancyDistribution,
  formatCents,
  instrumentsToCsv,
  summarizeLiability,
  validateSettings,
  INSTRUMENT_KINDS,
  type DormancyRow,
  type LiabilitySummaryRow,
  type StoredValueSettings,
} from '@/lib/storedValueLiability';
import { downloadCsv, fetchAllInstruments, fetchLiabilitySnapshot, saveSettings } from '@/lib/storedValueLiabilityApi';

type Snapshot = { summary: LiabilitySummaryRow[]; dormancy: DormancyRow[]; settings: StoredValueSettings };
type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: Snapshot };

/** Overview widget (billing permission). Informational only — no legal conclusions. */
export function StoredValueCard() {
  const { t, language } = useStoredValueT();
  const { user, teamMember, isOwner } = useAuth();
  const ownerId = isOwner ? user?.id : teamMember?.account_owner_id; // accountOwnerId scoping

  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState({ state_code: '', review_period_months: '', include_loyalty_points: false });

  const refresh = useCallback(async () => {
    if (!ownerId) return;
    setLoad({ status: 'loading' });
    try {
      const data = await fetchLiabilitySnapshot(ownerId);
      setLoad({ status: 'ready', data });
      setForm({
        state_code: data.settings.state_code ?? '',
        review_period_months: data.settings.review_period_months?.toString() ?? '',
        include_loyalty_points: data.settings.include_loyalty_points,
      });
    } catch {
      setLoad({ status: 'error' });
    }
  }, [ownerId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const includeLoyalty = load.status === 'ready' && load.data.settings.include_loyalty_points;
  const totals = useMemo(
    () => (load.status === 'ready' ? summarizeLiability(load.data.summary, includeLoyalty) : []),
    [load, includeLoyalty],
  );
  const main = totals[0];
  const buckets = useMemo(
    () => (load.status === 'ready' && main ? dormancyDistribution(load.data.dormancy, main.currency, includeLoyalty) : []),
    [load, main, includeLoyalty],
  );
  const maxBucket = Math.max(1, ...buckets.map((b) => b.cents));

  const onExport = async () => {
    if (!ownerId || busy) return;
    setBusy(true);
    setMsg({ kind: 'ok', text: t('exporting') });
    try {
      const { rows, truncated } = await fetchAllInstruments(ownerId);
      const csv = instrumentsToCsv(rows, includeLoyalty);
      if (rows.filter((r) => includeLoyalty || r.instrument_kind !== 'loyalty_points').length === 0) {
        setMsg({ kind: 'ok', text: t('exportEmpty') });
      } else {
        downloadCsv(csv, csvFileName());
        setMsg(truncated ? { kind: 'ok', text: t('exportTruncated', { count: rows.length }) } : null);
      }
    } catch {
      setMsg({ kind: 'err', text: t('exportFailed') });
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (busy) return;
    const v = validateSettings({ state_code: form.state_code, review_period_months: form.review_period_months });
    if (v.error) {
      setMsg({ kind: 'err', text: t(`settings.${v.error}`) });
      return;
    }
    setBusy(true);
    try {
      await saveSettings({ ...v.value, include_loyalty_points: form.include_loyalty_points });
      setMsg({ kind: 'ok', text: t('settings.saved') });
      await refresh();
    } catch {
      setMsg({ kind: 'err', text: t('settings.saveFailed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark">
      <div className="flex items-center justify-between gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Wallet size={20} aria-hidden="true" />
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            aria-expanded={showSettings}
            className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:underline"
          >
            <Settings2 size={12} aria-hidden="true" /> {t('settings.open')}
          </button>
          <button
            type="button"
            onClick={() => void onExport()}
            disabled={busy || load.status !== 'ready'}
            className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-accent hover:underline disabled:opacity-50"
          >
            <Download size={12} aria-hidden="true" /> {t('export')}
          </button>
        </div>
      </div>

      <p className="mt-4 text-sm font-medium text-text-primary">{t('title')}</p>
      <p className="text-xs text-text-secondary">{t('subtitle')}</p>

      {load.status === 'loading' && (
        <div className="mt-3 h-9 w-32 animate-pulse rounded bg-bg-tertiary" role="status" aria-label={t('loading')} />
      )}

      {load.status === 'error' && (
        <div className="mt-3 text-sm text-text-secondary" role="alert">
          {t('loadFailed')}{' '}
          <button type="button" onClick={() => void refresh()} className="focus-ring rounded font-medium text-accent hover:underline">
            {t('retry')}
          </button>
        </div>
      )}

      {load.status === 'ready' && !main && <p className="mt-3 text-sm text-text-secondary">{t('empty')}</p>}

      {load.status === 'ready' && main && (
        <>
          <p className="mt-3 text-3xl font-bold text-text-primary" dir="ltr">
            {formatCents(main.outstandingCents, main.currency, language)}
          </p>
          <p className="text-xs text-text-secondary">{t('openBalances', { count: main.instrumentCount })}</p>

          <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-xs">
            <div>
              <dt className="text-text-secondary">{t('expiredBalance')}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-text-primary" dir="ltr">{formatCents(main.expiredCents, main.currency, language)}</dd>
            </div>
            <div>
              <dt className="text-text-secondary" title={t('pastReviewHint')}>{t('pastReview')}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-text-primary" dir="ltr">{formatCents(main.pastReviewCents, main.currency, language)}</dd>
            </div>
          </dl>

          <div className="mt-4">
            <p className="text-xs font-medium text-text-secondary">{t('dormancyTitle')}</p>
            <ul className="mt-2 space-y-1.5">
              {buckets.map((b) => (
                <li key={b.bucket} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 text-text-secondary">{t(`buckets.${b.bucket}`)}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded bg-bg-tertiary" aria-hidden="true">
                    <span className="block h-full rounded bg-accent" style={{ width: `${Math.round((b.cents / maxBucket) * 100)}%` }} />
                  </span>
                  <span className="w-20 shrink-0 text-end text-text-primary" dir="ltr">{formatCents(b.cents, main.currency, language)}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="mt-3 text-xs text-text-secondary">
            {INSTRUMENT_KINDS.filter((k) => load.data.summary.some((r) => r.instrument_kind === k && (k !== 'loyalty_points' || includeLoyalty)))
              .map((k) => t(`kinds.${k}`))
              .join(' · ')}
            {' — '}
            {includeLoyalty ? t('loyaltyIncluded') : t('loyaltyExcluded')}
          </p>
          {main.unreconciledCount > 0 && (
            <p className="mt-1 text-xs text-warning">{t('unreconciled', { count: main.unreconciledCount })}</p>
          )}
        </>
      )}

      {showSettings && load.status === 'ready' && (
        <div className="mt-4 space-y-3 border-t border-border pt-4 text-xs">
          <label className="block">
            <span className="text-text-secondary">{t('settings.state')}</span>
            <input
              value={form.state_code}
              onChange={(e) => setForm((f) => ({ ...f, state_code: e.target.value.slice(0, 2) }))}
              maxLength={2}
              dir="ltr"
              className="focus-ring mt-1 block w-full rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm uppercase text-text-primary"
            />
          </label>
          <label className="block">
            <span className="text-text-secondary">{t('settings.period')}</span>
            <input
              value={form.review_period_months}
              onChange={(e) => setForm((f) => ({ ...f, review_period_months: e.target.value.replace(/\D/g, '').slice(0, 3) }))}
              inputMode="numeric"
              dir="ltr"
              className="focus-ring mt-1 block w-full rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary"
            />
            <span className="mt-1 block text-text-secondary">{t('settings.periodHint')}</span>
          </label>
          <label className="flex items-center gap-2 text-text-primary">
            <input
              type="checkbox"
              checked={form.include_loyalty_points}
              onChange={(e) => setForm((f) => ({ ...f, include_loyalty_points: e.target.checked }))}
            />
            {t('settings.includeLoyalty')}
          </label>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={busy}
            className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {t('settings.save')}
          </button>
        </div>
      )}

      {msg && (
        <p className={`mt-3 text-xs ${msg.kind === 'err' ? 'text-danger' : 'text-text-secondary'}`} role={msg.kind === 'err' ? 'alert' : 'status'}>
          {msg.text}
        </p>
      )}

      <p className="mt-4 border-t border-border pt-3 text-[11px] leading-relaxed text-text-secondary">{t('notice')}</p>
    </div>
  );
}

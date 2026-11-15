/**
 * Staff view — /staff/win-loss (wrapped in <StaffRoute>). Vireek staff only.
 * Record why deals are won or lost, and read the aggregate. Data: win_loss_records + win_loss_summary
 * (RLS: is_vireek_staff). Method: docs/sales/win-loss-interview-guide.md.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useWinLossT } from '@/i18n/winLossNamespace';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input, Textarea } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonPage } from '@/components/Skeleton';
import {
  createWinLossRecord, deleteWinLossRecord, fetchWinLossRecords, fetchWinLossSummary, updateWinLossRecord, WinLossApiError,
} from '@/lib/winLossApi';
import {
  INTERVIEW_STATUSES, LIMITS, MIN_DECIDED_FOR_RATE, OUTCOMES, REASONS, draftFromRecord, emptyDraft, groupSummary, isKnownReason,
  isLowSample, validateDraft, type DraftErrors, type SummaryRow, type WinLossDraft, type WinLossRecord,
} from '@/lib/winLoss';

type Load = 'loading' | 'ready' | 'error' | 'forbidden';
type Tab = 'competitor' | 'reason' | 'quarter';
const TABS: readonly Tab[] = ['competitor', 'reason', 'quarter'];
const todayUtc = () => new Date().toISOString().slice(0, 10);
const RECORD_LIMIT = 200;

export function StaffWinLossPage() {
  const { t, language } = useWinLossT();
  const { toast } = useToast();
  const [load, setLoad] = useState<Load>('loading');
  const [records, setRecords] = useState<WinLossRecord[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [tab, setTab] = useState<Tab>('competitor');
  const [draft, setDraft] = useState<WinLossDraft>(() => emptyDraft(todayUtc()));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const money = useMemo(() => new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }), [language]);
  const date = useMemo(() => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }), [language]);
  const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`);

  const refresh = useCallback(async () => {
    try {
      const [recs, sum] = await Promise.all([fetchWinLossRecords(RECORD_LIMIT), fetchWinLossSummary()]);
      setRecords(recs);
      setSummary(sum);
      setLoad('ready');
    } catch (e) {
      setLoad(e instanceof WinLossApiError && e.code === 'forbidden' ? 'forbidden' : 'error');
    }
  }, []);

  useEffect(() => {
    setLoad('loading');
    void refresh();
  }, [refresh]);

  const grouped = useMemo(() => groupSummary(summary), [summary]);
  const overall = grouped.overall[0];
  const set = <K extends keyof WinLossDraft>(key: K, value: WinLossDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const err = (k: keyof WinLossDraft) => (errors[k] ? t(`errors.${errors[k]}`) : undefined);

  const toggleReason = (r: (typeof REASONS)[number], on: boolean) =>
    setDraft((d) => ({ ...d, reasons: on ? [...new Set([...d.reasons, r])] : d.reasons.filter((x) => x !== r) }));

  const resetForm = () => {
    setDraft(emptyDraft(todayUtc()));
    setErrors({});
    setEditingId(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const result = validateDraft(draft, todayUtc());
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (editingId) await updateWinLossRecord(editingId, result.payload);
      else await createWinLossRecord(result.payload);
      toast(t(editingId ? 'form.updated' : 'form.saved'), 'success');
      resetForm();
      await refresh();
    } catch (ex) {
      const code = ex instanceof WinLossApiError ? ex.code : 'unknown';
      toast(t(code === 'forbidden' ? 'form.saveForbidden' : code === 'invalid' ? 'form.saveInvalid' : 'form.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (id: string) => {
    try {
      await deleteWinLossRecord(id);
      toast(t('records.deleted'), 'success');
      if (editingId === id) resetForm();
      await refresh();
    } catch {
      toast(t('records.deleteFailed'), 'error');
    } finally {
      setConfirmId(null);
    }
  };

  const bucketLabel = (dimension: Tab, bucket: string) =>
    dimension === 'reason' && isKnownReason(bucket) ? t(`reasons.${bucket}`) : bucket === '(none)' ? t('summary.none') : bucket;

  if (load === 'loading') return <main className="mx-auto max-w-6xl p-4 sm:p-6" aria-busy="true"><SkeletonPage /></main>;

  if (load === 'forbidden' || load === 'error') {
    const forbidden = load === 'forbidden';
    return (
      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <EmptyState
          icon={AlertTriangle}
          variant={forbidden ? 'no-permission' : 'load-failed'}
          title={t(forbidden ? 'page.forbiddenTitle' : 'page.loadFailedTitle')}
          description={t(forbidden ? 'page.forbiddenBody' : 'page.loadFailedBody')}
          action={forbidden ? undefined : { label: t('page.retry'), onClick: () => { setLoad('loading'); void refresh(); } }}
        />
      </main>
    );
  }

  const rows = tab === 'competitor' || tab === 'reason' || tab === 'quarter' ? grouped[tab] : [];

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <PageHeader title={t('page.title')} context={t('page.subtitle')} />

      <section aria-labelledby="wl-summary" className="space-y-4">
        <h2 id="wl-summary" className="text-base font-semibold text-text-primary">{t('summary.title')}</h2>
        {!overall ? (
          <EmptyState compact icon={AlertTriangle} title={t('summary.empty')} />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {([
                ['summary.wins', String(overall.wins)],
                ['summary.losses', String(overall.losses)],
                ['summary.noDecisions', String(overall.no_decisions)],
                ['summary.winRate', pct(overall.win_rate_pct)],
              ] as const).map(([k, v]) => (
                <Card key={k} padding="md" interactive={false}>
                  <h3 className="text-sm text-text-secondary">{t(k)}</h3>
                  <p className="mt-1 text-2xl font-semibold text-text-primary">{v}</p>
                </Card>
              ))}
            </div>
            <p className="text-xs text-text-secondary">{t('summary.winRateNote')}</p>
            {isLowSample(overall) && (
              <p role="status" className="text-xs text-warning">{t('summary.lowSample', { count: MIN_DECIDED_FOR_RATE })}</p>
            )}

            <div role="tablist" aria-label={t('summary.title')} className="flex flex-wrap gap-2">
              {TABS.map((k) => (
                <Button key={k} role="tab" aria-selected={tab === k} selected={tab === k} variant="secondary" size="sm" onClick={() => setTab(k)}>
                  {t(`summary.tabs.${k}`)}
                </Button>
              ))}
            </div>
            {tab === 'reason' && <p className="text-xs text-text-secondary">{t('summary.reasonNote')}</p>}
            <Card padding="sm" interactive={false}>
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <caption className="sr-only">{t(`summary.tabs.${tab}`)}</caption>
                  <thead>
                    <tr className="text-text-secondary">
                      {(['bucket', 'wins', 'losses', 'noDecisions', 'winRate', 'wonValue', 'lostValue'] as const).map((c) => (
                        <th key={c} scope="col" className="px-3 py-2 text-start font-medium">{t(`summary.cols.${c}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.dimension}:${r.bucket}`} className="border-t border-border">
                        <th scope="row" className="px-3 py-2 text-start font-medium text-text-primary">{bucketLabel(tab, r.bucket)}</th>
                        <td className="px-3 py-2">{r.wins}</td>
                        <td className="px-3 py-2">{r.losses}</td>
                        <td className="px-3 py-2">{r.no_decisions}</td>
                        <td className="px-3 py-2">
                          {pct(r.win_rate_pct)}
                          {isLowSample(r) && r.decided > 0 && <span className="ms-2 text-xs text-warning" title={t('summary.lowSample', { count: MIN_DECIDED_FOR_RATE })}>n={r.decided}</span>}
                        </td>
                        <td className="px-3 py-2">{money.format(r.won_value_cents / 100)}</td>
                        <td className="px-3 py-2">{money.format(r.lost_value_cents / 100)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </section>

      <section aria-labelledby="wl-form">
        <Card padding="md" interactive={false}>
          <h2 id="wl-form" className="mb-4 text-base font-semibold text-text-primary">{t(editingId ? 'form.titleEdit' : 'form.titleNew')}</h2>
          <form onSubmit={(e) => void onSubmit(e)} noValidate className="grid gap-4 md:grid-cols-2">
            <Input label={t('form.dealName')} helperText={t('form.dealNameHelp')} value={draft.dealName} maxLength={LIMITS.dealName + 50}
              onChange={(e) => set('dealName', e.target.value)} error={err('dealName')} required />
            <Select label={t('form.outcome')} value={draft.outcome} onChange={(e) => set('outcome', e.target.value as WinLossDraft['outcome'])} error={err('outcome')} required>
              <option value="">{t('form.outcomeChoose')}</option>
              {OUTCOMES.map((o) => <option key={o} value={o}>{t(`outcomes.${o}`)}</option>)}
            </Select>
            <Input label={t('form.competitor')} helperText={t('form.competitorHelp')} value={draft.competitor} maxLength={LIMITS.competitor + 20}
              onChange={(e) => set('competitor', e.target.value)} error={err('competitor')} required={draft.outcome === 'lost'} />
            <Input label={t('form.closedOn')} type="date" value={draft.closedOn} min={LIMITS.minDate} onChange={(e) => set('closedOn', e.target.value)} error={err('closedOn')} required />

            <fieldset className="md:col-span-2" aria-describedby="wl-reasons-help">
              <legend className="mb-1 text-sm font-medium text-text-primary">{t('form.reasons', { max: LIMITS.maxReasons })}</legend>
              <p id="wl-reasons-help" className="mb-2 text-xs text-text-secondary">{t('form.reasonsHelp')}</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {REASONS.map((r) => {
                  const on = draft.reasons.includes(r);
                  return (
                    <Checkbox key={r} label={t(`reasons.${r}`)} checked={on} disabled={!on && draft.reasons.length >= LIMITS.maxReasons}
                      onChange={(e) => toggleReason(r, e.target.checked)} />
                  );
                })}
              </div>
              {errors.reasons && <p role="alert" className="mt-2 text-sm text-danger">{err('reasons')}</p>}
            </fieldset>

            <Input label={t('form.dealValue')} inputMode="decimal" value={draft.dealValue} onChange={(e) => set('dealValue', e.target.value)} error={err('dealValue')} />
            <Select label={t('form.interview')} value={draft.interviewStatus} onChange={(e) => set('interviewStatus', e.target.value as WinLossDraft['interviewStatus'])}>
              {INTERVIEW_STATUSES.map((s) => <option key={s} value={s}>{t(`interviewStatuses.${s}`)}</option>)}
            </Select>
            <div className="md:col-span-2">
              <Textarea label={t('form.notes')} helperText={t('form.notesHelp')} value={draft.notes} onChange={(e) => set('notes', e.target.value)} error={err('notes')} rows={4} />
            </div>

            <div className="flex flex-wrap gap-3 md:col-span-2">
              <Button type="submit" loading={saving} loadingLabel={t('form.saving')}>{t(editingId ? 'form.saveChanges' : 'form.save')}</Button>
              {editingId && <Button type="button" variant="secondary" onClick={resetForm}>{t('form.cancelEdit')}</Button>}
            </div>
          </form>
        </Card>
      </section>

      <section aria-labelledby="wl-records" className="space-y-3">
        <h2 id="wl-records" className="text-base font-semibold text-text-primary">{t('records.title')}</h2>
        {records.length === 0 ? (
          <EmptyState compact icon={AlertTriangle} title={t('records.empty')} />
        ) : (
          <ul className="space-y-3">
            {records.map((r) => (
              <li key={r.id}>
                <Card padding="sm" interactive={false}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-text-primary">{r.deal_name}</p>
                      <p className="text-xs text-text-secondary">
                        {t(`outcomes.${r.outcome}`)} · {r.competitor ?? t('summary.none')} · {t('records.closed', { date: date.format(new Date(`${r.closed_on}T00:00:00Z`)) })}
                        {r.deal_value_cents !== null ? ` · ${money.format(r.deal_value_cents / 100)}` : ''}
                      </p>
                      {r.reasons.length > 0 && (
                        <p className="mt-1 text-xs text-text-secondary">{r.reasons.map((x) => (isKnownReason(x) ? t(`reasons.${x}`) : x)).join(', ')}</p>
                      )}
                      {r.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-text-primary">{r.notes}</p>}
                    </div>
                    <div className="flex gap-2">
                      <Button size="xs" variant="secondary" onClick={() => { setEditingId(r.id); setDraft(draftFromRecord(r)); setErrors({}); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                        {t('records.edit')}
                      </Button>
                      {confirmId === r.id ? (
                        <>
                          <Button size="xs" variant="danger" onClick={() => void onDelete(r.id)}>{t('records.confirmDelete')}</Button>
                          <Button size="xs" variant="ghost" onClick={() => setConfirmId(null)}>{t('records.cancel')}</Button>
                        </>
                      ) : (
                        <Button size="xs" variant="ghost" onClick={() => setConfirmId(r.id)}>{t('records.delete')}</Button>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {records.length >= RECORD_LIMIT && <p className="text-xs text-text-secondary">{t('records.limitNote', { count: RECORD_LIMIT })}</p>}
      </section>
    </main>
  );
}

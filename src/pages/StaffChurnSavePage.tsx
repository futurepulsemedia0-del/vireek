/** Staff — /staff/churn-save (wrapped in <StaffRoute>): configure save offers, caps, and track outcomes. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useChurnSaveT } from '@/i18n/churnSaveNamespace';
import {
  BANDS,
  DOWNGRADE_PLANS,
  OFFER_KINDS,
  REASONS,
  emptyDraft,
  fetchChurnSaveOverview,
  offerToDraft,
  pct,
  saveOffer,
  saveSettings,
  validateDraft,
  type ChurnSaveOverview,
  type OfferDraft,
  type OfferKind,
  type StaffOffer,
} from '@/lib/churnSave';

type Tab = 'offers' | 'outcomes' | 'audit';
type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: ChurnSaveOverview };

const SELECT =
  'focus-ring min-h-[44px] w-full rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary';

function Chips({ options, value, onChange, label }: { options: readonly string[]; value: string[]; onChange: (v: string[]) => void; label: (v: string) => string }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
            className={`focus-ring min-h-[36px] rounded-full border px-3 text-xs font-medium ${on ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}
          >
            {label(o)}
          </button>
        );
      })}
    </div>
  );
}

function OfferForm({ initial, onCancel, onSaved }: { initial: OfferDraft; onCancel: () => void; onSaved: () => void }) {
  const { t } = useChurnSaveT();
  const { toast } = useToast();
  const [d, setD] = useState<OfferDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const errors = useMemo(() => validateDraft(d), [d]);
  const err = (k: keyof OfferDraft) => (showErrors && errors[k] ? t(`staff.errors.${errors[k]}`) : undefined);
  const set = <K extends keyof OfferDraft>(k: K, v: OfferDraft[K]) => setD((p) => ({ ...p, [k]: v }));
  const isNew = !d.id;

  const submit = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length > 0 || busy) return;
    setBusy(true);
    try {
      await saveOffer(d);
      toast(t('staff.saved'), 'success');
      onSaved();
    } catch {
      toast(t('staff.saveFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-5 hover:translate-y-0">
      <h2 className="text-base font-semibold text-text-primary">{isNew ? t('staff.form.newTitle') : t('staff.form.editTitle')}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="cs-kind" className="mb-1 block text-xs font-medium text-text-secondary">{t('staff.form.kind')}</label>
          <select id="cs-kind" className={SELECT} value={d.kind} disabled={!isNew} onChange={(e) => set('kind', e.target.value as OfferKind)}>
            {OFFER_KINDS.map((k) => <option key={k} value={k}>{t(`staff.kind.${k}`)}</option>)}
          </select>
        </div>
        <Input label={t('staff.form.name')} value={d.name} maxLength={80} error={err('name')} onChange={(e) => set('name', e.target.value)} />
        {d.kind === 'pause' && <Input label={t('staff.form.pauseMonths')} inputMode="numeric" value={d.pause_months} error={err('pause_months')} onChange={(e) => set('pause_months', e.target.value)} />}
        {d.kind === 'downgrade' && (
          <div>
            <label htmlFor="cs-plan" className="mb-1 block text-xs font-medium text-text-secondary">{t('staff.form.plan')}</label>
            <select id="cs-plan" className={SELECT} value={d.downgrade_plan} onChange={(e) => set('downgrade_plan', e.target.value)}>
              {DOWNGRADE_PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        )}
        {d.kind === 'discount' && (
          <>
            <Input label={t('staff.form.percent')} inputMode="decimal" value={d.discount_percent} error={err('discount_percent')} helperText={t('staff.form.percentHelp')} onChange={(e) => set('discount_percent', e.target.value)} />
            <Input label={t('staff.form.discountMonths')} inputMode="numeric" value={d.discount_months} error={err('discount_months')} onChange={(e) => set('discount_months', e.target.value)} />
          </>
        )}
        <Input label={t('staff.form.priority')} inputMode="numeric" value={d.priority} error={err('priority')} helperText={t('staff.form.priorityHelp')} onChange={(e) => set('priority', e.target.value)} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-text-secondary">{t('staff.form.reasons')}</legend>
        <Chips options={REASONS} value={d.target_reasons} onChange={(v) => set('target_reasons', v)} label={(v) => t(`staff.reason.${v}`)} />
        <p className="text-[11px] text-text-secondary">{t('staff.form.emptyMeansAll')}</p>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-text-secondary">{t('staff.form.bands')}</legend>
        <Chips options={BANDS} value={d.target_bands} onChange={(v) => set('target_bands', v)} label={(v) => t(`staff.band.${v}`)} />
        <p className="text-[11px] text-text-secondary">{t('staff.form.bandsHelp')}</p>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input label={t('staff.form.perAccount')} inputMode="numeric" value={d.max_per_account} error={err('max_per_account')} onChange={(e) => set('max_per_account', e.target.value)} />
        <Input label={t('staff.form.cooldown')} inputMode="numeric" value={d.cooldown_days} error={err('cooldown_days')} onChange={(e) => set('cooldown_days', e.target.value)} />
        <Input label={t('staff.form.capTotal')} inputMode="numeric" value={d.cap_total} error={err('cap_total')} helperText={t('staff.form.capTotalHelp')} onChange={(e) => set('cap_total', e.target.value)} />
        <Input label={t('staff.form.window')} inputMode="numeric" value={d.cap_window_days} error={err('cap_window_days')} onChange={(e) => set('cap_window_days', e.target.value)} />
        <Input label={t('staff.form.starts')} type="datetime-local" value={d.starts_at} onChange={(e) => set('starts_at', e.target.value)} />
        <Input label={t('staff.form.ends')} type="datetime-local" value={d.ends_at} error={err('ends_at')} onChange={(e) => set('ends_at', e.target.value)} />
      </div>

      <label className="flex min-h-[44px] items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" className="h-4 w-4 accent-accent" checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} />
        {t('staff.form.enabled')}
      </label>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onCancel}>{t('staff.form.cancel')}</Button>
        <Button type="button" onClick={() => void submit()} loading={busy}>{t('staff.form.save')}</Button>
      </div>
    </Card>
  );
}

function termsText(o: StaffOffer, t: (k: string, v?: Record<string, unknown>) => string): string {
  if (o.kind === 'pause') return t('staff.terms.pause', { months: o.pause_months });
  if (o.kind === 'downgrade') return t('staff.terms.downgrade', { plan: o.downgrade_plan });
  return t('staff.terms.discount', { percent: o.discount_percent, months: o.discount_months });
}

export function StaffChurnSavePage() {
  const { t, language } = useChurnSaveT();
  const { toast } = useToast();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [tab, setTab] = useState<Tab>('offers');
  const [editing, setEditing] = useState<OfferDraft | null>(null);
  const [cooldown, setCooldown] = useState('90');
  const [settingsBusy, setSettingsBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchChurnSaveOverview(90);
      setCooldown(String(data.settings.global_cooldown_days));
      setLoad({ kind: 'ready', data });
    } catch {
      setLoad({ kind: 'error' });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const fmt = (iso: string) => (Number.isNaN(Date.parse(iso)) ? '—' : new Date(iso).toLocaleString(language));
  const rate = (a: number, b: number) => {
    const p = pct(a, b);
    return p === null ? '—' : `${p}%`;
  };

  const updateSettings = async (enabled: boolean, days: string) => {
    if (!/^\d+$/.test(days) || Number(days) > 730) {
      toast(t('staff.errors.cooldown'), 'error');
      return;
    }
    setSettingsBusy(true);
    try {
      await saveSettings(enabled, Number(days));
      toast(t('staff.saved'), 'success');
      await refresh();
    } catch {
      toast(t('staff.saveFailed'), 'error');
    } finally {
      setSettingsBusy(false);
    }
  };

  let body: React.ReactNode;
  if (load.kind === 'loading') {
    body = (
      <div role="status" aria-live="polite">
        <span className="sr-only">{t('staff.loading')}</span>
        <SkeletonCardList count={3} rows={3} />
      </div>
    );
  } else if (load.kind === 'error') {
    body = <EmptyStateError icon={WifiOff} title={t('staff.loadError')} description={t('staff.loadErrorHelp')} onRetry={() => { setLoad({ kind: 'loading' }); void refresh(); }} />;
  } else {
    const { data } = load;
    body = (
      <div className="space-y-5">
        <Card className="space-y-3 p-5 hover:translate-y-0">
          <h2 className="text-base font-semibold text-text-primary">{t('staff.settings.title')}</h2>
          <label className="flex min-h-[44px] items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" className="h-4 w-4 accent-accent" checked={data.settings.enabled} disabled={settingsBusy} onChange={(e) => void updateSettings(e.target.checked, cooldown)} />
            {t('staff.settings.killSwitch')}
          </label>
          <p className="text-xs text-text-secondary">{t('staff.settings.killSwitchHelp')}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Input label={t('staff.settings.globalCooldown')} inputMode="numeric" value={cooldown} onChange={(e) => setCooldown(e.target.value)} helperText={t('staff.settings.globalCooldownHelp')} />
            <Button type="button" variant="secondary" loading={settingsBusy} onClick={() => void updateSettings(data.settings.enabled, cooldown)}>{t('staff.form.save')}</Button>
          </div>
        </Card>

        <div role="tablist" aria-label={t('staff.title')} className="flex gap-2 overflow-x-auto">
          {(['offers', 'outcomes', 'audit'] as Tab[]).map((k) => (
            <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`focus-ring min-h-[44px] shrink-0 rounded-xl border px-4 text-sm font-medium ${tab === k ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>
              {t(`staff.tabs.${k}`)}
            </button>
          ))}
        </div>

        {tab === 'offers' && (
          <div className="space-y-4" role="tabpanel">
            {editing ? (
              <OfferForm initial={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} />
            ) : (
              <div className="flex flex-wrap gap-2">
                {OFFER_KINDS.map((k) => (
                  <Button key={k} type="button" variant="secondary" size="sm" onClick={() => setEditing(emptyDraft(k))}>{t('staff.addKind', { kind: t(`staff.kind.${k}`) })}</Button>
                ))}
              </div>
            )}
            {data.offers.length === 0 ? (
              <EmptyState icon={WifiOff} title={t('staff.empty.title')} description={t('staff.empty.text')} />
            ) : (
              data.offers.map((o) => (
                <Card key={o.id} className="space-y-2 p-5 hover:translate-y-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-text-primary">{o.name}</p>
                      <p className="text-xs text-text-secondary">{t(`staff.kind.${o.kind}`)} · {termsText(o, t)}</p>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${o.enabled ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}>
                      {o.enabled ? t('staff.on') : t('staff.off')}
                    </span>
                  </div>
                  <p className="text-xs text-text-secondary">
                    {t('staff.capsLine', { perAccount: o.max_per_account, cooldown: o.cooldown_days, used: o.in_cap_window, total: o.cap_total ?? '∞', window: o.cap_window_days })}
                  </p>
                  <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(offerToDraft(o)); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{t('staff.edit')}</Button>
                </Card>
              ))
            )}
          </div>
        )}

        {tab === 'outcomes' && (
          <div className="space-y-5" role="tabpanel">
            <p className="text-xs text-text-secondary">{t('staff.outcomes.note', { days: data.days })}</p>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[640px] text-start text-sm">
                <thead className="bg-bg-tertiary text-xs text-text-secondary">
                  <tr>{['offer', 'presented', 'accepted', 'acceptRate', 'declined', 'retained'].map((c) => <th key={c} scope="col" className="px-3 py-2 text-start font-medium">{t(`staff.outcomes.cols.${c}`)}</th>)}</tr>
                </thead>
                <tbody>
                  {data.offers.map((o) => (
                    <tr key={o.id} className="border-t border-border">
                      <th scope="row" className="px-3 py-2 text-start font-medium text-text-primary">{o.name}</th>
                      <td className="px-3 py-2">{o.presented}</td>
                      <td className="px-3 py-2">{o.accepted}</td>
                      <td className="px-3 py-2">{rate(o.accepted, o.presented)}</td>
                      <td className="px-3 py-2">{o.declined}</td>
                      <td className="px-3 py-2">{o.retention_cohort_30d > 0 ? `${o.retained_30d}/${o.retention_cohort_30d} (${rate(o.retained_30d, o.retention_cohort_30d)})` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Card className="p-4 hover:translate-y-0">
                <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('staff.outcomes.byReason')}</h3>
                {data.reasons.length === 0 ? <p className="text-xs text-text-secondary">{t('staff.outcomes.none')}</p> : (
                  <ul className="space-y-1 text-xs text-text-secondary">
                    {data.reasons.map((r) => <li key={r.reason}>{t(`staff.reason.${r.reason}`, { defaultValue: r.reason })}: {r.presented} → {r.accepted} ({rate(r.accepted, r.presented)})</li>)}
                  </ul>
                )}
              </Card>
              <Card className="p-4 hover:translate-y-0">
                <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('staff.outcomes.byBand')}</h3>
                {data.bands.length === 0 ? <p className="text-xs text-text-secondary">{t('staff.outcomes.none')}</p> : (
                  <ul className="space-y-1 text-xs text-text-secondary">
                    {data.bands.map((b) => <li key={b.band}>{t(`staff.band.${b.band}`, { defaultValue: b.band })}: {b.presented} → {b.accepted} ({rate(b.accepted, b.presented)})</li>)}
                  </ul>
                )}
              </Card>
            </div>
            <Card className="p-4 hover:translate-y-0">
              <h3 className="mb-2 text-sm font-semibold text-text-primary">{t('staff.outcomes.recent')}</h3>
              {data.recent.length === 0 ? <p className="text-xs text-text-secondary">{t('staff.outcomes.none')}</p> : (
                <ul className="divide-y divide-border text-xs text-text-secondary">
                  {data.recent.map((r) => (
                    <li key={r.id} className="flex flex-wrap justify-between gap-2 py-2">
                      <span className="text-text-primary">{r.account || '—'} · {r.offer_name}</span>
                      <span>{r.status} · {fmt(r.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}

        {tab === 'audit' && (
          <Card className="p-4 hover:translate-y-0" role="tabpanel">
            {data.audit.length === 0 ? <p className="text-xs text-text-secondary">{t('staff.outcomes.none')}</p> : (
              <ul className="divide-y divide-border text-xs text-text-secondary">
                {data.audit.map((a) => (
                  <li key={a.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span className="text-text-primary">{t(`staff.audit.${a.action}`, { defaultValue: a.action })}</span>
                    <span>{a.actor_email ?? '—'} · {fmt(a.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    );
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-bold text-text-primary">{t('staff.title')}</h1>
      <p className="mb-6 mt-1 text-sm text-text-secondary">{t('staff.subtitle')}</p>
      {body}
    </main>
  );
}

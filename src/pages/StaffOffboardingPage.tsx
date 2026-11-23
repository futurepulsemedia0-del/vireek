/** Staff — /staff/offboarding (wrapped in <StaffRoute>): why accounts leave, data-export/deletion funnel, win-back outcomes and settings. */
import { useCallback, useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { useOffboardingT } from '@/i18n/offboardingNamespace';
import {
  fetchOffboardingOverview,
  pct,
  saveOffboardingSettings,
  validateSettings,
  type OffboardingOverview,
  type OffboardingSettings,
} from '@/lib/offboarding';

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; data: OffboardingOverview };

function Stat({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-3">
      <dd className="text-xl font-bold text-text-primary">{value.toLocaleString()}</dd>
      <dt className="mt-0.5 text-xs leading-tight text-text-secondary">{label}</dt>
      {sub && <p className="mt-1 text-[11px] text-text-secondary">{sub}</p>}
    </div>
  );
}

function SettingsForm({ initial, onSaved }: { initial: OffboardingSettings; onSaved: () => void }) {
  const { t } = useOffboardingT();
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(initial.winbackEnabled);
  const [first, setFirst] = useState(String(initial.firstMessageDelayDays));
  const [gap, setGap] = useState(String(initial.secondMessageGapDays));
  const [attr, setAttr] = useState(String(initial.attributionDays));
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);

  const submit = async () => {
    if (busy) return;
    const next: OffboardingSettings = {
      winbackEnabled: enabled,
      firstMessageDelayDays: Number(first),
      secondMessageGapDays: Number(gap),
      attributionDays: Number(attr),
    };
    if (validateSettings(next)) return setInvalid(true);
    setInvalid(false);
    setBusy(true);
    try {
      await saveOffboardingSettings(next);
      toast(t('staff.saved'), 'success');
      onSaved();
    } catch {
      toast(t('staff.saveError'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-5 hover:translate-y-0">
      <h2 className="text-base font-semibold text-text-primary">{t('staff.settings')}</h2>
      <Checkbox label={t('staff.enabled')} helperText={t('staff.enabledHelp')} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Input label={t('staff.firstDelay')} inputMode="numeric" value={first} onChange={(e) => setFirst(e.target.value)} />
        <Input label={t('staff.gap')} inputMode="numeric" value={gap} onChange={(e) => setGap(e.target.value)} />
        <Input label={t('staff.attribution')} inputMode="numeric" value={attr} onChange={(e) => setAttr(e.target.value)} />
      </div>
      {invalid && <p role="alert" className="text-sm text-danger">{t('staff.invalid')}</p>}
      <p className="text-xs text-text-secondary">{t('staff.counsel')}</p>
      <Button type="button" loading={busy} onClick={() => void submit()}>{t('staff.save')}</Button>
    </Card>
  );
}

export function StaffOffboardingPage() {
  const { t } = useOffboardingT();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const refresh = useCallback(async () => {
    try {
      setLoad({ kind: 'ready', data: await fetchOffboardingOverview(90) });
    } catch {
      setLoad({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  let body: React.ReactNode;
  if (load.kind === 'loading') {
    body = <SkeletonCardList count={3} />;
  } else if (load.kind === 'error') {
    body = <EmptyStateError icon={WifiOff} title={t('staff.loadError')} onRetry={() => { setLoad({ kind: 'loading' }); void refresh(); }} />;
  } else {
    const { funnel: f, reasons, settings, days } = load.data;
    body = (
      <div className="space-y-6">
        <section aria-labelledby="ob-funnel">
          <h2 id="ob-funnel" className="mb-2 text-base font-semibold text-text-primary">
            {t('staff.funnel')} <span className="text-xs font-normal text-text-secondary">· {t('staff.range', { days })}</span>
          </h2>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label={t('staff.cases')} value={f.cases} />
            <Stat label={t('staff.ended')} value={f.ended} />
            <Stat label={t('staff.withdrawn')} value={f.withdrawn} sub={`${pct(f.withdrawn, f.cases)}%`} />
            <Stat label={t('staff.exported')} value={f.exported} sub={`${pct(f.exported, f.cases)}%`} />
            <Stat label={t('staff.optedIn')} value={f.optedIn} sub={`${pct(f.optedIn, f.cases)}%`} />
            <Stat label={t('staff.unsubscribed')} value={f.unsubscribed} sub={`${pct(f.unsubscribed, f.optedIn)}%`} />
            <Stat label={t('staff.sent1')} value={f.sent1} />
            <Stat label={t('staff.sent2')} value={f.sent2} />
            <Stat label={t('staff.failed')} value={f.failed} />
            <Stat label={t('staff.reactivated')} value={f.reactivated} sub={`${pct(f.reactivated, f.ended)}%`} />
            <Stat label={t('staff.reactivatedAttributed', { days: settings.attributionDays })} value={f.reactivatedAttributed} />
          </dl>
          <p className="mt-2 text-xs text-text-secondary">{t('staff.attributionNote')}</p>
        </section>

        <section aria-labelledby="ob-reasons">
          <h2 id="ob-reasons" className="mb-2 text-base font-semibold text-text-primary">{t('staff.reasons')}</h2>
          {reasons.length === 0 ? (
            <EmptyState compact title={t('staff.empty')} />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[520px] text-sm">
                <thead className="bg-bg-secondary text-xs text-text-secondary">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-start font-medium">{t('staff.reason')}</th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">{t('staff.cases')}</th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">{t('staff.withdrawn')}</th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">{t('staff.optedIn')}</th>
                    <th scope="col" className="px-3 py-2 text-end font-medium">{t('staff.reactivated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {reasons.map((r) => (
                    <tr key={r.reason} className="border-t border-border">
                      <th scope="row" className="px-3 py-2 text-start font-medium text-text-primary">{t(`reasons.${r.reason}`, { defaultValue: r.reason })}</th>
                      <td className="px-3 py-2 text-end tabular-nums">{r.cases}</td>
                      <td className="px-3 py-2 text-end tabular-nums">{r.withdrawn}</td>
                      <td className="px-3 py-2 text-end tabular-nums">{r.optedIn}</td>
                      <td className="px-3 py-2 text-end tabular-nums">{r.reactivated}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <SettingsForm initial={settings} onSaved={() => void refresh()} />
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

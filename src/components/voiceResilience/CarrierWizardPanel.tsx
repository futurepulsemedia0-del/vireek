import { AlertTriangle, CheckCircle2, Info, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CopyButton } from '@/components/ui/CopyButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { CARRIER_FAMILIES, hasDialCode, wizardView, type CarrierFamily, type CheckKind, type CheckStatus, type ForwardCode, type TFn } from '@/lib/voiceResilience';

export interface CarrierWizardPanelProps {
  t: TFn;
  family: CarrierFamily;
  onFamily: (f: CarrierFamily) => void;
  numbers: string[];
  number: string;
  onNumber: (n: string) => void;
  businessNumber: string;
  onBusinessNumber: (n: string) => void;
  plan: { codes: ForwardCode[]; warning: string } | null;
  planLoading: boolean;
  onLoadPlan: () => void;
  check: { kind: CheckKind; status: CheckStatus | 'starting'; elapsedSeconds: number } | null;
  onStart: (kind: CheckKind) => void;
  errorKey: string | null;
}

const ICON = { ok: CheckCircle2, warn: AlertTriangle, critical: ShieldAlert, info: Info } as const;
const TONE = {
  ok: 'border-success-500/30 bg-success-500/10',
  warn: 'border-warning-500/30 bg-warning-500/10',
  critical: 'border-danger/30 bg-danger/10',
  info: 'border-border bg-bg-secondary',
} as const;

export function CarrierWizardPanel(p: CarrierWizardPanelProps) {
  const { t } = p;
  const running = p.check?.status === 'starting' || p.check?.status === 'pending';
  const view = p.check && p.check.status !== 'starting' ? wizardView(p.check.status, p.check.kind) : null;
  const ResultIcon = view ? ICON[view.tone] : null;

  if (p.numbers.length === 0) {
    return (
      <Card interactive={false} className="!p-6 text-center">
        <h2 className="text-base font-semibold text-text-primary">{t('wizard.noNumbers.title')}</h2>
        <p className="mt-1 text-sm text-text-secondary">{t('wizard.noNumbers.description')}</p>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card interactive={false} className="space-y-4 !p-6">
        <div>
          <h2 className="text-base font-semibold text-text-primary">{t('wizard.title')}</h2>
          <p className="mt-1 text-sm text-text-secondary">{t('wizard.intro')}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select label={t('wizard.familyLabel')} value={p.family} onChange={(e) => p.onFamily(e.target.value as CarrierFamily)}>
            {CARRIER_FAMILIES.map((f) => <option key={f} value={f}>{t(`wizard.family.${f}`)}</option>)}
          </Select>
          <Select label={t('wizard.numberLabel')} value={p.number} onChange={(e) => p.onNumber(e.target.value)} dir="ltr">
            {p.numbers.map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </div>
        <Button variant="secondary" onClick={p.onLoadPlan} loading={p.planLoading} loadingLabel={t('wizard.loadingPlan')}>{t('wizard.loadPlan')}</Button>

        {p.plan && (
          <section aria-labelledby="wizard-plan-title" className="space-y-3">
            <h3 id="wizard-plan-title" className="text-sm font-semibold text-text-primary">{t('wizard.planTitle')}</h3>
            <ul className="space-y-3">
              {p.plan.codes.map((c) => (
                <li key={c.kind} className="rounded-xl border border-border p-3">
                  <p className="text-sm font-medium text-text-primary">{t(`wizard.kind.${c.kind}`)}</p>
                  <p className="text-xs text-text-secondary">{t(`wizard.confidence.${c.confidence}`)}</p>
                  {hasDialCode(c) ? (
                    <dl className="mt-2 space-y-2 text-sm">
                      {([['activate', c.activate], ['cancel', c.cancel], ['status', c.status]] as const).map(([k, v]) => v ? (
                        <div key={k} className="flex flex-wrap items-center justify-between gap-2">
                          <dt className="text-text-secondary">{t(`wizard.code.${k}`)}</dt>
                          <dd className="flex items-center gap-2">
                            <code dir="ltr" className="rounded-lg bg-bg-secondary px-2 py-1 font-mono text-text-primary">{v}</code>
                            <CopyButton text={v} label={t('wizard.copy')} copiedLabel={t('wizard.copied')} />
                          </dd>
                        </div>
                      ) : null)}
                    </dl>
                  ) : (
                    <p className="mt-2 text-sm text-text-primary">{t('wizard.noCode')}</p>
                  )}
                  {c.note && <p className="mt-2 text-xs text-text-secondary">{c.note}</p>}
                </li>
              ))}
            </ul>
            {p.plan.warning && <p className="text-xs text-text-secondary">{p.plan.warning}</p>}
            <p className="text-sm text-text-primary">{t('wizard.tip')}</p>
          </section>
        )}
      </Card>

      <Card interactive={false} className="space-y-4 !p-6">
        <h2 className="text-base font-semibold text-text-primary">{t('wizard.testTitle')}</h2>
        <Input label={t('wizard.businessLabel')} helperText={t('wizard.businessHelp')} type="tel" inputMode="tel" dir="ltr" autoComplete="tel"
          value={p.businessNumber} onChange={(e) => p.onBusinessNumber(e.target.value)} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Button className="w-full" onClick={() => p.onStart('forward_on')} disabled={running || !p.businessNumber.trim()}
              disabledReason={running ? t('wizard.starting') : t('wizard.businessLabel')}>{t('wizard.testOn')}</Button>
            <p className="mt-1 text-xs text-text-secondary">{t('wizard.testOnHelp')}</p>
          </div>
          <div>
            <Button className="w-full" variant="secondary" onClick={() => p.onStart('forward_off')} disabled={running || !p.businessNumber.trim()}
              disabledReason={running ? t('wizard.starting') : t('wizard.businessLabel')}>{t('wizard.testOff')}</Button>
            <p className="mt-1 text-xs text-text-secondary">{t('wizard.testOffHelp')}</p>
          </div>
        </div>

        {/* One live region for the whole test lifecycle: starting → waiting → result. */}
        <div role="status" aria-live="polite" aria-atomic="true" className="min-h-[1.25rem]">
          {p.check?.status === 'starting' && <p className="text-sm text-text-secondary">{t('wizard.starting')}</p>}
          {p.check?.status === 'pending' && (
            <div className={`rounded-xl border p-3 ${TONE.info}`}>
              <p className="text-sm font-semibold text-text-primary">{t(view?.titleKey ?? wizardView('pending', p.check.kind).titleKey)}</p>
              <p className="text-sm text-text-secondary">{t(wizardView('pending', p.check.kind).bodyKey)}</p>
              <p className="mt-1 text-xs text-text-secondary">{t('wizard.watching', { seconds: p.check.elapsedSeconds })}</p>
            </div>
          )}
          {view && view.terminal && ResultIcon && (
            <div className={`rounded-xl border p-3 ${TONE[view.tone]}`}>
              <p className="flex items-center gap-2 text-sm font-semibold text-text-primary"><ResultIcon size={16} aria-hidden="true" />{t(view.titleKey)}</p>
              <p className="mt-1 text-sm text-text-secondary">{t(view.bodyKey)}</p>
              {view.canRetry && p.check && (
                <Button className="mt-3" size="xs" variant="secondary" onClick={() => p.onStart(p.check!.kind)}>{t('wizard.retry')}</Button>
              )}
            </div>
          )}
        </div>
        {p.errorKey && <p role="alert" className="text-sm text-danger">{t(p.errorKey)}</p>}
      </Card>
    </div>
  );
}

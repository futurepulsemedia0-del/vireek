import { useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { useRetentionT } from '@/i18n/retentionNamespace';
import { DRIVER_KEYS, DRIVER_WEIGHTS } from '@/lib/technicianRetention';

/** The "how this score works" disclosure: signals, weights, bands, cost model and the fairness promise. */
export function HowScoreWorks() {
  const { t } = useRetentionT();
  const [open, setOpen] = useState(false);

  return (
    <Card className="!p-5 sm:!p-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="retention-how"
        className="focus-ring flex w-full items-center justify-between gap-3 text-start"
      >
        <span className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><ShieldCheck size={20} /></span>
          <span className="text-base font-semibold text-text-primary">{t('how.title')}</span>
        </span>
        <ChevronDown size={18} className={`shrink-0 text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div id="retention-how" className="mt-5 space-y-5 text-sm leading-relaxed text-text-secondary">
          <p>{t('how.intro')}</p>

          <section>
            <h3 className="mb-2 font-semibold text-text-primary">{t('how.signalsTitle')}</h3>
            <ul className="space-y-2">
              {DRIVER_KEYS.map((k) => (
                <li key={k} className="flex flex-col gap-0.5 rounded-xl border border-border/70 bg-bg-tertiary/40 p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <span>
                    <span className="block font-medium text-text-primary">{t(`drivers.${k}.name`)}</span>
                    <span>{t(`how.signal.${k}`)}</span>
                  </span>
                  <span className="shrink-0 text-xs font-semibold text-accent">{t('how.weight', { n: DRIVER_WEIGHTS[k] })}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-1 font-semibold text-text-primary">{t('how.bandsTitle')}</h3>
            <p>{t('how.bands')}</p>
          </section>

          <section>
            <h3 className="mb-1 font-semibold text-text-primary">{t('how.costTitle')}</h3>
            <p>{t('how.cost')}</p>
          </section>

          <section className="rounded-xl border border-success-500/30 bg-success-500/5 p-4">
            <h3 className="mb-1 font-semibold text-text-primary">{t('how.fairnessTitle')}</h3>
            <p>{t('how.fairness')}</p>
          </section>

          <section>
            <h3 className="mb-1 font-semibold text-text-primary">{t('how.limitsTitle')}</h3>
            <p>{t('how.limits')}</p>
          </section>
        </div>
      )}
    </Card>
  );
}

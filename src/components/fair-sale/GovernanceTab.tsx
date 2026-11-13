import { ShieldCheck } from 'lucide-react';
import { useFairSaleT } from '@/i18n/fairSaleNamespace';

const ITEMS = ['noDemographics', 'codesOnly', 'appendOnly', 'customerFirst', 'noSelfApproval', 'notLegalAdvice'] as const;

export function GovernanceTab() {
  const { t } = useFairSaleT();
  return (
    <section className="mt-4 space-y-3" aria-labelledby="fs-governance-title">
      <h2 id="fs-governance-title" className="text-base font-semibold text-text-primary">{t('governance.title')}</h2>
      <p className="text-sm text-text-secondary">{t('governance.intro')}</p>
      <ul className="space-y-2">
        {ITEMS.map((k) => (
          <li key={k} className="flex gap-3 rounded-2xl border border-border bg-bg-secondary p-4">
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success-500" aria-hidden />
            <p className="text-sm leading-relaxed text-text-primary">{t(`governance.items.${k}`)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { supabase } from '@/lib/supabase';
import { formatMoney, type TermsRow } from '@/lib/resultsPlanApi';

type Mode = 'flat' | 'results';

/** Public terms exist only after staff approve them AND mark them public; otherwise no price is ever shown. */
function usePublicTerms(): TermsRow | null {
  const [terms, setTerms] = useState<TermsRow | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data } = await supabase.from('results_plan_pricing_terms').select('*').eq('status', 'approved').eq('is_public', true).order('approved_at', { ascending: false }).limit(1).maybeSingle();
      if (alive) setTerms((data as TermsRow | null) ?? null);
    })();
    return () => { alive = false; };
  }, []);
  return terms;
}

export function PricingModeSwitch({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>('flat');
  const terms = usePublicTerms();
  const tabs: Array<{ id: Mode; label: string }> = [
    { id: 'flat', label: t('pricing.mode.flat', 'Flat plans') },
    { id: 'results', label: t('pricing.mode.results', 'Pay per result') },
  ];
  return (
    <>
      <div className="px-6 pt-10">
        <div role="tablist" aria-label={t('pricing.mode.label', 'Pricing model')} className="mx-auto flex w-fit rounded-xl border border-border bg-bg-secondary p-1">
          {tabs.map((tab) => (
            <button
              key={tab.id} role="tab" type="button" id={`pricing-tab-${tab.id}`} aria-selected={mode === tab.id} aria-controls={`pricing-panel-${tab.id}`}
              onClick={() => setMode(tab.id)}
              className={`focus-ring rounded-lg px-5 py-2 text-sm font-semibold ${mode === tab.id ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      {mode === 'flat' ? (
        <div role="tabpanel" id="pricing-panel-flat" aria-labelledby="pricing-tab-flat">{children}</div>
      ) : (
        <section role="tabpanel" id="pricing-panel-results" aria-labelledby="pricing-tab-results" className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl space-y-5 rounded-2xl border border-border bg-bg-secondary p-8">
            <h2 className="text-2xl font-bold text-text-primary">{t('pricing.results.title', 'Only pay for jobs Sarah actually booked')}</h2>
            <p className="text-text-secondary">{t('pricing.results.body', 'You are charged for a booked job only after it is verified: Sarah handled the first contact, it is not a duplicate or existing work, and it reaches the stage you choose. Every charge shows its evidence, and you can dispute any job within 14 days.')}</p>
            <p className="text-lg font-semibold text-text-primary">
              {terms
                ? `${formatMoney(terms.per_job_cents, terms.currency)} ${t('pricing.results.perJob', 'per verified job')}${terms.base_fee_cents > 0 ? ` + ${formatMoney(terms.base_fee_cents, terms.currency)} / ${t('pricing.results.month', 'month')}` : ''}`
                : t('pricing.results.tbd', 'Pricing is shared during onboarding.')}
            </p>
            <ul className="list-disc space-y-1 ps-5 text-sm text-text-secondary">
              <li>{t('pricing.results.cap', 'Set a monthly spending limit, with alerts at 50%, 80% and 100%.')}</li>
              <li>{t('pricing.results.flat', 'Optionally never pay more than your flat plan.')}</li>
              <li>{t('pricing.results.opt', 'Opt-in only. Your current plan never changes without your confirmation.')}</li>
            </ul>
            <div className="flex flex-wrap gap-3">
              <Link to="/dashboard/results-plan"><Button>{t('pricing.results.cta', 'See if it fits my business')}</Button></Link>
              <Link to="/how-we-verify"><Button variant="secondary">{t('pricing.results.how', 'How we verify a job')}</Button></Link>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

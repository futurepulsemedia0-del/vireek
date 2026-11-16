import { useEffect } from 'react';
import { Tags } from 'lucide-react';
import { StepShell } from '../StepShell';
import { INDUSTRY_OPTIONS, chipClass, type StepProps } from '../types';
import {
  DEFAULT_HOURS, PRICE_LEVELS, defaultServiceNames, formatSeedPrice, previewSeeds, tradeSlugFor,
} from '@/lib/onboardingTradeDefaults';

/** Trade + services + prices. Prefilled from the trade playbook; installed into the Price Book on launch (adds only what is missing). */
export function ServicesStep({ data, update, onBack, onNext, onSkip, saving }: StepProps) {
  const slug = tradeSlugFor(data.primaryIndustry);
  const seeds = previewSeeds(slug, data.priceLevel);

  // Smart defaults: when the trade is picked, prefill services and weekday hours — but never overwrite what the owner typed.
  useEffect(() => {
    if (!slug) return;
    const patch: Partial<typeof data> = {};
    if (data.services.length === 0) patch.services = defaultServiceNames(slug);
    if (Object.keys(data.hours).length === 0) patch.hours = DEFAULT_HOURS;
    if (Object.keys(patch).length > 0) update(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  return (
    <StepShell
      stepKey="services"
      icon={Tags}
      title="What do you do, and what do you charge?"
      description="Pick your trade and Sarah will already know your services and typical prices. You can change any of it later."
      onBack={onBack}
      onNext={onNext}
      onSkip={onSkip}
      saving={saving}
      nextDisabled={!data.primaryIndustry}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text-primary">Your trade</legend>
        <div className="flex flex-wrap gap-2">
          {INDUSTRY_OPTIONS.map((o) => (
            <button key={o.value} type="button" aria-pressed={data.primaryIndustry === o.value} onClick={() => update({ primaryIndustry: o.value })} className={chipClass(data.primaryIndustry === o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>

      {data.primaryIndustry && !slug && (
        <p className="mt-4 rounded-xl border border-border bg-bg-primary p-3 text-sm text-text-secondary" role="status">
          We don’t have ready-made prices for this trade yet. Continue, and add your services later in Price Book.
        </p>
      )}

      {slug && (
        <>
          <fieldset className="mt-5 space-y-2">
            <legend className="text-sm font-medium text-text-primary">How do your prices compare?</legend>
            <div className="flex flex-wrap gap-2">
              {PRICE_LEVELS.map((p) => (
                <button key={p.value} type="button" aria-pressed={data.priceLevel === p.value} onClick={() => update({ priceLevel: p.value })} className={chipClass(data.priceLevel === p.value)}>
                  {p.label}
                </button>
              ))}
            </div>
          </fieldset>

          <ul className="mt-5 divide-y divide-border rounded-xl border border-border bg-bg-primary" aria-label="Services that will be added to your Price Book">
            {seeds.map((s) => (
              <li key={s.serviceName} className="flex items-start justify-between gap-3 p-3 text-sm">
                <span className="min-w-0 text-text-primary">{s.serviceName}</span>
                <span className="shrink-0 font-medium tabular-nums text-text-primary">{formatSeedPrice(s)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-secondary">Starting points only — review them in Price Book any time. Services you already have are never changed.</p>
        </>
      )}
    </StepShell>
  );
}

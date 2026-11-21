import { Info } from 'lucide-react';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { usePricingDisclosureT } from '@/i18n/pricingDisclosureNamespace';
import { decidePricingNotice, PERSONALIZED_PRICING_FLAG, type PricePathId } from '@/lib/pricingPersonalization';

export interface PersonalizedPricingNoticeProps {
  /** Which price path produced the figure next to this notice. The registry decides if it is personalized. */
  path: PricePathId;
  /**
   * Set false when the personalized element is NOT part of this particular price
   * (e.g. a surge rate is configured but not active right now). Defaults to true.
   */
  applied?: boolean;
  /** Where the business explains how its prices are set. No link is rendered without it. */
  learnMoreHref?: string;
  className?: string;
}

/**
 * "This price depends on information about you" notice.
 *
 * Renders NOTHING unless (1) the `personalized_pricing_notice` flag is on for the account and (2) the price path is
 * classified as personalized in src/lib/pricingPersonalization.ts and (3) the personalized element is actually in
 * the price. The wording is a draft: whether and how it must be shown is [COUNSEL] (docs/compliance/pricing-personalization.md).
 * Layout uses logical properties only, so it mirrors correctly in RTL languages.
 */
export function PersonalizedPricingNotice({ path, applied = true, learnMoreHref, className = '' }: PersonalizedPricingNoticeProps) {
  const flagOn = useFeatureFlag(PERSONALIZED_PRICING_FLAG);
  const { t } = usePricingDisclosureT();
  const decision = decidePricingNotice({ path, flagEnabled: flagOn, applied });
  if (!decision.show || !decision.variant) return null;

  const { variant } = decision;
  return (
    <aside
      role="note"
      aria-label={t('notice.aria')}
      data-testid="personalized-pricing-notice"
      data-variant={variant}
      data-path={path}
      className={`flex items-start gap-2 rounded-xl border border-border bg-bg-primary p-3 text-start text-xs text-text-secondary ${className}`.trim()}
    >
      <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0">
        <p className="font-semibold text-text-primary">{t(`notice.${variant}.title`)}</p>
        <p className="mt-0.5">{t(`notice.${variant}.body`)}</p>
        {learnMoreHref ? (
          <a href={learnMoreHref} className="focus-ring mt-1 inline-block font-medium text-accent underline">
            {t('notice.learnMore')}
          </a>
        ) : null}
      </div>
    </aside>
  );
}

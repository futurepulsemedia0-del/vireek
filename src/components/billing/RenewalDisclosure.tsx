import { Link } from 'react-router-dom';
import { useRenewalDisclosureT } from '@/i18n/renewalDisclosureNamespace';

/**
 * Auto-renewal terms shown next to the buttons that start or change a paid plan.
 * Clear, adjacent to the action, and with a direct path to cancelling.
 * [COUNSEL] approve wording; [VERIFY] it matches how proration is configured in Stripe.
 */
export function RenewalDisclosure({ cancelPath = '/dashboard/billing/cancel', showCancelLink = true }: { cancelPath?: string; showCancelLink?: boolean }) {
  const { t } = useRenewalDisclosureT();
  return (
    <section aria-labelledby="renewal-disclosure-title" className="mt-5 rounded-xl border border-border bg-bg-primary p-4 text-start" data-testid="renewal-disclosure">
      <h3 id="renewal-disclosure-title" className="text-sm font-semibold text-text-primary">
        {t('title')}
      </h3>
      <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-text-secondary">
        <li>{t('renews')}</li>
        <li>{t('switch')}</li>
        <li>{t('cancel')}</li>
        <li>{t('confirmation')}</li>
      </ul>
      {showCancelLink && (
        <Link to={cancelPath} className="focus-ring mt-3 inline-flex min-h-[44px] items-center text-xs font-medium text-text-primary underline underline-offset-4">
          {t('cancelLink')}
        </Link>
      )}
    </section>
  );
}

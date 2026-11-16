import { Link } from 'react-router-dom';
import { asStrings, useHomeT } from '@/i18n/homeNamespace';
import { container, eyebrow, textLink } from './sectionStyles';

/**
 * Brand names are not translated. Each has a backend in this repo:
 * Google Calendar and HubSpot (OAuth functions), QuickBooks (qbo-*), Xero (xero-*), Stripe (stripe-connect-*),
 * ServiceTitan / Jobber / Housecall Pro (price-book import). Text marks only: no third-party logo files.
 */
const INTEGRATIONS = ['Google Calendar', 'QuickBooks', 'Xero', 'Stripe', 'HubSpot', 'ServiceTitan', 'Jobber', 'Housecall Pro'] as const;

const chip = 'rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm font-semibold text-text-primary';

export function TrustBar() {
  const { t } = useHomeT();
  const trades = asStrings(t('trust.trades', { returnObjects: true }));

  return (
    <section aria-labelledby="trust-heading" className="border-y border-border bg-bg-secondary/50 py-10 sm:py-12">
      <div className={`${container} grid gap-8 lg:grid-cols-[1.5fr_1fr] lg:gap-12`}>
        <div>
          <h2 id="trust-heading" className={eyebrow}>{t('trust.heading')}</h2>
          <ul className="mt-5 flex flex-wrap gap-2">
            {INTEGRATIONS.map((name) => (
              <li key={name} className={chip} translate="no">{name}</li>
            ))}
          </ul>
          <p className="mt-4 max-w-xl text-xs leading-relaxed text-text-secondary">{t('trust.note')}</p>
        </div>
        <div>
          <h3 className={eyebrow}>{t('trust.tradesHeading')}</h3>
          <ul className="mt-5 flex flex-wrap gap-2">
            {trades.map((name) => (
              <li key={name} className={chip}>{name}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-x-6">
            <Link to="/integrations" className={textLink}>{t('trust.allIntegrations')}</Link>
            <Link to="/industries" className={textLink}>{t('trust.allIndustries')}</Link>
          </div>
        </div>
      </div>
    </section>
  );
}

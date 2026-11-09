import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { useSEO } from '@/lib/seo';
import { BRAND } from '@/lib/brand/brandConfig';
import { LEGAL_ENTITY } from '@/lib/legalEntity';
import { getEndorsement } from '@/lib/brand/platformEndorsement';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-border py-3 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium text-text-primary">{label}</dt>
      <dd className="mt-1 break-words text-sm text-text-secondary sm:col-span-2 sm:mt-0">{children}</dd>
    </div>
  );
}

/**
 * /legal/company — platform-owned. Gated by the platform flag: when OFF it behaves exactly like an
 * unknown route (NotFoundPage), so flag-off behaviour is unchanged.
 */
export function CompanyPage() {
  const { t } = useTranslation();
  const endorsement = getEndorsement();
  const visible = endorsement.enabled;

  useSEO({
    title: `${t('legal.company.title', 'Company information')} | ${BRAND.name}`,
    description: t('legal.company.description', 'Who operates Vireek: legal entity, product and contact details.'),
    canonical: `${BRAND.siteUrl}/legal/company`,
  });

  if (!visible) return <NotFoundPage />;

  const entityName = [LEGAL_ENTITY.companyName, LEGAL_ENTITY.legalForm].filter(Boolean).join(' ').trim();

  return (
    <>
      <Header />
      <main className="bg-bg-primary pt-24" id="main-content">
        <div className="mx-auto max-w-3xl px-6 pb-16">
          <div className="py-8"><BackButton /></div>
          <h1 className="text-3xl font-semibold text-text-primary">{t('legal.company.title', 'Company information')}</h1>
          <p className="mt-2 text-sm text-text-secondary">
            {t('legal.company.subtitle', 'Who operates the Vireek platform.')}
          </p>
          {!entityName && (
            <div role="status" className="mt-6 rounded-lg border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
              {t('legal.company.incomplete', 'Legal entity details are being finalised. Please contact us by email in the meantime.')}
            </div>
          )}
          <dl className="mt-8">
            {entityName && <Row label={t('legal.company.entity', 'Legal entity')}>{entityName}</Row>}
            <Row label={t('legal.company.product', 'Product')}>{`${BRAND.name} — ${BRAND.descriptor}`}</Row>
            <Row label={t('legal.company.contact', 'Contact')}>
              <a className="text-text-primary underline" href={`mailto:${LEGAL_ENTITY.email}`}>{LEGAL_ENTITY.email}</a>
            </Row>
            {endorsement.line && endorsement.parentName && (
              <Row label={t('legal.company.parent', 'Parent company')}>
                {endorsement.parentUrl ? (
                  <a className="text-text-primary underline" href={endorsement.parentUrl} rel="noopener noreferrer">{endorsement.line}</a>
                ) : endorsement.line}
              </Row>
            )}
          </dl>
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

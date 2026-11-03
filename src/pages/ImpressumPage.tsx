import { useTranslation } from 'react-i18next';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';
import { LEGAL_ENTITY, missingImpressumFields } from '@/lib/legalEntity';

function Row({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null;
  return (
    <div className="border-b border-border py-3 sm:grid sm:grid-cols-3 sm:gap-4">
      <dt className="text-sm font-medium text-text-primary">{label}</dt>
      <dd className="mt-1 text-sm text-text-secondary sm:col-span-2 sm:mt-0">{value}</dd>
    </div>
  );
}

export function ImpressumPage() {
  const { t } = useTranslation();
  const e = LEGAL_ENTITY;
  const incomplete = missingImpressumFields(e).length > 0;

  useSEO({
    title: `${t('legal.impressum.title', 'Impressum')} | Vireek`,
    description: t('legal.impressum.description', 'Legal notice and provider identification for Vireek.'),
    canonical: 'https://vireek.com/impressum',
  });

  const address = [e.street, [e.postalCode, e.city].filter(Boolean).join(' '), e.country].filter(Boolean).join(', ');

  return (
    <>
      <Header />
      <main className="bg-bg-primary pt-24">
        <div className="mx-auto max-w-3xl px-6">
          <div className="py-8"><BackButton /></div>
          <h1 className="text-3xl font-semibold text-text-primary">{t('legal.impressum.title', 'Impressum')}</h1>
          <p className="mt-2 text-sm text-text-secondary">{t('legal.impressum.subtitle', 'Legal notice (§ 5 DDG)')}</p>

          {incomplete ? (
            <div role="status" className="mt-8 rounded-lg border border-border bg-bg-secondary p-4 text-sm text-text-secondary">
              {t('legal.impressum.incomplete', 'This legal notice is being finalised. Please contact us by email in the meantime.')}{' '}
              <a className="text-text-primary underline" href={`mailto:${e.email}`}>{e.email}</a>
            </div>
          ) : (
            <dl className="mt-8">
              <Row label={t('legal.impressum.provider', 'Provider')} value={[e.companyName, e.legalForm].filter(Boolean).join(' ')} />
              <Row label={t('legal.impressum.address', 'Address')} value={address} />
              <Row label={t('legal.impressum.representative', 'Represented by')} value={e.representative} />
              <Row label={t('legal.impressum.email', 'Email')} value={e.email} />
              <Row label={t('legal.impressum.phone', 'Phone')} value={e.phone} />
              <Row label={t('legal.impressum.register', 'Commercial register')} value={[e.registerCourt, e.registerNumber].filter(Boolean).join(', ')} />
              <Row label={t('legal.impressum.vat', 'VAT ID')} value={e.vatId} />
              <Row label={t('legal.impressum.content', 'Responsible for content')} value={e.contentResponsible} />
            </dl>
          )}
        </div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

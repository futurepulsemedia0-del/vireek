import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { DataRequestContent } from '@/components/sections/DataRequestContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function DataRequestPage() {
  useSEO({
    title: 'Data Request: Access, Delete or Correct Your Data | Vireek',
    description:
      'Submit a data subject request to Vireek: access, delete or correct your personal data under GDPR, UK GDPR and CCPA/CPRA. No account required.',
    canonical: 'https://vireek.com/data-request',
  });

  return (
    <>
      <Header />
      <main className="bg-bg-primary pt-24">
        <div className="mx-auto max-w-7xl px-6">
          <div className="py-8">
            <BackButton />
          </div>
        </div>
        <DataRequestContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { MsaContent } from '@/components/sections/MsaContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function MsaPage() {
  useSEO({
    title: 'Master Services Agreement | Vireek',
    description:
      "Vireek's Master Services Agreement for business and enterprise customers: order forms, fees, term, data protection, service levels, confidentiality, and liability.",
    canonical: 'https://vireek.com/msa',
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
        <MsaContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

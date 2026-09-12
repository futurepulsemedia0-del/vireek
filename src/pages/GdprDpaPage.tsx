import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { GdprDpaContent } from '@/components/sections/GdprDpaContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function GdprDpaPage() {
  useSEO({
    title: 'EU/UK GDPR Data Processing Addendum | Vireek',
    description:
      "Vireek's GDPR-specific Data Processing Addendum for EU, UK, and Swiss personal data: transfer mechanisms, sub-processors, and data subject rights.",
    canonical: 'https://vireek.com/gdpr-dpa',
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
        <GdprDpaContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

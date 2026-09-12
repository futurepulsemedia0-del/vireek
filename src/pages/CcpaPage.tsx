import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CcpaContent } from '@/components/sections/CcpaContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function CcpaPage() {
  useSEO({
    title: 'California Privacy Rights (CCPA/CPRA) | Vireek',
    description:
      "Vireek's California Consumer Privacy Act (CCPA/CPRA) disclosures: what we collect, your rights as a California resident, and how to exercise them.",
    canonical: 'https://vireek.com/ccpa',
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
        <CcpaContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

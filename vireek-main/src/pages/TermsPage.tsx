import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { TermsContent } from '@/components/sections/TermsContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function TermsPage() {
  useSEO({
    title: 'Terms of Service | Vireek',
    description: 'The terms governing use of Vireek\u2019s AI voice receptionist platform, including subscription billing, trial terms, customer responsibilities, and service limitations.',
    canonical: 'https://vireek.com/terms',
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
        <TermsContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

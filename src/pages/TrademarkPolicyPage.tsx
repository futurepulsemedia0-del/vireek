import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { TrademarkPolicyContent } from '@/components/sections/TrademarkPolicyContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function TrademarkPolicyPage() {
  useSEO({
    title: 'Trademark Usage Policy | Vireek',
    description:
      "Vireek's Trademark Usage Policy: how the Vireek name, logo, and brand marks may and may not be used by partners, media, and the public.",
    canonical: 'https://vireek.com/trademark-policy',
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
        <TrademarkPolicyContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

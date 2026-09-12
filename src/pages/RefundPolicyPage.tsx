import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { RefundPolicyContent } from '@/components/sections/RefundPolicyContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function RefundPolicyPage() {
  useSEO({
    title: 'Refund & Cancellation Policy | Vireek',
    description:
      "Vireek's Refund and Cancellation Policy: how billing cycles work, how to cancel, when refunds are issued, and how to request one.",
    canonical: 'https://vireek.com/refund-policy',
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
        <RefundPolicyContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

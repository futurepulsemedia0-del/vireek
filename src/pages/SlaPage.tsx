import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { SlaContent } from '@/components/sections/SlaContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function SlaPage() {
  useSEO({
    title: 'Service Level Agreement (SLA) | Vireek',
    description:
      "Vireek's Service Level Agreement: our uptime commitment, service credits, exclusions, and how uptime is measured and reported.",
    canonical: 'https://vireek.com/sla',
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
        <SlaContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

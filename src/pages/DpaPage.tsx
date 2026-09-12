import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { DpaContent } from '@/components/sections/DpaContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function DpaPage() {
  useSEO({
    title: 'Data Processing Agreement | Vireek',
    description:
      "Vireek's Data Processing Agreement (DPA): roles, sub-processors, security measures, international transfers, and how to request a countersigned copy for enterprise procurement.",
    canonical: 'https://vireek.com/dpa',
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
        <DpaContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

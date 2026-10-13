import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { DmcaContent } from '@/components/sections/DmcaContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function DmcaPage() {
  useSEO({
    title: 'DMCA & Copyright Complaints | Vireek',
    description:
      "How to report copyright infringement on Vireek or respond to a takedown. Submit a DMCA notice or counter-notification and reach our designated copyright agent.",
    canonical: 'https://vireek.com/dmca',
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
        <DmcaContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

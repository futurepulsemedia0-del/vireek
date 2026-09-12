import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { AcceptableUseContent } from '@/components/sections/AcceptableUseContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function AcceptableUsePage() {
  useSEO({
    title: 'Acceptable Use Policy | Vireek',
    description:
      "Vireek's Acceptable Use Policy: rules for lawful, respectful use of the platform, including calling and messaging compliance requirements.",
    canonical: 'https://vireek.com/acceptable-use-policy',
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
        <AcceptableUseContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

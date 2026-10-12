import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { SmsTermsContent } from '@/components/sections/SmsTermsContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function SmsTermsPage() {
  useSEO({
    title: 'SMS Terms & Conditions | Vireek',
    description:
      "Vireek's text messaging program terms: how you opt in, message types and frequency, message and data rates, and how to opt out with STOP or get help with HELP.",
    canonical: 'https://vireek.com/sms-terms',
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
        <SmsTermsContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

import { useEffect } from 'react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { TermsContent } from '@/components/sections/TermsContent';
import { CookieConsent } from '@/components/CookieConsent';

export function TermsPage() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <>
      <Header />
      <main>
        <TermsContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

import { useEffect } from 'react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { PrivacyContent } from '@/components/sections/PrivacyContent';
import { CookieConsent } from '@/components/CookieConsent';

export function PrivacyPage() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <>
      <Header />
      <main>
        <PrivacyContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

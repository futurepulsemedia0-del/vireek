import { useEffect } from 'react';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { PrivacyContent } from '@/components/sections/PrivacyContent';
import { CookieConsent } from '@/components/CookieConsent';
import { BackButton } from '@/components/BackButton';

export function PrivacyPage() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <ThemeProvider>
      <Header />
      <main>
        <div className="mx-auto max-w-4xl px-6 pt-8">
          <BackButton fallback="/" />
        </div>
        <PrivacyContent />
      </main>
      <Footer />
      <CookieConsent />
    </ThemeProvider>
  );
}

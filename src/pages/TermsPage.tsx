import { useEffect } from 'react';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { TermsContent } from '@/components/sections/TermsContent';

export function TermsPage() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <ThemeProvider>
      <Header />
      <main>
        <TermsContent />
      </main>
      <Footer />
    </ThemeProvider>
  );
}

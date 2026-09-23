import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { AccessibilityStatementContent } from '@/components/sections/AccessibilityStatementContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function AccessibilityStatementPage() {
  useSEO({
    title: 'Accessibility Statement | Vireek',
    description:
      "Vireek's commitment to WCAG 2.2 AA accessibility: what we've built, what's ongoing, and how to report a barrier.",
    canonical: 'https://vireek.com/accessibility-statement',
  });

  return (
    <>
      <Header />
      <main id="main-content" className="bg-bg-primary pt-24">
        <div className="mx-auto max-w-7xl px-6">
          <div className="py-8">
            <BackButton />
          </div>
        </div>
        <AccessibilityStatementContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

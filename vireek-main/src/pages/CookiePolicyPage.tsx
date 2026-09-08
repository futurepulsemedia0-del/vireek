import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookiePolicyContent } from '@/components/sections/CookiePolicyContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function CookiePolicyPage() {
  useSEO({
    title: 'Cookie Policy | Vireek',
    description: 'How Vireek uses cookies and similar technologies, what each category does, and how to manage your cookie preferences at any time.',
    canonical: 'https://vireek.com/cookies',
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
        <CookiePolicyContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { PrivacyContent } from '@/components/sections/PrivacyContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function PrivacyPage() {
  useSEO({
    title: 'Privacy Policy | Vireek',
    description: 'How Vireek collects, uses, and protects customer and caller data, including data retention, security practices, and your privacy choices.',
    canonical: 'https://vireek.com/privacy',
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
        <PrivacyContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

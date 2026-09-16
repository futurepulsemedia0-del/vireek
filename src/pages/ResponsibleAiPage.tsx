import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { ResponsibleAiContent } from '@/components/sections/ResponsibleAiContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function ResponsibleAiPage() {
  useSEO({
    title: 'Responsible AI Policy | Vireek',
    description:
      "How Vireek's AI voice receptionist discloses itself to callers, where human oversight applies, and the principles behind our responsible use of AI.",
    canonical: 'https://vireek.com/responsible-ai',
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
        <ResponsibleAiContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

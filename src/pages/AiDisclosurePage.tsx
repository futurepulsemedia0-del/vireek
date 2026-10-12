import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { AiDisclosureContent } from '@/components/sections/AiDisclosureContent';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';

export function AiDisclosurePage() {
  useSEO({
    title: 'AI Call Disclosure & Recording Policy | Vireek',
    description:
      'How Vireek tells callers they are speaking with an AI, what we record and transcribe, how long recordings are kept, and the choices callers and businesses have.',
    canonical: 'https://vireek.com/ai-disclosure',
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
        <AiDisclosureContent />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

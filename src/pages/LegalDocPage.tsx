import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { LegalDocument } from '@/components/legal/LegalDocument';
import { useSEO } from '@/lib/seo';
import { getLegalDoc } from '@/lib/legalDocs';
import { NotFoundPage } from '@/pages/NotFoundPage';

/** Renders one standalone legal document from src/lib/legalDocs by slug. */
export function LegalDocPage({ slug }: { slug: string }) {
  const doc = getLegalDoc(slug);
  useSEO({
    title: doc?.metaTitle ?? 'Legal | Vireek',
    description: doc?.description ?? 'Vireek legal documents.',
    canonical: `https://vireek.com${doc?.path ?? '/'}`,
  });
  if (!doc) return <NotFoundPage />;
  return (
    <>
      <Header />
      <main className="bg-bg-primary pt-24">
        <div className="mx-auto max-w-7xl px-6">
          <div className="py-8"><BackButton /></div>
        </div>
        <LegalDocument doc={doc} />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { ThankYouContent } from '@/components/thank-you/ThankYouContent';
import { parseThankYouParams } from '@/lib/thankYou';

function SEO() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Thank You | Vireek';

    // A confirmation page must never be indexed: it would pollute search results and could be
    // reached directly to inflate conversion counts.
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousRobots = robots?.getAttribute('content') ?? null;
    if (!robots) {
      robots = document.createElement('meta');
      robots.setAttribute('name', 'robots');
      document.head.appendChild(robots);
    }
    robots.setAttribute('content', 'noindex, nofollow');

    return () => {
      document.title = previousTitle;
      if (previousRobots === null) robots?.remove();
      else robots?.setAttribute('content', previousRobots);
    };
  }, []);
  return null;
}

export function ThankYouPage() {
  const { search } = useLocation();
  const { source, demoStart } = useMemo(() => parseThankYouParams(search), [search]);

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <ThankYouContent source={source} demoStart={demoStart} />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

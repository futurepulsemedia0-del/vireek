import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { ServerErrorView } from '@/components/system/ServerErrorView';
import { generateIncidentId, readIncidentFromSearch } from '@/lib/incident';

function SEO() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Something went wrong | Vireek';

    // An error page must never be indexed.
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

/**
 * /error — the standalone 500 page. Link or redirect here as `/error?incident=INC-XXXX-XXXX`
 * to show a specific incident; without a valid ID one is generated and written
 * into the URL, so a refresh or a shared link keeps the same ID.
 */
export function ServerErrorPage() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const [incidentId] = useState(() => readIncidentFromSearch(search) ?? generateIncidentId());

  useEffect(() => {
    if (readIncidentFromSearch(search) !== incidentId) navigate({ search: `?incident=${incidentId}` }, { replace: true });
  }, [incidentId, navigate, search]);

  return (
    <>
      <SEO />
      <Header />
      <main className="flex min-h-[100dvh] flex-col items-center justify-center bg-bg-primary px-6 pb-[max(3rem,env(safe-area-inset-bottom))] pt-28">
        <ServerErrorView incidentId={incidentId} />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

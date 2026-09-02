import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { PhoneOff, ArrowRight, Home } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { EASE } from '@/lib/motion';

function SEO() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Page Not Found | Vireek';

    // Tell search engines this URL isn't a real page, so it never gets
    // indexed as duplicate/soft-404 content.
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousRobots = robots?.getAttribute('content') ?? null;
    if (!robots) {
      robots = document.createElement('meta');
      robots.setAttribute('name', 'robots');
      document.head.appendChild(robots);
    }
    robots.setAttribute('content', 'noindex, follow');

    return () => {
      document.title = previousTitle;
      if (previousRobots === null) robots?.remove();
      else robots?.setAttribute('content', previousRobots);
    };
  }, []);
  return null;
}

export function NotFoundPage() {
  return (
    <>
      <SEO />
      <Header />
      <main className="flex min-h-screen flex-col items-center justify-center overflow-hidden bg-bg-primary px-6 pt-24">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="flex max-w-lg flex-col items-center text-center"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <PhoneOff size={28} />
          </span>
          <p className="mt-6 text-sm font-semibold uppercase tracking-[0.2em] text-accent">404</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl">
            This call didn&apos;t go through.
          </h1>
          <p className="mt-4 text-base leading-7 text-text-secondary">
            The page you&apos;re looking for doesn&apos;t exist or may have moved. Let&apos;s get
            you back on the line.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
            <Link to="/">
              <Button variant="primary" size="lg">
                <Home className="h-4 w-4" />
                Back to Home
              </Button>
            </Link>
            <Link
              to="/faq"
              className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
            >
              Visit our FAQ <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </motion.div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { CheckCircle2, Users } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { EnterpriseDemoBookingCalendar } from '@/components/EnterpriseDemoBookingCalendar';
import { EASE } from '@/lib/motion';

function SEO() {
  useEffect(() => {
    const title = 'Book a Demo | Vireek AI Voice Receptionist';
    const description =
      'Pick a time on our live calendar and see Vireek answer calls, book jobs, and capture leads for your home service business.';
    const previousTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', description);
    document.title = title;
    return () => {
      document.title = previousTitle;
      if (previousContent === null) meta?.remove();
      else meta?.setAttribute('content', previousContent);
    };
  }, []);
  return null;
}

export function DemoPage() {
  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-start">
            {/* Left: pitch */}
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
            >
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-2 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <Users className="h-4 w-4 text-accent" />
                For teams & multi-location businesses
              </div>
              <h1 className="mt-6 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
                See Vireek answer real calls, live.
              </h1>
              <p className="mt-6 max-w-lg text-lg leading-8 text-text-secondary">
                If you run a larger team or want to see exactly how Vireek would handle your
                calls before signing up, book a walkthrough with us — pick a time below and
                it's confirmed instantly, no back-and-forth required.
              </p>
              <ul className="mt-8 space-y-4">
                {[
                  'A live demo tailored to your trade and call volume',
                  'Pick a time instantly on our real calendar — no waiting on email',
                  'No pressure — you can still self-serve sign up anytime',
                ].map((item) => (
                  <li key={item} className="flex gap-3 text-sm text-text-secondary">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-8 text-sm text-text-secondary">
                In a hurry?{' '}
                <Link to="/signup" className="focus-ring font-semibold text-accent hover:text-cta">
                  Start your free trial instead
                </Link>
              </p>
            </motion.div>

            {/* Right: real-calendar booking */}
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE, delay: 0.1 }}
            >
              <EnterpriseDemoBookingCalendar />
            </motion.div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

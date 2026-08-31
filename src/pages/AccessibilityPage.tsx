import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Accessibility, Mail } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE } from '@/lib/motion';

const EMAIL = 'ali@vireek.com';

function SEO() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Accessibility Statement | Vireek';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', "Vireek's ongoing commitment to digital accessibility and how to report an accessibility issue.");
    return () => {
      document.title = previousTitle;
      if (previousContent === null) meta?.remove();
      else meta?.setAttribute('content', previousContent);
    };
  }, []);
  return null;
}

export function AccessibilityPage() {
  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary px-6 pb-24 pt-32">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Accessibility size={26} />
          </span>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
            Accessibility Statement
          </h1>
          <p className="mt-4 text-sm text-text-secondary">Last updated: August 2026</p>

          <div className="mt-10 space-y-8 text-base leading-relaxed text-text-secondary">
            <div>
              <h2 className="text-xl font-bold text-text-primary">Our commitment</h2>
              <p className="mt-3">
                Vireek is committed to making our website and dashboard usable by as many people
                as possible, including people with disabilities. We are actively working to
                align our site with the{' '}
                <a
                  href="https://www.w3.org/WAI/standards-guidelines/wcag/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-accent hover:underline"
                >
                  Web Content Accessibility Guidelines (WCAG) 2.1
                </a>{' '}
                at Level AA, and we treat this as an ongoing process rather than a one-time
                project.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-bold text-text-primary">What we&apos;ve done so far</h2>
              <ul className="mt-3 list-disc space-y-2 pl-5">
                <li>Semantic HTML and ARIA labelling on interactive elements like navigation, forms, and dialogs.</li>
                <li>Visible keyboard focus states across buttons, links, and form fields.</li>
                <li>Color combinations chosen with contrast in mind across both light and dark themes.</li>
                <li>Descriptive alt text and labels on icons and images that convey meaning.</li>
              </ul>
            </div>

            <div>
              <h2 className="text-xl font-bold text-text-primary">Known limitations</h2>
              <p className="mt-3">
                No website is perfectly accessible, and ours is no exception. Some third-party
                embedded components (such as payment or scheduling widgets) are outside our
                direct control. We prioritize fixes as they&apos;re identified.
              </p>
            </div>

            <div>
              <h2 className="text-xl font-bold text-text-primary">Reporting an issue</h2>
              <p className="mt-3">
                If you encounter a barrier while using Vireek, please tell us. Include the page
                URL and a brief description of the issue, and we&apos;ll work to address it.
              </p>
              <a
                href={`mailto:${EMAIL}?subject=Accessibility%20issue`}
                className="mt-4 inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
              >
                <Mail size={16} />
                {EMAIL}
              </a>
            </div>

            <p className="text-sm text-text-secondary/70">
              See also our{' '}
              <Link to="/privacy" className="font-semibold text-accent hover:underline">
                Privacy Policy
              </Link>{' '}
              and{' '}
              <Link to="/terms" className="font-semibold text-accent hover:underline">
                Terms of Service
              </Link>
              .
            </p>
          </div>
        </motion.div>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

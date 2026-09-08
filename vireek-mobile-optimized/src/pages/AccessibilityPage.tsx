import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Accessibility, Mail, Sparkles, Eye, Brain, Book, Shield, Keyboard, Volume2, User, ArrowRight } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { BackButton } from '@/components/ui/BackButton';
import { useAccessibility, PROFILES } from '@/contexts/AccessibilityContext';
import { EASE } from '@/lib/motion';

const EMAIL = 'ali@vireek.com';

const ICON_MAP: Record<string, typeof Eye> = {
  universal: Accessibility,
  eye: Eye,
  brain: Brain,
  book: Book,
  shield: Shield,
  keyboard: Keyboard,
  volume: Volume2,
  user: User,
};

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
  const { score, activeProfile } = useAccessibility();

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
          <div className="mb-6">
            <BackButton />
          </div>
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
            <Accessibility size={26} />
          </span>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
            Accessibility Statement
          </h1>
          <p className="mt-4 text-sm text-text-secondary">Last updated: August 2026</p>

          {/* Live accessibility status card */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
            className="mt-8 overflow-hidden rounded-2xl border border-accent/20 bg-bg-secondary shadow-card"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-50"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 20% 0%, rgb(var(--accent-primary) / 0.10), transparent 55%)',
              }}
            />
            <div className="relative flex items-center gap-4 p-5">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/20">
                <Sparkles size={22} />
              </span>
              <div className="flex-1">
                <h2 className="text-base font-bold text-text-primary">Your Accessibility Experience</h2>
                <p className="mt-0.5 text-sm text-text-secondary">
                  {score === 100
                    ? 'Your accessibility experience: 100% optimized'
                    : `Your accessibility experience: ${score}% optimized`}
                  {activeProfile && ` · ${PROFILES.find((p) => p.id === activeProfile)?.name ?? ''}`}
                </p>
              </div>
              <div className="text-right">
                <span className="text-2xl font-bold tabular-nums text-accent">{score}%</span>
              </div>
            </div>
            <div className="relative border-t border-border px-5 py-3">
              <p className="text-xs text-text-secondary/70">
                Use the floating accessibility button in the bottom-right corner to customize your experience with profiles, vision controls, contrast settings, and more.
              </p>
            </div>
          </motion.div>

          {/* Available profiles preview */}
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {PROFILES.slice(0, 8).map((profile, i) => {
              const Icon = ICON_MAP[profile.icon] ?? Accessibility;
              return (
                <motion.div
                  key={profile.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: EASE, delay: 0.15 + i * 0.04 }}
                  className={`rounded-xl border p-3 transition-colors ${
                    activeProfile === profile.id
                      ? 'border-accent/40 bg-accent/5'
                      : 'border-border bg-bg-secondary'
                  }`}
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Icon size={15} />
                  </span>
                  <h3 className="mt-2 text-xs font-semibold text-text-primary leading-tight">{profile.name}</h3>
                </motion.div>
              );
            })}
          </div>

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
                <li>A full accessibility center with profiles, vision controls, contrast adjustments, reading tools, and motion settings.</li>
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
                <ArrowRight size={14} className="ml-1" />
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

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FileCheck2, Mail, ArrowRight } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE } from '@/lib/motion';

const EMAIL = 'ali@vireek.com';
const STATEMENT_DATE = 'September 2026';
const NEXT_REVIEW = 'March 2027';

// ============================================================
// CONTENT — edit these arrays directly to update the statement.
// Structure follows the standard W3C accessibility-statement model
// (conformance status / evaluation method / compatibility / known
// issues per success criterion), written for Vireek specifically.
// ============================================================

interface KnownIssue {
  criterion: string; // e.g. "1.1.1 Non-text Content (Level A)"
  description: string;
  status: 'open' | 'in-progress';
}

const KNOWN_ISSUES: KnownIssue[] = [
  {
    criterion: '1.4.13 Content on Hover or Focus (Level AA)',
    description:
      'Some tooltip content triggered on hover does not yet remain visible when the pointer moves onto the tooltip itself.',
    status: 'in-progress',
  },
  {
    criterion: '2.4.7 Focus Visible (Level AA)',
    description:
      'A small number of custom-styled interactive elements in third-party embedded widgets (e.g. payment or scheduling embeds) may not show a Vireek-styled focus outline, as they render inside an iframe we do not control.',
    status: 'open',
  },
];

const AT_COMBINATIONS = [
  'NVDA + Google Chrome (Windows)',
  'VoiceOver + Safari (macOS)',
  'VoiceOver + Safari (iOS)',
  'TalkBack + Chrome (Android)',
];

function SEO() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'WCAG Conformance Statement | Vireek';
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previousContent = meta?.getAttribute('content') ?? null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute(
      'content',
      'Formal WCAG 2.1 Level AA conformance statement for Vireek: conformance status, evaluation methods, assistive technology compatibility, and known issues.'
    );
    return () => {
      document.title = previousTitle;
      if (previousContent === null) meta?.remove();
      else meta?.setAttribute('content', previousContent);
    };
  }, []);
  return null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-xl font-bold text-text-primary">{title}</h2>
      <div className="mt-3 space-y-3 text-base leading-relaxed text-text-secondary">{children}</div>
    </div>
  );
}

export function AccessibilityConformancePage() {
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
            <FileCheck2 size={26} />
          </span>
          <h1 className="mt-6 text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl">
            WCAG Conformance Statement
          </h1>
          <p className="mt-4 text-sm text-text-secondary">
            Statement date: {STATEMENT_DATE} · Next scheduled review: {NEXT_REVIEW}
          </p>
          <p className="mt-2 text-sm text-text-secondary">
            This is a formal conformance statement covering the public Vireek marketing site and
            the Vireek dashboard. For a plain-language overview of the accessibility tools built
            into the product, see our{' '}
            <Link to="/accessibility" className="font-semibold text-accent hover:underline">
              Accessibility Statement
            </Link>
            .
          </p>

          <div className="mt-10 space-y-8">
            <Section title="Conformance status">
              <p>
                The{' '}
                <a
                  href="https://www.w3.org/WAI/standards-guidelines/wcag/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-accent hover:underline"
                >
                  Web Content Accessibility Guidelines (WCAG) 2.1
                </a>{' '}
                defines requirements for designers and developers to improve accessibility for
                people with disabilities, at three levels: A, AA, and AAA.
              </p>
              <p>
                Vireek is <strong className="text-text-primary">partially conformant</strong> with
                WCAG 2.1 Level AA. Partially conformant means that some parts of the content do
                not fully conform to the accessibility standard — the specific gaps we are aware
                of are listed under "Known issues" below, and we do not consider this statement
                complete until that list is empty.
              </p>
            </Section>

            <Section title="Scope of this statement">
              <p>
                This statement applies to the Vireek marketing website (vireek.com) and the
                Vireek customer dashboard, accessed by authenticated account holders. It does not
                cover content hosted by third parties and merely linked to or embedded from
                Vireek pages (for example, an embedded payment or e-signature widget), where
                conformance depends on that third party.
              </p>
            </Section>

            <Section title="Technical specifications relied upon">
              <p>
                Accessibility of Vireek relies on the following technologies working together in
                the visitor's browser and any assistive technology used:
              </p>
              <ul className="list-disc space-y-1.5 pl-5">
                <li>HTML5</li>
                <li>WAI-ARIA</li>
                <li>CSS</li>
                <li>JavaScript</li>
              </ul>
              <p>
                These technologies are relied upon for conformance with the accessibility
                standards used.
              </p>
            </Section>

            <Section title="Evaluation methods">
              <p>Conformance was assessed using a combination of:</p>
              <ul className="list-disc space-y-1.5 pl-5">
                <li>
                  Automated scanning of key pages and dashboard flows against WCAG 2.1 success
                  criteria.
                </li>
                <li>
                  Manual keyboard-only navigation testing across primary user flows (sign-up,
                  login, dashboard navigation, call review, settings).
                </li>
                <li>
                  Manual screen-reader testing using the assistive technology and browser
                  combinations listed below.
                </li>
                <li>Color contrast verification across both light and dark themes.</li>
              </ul>
            </Section>

            <Section title="Compatibility with browsers and assistive technology">
              <p>
                Vireek is designed to be compatible with the following assistive technology and
                browser combinations:
              </p>
              <ul className="list-disc space-y-1.5 pl-5">
                {AT_COMBINATIONS.map((combo) => (
                  <li key={combo}>{combo}</li>
                ))}
              </ul>
              <p>
                Vireek is not designed to be compatible with browser versions older than the last
                two major releases, or with assistive technology combinations not listed above.
              </p>
            </Section>

            <Section title="Known issues">
              {KNOWN_ISSUES.length === 0 ? (
                <p>No known conformance issues at this time.</p>
              ) : (
                <div className="space-y-4">
                  {KNOWN_ISSUES.map((issue) => (
                    <div
                      key={issue.criterion}
                      className="rounded-xl border border-border bg-bg-secondary p-4"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-text-primary">
                          {issue.criterion}
                        </p>
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            issue.status === 'in-progress'
                              ? 'bg-warning-500/10 text-warning-500'
                              : 'bg-bg-tertiary text-text-secondary'
                          }`}
                        >
                          {issue.status === 'in-progress' ? 'In progress' : 'Open'}
                        </span>
                      </div>
                      <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                        {issue.description}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Feedback and formal complaints">
              <p>
                We aim to respond to accessibility feedback within 5 business days, and to
                propose a resolution timeline within 10 business days for any confirmed
                conformance gap. Please include the page URL, a description of the barrier, and
                the assistive technology and browser you were using, if applicable.
              </p>
              <a
                href={`mailto:${EMAIL}?subject=WCAG%20Conformance%20Feedback`}
                className="mt-2 inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
              >
                <Mail size={16} />
                {EMAIL}
                <ArrowRight size={14} className="ml-1" />
              </a>
            </Section>

            <p className="text-sm text-text-secondary/70">
              See also our{' '}
              <Link to="/accessibility" className="font-semibold text-accent hover:underline">
                Accessibility Statement
              </Link>
              ,{' '}
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

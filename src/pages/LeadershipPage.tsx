import { motion } from 'framer-motion';
import { ArrowRight, Linkedin, Mail, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { FOUNDER_NAME, FOUNDER_TITLE, FOUNDER_PHOTO_URL, FOUNDER_LINKEDIN_URL, FOUNDER_EMAIL, FOUNDER_BIO } from '@/lib/founder';

// ============================================================
// REPLACE THESE WITH REAL INFORMATION BEFORE PUBLISHING
// ============================================================
// Nothing here is invented. Fill in the founder's real name, a real
// photo, and a real LinkedIn URL. If you leave FOUNDER_LINKEDIN_URL
// empty, the LinkedIn button is hidden automatically rather than
// linking nowhere. If you leave FOUNDER_PHOTO_URL empty, a monogram
// avatar is shown instead of a broken image.

// Real advisors only. Leave this array empty until you actually have
// one — the section below renders an honest "not yet" state instead of
// a placeholder grid when it's empty, so the page never implies advisors
// exist that don't.
interface Advisor {
  name: string;
  title: string;
  photoUrl?: string;
  linkedinUrl?: string;
}
const ADVISORS: Advisor[] = [];

function Initials({ name }: { name: string }) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-accent to-cta text-2xl font-bold text-white">
      {initials || '?'}
    </div>
  );
}

function PersonCard({ person, size = 'lg' }: { person: Advisor; size?: 'lg' | 'md' }) {
  const dim = size === 'lg' ? 'h-28 w-28' : 'h-20 w-20';
  return (
    <div className="flex flex-col items-center rounded-2xl border border-border bg-bg-secondary p-6 text-center shadow-card dark:shadow-card-dark">
      <div className={`${dim} overflow-hidden rounded-full ring-4 ring-accent/10`}>
        {person.photoUrl ? (
          <img src={person.photoUrl} alt={person.name} className="h-full w-full object-cover" />
        ) : (
          <Initials name={person.name} />
        )}
      </div>
      <h3 className="mt-4 text-base font-bold text-text-primary">{person.name}</h3>
      <p className="text-sm text-text-secondary">{person.title}</p>
      {person.linkedinUrl && (
        <a
          href={person.linkedinUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-ring mt-3 flex items-center gap-1.5 text-xs font-semibold text-accent hover:underline"
        >
          <Linkedin size={13} />
          LinkedIn
        </a>
      )}
    </div>
  );
}

function NotYetPanel({
  icon: Icon,
  title,
  body,
  ctaLabel,
  ctaHref,
}: {
  icon: typeof Users;
  title: string;
  body: string;
  ctaLabel: string;
  ctaHref: string;
}) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
        <Icon size={22} />
      </span>
      <h3 className="mt-4 text-base font-semibold text-text-primary">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-text-secondary">{body}</p>
      <a href={ctaHref} className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
        {ctaLabel}
        <ArrowRight size={14} />
      </a>
    </div>
  );
}

export function LeadershipPage() {
  useSEO({
    title: 'Leadership & Advisors | Vireek',
    description: 'The people behind Vireek — founder, advisors, and the customers helping shape the roadmap.',
    canonical: 'https://vireek.com/leadership',
  });

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton fallback="/about" />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Who's Behind This</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Leadership &amp; Advisors
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                A real name and face behind the product, not a logo. Here's who's building
                Vireek and who's helping shape where it goes.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Founder */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="flex flex-col items-center gap-6 rounded-2xl border border-border bg-bg-secondary p-8 text-center shadow-card dark:shadow-card-dark sm:flex-row sm:text-left"
            >
              <div className="h-28 w-28 shrink-0 overflow-hidden rounded-full ring-4 ring-accent/10">
                {FOUNDER_PHOTO_URL ? (
                  <img src={FOUNDER_PHOTO_URL} alt={FOUNDER_NAME} className="h-full w-full object-cover" />
                ) : (
                  <Initials name={FOUNDER_NAME} />
                )}
              </div>
              <div>
                <h2 className="text-xl font-bold text-text-primary">{FOUNDER_NAME}</h2>
                <p className="text-sm font-medium text-accent">{FOUNDER_TITLE}</p>
                <p className="mt-3 text-sm leading-relaxed text-text-secondary sm:text-base">{FOUNDER_BIO}</p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-4 sm:justify-start">
                  {FOUNDER_LINKEDIN_URL && (
                    <a
                      href={FOUNDER_LINKEDIN_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="focus-ring flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
                    >
                      <Linkedin size={15} />
                      LinkedIn
                    </a>
                  )}
                  <a
                    href={`mailto:${FOUNDER_EMAIL}`}
                    className="focus-ring flex items-center gap-1.5 text-sm font-semibold text-text-secondary hover:text-accent"
                  >
                    <Mail size={15} />
                    {FOUNDER_EMAIL}
                  </a>
                </div>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Radical transparency note — matches /careers wording on purpose */}
        <section className="px-6 py-6">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="mx-auto flex max-w-3xl items-start gap-4 rounded-2xl border border-accent/20 bg-accent/5 p-6"
          >
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
            <p className="text-sm leading-relaxed text-text-secondary sm:text-base">
              <strong className="text-text-primary">Where we are today:</strong> Vireek is built
              by a small, focused team. We'd rather show you exactly who's here than pad this
              page with inflated titles. As the team, advisors, and customer board below grow,
              we'll add real people here — not before.
            </p>
          </motion.div>
        </section>

        {/* Advisors */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Advisors</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                Industry advisors
              </h2>
            </motion.div>

            {ADVISORS.length > 0 ? (
              <div className="mt-12 grid gap-6 sm:grid-cols-2 md:grid-cols-3">
                {ADVISORS.map((a) => (
                  <PersonCard key={a.name} person={a} />
                ))}
              </div>
            ) : (
              <div className="mt-12">
                <NotYetPanel
                  icon={Users}
                  title="Building this out"
                  body="We haven't added formal advisors yet — we'd rather leave this empty than fill it with names that aren't real. If you're deep in home-service operations, trades, or field-service software and want to help shape Vireek, we'd love to talk."
                  ctaLabel="Reach out about advising"
                  ctaHref="mailto:ali@vireek.com?subject=Advisor%20Interest"
                />
              </div>
            )}
          </div>
        </section>

        {/* Customer Advisory Board */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="rounded-2xl border border-border bg-bg-secondary p-8 shadow-card dark:shadow-card-dark"
            >
              <div className="flex items-center gap-3">
                <Sparkles className="h-5 w-5 text-accent" />
                <h2 className="text-lg font-bold text-text-primary sm:text-xl">
                  Customer Advisory Board
                </h2>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-text-secondary sm:text-base">
                We're forming a small group of active customers to give direct input on what we
                build next — before it ships, not after. It doesn't exist yet, and we're not
                going to claim it does. If you run a home-service business on Vireek and want a
                real say in the roadmap, apply below.
              </p>
              <a href="mailto:ali@vireek.com?subject=Customer%20Advisory%20Board" className="mt-5 inline-block">
                <Button variant="secondary" size="lg">
                  Apply to Join
                </Button>
              </a>
            </motion.div>
          </div>
        </section>

        {/* Link back to the full story */}
        <section className="px-6 pb-20 pt-4 text-center">
          <Link
            to="/about"
            className="focus-ring inline-flex items-center gap-2 text-sm font-semibold text-text-secondary transition-colors hover:text-accent"
          >
            Read the full story behind Vireek
            <ArrowRight size={14} />
          </Link>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

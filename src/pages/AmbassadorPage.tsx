import { motion } from 'framer-motion';
import { ArrowRight, Award, Mail, MessageCircle, Rocket, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

const CHAMPION_EMAIL = 'ali@vireek.com';
const APPLY_SUBJECT = 'Vireek Champion — interested';
const APPLY_HREF = `mailto:${CHAMPION_EMAIL}?subject=${encodeURIComponent(APPLY_SUBJECT)}`;

const PERKS = [
  { icon: Rocket, title: 'Early access', body: 'Try new features before they go out to everyone else, and have a real say in whether they ship as-is.' },
  { icon: Users, title: 'Recognition in the Community', body: 'A Champion role in the Discord, so other owners can see who to ask when they want a straight answer from someone actually running Vireek.' },
  { icon: Award, title: 'Featured on our site', body: 'With your permission, your story gets a real spot on our testimonials and case studies pages — not a generic quote, your name and business.' },
  { icon: MessageCircle, title: 'A direct line to the founder', body: 'Skip the support queue for product feedback — Champions talk to the person actually building this.' },
];

const HOW_IT_WORKS = [
  { step: '01', title: 'Be a genuine customer', body: 'There is no minimum tenure or call volume — just be an active Vireek customer who has an honest opinion about it.' },
  { step: '02', title: 'Reach out', body: 'Send a note about what has worked, what has not, and what you would want to see next. That conversation is the application.' },
  { step: '03', title: "That's it", body: 'No tiers, no points, no leaderboard — we do not have that infrastructure and would rather not fake one. It stays a real, personal relationship.' },
];

function SEO() {
  useSEO({
    title: 'Vireek Champions — Customer Recognition Program',
    description:
      'Vireek Champions is a recognition program for customers who go out of their way to give feedback and share their story — early feature access, a direct line to the founder, and a spot in the Community.',
    canonical: 'https://vireek.com/ambassador',
  });
  return null;
}

export function AmbassadorPage() {
  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Vireek Champions</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Recognition for Customers Who Go Out of Their Way
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Not a referral program — that's{' '}
                <Link to="/affiliate" className="font-semibold text-accent hover:underline">
                  the Affiliate Program
                </Link>
                . This is for customers who give real feedback, help other owners in the{' '}
                <Link to="/community" className="font-semibold text-accent hover:underline">
                  Community
                </Link>
                , and are willing to put their name on their story.
              </p>
              <div className="mt-10 flex justify-center">
                <a href={APPLY_HREF}>
                  <Button variant="primary" size="lg">
                    Reach out <ArrowRight size={18} />
                  </Button>
                </a>
              </div>
              <p className="mt-6 flex items-center justify-center gap-1.5 text-xs font-medium text-text-secondary/70">
                <ShieldCheck size={13} className="shrink-0" />
                Free, informal, and reviewed personally — no application form to fill out.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Perks */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>What You Get</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Not points. Real access.</h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-14 grid gap-6 sm:grid-cols-2"
            >
              {PERKS.map((p) => (
                <motion.div key={p.title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="flex h-full flex-col">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                      <p.icon size={20} />
                    </span>
                    <h3 className="mt-5 text-lg font-semibold text-text-primary">{p.title}</h3>
                    <p className={`${bodyClass()} mt-3 flex-1 text-sm`}>{p.body}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* How it works */}
        <section className="px-6 pb-20 sm:pb-24">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>How It Works</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Three steps. No gamification.</h2>
            </motion.div>

            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="mt-12 space-y-4"
            >
              {HOW_IT_WORKS.map((s) => (
                <motion.div
                  key={s.step}
                  variants={fadeUpItem}
                  transition={{ duration: 0.4, ease: EASE }}
                  className="flex items-start gap-5 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-accent/20 bg-accent/10 text-sm font-bold text-accent">
                    {s.step}
                  </span>
                  <div>
                    <h3 className="text-base font-semibold text-text-primary">{s.title}</h3>
                    <p className={`${bodyClass()} mt-1.5 text-sm`}>{s.body}</p>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-6 pb-16 md:pb-24">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="bg-noise relative mx-auto flex max-w-6xl flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-br from-accent-800 via-accent-700 to-cta-800 px-6 py-16 text-center shadow-glow-accent md:px-16 md:py-24"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 45%), radial-gradient(circle at 85% 80%, rgb(var(--accent-secondary) / 0.20), transparent 45%)',
              }}
            />
            <div className="relative">
              <Sparkles className="mx-auto h-10 w-10 text-white/90" />
              <h2 className="mt-5 text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Already a Vireek customer with something to say?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Send a note. If it's a real fit, we'll take it from there — no form, no waiting on a review board.
              </p>
              <div className="mt-9 flex justify-center">
                <a href={APPLY_HREF}>
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    <Mail size={18} /> Email us
                  </Button>
                </a>
              </div>
            </div>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

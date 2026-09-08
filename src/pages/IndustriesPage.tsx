import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { INDUSTRIES } from '@/lib/industries';

export function IndustriesPage() {
  useSEO({
    title: 'Industries — AI Voice Receptionist for Every Home Service Trade | Vireek',
    description: 'Vireek is built for HVAC, plumbing, roofing, electrical, restoration, and locksmith businesses. Sarah speaks the language of your trade.',
    canonical: 'https://vireek.com/industries',
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
              <BackButton />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>Industries</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Built for Your Trade. Not a Generic Bot.
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                Sarah speaks the language of home services. She knows the difference between a heat
                pump and a torsion spring — and she&apos;s trained on the terminology, pain points,
                and call patterns of each trade.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Industry cards */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-7xl">
            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
            >
              {INDUSTRIES.map(({ icon: Icon, name, slug, tagline, terms }) => (
                <motion.div key={name} variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE }}>
                  <Link
                    to={`/industries/${slug}`}
                    className="group flex h-full flex-col rounded-2xl border border-border bg-bg-secondary p-7 shadow-card transition-all duration-300 ease-out hover:-translate-y-1 hover:border-accent/30 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent transition-colors duration-300 group-hover:bg-accent group-hover:text-white">
                        <Icon size={22} />
                      </span>
                      <h3 className="text-xl font-semibold text-text-primary">{name}</h3>
                    </div>
                    <p className="mt-4 text-sm leading-relaxed text-text-secondary">{tagline}</p>
                    <ul className="mt-5 flex flex-wrap gap-2">
                      {terms.slice(0, 4).map((term) => (
                        <li
                          key={term}
                          className="rounded-lg border border-border bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary"
                        >
                          {term}
                        </li>
                      ))}
                    </ul>
                    <span className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
                      Learn more
                      <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </Link>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* CTA */}
        <section className="px-6 py-16 md:py-20">
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
              <h2 className="text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                Don&apos;t see your trade?
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                Sarah is adaptable. If you run a home-service business, she can learn your terminology,
                your services, and your booking rules.
              </p>
              <div className="mt-9 flex justify-center">
                <Link
                  to="/login"
                  className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-accent-800 shadow-lg transition-all hover:brightness-95 active:scale-[0.98]"
                >
                  Start Free Trial
                  <ArrowRight size={18} />
                </Link>
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

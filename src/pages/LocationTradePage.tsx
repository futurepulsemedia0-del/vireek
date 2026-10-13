import { useMemo } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, CheckCircle2, CloudLightning, Home, MapPin, Sparkles } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Button } from '@/components/ui/Button';
import { IndustryRoiCalculator } from '@/components/sections/IndustryRoiCalculator';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { INDUSTRIES, getIndustryBySlug } from '@/lib/industries';
import { CITIES, buildLocalJsonLd, buildLocalPage, getCityBySlug, locationPath } from '@/lib/locations';

const chip =
  'focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent sm:px-4';
const panel = 'rounded-2xl border border-border bg-bg-secondary/90 p-5 shadow-card dark:shadow-card-dark sm:p-6';

export function LocationTradePage() {
  const { city: citySlug, trade } = useParams<{ city: string; trade: string }>();
  const city = getCityBySlug(citySlug);
  const industry = getIndustryBySlug(trade);
  const page = useMemo(() => (city && industry ? buildLocalPage(industry, city) : null), [city, industry]);
  const jsonLd = useMemo(
    () => (city && industry && page ? buildLocalJsonLd(industry, city, page) : []),
    [city, industry, page],
  );

  useSEO({
    title: page?.title ?? 'Service Areas | Vireek',
    description: page?.description ?? 'Vireek answers every call for home service companies across the US.',
    canonical: page?.canonical ?? 'https://vireek.com/locations',
    jsonLd,
  });

  if (!city || !industry || !page) return <Navigate to="/locations" replace />;

  const { name, icon: Icon, capabilities } = industry;
  const place = `${city.name}, ${city.stateCode}`;

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-5 py-14 sm:px-6 sm:py-20 lg:py-24">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl text-center">
            <nav aria-label="Breadcrumb" className="mb-5 flex flex-wrap items-center justify-center gap-1.5 text-xs text-text-secondary sm:text-sm">
              <Link to="/locations" className="hover:text-accent">Locations</Link>
              <span aria-hidden="true">/</span>
              <Link to={locationPath(city)} className="hover:text-accent">{city.name}</Link>
              <span aria-hidden="true">/</span>
              <span aria-current="page" className="font-semibold text-text-primary">{name}</span>
            </nav>
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, ease: EASE }}>
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-text-secondary shadow-sm backdrop-blur sm:text-sm">
                <Icon className="h-4 w-4 text-accent" />
                {name} · {place}
              </div>
              <h1 className="text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-5xl">{page.h1}</h1>
              <p className="mx-auto mt-5 max-w-3xl text-base leading-7 text-text-secondary sm:text-lg sm:leading-8">{page.intro}</p>
              <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4">
                <Link to="/login" className="w-full sm:w-auto">
                  <Button variant="primary" size="lg" className="w-full sm:w-auto">Start Free Trial</Button>
                </Link>
                <a href="/#pricing" className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent sm:w-auto">
                  View pricing <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </motion.div>
          </div>
        </section>

        <section className="px-5 py-12 sm:px-6 sm:py-16">
          <div className="mx-auto max-w-6xl">
            <p className={`${eyebrowClass()} text-center`}>Local demand</p>
            <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>What drives {name} calls in {city.name}</h2>
            <div className="mt-8 grid gap-4 sm:mt-10 md:grid-cols-2 lg:grid-cols-3">
              {page.drivers.map((d, i) => (
                <motion.div key={d.tag} initial={{ opacity: 0, y: 14 }} whileInView={{ opacity: 1, y: 0 }} viewport={viewport} transition={{ duration: 0.4, delay: i * 0.06, ease: EASE }} className={panel}>
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><CloudLightning size={18} /></span>
                  <h3 className="mt-3 text-base font-semibold text-text-primary">{d.label}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{d.text}</p>
                </motion.div>
              ))}
              <div className={panel}>
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><Home size={18} /></span>
                <h3 className="mt-3 text-base font-semibold text-text-primary">Housing and equipment</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{city.housingNote}</p>
              </div>
              <div className={panel}>
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent"><MapPin size={18} /></span>
                <h3 className="mt-3 text-base font-semibold text-text-primary">Peak season: {city.peakSeason}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{city.seasonNote}</p>
              </div>
            </div>
          </div>
        </section>

        <section className="px-5 py-12 sm:px-6 sm:py-16">
          <div className={`${panel} mx-auto max-w-4xl sm:p-8`}>
            <p className={eyebrowClass()}>How Vireek helps</p>
            <h2 className="mt-2 text-xl font-bold text-text-primary sm:text-2xl">Built for {name.toLowerCase() === 'hvac' ? 'HVAC' : name.toLowerCase()} teams in {city.name}</h2>
            <ul className="mt-5 space-y-3">
              {capabilities.map((cap) => (
                <li key={cap} className="flex gap-3 text-sm leading-relaxed text-text-secondary">
                  <CheckCircle2 size={18} className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                  {cap}
                </li>
              ))}
            </ul>
            <p className="mt-6 text-sm font-semibold text-text-primary">Service areas we answer calls for:</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {[city.name, ...page.coverage].map((area) => (
                <span key={area} className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary sm:text-sm">{area}</span>
              ))}
            </div>
          </div>
        </section>

        <IndustryRoiCalculator key={`${city.slug}-${industry.slug}`} industry={industry} />

        <section className="px-5 py-12 sm:px-6 sm:py-16">
          <div className="mx-auto max-w-3xl">
            <p className={`${eyebrowClass()} text-center`}>FAQ</p>
            <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>{name} in {city.name}: common questions</h2>
            <div className="mt-8 space-y-3 sm:space-y-4">
              {page.faq.map((item) => (
                <div key={item.q} className={panel}>
                  <h3 className="text-base font-semibold text-text-primary">{item.q}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="px-5 py-12 sm:px-6 sm:py-16">
          <div className="mx-auto max-w-5xl space-y-10">
            <div>
              <h2 className="text-center text-lg font-bold text-text-primary sm:text-xl">Other trades in {city.name}</h2>
              <div className="mt-5 flex flex-wrap justify-center gap-2 sm:gap-3">
                {INDUSTRIES.filter((i) => i.slug !== industry.slug).map((other) => (
                  <Link key={other.slug} to={locationPath(city, other)} className={chip}>
                    <other.icon className="h-4 w-4" />{other.name}
                  </Link>
                ))}
              </div>
            </div>
            <div>
              <h2 className="text-center text-lg font-bold text-text-primary sm:text-xl">{name} in other cities</h2>
              <div className="mt-5 flex flex-wrap justify-center gap-2 sm:gap-3">
                {CITIES.filter((c) => c.slug !== city.slug).map((other) => (
                  <Link key={other.slug} to={locationPath(other, industry)} className={chip}>
                    <MapPin className="h-4 w-4" />{other.name}
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="px-5 pb-16 sm:px-6 sm:pb-24">
          <div className={`${panel} mx-auto max-w-5xl text-center sm:p-12`}>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              <Sparkles className="mr-1.5 inline h-4 w-4" />Ready when your phone rings
            </p>
            <h2 className="mt-4 text-2xl font-bold tracking-tight text-text-primary sm:text-3xl">Stop losing {city.name} leads to voicemail.</h2>
            <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-text-secondary sm:text-base">Set up Vireek in minutes and start answering every call today.</p>
            <div className="mt-8 flex justify-center">
              <Link to="/login" className="w-full sm:w-auto">
                <Button variant="primary" size="lg" className="w-full sm:w-auto">Start Free Trial</Button>
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

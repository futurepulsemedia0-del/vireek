import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, MapPin } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { eyebrowClass } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { CITIES, SITE_URL, locationPath } from '@/lib/locations';

export function LocationsPage() {
  const jsonLd = useMemo(
    () => [
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
          { '@type': 'ListItem', position: 2, name: 'Locations', item: `${SITE_URL}/locations` },
        ],
      },
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        name: 'Vireek service areas',
        itemListElement: CITIES.map((c, idx) => ({
          '@type': 'ListItem',
          position: idx + 1,
          name: `${c.name}, ${c.stateCode}`,
          url: `${SITE_URL}${locationPath(c)}`,
        })),
      },
    ],
    [],
  );

  useSEO({
    title: 'Service Areas — AI Receptionist for Home Service Companies by City | Vireek',
    description: 'Find Vireek by city and trade. See how our AI receptionist answers every call for HVAC, plumbing, roofing, electrical and more across the US.',
    canonical: `${SITE_URL}/locations`,
    jsonLd,
  });

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-5 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-4xl text-center">
            <p className={eyebrowClass()}>Service areas</p>
            <h1 className="mt-3 text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-5xl">
              Local Call Answering for Every Trade, in Your City
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-text-secondary sm:text-lg">
              Weather, housing stock and seasons change what customers call about. Choose your city to see how Vireek handles it.
            </p>
          </div>
        </section>
        <section className="px-5 py-12 sm:px-6 sm:py-16">
          <ul className="mx-auto grid max-w-6xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CITIES.map((c) => (
              <li key={c.slug}>
                <Link to={locationPath(c)} className="focus-ring flex h-full items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary/90 p-4 shadow-card transition-colors hover:border-accent/40 dark:shadow-card-dark sm:p-5">
                  <span className="flex items-center gap-3 text-sm font-semibold text-text-primary sm:text-base">
                    <MapPin className="h-5 w-5 text-accent" />{c.name}, {c.stateCode}
                  </span>
                  <ArrowRight className="h-4 w-4 text-text-secondary" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

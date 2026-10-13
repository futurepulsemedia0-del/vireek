import { useMemo } from 'react';
import { useParams, Link, Navigate } from 'react-router-dom';
import { ArrowRight, MapPin } from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { eyebrowClass, sectionHeadingClass } from '@/lib/motion';
import { useSEO } from '@/lib/seo';
import { INDUSTRIES } from '@/lib/industries';
import { CITIES, SITE_URL, getCityBySlug, locationPath } from '@/lib/locations';

export function LocationCityPage() {
  const { city: citySlug } = useParams<{ city: string }>();
  const city = getCityBySlug(citySlug);
  const canonical = city ? `${SITE_URL}${locationPath(city)}` : `${SITE_URL}/locations`;

  const jsonLd = useMemo(
    () =>
      city
        ? [
            {
              '@context': 'https://schema.org',
              '@type': 'BreadcrumbList',
              itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
                { '@type': 'ListItem', position: 2, name: 'Locations', item: `${SITE_URL}/locations` },
                { '@type': 'ListItem', position: 3, name: city.name, item: canonical },
              ],
            },
            {
              '@context': 'https://schema.org',
              '@type': 'ItemList',
              name: `Vireek AI receptionist by trade in ${city.name}, ${city.stateCode}`,
              itemListElement: INDUSTRIES.map((i, idx) => ({
                '@type': 'ListItem',
                position: idx + 1,
                name: `${i.name} AI receptionist in ${city.name}`,
                url: `${SITE_URL}${locationPath(city, i)}`,
              })),
            },
          ]
        : [],
    [city, canonical],
  );

  useSEO({
    title: city ? `AI Receptionist for Home Service Companies in ${city.name}, ${city.stateCode} | Vireek` : 'Service Areas | Vireek',
    description: city
      ? `Vireek answers every call for ${city.name}, ${city.stateCode} home service companies — HVAC, plumbing, roofing, electrical and more. 24/7, no missed calls.`
      : 'Vireek answers every call for home service companies across the US.',
    canonical,
    jsonLd,
  });

  if (!city) return <Navigate to="/locations" replace />;

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-20 sm:pt-24">
        <section className="relative bg-gradient-mesh bg-noise px-5 py-14 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-4xl text-center">
            <nav aria-label="Breadcrumb" className="mb-5 flex items-center justify-center gap-1.5 text-xs text-text-secondary sm:text-sm">
              <Link to="/locations" className="hover:text-accent">Locations</Link>
              <span aria-hidden="true">/</span>
              <span aria-current="page" className="font-semibold text-text-primary">{city.name}</span>
            </nav>
            <p className={eyebrowClass()}>{city.name}, {city.state}</p>
            <h1 className="mt-3 text-balance text-3xl font-extrabold tracking-tight text-text-primary sm:text-4xl lg:text-5xl">
              AI Receptionist for {city.name} Home Service Companies
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base leading-7 text-text-secondary sm:text-lg">
              {city.seasonNote} Pick your trade to see how Vireek handles the calls {city.name} companies get.
            </p>
          </div>
        </section>
        <section className="px-5 py-12 sm:px-6 sm:py-16">
          <div className="mx-auto max-w-6xl">
            <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>Choose your trade in {city.name}</h2>
            <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {INDUSTRIES.map((i) => (
                <li key={i.slug}>
                  <Link to={locationPath(city, i)} className="focus-ring flex h-full items-center justify-between gap-3 rounded-2xl border border-border bg-bg-secondary/90 p-4 shadow-card transition-colors hover:border-accent/40 dark:shadow-card-dark sm:p-5">
                    <span className="flex items-center gap-3 text-sm font-semibold text-text-primary sm:text-base">
                      <i.icon className="h-5 w-5 text-accent" />{i.name}
                    </span>
                    <ArrowRight className="h-4 w-4 text-text-secondary" />
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-10 text-center text-sm font-semibold text-text-primary">Other cities</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {CITIES.filter((c) => c.slug !== city.slug).map((c) => (
                <Link key={c.slug} to={locationPath(c)} className="focus-ring inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-xs text-text-secondary hover:text-accent sm:text-sm">
                  <MapPin className="h-3.5 w-3.5" />{c.name}
                </Link>
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

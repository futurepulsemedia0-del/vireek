import { Link } from 'react-router-dom';
import { MapPin } from 'lucide-react';
import { eyebrowClass, sectionHeadingClass } from '@/lib/motion';
import { CITIES, locationPath } from '@/lib/locations';
import type { Industry } from '@/lib/industries';

/** Internal links from an /industries/:slug page to its city pages. */
export function LocalAreaLinks({ industry }: { industry: Industry }) {
  return (
    <section className="px-5 py-12 sm:px-6 sm:py-16">
      <div className="mx-auto max-w-5xl">
        <p className={`${eyebrowClass()} text-center`}>Service areas</p>
        <h2 className={`${sectionHeadingClass()} text-center text-2xl sm:text-3xl`}>{industry.name} answering by city</h2>
        <div className="mt-6 flex flex-wrap justify-center gap-2 sm:mt-8 sm:gap-3">
          {CITIES.map((city) => (
            <Link
              key={city.slug}
              to={locationPath(city, industry)}
              className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent sm:px-4"
            >
              <MapPin className="h-4 w-4" />
              {city.name}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { FOUNDING_OFFER, TRIAL } from '@/lib/homeContent';
import { trackHomeCta } from '@/lib/homeAnalytics';
import { container, eyebrow, h2, lead, panel, sectionY, textLink } from './sectionStyles';

/**
 * Replaces the fabricated "Coastal Plumbing Co." result. Contains no testimonials, logos or customer metrics.
 * If a real founding offer is defined in homeContent.FOUNDING_OFFER it is shown; otherwise the section says so.
 */
export function FoundingProgram() {
  return (
    <section id="founding" aria-labelledby="founding-heading" className={`${sectionY} border-t border-border`}>
      <div className={container}>
        <div className={`${panel} grid gap-8 p-6 sm:p-10 md:grid-cols-[1.2fr_0.8fr] md:items-center`}>
          <div>
            <p className={eyebrow}>Founding customers</p>
            <h2 id="founding-heading" className={h2}>We’re early, and we’ll say so</h2>
            <p className={lead}>
              Vireek is a young product. We don’t publish customer counts, logos or quotes we can’t back up. Start the
              trial, listen to real calls on your own line, and judge Sarah on that.
            </p>
            {FOUNDING_OFFER && (
              <p className="mt-4 text-sm text-text-primary">
                <strong>{FOUNDING_OFFER.title}.</strong> {FOUNDING_OFFER.terms}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-3">
            <ButtonLink to="/signup" size="lg" className="w-full" onClick={() => trackHomeCta('founding_primary')}>
              Start free trial
              <ArrowRight size={18} aria-hidden="true" className="rtl:-scale-x-100" />
            </ButtonLink>
            <p className="text-sm text-text-secondary">{TRIAL.short}</p>
            <Link to="/demo" className={textLink}>Prefer a walkthrough? Book a demo</Link>
          </div>
        </div>
      </div>
    </section>
  );
}

import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Pause, Play } from 'lucide-react';
import { LogoMarquee, type MarqueeItem } from '@/components/ui/LogoMarquee';
import { usePrefersReducedMotion } from '@/lib/usePrefersReducedMotion';

/**
 * Only integrations with real backend code in this repo. The proof (file paths)
 * lives in integrationsMarquee.evidence.ts and is enforced by a Vitest test, so
 * this list cannot silently drift from what Vireek actually ships.
 *
 * Wordmarks are plain text until an official brand-kit SVG is supplied via
 * `logo` (see the brand guidelines of each vendor).
 */
const ROW_A: readonly MarqueeItem[] = [
  { id: 'servicetitan', name: 'ServiceTitan', href: '/integrations/servicetitan' },
  { id: 'jobber', name: 'Jobber', href: '/integrations/jobber' },
  { id: 'housecall-pro', name: 'Housecall Pro', href: '/integrations' },
  { id: 'hubspot', name: 'HubSpot', href: '/integrations/hubspot' },
  { id: 'salesforce', name: 'Salesforce', href: '/integrations/salesforce' },
  { id: 'quickbooks', name: 'QuickBooks', href: '/integrations/quickbooks' },
];

const ROW_B: readonly MarqueeItem[] = [
  { id: 'google-calendar', name: 'Google Calendar', href: '/integrations/google-calendar' },
  { id: 'microsoft-365', name: 'Microsoft 365', href: '/integrations/microsoft-365' },
  { id: 'slack', name: 'Slack', href: '/integrations/slack' },
  { id: 'microsoft-teams', name: 'Microsoft Teams', href: '/integrations' },
  { id: 'stripe', name: 'Stripe', href: '/integrations/stripe' },
];

export const MARQUEE_ITEMS: readonly MarqueeItem[] = [...ROW_A, ...ROW_B];

export function IntegrationsMarquee() {
  const headingId = useId();
  const reduced = usePrefersReducedMotion();
  const [paused, setPaused] = useState(false);

  return (
    <section
      aria-labelledby={headingId}
      data-testid="integrations-marquee"
      className="border-y border-border/60 bg-bg-secondary/50 py-10 sm:py-12"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <h2
          id={headingId}
          className="text-center text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-text-secondary sm:text-xs sm:tracking-[0.18em]"
        >
          Works with the tools you already use
        </h2>

        <div className="mt-5 sm:mt-6">
          {reduced ? (
            <LogoMarquee items={MARQUEE_ITEMS} label="Supported integrations" />
          ) : (
            <>
              <div className="md:hidden">
                <LogoMarquee items={MARQUEE_ITEMS} label="Supported integrations" paused={paused} />
              </div>
              <div className="hidden md:block">
                <LogoMarquee
                  items={ROW_A}
                  label="Field service, CRM and accounting integrations"
                  direction="left"
                  speed={48}
                  paused={paused}
                />
                <LogoMarquee
                  items={ROW_B}
                  label="Calendar, messaging and payments integrations"
                  direction="right"
                  speed={42}
                  paused={paused}
                />
              </div>
            </>
          )}
        </div>

        <div className="mt-4 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
          <p className="text-xs text-text-secondary">
            Logos are trademarks of their respective owners. Names shown for compatibility; no
            partnership is implied.
          </p>
          <div className="flex items-center gap-5">
            {!reduced && (
              <button
                type="button"
                onClick={() => setPaused((p) => !p)}
                className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium text-text-secondary transition-colors hover:text-text-primary"
              >
                {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
                {paused ? 'Play logo scroll' : 'Pause logo scroll'}
              </button>
            )}
            <Link
              to="/integrations"
              className="inline-flex items-center gap-1 rounded-md text-xs font-semibold text-accent transition-colors hover:text-accent-hover"
            >
              See all integrations
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

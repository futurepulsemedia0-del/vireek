import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Droplets, House, Pause, Play, Snowflake, Zap, type LucideIcon } from 'lucide-react';
import {
  GoogleCalendarMark,
  HubSpotMark,
  InitialMark,
  MicrosoftTeamsMark,
  QuickBooksMark,
  SalesforceMark,
  SlackMark,
  StripeMark,
} from '@/components/brand/thirdPartyLogos';
import {
  HousecallProMark,
  JobberMark,
  Microsoft365Mark,
  ServiceTitanMark,
} from '@/components/brand/fieldServiceMarks';
import { LogoMarquee, type MarqueeItem } from '@/components/ui/LogoMarquee';
import { TRADES } from '@/lib/homeContent';
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
  { id: 'servicetitan', name: 'ServiceTitan', href: '/integrations/servicetitan', showName: true, logo: <ServiceTitanMark /> },
  { id: 'jobber', name: 'Jobber', href: '/integrations/jobber', showName: true, logo: <JobberMark /> },
  { id: 'housecall-pro', name: 'Housecall Pro', href: '/integrations', showName: true, logo: <HousecallProMark /> },
  { id: 'hubspot', name: 'HubSpot', href: '/integrations/hubspot', showName: true, logo: <HubSpotMark /> },
  { id: 'salesforce', name: 'Salesforce', href: '/integrations/salesforce', showName: true, logo: <SalesforceMark /> },
  { id: 'quickbooks', name: 'QuickBooks', href: '/integrations/quickbooks', showName: true, logo: <QuickBooksMark /> },
];

const ROW_B: readonly MarqueeItem[] = [
  { id: 'google-calendar', name: 'Google Calendar', href: '/integrations/google-calendar', showName: true, logo: <GoogleCalendarMark /> },
  { id: 'microsoft-365', name: 'Microsoft 365', href: '/integrations/microsoft-365', showName: true, logo: <Microsoft365Mark /> },
  { id: 'slack', name: 'Slack', href: '/integrations/slack', showName: true, logo: <SlackMark /> },
  { id: 'microsoft-teams', name: 'Microsoft Teams', href: '/integrations', showName: true, logo: <MicrosoftTeamsMark /> },
  { id: 'stripe', name: 'Stripe', href: '/integrations/stripe', showName: true, logo: <StripeMark /> },
];

const TRADE_ICONS: Record<(typeof TRADES)[number], LucideIcon> = {
  Plumbing: Droplets,
  HVAC: Snowflake,
  Electrical: Zap,
  Roofing: House,
};

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

        <div className="mt-8 border-t border-border/60 pt-6 sm:mt-10">
          <h3 className="text-center text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-text-secondary sm:text-xs sm:tracking-[0.18em]">
            Built for the vocabulary of each trade
          </h3>
          <ul aria-label="Trades we support" className="mt-4 flex flex-wrap items-center justify-center gap-3">
            {TRADES.map((trade) => {
              const Icon = TRADE_ICONS[trade];
              return (
                <li
                  key={trade}
                  className="inline-flex h-10 items-center gap-2 rounded-full border border-border bg-bg-primary px-4 text-sm font-semibold text-text-primary"
                >
                  <Icon size={16} aria-hidden="true" className="text-text-secondary" />
                  {trade}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
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

import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useSEO } from '@/lib/seo';
import { CookieConsent } from '@/components/CookieConsent';
import { Hero } from '@/components/sections/Hero';
import { TrustBar } from '@/components/sections/TrustBar';
import { HowItWorks } from '@/components/sections/HowItWorks';
import { WhyNow } from '@/components/sections/WhyNow';
import { LiveDemo } from '@/components/sections/LiveDemo';
import { MissedCallCalculator } from '@/components/sections/MissedCallCalculator';
import { PricingTeaser } from '@/components/sections/PricingTeaser';
import { CustomerResults } from '@/components/sections/CustomerResults';
import { FinalCTA } from '@/components/sections/FinalCTA';
/**
 * Homepage — a single, seven-section path: prove it works (Hero), prove
 * it's trusted (TrustBar), make the case for urgency (WhyNow), explain it
 * (HowItWorks), let the visitor try it themselves (LiveDemo), make the
 * cost of missed calls concrete (MissedCallCalculator), show the price
 * (PricingTeaser), close (FinalCTA).
 *
 * SocialProof, HighlightBanner, ReviewBadges, DashboardPreview,
 * Integrations and Comparison used to live here too. Each one was saying
 * a version of "Sarah is smart and trusted" a second or third time,
 * which pushed the live demo and pricing further down the page than a
 * first-time visitor actually scrolls — and Comparison specifically
 * duplicated the dedicated, more complete /compare page. None of that
 * content is gone: it lives on /platform, /industries, /integrations,
 * /compare and /case-studies, all one click away from the header and
 * footer nav.
 */
export function HomePage() {
  useSEO({
    title: 'Vireek — AI Voice Receptionist for Home Services | Never Miss a Call',
    description:
      'Vireek is an AI voice receptionist built for home service businesses. Answer calls, capture leads, book appointments, and keep customer communication moving 24/7.',
    canonical: 'https://vireek.com/',
  });

  return (
    <>
      <Header />

      <main>
        <Hero />
        <TrustBar />
        <WhyNow />
        <HowItWorks />
        <LiveDemo />
        <MissedCallCalculator />
        <PricingTeaser />
        <CustomerResults />
        <FinalCTA />
      </main>

      <Footer />
      <CookieConsent />
    </>
  );
}

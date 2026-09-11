import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useSEO } from '@/lib/seo';
import { Hero } from '@/components/sections/Hero';
import { HighlightBanner } from '@/components/sections/HighlightBanner';
import { TrustBar } from '@/components/sections/TrustBar';
import { HowItWorks } from '@/components/sections/HowItWorks';
import { LiveDemo } from '@/components/sections/LiveDemo';
import { MissedCallCalculator } from '@/components/sections/MissedCallCalculator';
import { PricingTeaser } from '@/components/sections/PricingTeaser';
import { FinalCTA } from '@/components/sections/FinalCTA';
import { CookieConsent } from '@/components/CookieConsent';

/**
 * Homepage — cut down to a single, six-section path: prove it works (Hero),
 * prove it's trusted (TrustBar), explain it (HowItWorks), let the visitor
 * try it themselves (LiveDemo), make the cost of missed calls concrete
 * (MissedCallCalculator), show the price (PricingTeaser), close
 * (FinalCTA). Everything else that used to live here — AICapability,
 * LiveActivityStream, DashboardPreview, Industries, Integrations,
 * CaseStudies — was saying the same "Sarah is smart" pitch a second or
 * third time and pushing the live demo and pricing further down the page
 * than a first-time visitor actually scrolls. That content isn't gone: it
 * lives on /platform, /industries, /integrations and /case-studies, all one
 * click away from the header and footer nav.
 */
export function HomePage() {
  useSEO({
    title: 'Vireek — AI Voice Receptionist for Home Services | Never Miss a Call',
    description: 'Vireek is an AI voice receptionist built for home service businesses. Answer calls, capture leads, book appointments, and keep customer communication moving 24/7.',
    canonical: 'https://vireek.com/',
  });

  return (
    <>
      <Header />
      <main>
        <Hero />
        <HighlightBanner />
        <TrustBar />
        <HowItWorks />
        <LiveDemo />
        <MissedCallCalculator />
        <PricingTeaser />
        <FinalCTA />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useSEO } from '@/lib/seo';
import { Hero } from '@/components/sections/Hero';
import { TrustBar } from '@/components/sections/TrustBar';
import { LiveActivityStream } from '@/components/sections/LiveActivityStream';
import { AICapability } from '@/components/sections/AICapability';
import { DashboardPreview } from '@/components/sections/DashboardPreview';
import { HowItWorks } from '@/components/sections/HowItWorks';
import { LiveDemo } from '@/components/sections/LiveDemo';
import { PricingTeaser } from '@/components/sections/PricingTeaser';
import { MissedCallCalculator } from '@/components/sections/MissedCallCalculator';
import { Industries } from '@/components/sections/Industries';
import { Integrations } from '@/components/sections/Integrations';
import { WhyVireekFeatures } from '@/components/sections/WhyVireekFeatures';
import { CaseStudies } from '@/components/sections/CaseStudies';
import { SecurityPrivacy } from '@/components/sections/SecurityPrivacy';
import { FinalCTA } from '@/components/sections/FinalCTA';
import { CookieConsent } from '@/components/CookieConsent';

/**
 * Homepage — kept intentionally tight. It only needs to do one job: convince
 * a first-time visitor Vireek is worth a trial, then hand them to /platform
 * (deep technical dive), /pricing (full plan comparison), or /industries.
 *
 * The five "Sarah is smart, not a chatbot" deep-dive sections that used to
 * live here (AiBusinessMemory, AIBrain, RevenueIntelligence,
 * OperationsCommandCenter, AiCallCoach) were repeating the same pitch in
 * different words and pushing Pricing to the very bottom of the page. They
 * now live on /platform, which is the natural home for that level of detail.
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
        <TrustBar />
        <LiveActivityStream />
        <AICapability />
        <HowItWorks />
        <DashboardPreview />
        <LiveDemo />
        <PricingTeaser />
        <MissedCallCalculator />
        <Industries />
        <Integrations />
        <WhyVireekFeatures />
        <CaseStudies />
        <SecurityPrivacy />
        <FinalCTA />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

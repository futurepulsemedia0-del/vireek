import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useSEO } from '@/lib/seo';
import { Hero } from '@/components/sections/Hero';
import { TrustBar } from '@/components/sections/TrustBar';
import { LiveActivityStream } from '@/components/sections/LiveActivityStream';
import { AICapability } from '@/components/sections/AICapability';
import { AiBusinessMemory } from '@/components/sections/AiBusinessMemory';
import { DashboardPreview } from '@/components/sections/DashboardPreview';
import { HowItWorks } from '@/components/sections/HowItWorks';
import { AIBrain } from '@/components/sections/AIBrain';
import { LiveDemo } from '@/components/sections/LiveDemo';
import { Industries } from '@/components/sections/Industries';
import { Integrations } from '@/components/sections/Integrations';
import { WhyVireekFeatures } from '@/components/sections/WhyVireekFeatures';
import { CaseStudies } from '@/components/sections/CaseStudies';
import { MissedCallCalculator } from '@/components/sections/MissedCallCalculator';
import { RevenueIntelligence } from '@/components/sections/RevenueIntelligence';
import { SecurityPrivacy } from '@/components/sections/SecurityPrivacy';
import { PricingTeaser } from '@/components/sections/PricingTeaser';
import { FinalCTA } from '@/components/sections/FinalCTA';
import { CookieConsent } from '@/components/CookieConsent';

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
        <AiBusinessMemory />
        <DashboardPreview />
        <HowItWorks />
        <AIBrain />
        <LiveDemo />
        <MissedCallCalculator />
        <RevenueIntelligence />
        <Industries />
        <Integrations />
        <WhyVireekFeatures />
        <CaseStudies />
        <SecurityPrivacy />
        <PricingTeaser />
        <FinalCTA />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

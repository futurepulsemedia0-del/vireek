import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useSEO } from '@/lib/seo';
import { Hero } from '@/components/sections/Hero';
import { LiveActivityStream } from '@/components/sections/LiveActivityStream';
import { Problem } from '@/components/sections/Problem';
import { MissedCallCalculator } from '@/components/sections/MissedCallCalculator';
import { BeforeAfter } from '@/components/sections/BeforeAfter';
import { Solution } from '@/components/sections/Solution';
import { HowItWorks } from '@/components/sections/HowItWorks';
import { Industries } from '@/components/sections/Industries';
import { LiveDemo } from '@/components/sections/LiveDemo';
import { Features } from '@/components/sections/Features';
import { SocialProof } from '@/components/sections/SocialProof';
import { PricingTeaser } from '@/components/sections/PricingTeaser';
import { FAQCallout } from '@/components/sections/FAQCallout';
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
        <LiveActivityStream />
        <Problem />
        <MissedCallCalculator />
        <BeforeAfter />
        <Solution />
        <HowItWorks />
        <Industries />
        <LiveDemo />
        <Features />
        <SocialProof />
        <PricingTeaser />
        <FAQCallout />
        <FinalCTA />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

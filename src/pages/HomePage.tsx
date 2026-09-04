import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useSEO } from '@/lib/seo';
import { Hero } from '@/components/sections/Hero';
import { TrustBar } from '@/components/sections/TrustBar';
import { LiveActivityStream } from '@/components/sections/LiveActivityStream';
import { AICapability } from '@/components/sections/AICapability';
import { HowItWorks } from '@/components/sections/HowItWorks';
import { LiveDemo } from '@/components/sections/LiveDemo';
import { Industries } from '@/components/sections/Industries';
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
        <HowItWorks />
        <LiveDemo />
        <Industries />
        <PricingTeaser />
        <FinalCTA />
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

import { ThemeProvider } from '@/contexts/ThemeContext';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Hero } from '@/components/sections/Hero';
import { Problem } from '@/components/sections/Problem';
import { BeforeAfter } from '@/components/sections/BeforeAfter';
import { Solution } from '@/components/sections/Solution';
import { HowItWorks } from '@/components/sections/HowItWorks';
import { Industries } from '@/components/sections/Industries';
import { LiveDemo } from '@/components/sections/LiveDemo';
import { Features } from '@/components/sections/Features';
import { SocialProof } from '@/components/sections/SocialProof';
import { Pricing } from '@/components/sections/Pricing';
import { SignupForm } from '@/components/sections/SignupForm';
import { FinalCTA } from '@/components/sections/FinalCTA';
import { CookieConsent } from '@/components/CookieConsent';

export function HomePage() {
  return (
    <ThemeProvider>
      <Header />
      <main>
        <Hero />
        <Problem />
        <BeforeAfter />
        <Solution />
        <HowItWorks />
        <Industries />
        <LiveDemo />
        <Features />
        <SocialProof />
        <Pricing />
        <SignupForm />
        <FinalCTA />
      </main>
      <Footer />
      <CookieConsent />
    </ThemeProvider>
  );
}

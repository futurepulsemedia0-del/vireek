import { Suspense, lazy, useMemo } from 'react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { CookieConsent } from '@/components/CookieConsent';
import { Hero } from '@/components/home/Hero';
import { IntegrationsMarquee } from '@/components/sections/IntegrationsMarquee';
import { StickyMobileCta } from '@/components/home/StickyMobileCta';
import { useSEO } from '@/lib/seo';
import { useScrollDepthTracking } from '@/lib/homeAnalytics';
import { HOME_FAQS, SARAH_SAMPLE_AUDIO, SITE_URL, TRIAL_CARD_PHRASE } from '@/lib/homeContent';

// Everything below the fold is code-split so the hero paints without waiting on it.
const CostOfMissedCalls = lazy(() => import('@/components/home/CostOfMissedCalls').then((m) => ({ default: m.CostOfMissedCalls })));
const HowItWorks = lazy(() => import('@/components/home/HowItWorks').then((m) => ({ default: m.HowItWorks })));
const LiveDemo = lazy(() => import('@/components/sections/LiveDemo').then((m) => ({ default: m.LiveDemo })));
const ProductProof = lazy(() => import('@/components/home/ProductProof').then((m) => ({ default: m.ProductProof })));
const FoundingProgram = lazy(() => import('@/components/home/FoundingProgram').then((m) => ({ default: m.FoundingProgram })));
const HomePricing = lazy(() => import('@/components/home/HomePricing').then((m) => ({ default: m.HomePricing })));
const HomeFaq = lazy(() => import('@/components/home/HomeFaq').then((m) => ({ default: m.HomeFaq })));
const SampleCall = lazy(() => import('@/components/home/SampleCall').then((m) => ({ default: m.SampleCall })));
const FounderNote = lazy(() => import('@/components/home/FounderNote').then((m) => ({ default: m.FounderNote })));
const FinalCta = lazy(() => import('@/components/home/FinalCta').then((m) => ({ default: m.FinalCta })));

/** Reserves space while a lazy section loads, so nothing below shifts when it arrives (CLS). */
function Slot({ minHeight, children }: { minHeight: number; children: React.ReactNode }) {
  return (
    <Suspense fallback={<div aria-hidden="true" style={{ minHeight }} />}>{children}</Suspense>
  );
}

/**
 * Homepage order: Hero → integrations/trades → cost of missed calls → how it works → live demo →
 * product proof → founding customers → pricing → FAQ → final CTA.
 * Organization + SoftwareApplication JSON-LD are static in index.html (crawlers see them without JS);
 * FAQPage JSON-LD is generated here from the same HOME_FAQS the page renders.
 */
export function HomePage() {
  const jsonLd = useMemo(
    () => ({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: HOME_FAQS.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    }),
    [],
  );

useSEO({
 title: 'Vireek',
  description: `Vireek answers every call for home-service contractors, 24/7: books the job, flags emergencies and texts the customer. 14-day free trial, ${TRIAL_CARD_PHRASE}.`,
  canonical: `${SITE_URL}/`,
  jsonLd,
});

  useScrollDepthTracking();

  return (
    <>
      <Header />
      <main id="main">
        <Hero />
        <IntegrationsMarquee />
        <Slot minHeight={760}><LiveDemo /></Slot>
        {SARAH_SAMPLE_AUDIO && <Slot minHeight={0}><SampleCall /></Slot>}
        <Slot minHeight={640}><CostOfMissedCalls /></Slot>
        <Slot minHeight={520}><HowItWorks /></Slot>
        <Slot minHeight={620}><ProductProof /></Slot>
        <Slot minHeight={360}><FoundingProgram /></Slot>
        <Slot minHeight={0}><FounderNote /></Slot>
        <Slot minHeight={760}><HomePricing /></Slot>
        <Slot minHeight={720}><HomeFaq /></Slot>
        <Slot minHeight={380}><FinalCta /></Slot>
      </main>
      <Footer />
      <StickyMobileCta />
      <CookieConsent />
    </>
  );
}

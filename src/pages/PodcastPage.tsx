import { FormEvent, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight, CheckCircle2, Mic, PlayCircle, Sparkles, Youtube,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

// IMPORTANT: no real episodes, guest names, or quotes exist yet — every
// card below is deliberately marked "Coming Soon." Do not fill these in
// with invented guest names or fabricated quotes. Replace with real
// episode data (title, guest, platform links) as episodes are recorded
// and published, and add real subscribe links to SUBSCRIBE_LINKS once
// the show exists on each platform.

const EMAIL = 'ali@vireek.com';
// Swap for a dedicated form endpoint before launch.
const FORM_ENDPOINT = 'https://formspree.io/f/xppzgqap';

const FORMAT_POINTS = [
  {
    title: '20&ndash;30 minute conversations',
    body: 'Focused, no-filler conversations with home-service business owners about how they actually run their operation \u2014 not a scripted infomercial.',
  },
  {
    title: 'Real operators, real numbers where they\u2019ll share them',
    body: 'HVAC, plumbing, electrical, roofing, and restoration owners talking about call volume, staffing, and what changed when they fixed their phone coverage \u2014 with their consent to publish specifics.',
  },
  {
    title: 'Video first, audio everywhere',
    body: 'Recorded for YouTube so you can see the conversation, with an audio version wherever you already listen to podcasts.',
  },
];

const PLACEHOLDER_EPISODES = [
  { number: 1, title: 'Coming Soon', status: 'In production' },
  { number: 2, title: 'Coming Soon', status: 'Guest booking' },
  { number: 3, title: 'Coming Soon', status: 'Guest booking' },
];

type FormState = 'idle' | 'loading' | 'success' | 'error';

interface NominationData {
  yourName: string;
  email: string;
  guestName: string;
  businessName: string;
  trade: string;
  whyThisGuest: string;
}

const INITIAL: NominationData = {
  yourName: '',
  email: '',
  guestName: '',
  businessName: '',
  trade: '',
  whyThisGuest: '',
};

const inputClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary placeholder:text-text-secondary/60 transition-colors focus-visible:border-accent';

function NominateGuestForm() {
  const [data, setData] = useState<NominationData>(INITIAL);
  const [state, setState] = useState<FormState>('idle');

  const update = (key: keyof NominationData, value: string) => setData((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (state === 'loading' || state === 'success') return;
    if (!data.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || !data.guestName.trim()) {
      setState('error');
      return;
    }
    setState('loading');
    try {
      const response = await fetch(FORM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, source: 'podcast-guest-nomination' }),
      });
      setState(response.ok ? 'success' : 'error');
    } catch {
      setState('error');
    }
  };

  if (state === 'success') {
    return (
      <div className="flex flex-col items-center py-10 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle2 size={30} />
        </span>
        <h3 className="mt-5 text-xl font-bold text-text-primary">Thanks for the nomination</h3>
        <p className="mt-2 max-w-sm text-sm leading-relaxed text-text-secondary">
          We'll review it and reach out directly if it's a fit for an upcoming episode.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="mt-6 grid gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="yourName" className="mb-2 block text-sm font-medium text-text-primary">Your name</label>
          <input id="yourName" className={inputClass} value={data.yourName} onChange={(e) => update('yourName', e.target.value)} />
        </div>
        <div>
          <label htmlFor="nomEmail" className="mb-2 block text-sm font-medium text-text-primary">
            Your email <span className="text-cta">*</span>
          </label>
          <input id="nomEmail" type="email" className={inputClass} value={data.email} onChange={(e) => update('email', e.target.value)} />
        </div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="guestName" className="mb-2 block text-sm font-medium text-text-primary">
            Guest's name <span className="text-cta">*</span>
          </label>
          <input id="guestName" className={inputClass} value={data.guestName} onChange={(e) => update('guestName', e.target.value)} />
        </div>
        <div>
          <label htmlFor="businessName" className="mb-2 block text-sm font-medium text-text-primary">Their business</label>
          <input id="businessName" className={inputClass} value={data.businessName} onChange={(e) => update('businessName', e.target.value)} />
        </div>
      </div>
      <div>
        <label htmlFor="trade" className="mb-2 block text-sm font-medium text-text-primary">Trade (HVAC, plumbing, electrical…)</label>
        <input id="trade" className={inputClass} value={data.trade} onChange={(e) => update('trade', e.target.value)} />
      </div>
      <div>
        <label htmlFor="whyThisGuest" className="mb-2 block text-sm font-medium text-text-primary">Why would they be a great guest?</label>
        <textarea id="whyThisGuest" rows={4} className={`${inputClass} resize-none`} value={data.whyThisGuest} onChange={(e) => update('whyThisGuest', e.target.value)} />
      </div>
      {state === 'error' && (
        <p className="text-sm text-danger">Please fill in your email and the guest's name.</p>
      )}
      <Button type="submit" variant="primary" size="lg" disabled={state === 'loading'} className="w-fit">
        {state === 'loading' ? 'Submitting…' : 'Submit Nomination'}
      </Button>
    </form>
  );
}

export function PodcastPage() {
  useSEO({
    title: 'The Vireek Show: A Podcast for Home Service Business Owners | Vireek',
    description:
      'Conversations with home-service business owners about running better operations, handling call volume, and growing without losing jobs to the phone. Coming soon on YouTube and everywhere you listen.',
    canonical: 'https://vireek.com/podcast',
  });

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <div className="mx-auto mb-5 inline-flex items-center gap-2 rounded-full border border-border bg-bg-secondary/80 px-4 py-1.5 text-sm font-semibold text-text-secondary shadow-sm backdrop-blur">
                <Mic className="h-4 w-4 text-accent" />
                Launching Soon
              </div>
              <p className={eyebrowClass()}>The Vireek Show</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Real Talk with Home Service Owners
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                A video and audio series featuring HVAC, plumbing, electrical, and roofing business
                owners talking honestly about growth, staffing, and what it actually takes to stop
                losing jobs to a ringing phone.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <a href="#nominate">
                  <Button variant="primary" size="lg">Nominate a Guest</Button>
                </a>
                <Link
                  to="/blog"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  Read the blog instead
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Format */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>The Format</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>What to expect</h2>
            </motion.div>

            <div className="mt-12 grid gap-6 md:grid-cols-3">
              {FORMAT_POINTS.map((point, index) => (
                <motion.div
                  key={point.title}
                  initial={{ opacity: 0, y: 18 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.45, delay: index * 0.08, ease: EASE }}
                  className="rounded-2xl border border-border bg-bg-secondary p-6 shadow-card dark:shadow-card-dark"
                >
                  <h3 className="text-lg font-semibold text-text-primary" dangerouslySetInnerHTML={{ __html: point.title }} />
                  <p className="mt-3 text-sm leading-relaxed text-text-secondary" dangerouslySetInnerHTML={{ __html: point.body }} />
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Episodes */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>First Season</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>Episodes</h2>
            </motion.div>

            <div className="mt-10 space-y-3">
              {PLACEHOLDER_EPISODES.map((ep, index) => (
                <motion.div
                  key={ep.number}
                  initial={{ opacity: 0, y: 14 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, delay: index * 0.06, ease: EASE }}
                  className="flex items-center gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
                >
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-text-secondary">
                    <PlayCircle size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary/70">
                      Episode {ep.number}
                    </p>
                    <p className="text-sm font-semibold text-text-primary sm:text-base">{ep.title}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-warning-500/15 px-3 py-1 text-xs font-semibold text-warning-500">
                    {ep.status}
                  </span>
                </motion.div>
              ))}
            </div>

            {/* Subscribe badges */}
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-xl border border-border bg-bg-tertiary/50 px-4 py-2.5 text-sm font-medium text-text-secondary">
                <Youtube size={16} />
                Coming to YouTube
              </span>
              <span className="inline-flex items-center gap-2 rounded-xl border border-border bg-bg-tertiary/50 px-4 py-2.5 text-sm font-medium text-text-secondary">
                <Mic size={16} />
                Coming to Spotify &amp; Apple Podcasts
              </span>
            </div>
          </div>
        </section>

        {/* Nominate a guest */}
        <section id="nominate" className="scroll-mt-24 px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-3xl rounded-2xl border border-accent/25 bg-bg-secondary p-8 shadow-card dark:shadow-card-dark md:p-10">
            <div className="flex items-center gap-3">
              <Sparkles className="h-5 w-5 text-accent" />
              <h2 className="text-xl font-bold text-text-primary sm:text-2xl">
                Know a great guest? Nominate them.
              </h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-text-secondary sm:text-base">
              We're looking for home-service business owners with a real story &mdash; growth,
              a turnaround, or lessons learned the hard way. Tell us about them below, or if
              it's you, put your own name in.
            </p>
            <NominateGuestForm />
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-6 py-16 md:py-20">
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-sm leading-relaxed text-text-secondary">
              Want to be notified when the first episode drops?{' '}
              <a href={`mailto:${EMAIL}?subject=Notify%20me%20-%20Vireek%20Podcast`} className="font-semibold text-accent hover:underline">
                Email us
              </a>{' '}
              and we'll add you to the list.
            </p>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

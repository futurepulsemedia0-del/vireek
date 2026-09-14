import { useState, useRef, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  MessageCircle,
  Users,
  Lightbulb,
  Wrench,
  Mail,
  CheckCircle2,
} from 'lucide-react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

// ============================================================
// CONFIG — edit once the real invite link exists.
// ============================================================
//
// HONESTY NOTE (same standard as WebinarsPage.tsx / CaseStudiesPage.tsx):
// leave COMMUNITY_INVITE_URL empty until a real Discord server has
// actually been created. Never point this at a placeholder or a server
// nobody is moderating — the empty state below renders a clean "notify me"
// signup instead of a dead or empty-feeling invite link.
//
// To go live: create the server, set an invite link that never expires
// and has no member cap, then fill in both constants below.
const COMMUNITY_INVITE_URL = ''; // e.g. 'https://discord.gg/xxxxxxx'
const COMMUNITY_PLATFORM = 'Discord';

const BENEFITS = [
  {
    icon: Users,
    title: 'Learn from other owners',
    description:
      'Talk directly with other home service business owners running Vireek — what scripts work, how they set up dispatch, what they wish they knew on day one.',
  },
  {
    icon: Wrench,
    title: 'Get unstuck faster',
    description:
      'Ask a setup or configuration question and get an answer from someone who solved the same problem last week, not just a support ticket queue.',
  },
  {
    icon: Lightbulb,
    title: 'Shape what gets built next',
    description:
      'Feature requests and feedback from the community directly inform the roadmap — this is the most direct line to the team outside of support.',
  },
];

function NotifySignup() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (state === 'loading' || state === 'success') return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setState('error');
      inputRef.current?.focus();
      return;
    }
    setState('loading');
    // TODO: wire to the real notify-list endpoint once the backend route
    // exists (same mock-submit pattern used in WebinarsPage.tsx until that
    // lands).
    await new Promise((r) => setTimeout(r, 1000));
    setState('success');
    setEmail('');
  };

  if (state === 'success') {
    return (
      <p className="flex items-center justify-center gap-2 text-sm font-semibold text-success">
        <CheckCircle2 size={18} /> You're on the list — we'll email you the invite the day it opens.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex max-w-md flex-col gap-3 sm:flex-row">
      <input
        ref={inputRef}
        type="email"
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          if (state === 'error') setState('idle');
        }}
        placeholder="you@company.com"
        aria-label="Email address"
        className={`focus-ring w-full rounded-xl border bg-bg-secondary px-4 py-3 text-sm text-text-primary placeholder:text-text-secondary/60 ${
          state === 'error' ? 'border-danger/60' : 'border-border'
        }`}
      />
      <Button type="submit" variant="primary" size="md" disabled={state === 'loading'}>
        {state === 'loading' ? 'Sending…' : 'Notify me'}
      </Button>
    </form>
  );
}

function SEO() {
  useSEO({
    title: 'Community — Vireek',
    description:
      'Join other home service business owners running Vireek to trade setup tips, dispatch workflows, and what actually works.',
    canonical: 'https://vireek.com/community',
  });
  return null;
}

export function CommunityPage() {
  return (
    <>
      <SEO />
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
              <p className={eyebrowClass()}>Community</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Home Service Owners, Learning From Each Other
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                A free space for Vireek customers to compare notes on dispatch, call scripts,
                and everything else that goes into running a service business — not just a
                support channel.
              </p>
            </motion.div>
          </div>
        </section>

        {/* Benefits */}
        <section className="px-6 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <motion.div
              variants={staggerContainer}
              initial="initial"
              whileInView="whileInView"
              viewport={viewport}
              className="grid gap-6 sm:grid-cols-3"
            >
              {BENEFITS.map((b) => (
                <motion.div key={b.title} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                  <Card className="flex h-full flex-col">
                    <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent">
                      <b.icon size={20} />
                    </span>
                    <h3 className="mt-5 text-lg font-semibold text-text-primary">{b.title}</h3>
                    <p className={`${bodyClass()} mt-3 flex-1 text-sm`}>{b.description}</p>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* Join */}
        <section className="px-6 pb-20 sm:pb-24">
          <div className="mx-auto max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              {COMMUNITY_INVITE_URL ? (
                <Card className="text-center">
                  <MessageCircle className="mx-auto h-10 w-10 text-accent" />
                  <h2 className={`${sectionHeadingClass()} mt-5`}>Join the {COMMUNITY_PLATFORM}</h2>
                  <p className={`${bodyClass()} mx-auto mt-3 max-w-md`}>
                    Free to join, moderated by the Vireek team. No sales pitches — just other
                    owners and real answers.
                  </p>
                  <div className="mt-8 flex justify-center">
                    <a href={COMMUNITY_INVITE_URL} target="_blank" rel="noopener noreferrer">
                      <Button variant="primary" size="lg">
                        Join on {COMMUNITY_PLATFORM} <ArrowRight size={18} />
                      </Button>
                    </a>
                  </div>
                </Card>
              ) : (
                <Card className="text-center">
                  <Mail className="mx-auto h-9 w-9 text-accent" />
                  <h2 className={`${sectionHeadingClass()} mt-5 text-2xl`}>
                    The community isn't open yet
                  </h2>
                  <p className={`${bodyClass()} mx-auto mt-3 max-w-md`}>
                    We'd rather launch this with real moderation and a founding group of owners
                    than open an empty server. Leave your email and we'll invite you personally
                    the day it's live.
                  </p>
                  <div className="mt-7">
                    <NotifySignup />
                  </div>
                </Card>
              )}
            </motion.div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

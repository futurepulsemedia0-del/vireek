import { motion } from 'framer-motion';
import { ArrowRight, ShieldCheck, Clock, Zap, PhoneCall } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, viewport } from '@/lib/motion';
import { SARAH_PHONE } from '@/lib/site';

const GUARANTEES = [
  { icon: Clock, label: 'Live in 15 minutes' },
  { icon: ShieldCheck, label: 'No credit card required' },
  { icon: Zap, label: 'Cancel anytime' },
];

/**
 * Rebuilt away from the "rounded gradient box with blurred orbs" pattern —
 * that shape is the single most reused SaaS closer on the web. Instead this
 * sits directly on the page background (so it doesn't compete with the
 * hero's own gradient mesh), leads with a real action — an actual phone
 * number to call, mirroring the hero's "call Sarah" moment — and separates
 * the two calls to action by intent instead of stacking two identical
 * buttons side by side.
 */
export function FinalCTA() {
  return (
    <section id="contact" className="relative overflow-hidden border-t border-border/70 bg-noise py-16 sm:py-24 md:py-28">
      {/* Same signature ambient wash as the Hero, mirrored — bookends the
          page with the one other moment it's allowed to feel a bit more
          alive, without reviving the "boxed gradient card" cliché. */}
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-60"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 55% 60% at 90% 110%, rgb(var(--accent-primary) / 0.14), transparent 60%), radial-gradient(ellipse 50% 45% at 5% -10%, rgb(var(--accent-secondary) / 0.10), transparent 58%)',
        }}
        aria-hidden="true"
      />
      <div className="mx-auto max-w-5xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, ease: EASE }}
          className="text-center"
        >
          <h2 className="mx-auto max-w-2xl font-display text-3xl font-semibold leading-[1.1] tracking-tightest text-text-primary sm:text-5xl">
            Stop losing jobs to voicemail.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-text-secondary sm:text-lg">
            Every call Sarah answers is a customer who reached a real voice instead of a beep.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, delay: 0.1, ease: EASE }}
          className="mx-auto mt-10 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2"
        >
          <Link
            to="/signup"
            className="group flex flex-col justify-between rounded-2xl border border-accent bg-accent p-6 text-left shadow-glow-accent transition-transform duration-200 hover:-translate-y-0.5"
          >
            <div>
              <p className="text-sm font-medium text-white/75">Get started</p>
              <p className="mt-1 text-xl font-semibold text-white">Start your free trial</p>
              <p className="mt-1.5 text-sm text-white/75">14 days · no card · cancel anytime</p>
            </div>
            <span className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-white">
              Create account
              <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-1" />
            </span>
          </Link>

          <a
            href={SARAH_PHONE}
            className="group flex flex-col justify-between rounded-2xl border border-border bg-bg-secondary p-6 text-left shadow-card transition-transform duration-200 hover:-translate-y-0.5 dark:shadow-card-dark"
          >
            <div>
              <p className="text-sm font-medium text-text-secondary">Hear it first</p>
              <p className="mt-1 text-xl font-semibold text-text-primary">Call Sarah right now</p>
              <p className="mt-1.5 text-sm text-text-secondary">A real, live call — no signup needed</p>
            </div>
            <span className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-accent">
              <PhoneCall size={16} />
              {SARAH_PHONE.replace('tel:', '')}
            </span>
          </a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2"
        >
          {GUARANTEES.map(({ icon: Icon, label }) => (
            <span key={label} className="flex items-center gap-1.5 text-sm font-medium text-text-secondary">
              <Icon size={14} className="shrink-0 text-accent" />
              {label}
            </span>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, CalendarPlus, CheckCircle2, PhoneCall } from 'lucide-react';
import { hasAnalyticsConsent, onAnalyticsConsent, trackEvent } from '@/lib/analytics';
import { buildDemoBookingIcs } from '@/lib/enterpriseDemoBooking';
import { EASE } from '@/lib/motion';
import { SARAH_PHONE } from '@/lib/site';
import { safeSessionStorage, sendConversionOnce, type ConversionSource } from '@/lib/thankYou';

interface Copy {
  heading: string;
  subheading: string;
  steps: { title: string; body: string }[];
}

const COPY: Record<ConversionSource | 'generic', Copy> = {
  signup: {
    heading: 'Thanks — we’ve got your details',
    subheading: 'A Vireek specialist will reach out within 24 hours to get your free trial set up.',
    steps: [
      { title: 'Watch for our call or text', body: 'We’ll contact you at the number you gave us, around the time you told us works best.' },
      { title: 'Have a few basics ready', body: 'Your business hours, the services you offer, and the number you want calls forwarded from.' },
      { title: 'Hear it for yourself', body: 'Call Sarah, our AI receptionist, and hear how she would answer your customers.' },
    ],
  },
  demo: {
    heading: 'You’re booked!',
    subheading: 'Your live demo is confirmed.',
    steps: [
      { title: 'Add it to your calendar', body: 'So the time doesn’t slip by — it takes one click.' },
      { title: 'Think about your busiest hours', body: 'We’ll tailor the walkthrough to your trade and call volume.' },
      { title: 'Hear it for yourself', body: 'Call Sarah, our AI receptionist, any time before the demo.' },
    ],
  },
  generic: {
    heading: 'Thank you',
    subheading: 'Your request has been received.',
    steps: [],
  },
};

const PRIMARY_CLASS =
  'focus-ring inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-base font-semibold text-white shadow-sm transition-all hover:brightness-110 active:scale-[0.97]';
const SECONDARY_CLASS =
  'focus-ring inline-flex min-h-[48px] items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary px-5 py-3 text-base font-semibold text-text-primary transition-all hover:border-accent/40 hover:bg-bg-tertiary active:scale-[0.97]';

const demoTimeFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

interface Props {
  source: ConversionSource | null;
  demoStart: Date | null;
}

export function ThankYouContent({ source, demoStart }: Props) {
  const copy = COPY[source ?? 'generic'];
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hasDemoTime = source === 'demo' && demoStart !== null;
  // Without a known time the "add to calendar" step has nothing to add.
  const steps = source === 'demo' && !hasDemoTime ? copy.steps.slice(1) : copy.steps;

  // After the redirect, move focus to the heading so screen-reader users hear the confirmation.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Conversion tracking: once per session, and only for a recognised source.
  useEffect(() => {
    if (!source) return;
    return sendConversionOnce(source, demoStart, {
      track: trackEvent,
      hasConsent: hasAnalyticsConsent,
      onConsent: onAnalyticsConsent,
      storage: safeSessionStorage(),
    });
  }, [source, demoStart]);

  const downloadIcs = () => {
    if (!demoStart) return;
    const blob = buildDemoBookingIcs({
      start: demoStart,
      end: new Date(demoStart.getTime() + 30 * 60_000),
      title: 'Vireek Enterprise Demo',
      description: 'Live walkthrough of Vireek.',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vireek-enterprise-demo.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="relative bg-gradient-mesh bg-noise px-6 py-16 sm:py-24">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE }}
        className="mx-auto max-w-2xl text-center"
      >
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckCircle2 size={36} aria-hidden="true" />
        </span>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="mt-6 text-balance text-3xl font-extrabold tracking-tight text-text-primary outline-none sm:text-4xl"
        >
          {copy.heading}
        </h1>
        <p className="mt-4 text-lg leading-8 text-text-secondary">{copy.subheading}</p>
        {hasDemoTime && demoStart && (
          <p className="mt-3 text-base font-semibold text-text-primary">{demoTimeFormatter.format(demoStart)}</p>
        )}

        {steps.length > 0 && (
          <ol className="mt-10 space-y-4 text-left">
            {steps.map((step, i) => (
              <li
                key={step.title}
                className="flex gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-sm font-bold text-accent">
                  {i + 1}
                </span>
                <div>
                  <h2 className="text-base font-semibold text-text-primary">{step.title}</h2>
                  <p className="mt-1 text-sm leading-relaxed text-text-secondary">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        )}

        <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          {hasDemoTime && (
            <button type="button" onClick={downloadIcs} className={PRIMARY_CLASS}>
              <CalendarPlus size={18} aria-hidden="true" /> Add to calendar
            </button>
          )}
          {source !== null ? (
            <>
              <a href={SARAH_PHONE} className={hasDemoTime ? SECONDARY_CLASS : PRIMARY_CLASS}>
                <PhoneCall size={18} aria-hidden="true" /> Call Sarah now
              </a>
              <Link to="/features" className={SECONDARY_CLASS}>
                Explore features <ArrowRight size={18} aria-hidden="true" />
              </Link>
            </>
          ) : (
            <Link to="/" className={PRIMARY_CLASS}>
              Back to home
            </Link>
          )}
        </div>
      </motion.div>
    </section>
  );
}

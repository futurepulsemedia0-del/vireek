import { motion } from 'framer-motion';
import {
  PhoneIncoming,
  ScanSearch,
  Siren,
  CalendarCheck,
  BellRing,
  DatabaseZap,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { EASE, viewport } from '@/lib/motion';

/**
 * Live AI Activity Stream
 * ------------------------------------------------------------------
 * A flagship, always-on product-visualization strip that makes Vireek's
 * core promise tangible right after the hero: a real AI system is
 * actively answering calls, triaging emergencies, booking jobs, and
 * syncing data — right now, for real businesses.
 *
 * Each "event" below is one caller's journey through the six-stage
 * pipeline. Multiple events flow in a calm, seamless right-to-left
 * marquee, separated by a hairline divider. The marquee is built from
 * two identical copies of the same track so translating -50% loops
 * perfectly (see the `marquee` keyframes in tailwind.config.js).
 */

type StageTone = 'accent' | 'cta' | 'danger' | 'success' | 'neutral';

interface Stage {
  icon: LucideIcon;
  tone: StageTone;
  label: string;
  detail: string;
}

interface ActivityEvent {
  id: string;
  stages: Stage[];
}

const TONE_STYLES: Record<StageTone, string> = {
  accent: 'bg-accent/10 text-accent',
  cta: 'bg-cta/10 text-cta',
  danger: 'bg-danger/10 text-danger',
  success: 'bg-success/10 text-success',
  neutral: 'bg-text-secondary/10 text-text-secondary',
};

function buildEvent(
  id: string,
  detail: [call: string, understood: string, emergency: string, booked: string, notified: string, synced: string]
): ActivityEvent {
  return {
    id,
    stages: [
      { icon: PhoneIncoming, tone: 'accent', label: 'Call Answered', detail: detail[0] },
      { icon: ScanSearch, tone: 'cta', label: 'Customer Understood', detail: detail[1] },
      { icon: Siren, tone: 'danger', label: 'Emergency Prioritized', detail: detail[2] },
      { icon: CalendarCheck, tone: 'success', label: 'Job Booked', detail: detail[3] },
      { icon: BellRing, tone: 'accent', label: 'Customer Notified', detail: detail[4] },
      { icon: DatabaseZap, tone: 'neutral', label: 'CRM Synced', detail: detail[5] },
    ],
  };
}

const EVENTS: ActivityEvent[] = [
  buildEvent('plumbing', [
    'Ramirez Plumbing',
    'Burst pipe, hallway ceiling',
    'Dispatch within 30 min',
    'Today, 2:30 PM',
    'Arrival text sent',
    'Google Calendar updated',
  ]),
  buildEvent('electrical', [
    'Volt Electric',
    'Sparking outlet near kids',
    'Moved to top of queue',
    'Technician at 4:00 PM',
    'Confirmation call placed',
    'Synced to HubSpot',
  ]),
  buildEvent('hvac', [
    'Apex Heating & Air',
    'No heat, overnight low 12°F',
    'Same-day dispatch flagged',
    '6:00 PM appointment set',
    'SMS + email confirmation',
    'Synced via Zapier',
  ]),
  buildEvent('locksmith', [
    'SafeKey Locksmith',
    'Lockout, elderly resident inside',
    'Immediate dispatch flagged',
    'ETA 25 minutes confirmed',
    'Live tracking link sent',
    'Webhook fired to dispatch',
  ]),
];

function StagePill({ stage }: { stage: Stage }) {
  const Icon = stage.icon;
  return (
    <div className="flex shrink-0 items-center gap-3 whitespace-nowrap rounded-2xl border border-border/70 bg-bg-secondary/90 px-4 py-3 shadow-sm backdrop-blur-sm dark:bg-bg-secondary/80">
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${TONE_STYLES[stage.tone]}`}
      >
        <Icon size={17} strokeWidth={2.25} aria-hidden="true" />
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-secondary/70">
          {stage.label}
        </span>
        <span className="text-[13px] font-semibold text-text-primary">{stage.detail}</span>
      </span>
    </div>
  );
}

function MarqueeTrack() {
  return (
    <div className="flex shrink-0 items-stretch gap-3 pr-3">
      {EVENTS.map((event, eventIndex) => (
        <div key={event.id} className="flex items-stretch gap-3">
          {event.stages.map((stage, stageIndex) => (
            <div key={stage.label} className="flex items-center gap-3">
              <StagePill stage={stage} />
              {stageIndex < event.stages.length - 1 && (
                <ChevronRight
                  size={15}
                  strokeWidth={2.5}
                  className="shrink-0 text-text-secondary/25"
                  aria-hidden="true"
                />
              )}
            </div>
          ))}
          {eventIndex < EVENTS.length - 1 && (
            <span className="mx-1 my-2 w-px shrink-0 bg-border/70" aria-hidden="true" />
          )}
        </div>
      ))}
    </div>
  );
}

export function LiveActivityStream() {
  return (
    <section
      id="live-activity"
      aria-label="Live AI activity stream"
      className="relative overflow-hidden border-y border-border/60 bg-bg-secondary/60 bg-noise py-12 sm:py-16 md:py-20"
    >
      {/* Ambient brand glow — echoes the hero's mesh without repeating it */}
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-70"
        style={{
          backgroundImage:
            'radial-gradient(circle at 10% 50%, rgb(var(--accent-primary) / 0.08), transparent 55%), radial-gradient(circle at 90% 50%, rgb(var(--accent-secondary) / 0.07), transparent 55%)',
        }}
      />

      <div className="mx-auto max-w-2xl px-5 text-center sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <div className="mx-auto flex w-fit items-center gap-2 rounded-full border border-success/25 bg-success/10 px-3 py-1">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75 motion-reduce:hidden" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            <span className="text-xs font-semibold uppercase tracking-[0.1em] text-success">Live</span>
          </div>

          <h2 className="mt-4 text-2xl font-bold leading-[1.2] tracking-tight text-text-primary sm:text-3xl md:text-5xl">
            This Is Vireek, Working Right Now
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-text-secondary sm:mt-4 sm:text-base md:text-lg">
            Every call flows through the same six steps — instantly, and without you lifting a
            finger.
          </p>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={viewport}
        transition={{ duration: 0.6, delay: 0.1, ease: EASE }}
        className="relative mt-10 w-full overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)] sm:mt-12"
        aria-hidden="true"
      >
        <div className="flex w-max gap-3 py-1 motion-safe:animate-marquee hover:[animation-play-state:paused]">
          <MarqueeTrack />
          <MarqueeTrack />
        </div>
      </motion.div>

      {/* Accessible, non-decorative summary of what the marquee illustrates */}
      <p className="sr-only">
        Every call is answered instantly, the customer&rsquo;s issue is understood, emergencies
        are automatically prioritized, the job is booked on your calendar, the customer receives
        a confirmation, and the details sync to your CRM — automatically, for every call.
      </p>

      <p className="mt-6 text-center text-xs font-medium uppercase tracking-[0.12em] text-text-secondary/60 sm:mt-8 sm:tracking-[0.14em]">
        Six steps. Zero missed calls. Every time.
      </p>
    </section>
  );
}

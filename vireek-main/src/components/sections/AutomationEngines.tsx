import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PhoneIncoming,
  Brain,
  UserPlus,
  CalendarCheck,
  MessageCircleHeart,
  Wallet,
  ShieldAlert,
  Radar,
  Boxes,
  Sparkles,
  type LucideIcon,
  Camera,
  MonitorSmartphone,
  Wrench,
  DollarSign,
  Route as RouteIcon,
  PackageSearch,
  Inbox,
  CloudLightning,
  Mic,
  Landmark,
  ArrowRight,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';

type Engine = {
  icon: LucideIcon;
  title: string;
  body: string;
};

type Category = {
  key: string;
  label: string;
  tagline: string;
  icon: LucideIcon;
  engines: Engine[];
};

const CATEGORIES: Category[] = [
  {
    key: 'intelligence',
    label: 'Call & Lead Intelligence',
    tagline: 'Every call answered, understood, and scored automatically.',
    icon: Brain,
    engines: [
      { icon: PhoneIncoming, title: 'Call Ingestion Engine', body: 'Sarah answers, validates the request, filters spam, and logs every call the instant it comes in.' },
      { icon: Brain, title: 'AI Intelligence Engine', body: 'GPT-4o-mini summarizes the call, detects intent, scores sentiment, and rates the lead 1–10.' },
      { icon: UserPlus, title: 'Lead Engine', body: 'Deduplicates callers, builds a customer profile, and enriches it automatically — no manual data entry.' },
      { icon: ShieldAlert, title: 'Sentiment Alert', body: 'A score below -0.5 fires an instant SMS to the owner so an upset customer never slips through.' },
      { icon: Radar, title: 'Call QA Auto-Scoring', body: 'Daily random calls are graded on professionalism, empathy, and accuracy — with a weekly report.' },
      { icon: Mic, title: 'AI Call Coaching', body: 'Every Sunday, 10 calls are analyzed and turned into 3 coaching tips fed straight back into Sarah.' },
    ],
  },
  {
    key: 'booking',
    label: 'Booking & Scheduling',
    tagline: 'From "hello" to a confirmed slot on the calendar — hands-free.',
    icon: CalendarCheck,
    engines: [
      { icon: CalendarCheck, title: 'Appointment Engine', body: 'Checks live availability, books the slot, syncs Google Calendar, and texts a confirmation.' },
      { icon: MessageCircleHeart, title: 'Follow-Up Engine', body: 'Quotes that go quiet for 3 days get an automatic, friendly nudge by email and SMS.' },
      { icon: RouteIcon, title: 'Dynamic Dispatch & Routing', body: 'Matches the right technician by skill, truck stock, and live GPS — then auto-assigns the closest fit.' },
      { icon: MessageCircleHeart, title: 'Reschedule Handler', body: 'Customer texts "reschedule," Sarah offers 3 new slots, and the booking updates itself.' },
      { icon: CalendarCheck, title: 'Appointment Reminder', body: '24-hour and 1-hour heads-up texts, including a live "your tech is en route" update.' },
      { icon: CloudLightning, title: 'Weather-Triggered Campaigns', body: 'A cold snap or heatwave in the forecast auto-targets aging equipment owners with a timely offer.' },
    ],
  },
  {
    key: 'growth',
    label: 'Growth & Retention',
    tagline: 'Turns finished jobs into repeat revenue and 5-star reviews.',
    icon: Sparkles,
    engines: [
      { icon: PhoneIncoming, title: 'Abandoned Call Recovery', body: 'A missed call gets a "sorry we missed you" text 15 minutes later, with an incentive to book today.' },
      { icon: Sparkles, title: 'Review Generation Engine', body: 'Two hours after job completion, a review link goes out automatically — with click tracking.' },
      { icon: MessageCircleHeart, title: 'Cold Lead Re-engagement', body: 'Quotes stuck for 3+ days get a daily-checked, automatic re-engagement text.' },
      { icon: Wrench, title: 'Equipment Asset Lifecycle', body: 'Tracks every unit\u2019s age and predicts maintenance 90 days out, with automatic upsell texts.' },
      { icon: DollarSign, title: 'Embedded Customer Financing', body: 'Estimates over $1,000 trigger an instant "pay monthly instead" offer with e-sign and approval.' },
      { icon: Inbox, title: 'Multi-Channel Unified Inbox', body: 'Facebook, Angi, Thumbtack, and Google chat all land in one thread — Sarah answers everywhere.' },
    ],
  },
  {
    key: 'operations',
    label: 'Operations & Field Tools',
    tagline: 'What keeps the business running behind the scenes.',
    icon: Boxes,
    engines: [
      { icon: DollarSign, title: 'Real-Time Job Profitability', body: 'Labor, parts, and drive time are compared to the invoice the moment a job closes — margin included.' },
      { icon: PackageSearch, title: 'Parts & Truck Stock Intelligence', body: 'Checks truck inventory before dispatch and auto-orders missing parts from the supplier.' },
      { icon: Boxes, title: 'Multi-Location Engine', body: 'Every new location gets its own workspace, technician roster, routing, and isolated analytics.' },
      { icon: Landmark, title: 'External CRM Sync', body: 'Bidirectional sync with HubSpot, Salesforce, and Zoho with automatic conflict resolution.' },
      { icon: Inbox, title: 'Notification Router', body: 'Picks the right channel — SMS, email, or push — and personalizes every message it sends.' },
      { icon: Brain, title: 'Knowledge Base Sync', body: 'Any update to your business info is embedded and pushed straight into Sarah\u2019s live prompt.' },
    ],
  },
  {
    key: 'trust',
    label: 'Billing, Security & Compliance',
    tagline: 'The unglamorous plumbing that keeps you audit-ready.',
    icon: ShieldAlert,
    engines: [
      { icon: Wallet, title: 'Billing & Subscription Engine', body: 'Stripe events sync plan status, usage meters, and invoices to Supabase in real time.' },
      { icon: ShieldAlert, title: 'Error Handler & Dead Letter Queue', body: 'Failed workflows retry three times with backoff, then alert the team on Slack and email.' },
      { icon: Radar, title: 'Usage Alert & Overage Guard', body: 'Warns at 80%, throttles or upgrades at 100%, and hard-stops at 120% of plan limits.' },
      { icon: Landmark, title: 'Invoice Reconciliation', body: 'Every month, Stripe invoices are matched against usage automatically, flagging any mismatch.' },
      { icon: ShieldAlert, title: 'Security & Audit Engine', body: 'Every execution passes an RLS check, a PII scan, and anomaly detection with instant alerts.' },
      { icon: ShieldAlert, title: 'TCPA Opt-Out Handler', body: 'A single "STOP" text is verified, logged, and blocks all future messages — compliance built in.' },
      { icon: Landmark, title: 'Data Retention & GDPR Engine', body: 'Nightly job anonymizes records at 2 years and deletes at 7, with a compliance certificate.' },
      { icon: Radar, title: 'Webhook Health Monitor', body: 'Pings Vapi, Twilio, and Stripe every 5 minutes and alerts the moment something goes down.' },
    ],
  },
];

const EXCLUSIVES: Engine[] = [
  { icon: Camera, title: 'Visual AI Estimating', body: 'A photo of a burst pipe becomes a priced, line-item estimate in seconds — no site visit required.' },
  { icon: MonitorSmartphone, title: 'Instant Self-Service Quotes', body: 'A 9 PM website visitor gets a price range from 3 questions and books with a $49 deposit — no call.' },
  { icon: Wrench, title: 'Equipment Lifecycle Intelligence', body: 'AI-first predictive maintenance that flags aging units before they fail, automatically.' },
  { icon: DollarSign, title: 'Real-Time Job Profitability', body: 'Live margin on every job — not a monthly report, a number the moment the invoice closes.' },
  { icon: RouteIcon, title: 'Skill + Stock-Aware Dispatch', body: 'Routes jobs by technician skill, live GPS, and truck inventory — not just "who\u2019s free."' },
  { icon: PackageSearch, title: 'Truck Stock Intelligence', body: 'Confirms the part is on the truck before dispatch, and auto-orders it when it isn\u2019t.' },
  { icon: Inbox, title: 'True Omnichannel Inbox', body: 'One AI, one thread, across phone, SMS, Facebook, Angi, Thumbtack, and web chat.' },
  { icon: CloudLightning, title: 'Weather-Triggered Campaigns', body: 'A 15\u00b0F forecast swing quietly turns into a targeted, revenue-tracked campaign overnight.' },
  { icon: Mic, title: 'Hands-Free Field Voice Agent', body: 'Technicians update jobs, log parts, and get directions by voice — gloves stay on.' },
  { icon: DollarSign, title: 'Embedded Financing', body: 'Big-ticket estimates get instant "pay monthly" financing built into the quote itself.' },
];

export function AutomationEngines() {
  const [activeKey, setActiveKey] = useState(CATEGORIES[0].key);
  const active = CATEGORIES.find((c) => c.key === activeKey) ?? CATEGORIES[0];

  return (
    <section id="platform" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>The Platform</p>
          <h2 className={sectionHeadingClass()}>31 Engines Running Quietly Behind Every Call</h2>
          <p className="mt-5 text-base leading-relaxed text-text-secondary md:text-lg">
            This isn&rsquo;t one chatbot bolted onto a phone line. It&rsquo;s a full automation stack — intake,
            intelligence, booking, growth, operations, and compliance — working together so nothing falls through
            the cracks.
          </p>
        </motion.div>

        {/* Category tabs */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
          className="mt-10 flex flex-wrap gap-2"
        >
          {CATEGORIES.map((cat) => {
            const isActive = cat.key === activeKey;
            return (
              <button
                key={cat.key}
                onClick={() => setActiveKey(cat.key)}
                className={`focus-ring flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? 'border-accent/30 bg-accent/10 text-accent shadow-sm'
                    : 'border-border/80 bg-bg-secondary text-text-secondary hover:border-accent/20 hover:text-text-primary'
                }`}
              >
                <cat.icon size={16} />
                {cat.label}
              </button>
            );
          })}
        </motion.div>

        <p className="mt-4 text-sm text-text-secondary">{active.tagline}</p>

        {/* Engine grid */}
        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence mode="wait">
            {active.engines.map((engine, i) => (
              <motion.div
                key={active.key + engine.title}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.35, ease: EASE, delay: i * 0.04 }}
                className="rounded-2xl border border-border/80 bg-bg-secondary p-6 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:bg-bg-secondary/95 dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <engine.icon size={19} />
                </span>
                <h3 className="mt-4 text-base font-semibold text-text-primary">{engine.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-text-secondary">{engine.body}</p>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* Exclusive / industry-first strip */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mt-20 rounded-3xl border border-cta/20 bg-gradient-mesh bg-noise p-8 md:p-12"
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-cta/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-cta">
                <Sparkles size={13} />
                Nowhere else in the industry
              </span>
              <h3 className="mt-4 text-2xl font-bold text-text-primary md:text-3xl">
                Ten capabilities ServiceTitan, FieldEdge, and every voice-AI competitor don&rsquo;t have
              </h3>
              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-text-secondary md:text-base">
                Most competitors answer the phone and book a job. We go past the call: pricing from a photo,
                live job margins, financing at the point of quote, and a technician who never has to type.
              </p>
            </div>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {EXCLUSIVES.map((item) => (
              <div
                key={item.title}
                className="rounded-2xl border border-border/70 bg-bg-secondary/80 p-5 backdrop-blur-sm dark:bg-bg-secondary/60"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-cta/10 text-cta">
                  <item.icon size={17} />
                </span>
                <h4 className="mt-3 text-sm font-semibold text-text-primary">{item.title}</h4>
                <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{item.body}</p>
              </div>
            ))}
          </div>

          <a
            href="#pricing"
            className="focus-ring mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-cta hover:gap-2.5 transition-all"
          >
            See it running on your business
            <ArrowRight size={16} />
          </a>
        </motion.div>
      </div>
    </section>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import {
  ChevronDown,
  Bot,
  Mail,
  Mic,
  Clock,
  UserCheck,
  ShieldCheck,
  Scale,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, viewport } from '@/lib/motion';

const CONTACT_EMAIL = 'ali@vireek.com';

interface Section {
  id: string;
  number: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'overview', number: '1', title: 'Overview' },
  { id: 'at-a-glance', number: '2', title: 'At a Glance' },
  { id: 'ai-disclosure', number: '3', title: 'How We Disclose AI on Calls' },
  { id: 'what-we-record', number: '4', title: 'What We Record and Process' },
  { id: 'consent-and-notices', number: '5', title: 'Consent and Recording Notices' },
  { id: 'retention', number: '6', title: 'Retention and Deletion' },
  { id: 'access-and-sharing', number: '7', title: 'Who Can Access Recordings' },
  { id: 'outbound-calls', number: '8', title: 'Outbound AI Calls' },
  { id: 'your-choices', number: '9', title: 'Your Choices and Rights' },
  { id: 'changes-to-policy', number: '10', title: 'Changes to This Policy' },
  { id: 'contact-us', number: '11', title: 'Contact Us' },
];

const LINK_CLASS = 'font-semibold text-accent hover:underline';

const FACTS: { icon: typeof Bot; title: string; body: string }[] = [
  {
    icon: Bot,
    title: 'Disclosed up front',
    body: 'The AI identifies itself as an automated assistant at the start of the call.',
  },
  {
    icon: Mic,
    title: 'Recorded and transcribed',
    body: 'Calls may be recorded, transcribed, and summarized to run the service.',
  },
  {
    icon: Clock,
    title: 'Kept for 12 months',
    body: 'Recordings and transcripts are then deleted or anonymized.',
  },
  {
    icon: UserCheck,
    title: 'A human on request',
    body: 'Callers can ask for a person at any point in the conversation.',
  },
];

function CalloutCard({ icon: Icon, children }: { icon: typeof ShieldCheck; children: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border-2 border-accent/40 bg-accent/[0.04] p-6 md:p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle at 0% 0%, rgb(var(--accent-primary) / 0.10), transparent 50%)',
        }}
      />
      <div className="relative">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <Icon size={20} />
          </span>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-accent">
            Our Commitment
          </p>
        </div>
        {children}
      </div>
    </div>
  );
}

function SectionHeading({ id, number, title }: { id: string; number: string; title: string }) {
  return (
    <div className="mt-14 first:mt-0">
      <a href={`#${id}`} className="group block scroll-mt-24" id={id}>
        <h2 className="flex items-baseline gap-3 text-2xl font-bold tracking-tight text-text-primary md:text-3xl">
          <span className="text-accent">{number}.</span>
          {title}
          <span className="ml-1 text-base font-normal text-text-secondary/0 transition-colors group-hover:text-text-secondary/60">
            #
          </span>
        </h2>
      </a>
    </div>
  );
}

function SectionBody({ children }: { children: ReactNode }) {
  return <div className="mt-4 space-y-4 text-base leading-relaxed text-text-secondary">{children}</div>;
}

export function AiDisclosureContent() {
  const [activeId, setActiveId] = useState<string>('overview');
  const [mobileTocOpen, setMobileTocOpen] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-96px 0px -72% 0px' }
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <section className="py-28 md:py-32">
      <div className="mx-auto max-w-7xl px-6">
        <div className="grid gap-12 lg:grid-cols-[16rem_1fr] lg:gap-16">
          <aside className="hidden lg:block">
            <div className="sticky top-28">
              <p className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">
                Table of Contents
              </p>
              <nav aria-label="Table of contents" className="flex flex-col gap-1 border-l border-border">
                {SECTIONS.map((s) => (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
                    aria-current={activeId === s.id ? 'true' : undefined}
                    className={`-ml-px border-l-2 py-1.5 pl-4 text-sm transition-colors ${
                      activeId === s.id
                        ? 'border-accent font-medium text-accent'
                        : 'border-transparent text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    <span className="mr-1.5 text-text-secondary/50">{s.number}.</span>
                    {s.title}
                  </a>
                ))}
              </nav>
            </div>
          </aside>

          <div className="min-w-0 max-w-3xl">
            <div className="mb-8 lg:hidden">
              <button
                type="button"
                aria-expanded={mobileTocOpen}
                aria-controls="ai-disclosure-mobile-toc"
                onClick={() => setMobileTocOpen((v) => !v)}
                className="focus-ring flex w-full items-center justify-between rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm font-medium text-text-primary"
              >
                Jump to section
                <ChevronDown
                  size={18}
                  className={`text-text-secondary transition-transform ${mobileTocOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {mobileTocOpen && (
                <nav
                  id="ai-disclosure-mobile-toc"
                  aria-label="Table of contents"
                  className="mt-2 flex flex-col gap-1 rounded-xl border border-border bg-bg-secondary p-3"
                >
                  {SECTIONS.map((s) => (
                    <a
                      key={s.id}
                      href={`#${s.id}`}
                      onClick={() => setMobileTocOpen(false)}
                      className={`rounded-lg px-3 py-2 text-sm transition-colors ${
                        activeId === s.id
                          ? 'bg-accent/10 font-medium text-accent'
                          : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                      }`}
                    >
                      <span className="mr-1.5 text-text-secondary/50">{s.number}.</span>
                      {s.title}
                    </a>
                  ))}
                </nav>
              )}
            </div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <p className="text-eyebrow font-semibold uppercase text-accent">Legal</p>
              <h1 className="mt-3 text-4xl font-bold leading-[1.15] tracking-tight text-text-primary md:text-5xl">
                AI Call Disclosure &amp; Recording Policy
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: October 8, 2026</p>
            </motion.div>

            <SectionHeading id="overview" number="1" title="Overview" />
            <SectionBody>
              <p>
                Vireek's AI voice receptionist, Sarah, answers and places phone calls on behalf
                of home-service businesses. This page explains, in plain language, how callers
                are told they are speaking with an AI, what is recorded and processed during a
                call, how long it is kept, and what choices callers and businesses have.
              </p>
              <p>
                It supplements our{' '}
                <Link to="/responsible-ai" className={LINK_CLASS}>
                  Responsible AI Policy
                </Link>
                ,{' '}
                <Link to="/privacy" className={LINK_CLASS}>
                  Privacy Policy
                </Link>
                , and{' '}
                <Link to="/terms" className={LINK_CLASS}>
                  Terms of Service
                </Link>
                . If anything here conflicts with a signed agreement with Vireek, that agreement
                controls.
              </p>
            </SectionBody>

            <SectionHeading id="at-a-glance" number="2" title="At a Glance" />
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              {FACTS.map(({ icon: Icon, title, body }) => (
                <div
                  key={title}
                  className="rounded-2xl border border-border bg-bg-secondary p-5"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
                    <Icon size={20} aria-hidden="true" />
                  </span>
                  <p className="mt-4 text-base font-semibold text-text-primary">{title}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{body}</p>
                </div>
              ))}
            </div>

            <SectionHeading id="ai-disclosure" number="3" title="How We Disclose AI on Calls" />
            <div className="mt-5">
              <CalloutCard icon={Bot}>
                <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                  <p>
                    <strong className="text-text-primary">
                      Callers are never led to believe they are speaking with a human.
                    </strong>{' '}
                    Vireek's voice agent identifies itself as an automated AI assistant at the
                    start of the interaction.
                  </p>
                  <p>
                    Businesses cannot configure Sarah to claim to be a person, to use a human
                    name as a substitute for disclosure, or to deny being an AI when asked
                    sincerely.
                  </p>
                </div>
              </CalloutCard>
            </div>
            <SectionBody>
              <p>
                At any point in a call, a caller can ask whether they are speaking with an AI or
                ask to be connected to a person. The AI answers honestly and follows the
                business's configured escalation path, as described in our{' '}
                <Link to="/responsible-ai#human-oversight" className={LINK_CLASS}>
                  Responsible AI Policy
                </Link>
                .
              </p>
            </SectionBody>

            <SectionHeading id="what-we-record" number="4" title="What We Record and Process" />
            <SectionBody>
              <p>
                To answer, qualify, route, and book calls, Vireek may capture and process the
                following during a call:
              </p>
              <ul className="ml-1 space-y-1.5">
                <li>• Call audio, including the caller's voice and the AI's responses</li>
                <li>• Speech-to-text transcripts and AI-generated call summaries</li>
                <li>• Caller phone number, call time, duration, and routing outcome</li>
                <li>• Details the caller provides, such as name, address, and the service needed</li>
                <li>• Call-quality and sentiment signals used for coaching and quality review</li>
              </ul>
              <p>
                We use this information to provide the service to the business that received the
                call, to support quality review and troubleshooting, and to resolve disputes. We
                do not use customer call recordings or transcripts to train general-purpose AI
                models shared across customers or made available to the public.
              </p>
            </SectionBody>

            <SectionHeading id="consent-and-notices" number="5" title="Consent and Recording Notices" />
            <SectionBody>
              <p>
                Laws on recording calls vary by country and, in the United States, by state.
                Some jurisdictions require the consent of every party to a call (often called
                all-party or two-party consent), and some require specific notices when a call is
                handled by automated technology.
              </p>
              <ul className="ml-1 space-y-2">
                <li>
                  • <strong className="text-text-primary">Vireek's role.</strong> We provide
                  configurable greetings and notices so that callers are told when a call may be
                  recorded and handled by an automated AI system.
                </li>
                <li>
                  • <strong className="text-text-primary">Business customers' responsibility.</strong>{' '}
                  Each business remains responsible for complying with the call-recording,
                  consent, and notice laws that apply where it and its callers are located,
                  including in all-party consent jurisdictions such as California, and for
                  keeping its notices enabled and accurate.
                </li>
                <li>
                  • <strong className="text-text-primary">Callers' ability to object.</strong>{' '}
                  A caller who does not want to be recorded can say so during the call, and the
                  business's configured process for handling that request applies.
                </li>
              </ul>
            </SectionBody>

            <SectionHeading id="retention" number="6" title="Retention and Deletion" />
            <SectionBody>
              <p>
                Call recordings and transcripts are retained for{' '}
                <strong className="text-text-primary">12 months</strong> to support quality
                review, troubleshooting, and dispute resolution. After that period they are
                deleted or anonymized.
              </p>
              <p>
                A business can delete individual recordings and transcripts from its dashboard
                earlier, and can ask us to delete data when its account closes. We may retain
                limited records for longer where required by law or needed to establish, exercise,
                or defend legal claims. Full details are in our{' '}
                <Link to="/privacy#data-retention" className={LINK_CLASS}>
                  Privacy Policy
                </Link>
                .
              </p>
            </SectionBody>

            <SectionHeading id="access-and-sharing" number="7" title="Who Can Access Recordings" />
            <SectionBody>
              <ul className="ml-1 space-y-1.5">
                <li>• The business that received the call, and the team members it authorizes</li>
                <li>• Vireek personnel, only where needed to operate, secure, or support the service</li>
                <li>
                  • Sub-processors that provide speech, telephony, and AI infrastructure, under
                  contracts that restrict them from using call data to train their own models
                </li>
                <li>• Authorities or other parties only where required by law or valid legal process</li>
              </ul>
              <p>
                We do not sell call recordings or transcripts. Our current providers are listed on
                the{' '}
                <Link to="/subprocessors" className={LINK_CLASS}>
                  Sub-processor List
                </Link>
                , and our data-protection terms are in the{' '}
                <Link to="/dpa" className={LINK_CLASS}>
                  Data Processing Agreement
                </Link>
                .
              </p>
            </SectionBody>

            <SectionHeading id="outbound-calls" number="8" title="Outbound AI Calls" />
            <SectionBody>
              <p>
                When a business uses Vireek to place outbound calls, the same disclosure rules
                apply: the AI identifies itself as automated at the start of the call, and it
                honors requests to stop calling or to speak with a person.
              </p>
              <p>
                Businesses must have the legal basis and any required consent to contact each
                recipient, and must comply with applicable telemarketing, do-not-call, and
                automated-call laws, which in some countries treat AI-generated voices as
                artificial or pre-recorded voices. These obligations are also part of our{' '}
                <Link to="/acceptable-use-policy" className={LINK_CLASS}>
                  Acceptable Use Policy
                </Link>
                .
              </p>
            </SectionBody>

            <SectionHeading id="your-choices" number="9" title="Your Choices and Rights" />
            <SectionBody>
              <p>If you are a caller, you can:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Ask at any time whether you are speaking with an AI</li>
                <li>• Ask to be transferred to a person</li>
                <li>• Tell the business you do not want the call recorded</li>
                <li>• Ask the business, or Vireek, for access to or deletion of your call data, subject to applicable law</li>
                <li>• Ask the business to stop AI-driven outbound calls or messages to your number</li>
              </ul>
              <p>
                Depending on where you live, you may also have rights under laws such as the GDPR
                or the CCPA. See our{' '}
                <Link to="/ccpa" className={LINK_CLASS}>
                  CCPA Rights
                </Link>{' '}
                and{' '}
                <Link to="/gdpr-dpa" className={LINK_CLASS}>
                  GDPR Addendum
                </Link>{' '}
                pages. Because the business that took your call usually decides how your data is
                used, requests sent to Vireek may be passed to that business.
              </p>
            </SectionBody>

            <SectionHeading id="changes-to-policy" number="10" title="Changes to This Policy" />
            <SectionBody>
              <p>
                We may update this policy as our product and the law evolve. The date at the top
                shows the latest revision, and material changes will be communicated to active
                customers by email.
              </p>
            </SectionBody>

            <SectionHeading id="contact-us" number="11" title="Contact Us" />
            <SectionBody>
              <p>
                Questions about AI disclosure or call recording, or want to make a request or
                report a concern? Email us.
              </p>
              <div className="mt-2 flex items-center gap-3">
                <Mail size={18} className="text-accent" aria-hidden="true" />
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="break-all text-lg font-semibold text-accent hover:underline"
                >
                  {CONTACT_EMAIL}
                </a>
              </div>
            </SectionBody>

            <div className="mt-12 rounded-2xl border border-border bg-bg-secondary p-6 md:p-8">
              <p className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">
                <Scale size={16} aria-hidden="true" />
                Related
              </p>
              <div className="mt-3 flex flex-col gap-2">
                <Link to="/responsible-ai" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Responsible AI Policy &rarr;
                </Link>
                <Link to="/privacy" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Privacy Policy &rarr;
                </Link>
                <Link to="/acceptable-use-policy" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Acceptable Use Policy &rarr;
                </Link>
                <Link to="/trust" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Trust Center &rarr;
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Bot, Mail, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, viewport } from '@/lib/motion';

const CONTACT_EMAIL = 'ali@vireek.com';

interface Section {
  id: string;
  number: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'introduction', number: '1', title: 'Introduction' },
  { id: 'our-principles', number: '2', title: 'Our Responsible AI Principles' },
  { id: 'ai-disclosure', number: '3', title: 'AI Disclosure to Callers' },
  { id: 'how-we-use-ai', number: '4', title: 'How Vireek Uses AI' },
  { id: 'human-oversight', number: '5', title: 'Human Oversight & Escalation' },
  { id: 'data-used-by-ai', number: '6', title: 'Data Used By Our AI Systems' },
  { id: 'third-party-providers', number: '7', title: 'Third-Party AI Providers' },
  { id: 'limitations', number: '8', title: 'Known Limitations of AI Outputs' },
  { id: 'your-choices', number: '9', title: 'Your Choices & Opt-Out Rights' },
  { id: 'changes-to-policy', number: '10', title: 'Changes to This Policy' },
  { id: 'contact-us', number: '11', title: 'Contact Us' },
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

export function ResponsibleAiContent() {
  const [activeId, setActiveId] = useState<string>('introduction');
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
              <nav className="flex flex-col gap-1 border-l border-border">
                {SECTIONS.map((s) => (
                  <a
                    key={s.id}
                    href={`#${s.id}`}
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

          <div className="max-w-3xl">
            <div className="mb-8 lg:hidden">
              <button
                type="button"
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
                <nav className="mt-2 flex flex-col gap-1 rounded-xl border border-border bg-bg-secondary p-3">
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
                Responsible AI Policy
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: September 16, 2026</p>
            </motion.div>

            <SectionHeading id="introduction" number="1" title="Introduction" />
            <SectionBody>
              <p>
                Vireek builds AI voice receptionists that answer and place calls, book
                appointments, and help home-service businesses recover missed revenue. This
                Responsible AI Policy explains how we design, disclose, and govern the AI
                systems that power Vireek, and what rights you and your callers have around
                them. It applies alongside our{' '}
                <Link to="/terms" className="font-semibold text-accent hover:underline">
                  Terms of Service
                </Link>{' '}
                and{' '}
                <Link to="/privacy" className="font-semibold text-accent hover:underline">
                  Privacy Policy
                </Link>
                .
              </p>
            </SectionBody>

            <div className="mt-10">
              <SectionHeading id="our-principles" number="2" title="Our Responsible AI Principles" />
              <div className="mt-5">
                <CalloutCard icon={ShieldCheck}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>Every AI feature we ship is built around five principles:</p>
                    <ul className="ml-1 space-y-2">
                      <li>• <strong className="text-text-primary">Transparency</strong> — callers are told they are speaking with an AI, and customers can see what the AI did and why</li>
                      <li>• <strong className="text-text-primary">Human oversight</strong> — every conversation can be escalated to a person, and businesses control when that happens</li>
                      <li>• <strong className="text-text-primary">Data minimization</strong> — our AI only uses the business and call data needed to do its job</li>
                      <li>• <strong className="text-text-primary">Safety by design</strong> — the AI is scoped away from emergency dispatch, medical, legal, or financial advice</li>
                      <li>• <strong className="text-text-primary">Accountability</strong> — we test, monitor, and log AI behavior, and we take responsibility for fixing it when it falls short</li>
                    </ul>
                  </div>
                </CalloutCard>
              </div>
            </div>

            <SectionHeading id="ai-disclosure" number="3" title="AI Disclosure to Callers" />
            <SectionBody>
              <p>
                Where Vireek's voice agent answers or places a call on a customer's behalf, it
                identifies itself as an automated assistant at the start of the interaction,
                consistent with applicable law. Customers may not configure the AI to
                impersonate a human employee or to conceal that a call is AI-assisted.
              </p>
              <p>
                Any caller can ask to speak with a person at any point in the conversation, and
                the AI is required to honor that request by following the business's configured
                escalation path (see Section 5).
              </p>
            </SectionBody>

            <SectionHeading id="how-we-use-ai" number="4" title="How Vireek Uses AI" />
            <SectionBody>
              <p>Vireek uses AI models &mdash; including speech recognition, text-to-speech, and large language models &mdash; to:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Answer inbound calls, understand caller intent, and hold a natural voice conversation</li>
                <li>• Book, confirm, and reschedule appointments against a business's calendar and availability rules</li>
                <li>• Generate quotes, estimates, and job summaries from a business's configured price book</li>
                <li>• Summarize calls, tag leads, and surface coaching insights for the business owner or team</li>
                <li>• Draft follow-up messages, reminders, and outbound campaign scripts, subject to business review</li>
              </ul>
              <p>
                In every case, the AI operates within the scripts, knowledge base, and guardrails
                a business configures &mdash; it does not invent services, pricing, or policies
                outside what the business has provided.
              </p>
            </SectionBody>

            <SectionHeading id="human-oversight" number="5" title="Human Oversight & Escalation" />
            <SectionBody>
              <p>
                Businesses configure escalation rules that determine when a call is transferred
                to a human &mdash; for example, on caller request, for complaints, for
                out-of-scope questions, or for anything resembling a medical, legal, or safety
                emergency. Vireek's AI does not make autonomous decisions on emergency dispatch,
                medical guidance, legal advice, or financial commitments; those are always routed
                to a human or to the appropriate emergency service.
              </p>
              <p>
                Businesses can review call transcripts and recordings, correct the AI's knowledge
                base, and adjust or disable AI behaviors at any time from the Vireek dashboard.
              </p>
            </SectionBody>

            <SectionHeading id="data-used-by-ai" number="6" title="Data Used By Our AI Systems" />
            <SectionBody>
              <p>
                Our AI uses the business profile, knowledge base, price book, calendar, and call
                transcript data a business connects to Vireek in order to respond accurately. It
                does not access data outside what is configured for that business's account.
              </p>
              <p>
                We do not use customer call recordings, transcripts, or business data to train
                general-purpose AI models that are shared across other Vireek customers or made
                available to the public. Details on retention and processing are in our{' '}
                <Link to="/privacy" className="font-semibold text-accent hover:underline">
                  Privacy Policy
                </Link>{' '}
                and{' '}
                <Link to="/dpa" className="font-semibold text-accent hover:underline">
                  Data Processing Agreement
                </Link>
                .
              </p>
            </SectionBody>

            <SectionHeading id="third-party-providers" number="7" title="Third-Party AI Providers" />
            <SectionBody>
              <p>
                Vireek relies on third-party infrastructure &mdash; including speech, telephony,
                and large language model providers &mdash; to power its AI voice agent. We
                contract with these providers under terms that restrict them from using customer
                call data to train their own models, and we review our providers' security and
                data-handling practices as part of our vendor process. Our current sub-processors
                are listed on our{' '}
                <Link to="/subprocessors" className="font-semibold text-accent hover:underline">
                  Sub-processor List
                </Link>
                .
              </p>
            </SectionBody>

            <SectionHeading id="limitations" number="8" title="Known Limitations of AI Outputs" />
            <SectionBody>
              <p>
                AI speech recognition and language models are not perfect. The AI may
                occasionally mishear a caller, misunderstand context, or produce an inaccurate
                summary or quote. Businesses are responsible for reviewing AI-generated quotes,
                summaries, and messages before relying on them for binding commitments, and
                should not use Vireek as the sole channel for handling genuine emergencies.
              </p>
            </SectionBody>

            <SectionHeading id="your-choices" number="9" title="Your Choices & Opt-Out Rights" />
            <SectionBody>
              <p>As a caller or customer, you can:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Ask the AI at any time to transfer you to a human</li>
                <li>• Request a copy of a call transcript by contacting the business you called or Vireek directly</li>
                <li>• Ask a business to disable AI-driven outbound calling or messaging to your number</li>
              </ul>
              <p>
                As a Vireek customer, you can disable individual AI features (such as outbound
                campaigns or AI coaching) from your dashboard settings, or contact us for help
                configuring escalation rules.
              </p>
            </SectionBody>

            <SectionHeading id="changes-to-policy" number="10" title="Changes to This Policy" />
            <SectionBody>
              <p>
                As our AI capabilities evolve, we may update this policy. Material changes will
                be communicated to active customers by email.
              </p>
            </SectionBody>

            <SectionHeading id="contact-us" number="11" title="Contact Us" />
            <SectionBody>
              <p>Questions about how Vireek uses AI, or want to report a concern? Email us.</p>
              <div className="mt-2 flex items-center gap-3">
                <Mail size={18} className="text-accent" />
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-lg font-semibold text-accent hover:underline"
                >
                  {CONTACT_EMAIL}
                </a>
              </div>
            </SectionBody>

            <div className="mt-12 rounded-2xl border border-border bg-bg-secondary p-6 md:p-8">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">
                Related
              </p>
              <div className="mt-3 flex flex-col gap-2">
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

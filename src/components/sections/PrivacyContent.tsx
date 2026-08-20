import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, TriangleAlert as AlertTriangle, MessageSquareText, Mail } from 'lucide-react';
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
  { id: 'information-we-collect', number: '2', title: 'Information We Collect' },
  { id: 'call-recording-ai-processing', number: '3', title: 'Call Recording and AI Processing Disclosure' },
  { id: 'how-we-use-information', number: '4', title: 'How We Use Information' },
  { id: 'sms-consent', number: '5', title: 'SMS / Text Messaging Consent' },
  { id: 'how-we-share-information', number: '6', title: 'How We Share Information' },
  { id: 'data-retention', number: '7', title: 'Data Retention' },
  { id: 'your-rights', number: '8', title: 'Your Rights and Choices' },
  { id: 'data-security', number: '9', title: 'Data Security' },
  { id: 'childrens-privacy', number: '10', title: "Children's Privacy" },
  { id: 'changes-to-policy', number: '11', title: 'Changes to This Policy' },
  { id: 'contact-us', number: '12', title: 'Contact Us' },
];

function CalloutCard({
  icon: Icon,
  children,
}: {
  icon: typeof AlertTriangle;
  children: React.ReactNode;
}) {
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
            Important Disclosure
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

function SectionBody({ children }: { children: React.ReactNode }) {
  return <div className="mt-4 space-y-4 text-base leading-relaxed text-text-secondary">{children}</div>;
}

export function PrivacyContent() {
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
          {/* Desktop sticky TOC */}
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

          {/* Main content */}
          <div className="max-w-3xl">
            {/* Mobile collapsible TOC */}
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

            {/* Page header */}
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
            >
              <p className="text-eyebrow font-semibold uppercase text-accent">Legal</p>
              <h1 className="mt-3 text-4xl font-bold leading-[1.15] tracking-tight text-text-primary md:text-5xl">
                Privacy Policy
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: August 20, 2026</p>
            </motion.div>

            {/* Intro paragraph */}
            <div className="mt-8 rounded-2xl border border-border bg-bg-secondary p-6 text-base leading-relaxed text-text-secondary md:p-8">
              Vireek is an AI voice receptionist service for home service businesses — including
              HVAC, plumbing, roofing, electrical, and restoration companies. Vireek's AI
              receptionist &ldquo;Sarah&rdquo; answers business calls, records and processes
              conversations, qualifies leads, helps schedule appointments, and sends SMS
              confirmations.
            </div>

            {/* Section 1 */}
            <SectionHeading id="introduction" number="1" title="Introduction" />
            <SectionBody>
              <p>
                Vireek (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) provides an AI
                voice receptionist service for home service businesses. This Privacy Policy
                explains how we collect, use, and protect information when you interact with our
                service.
              </p>
              <p>This policy applies to two groups of people:</p>
              <ul className="ml-1 space-y-2">
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">(a)</span>
                  <span>
                    <span className="font-medium text-text-primary">Business customers</span> who
                    sign up for Vireek and use Sarah to answer their incoming calls.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">(b)</span>
                  <span>
                    <span className="font-medium text-text-primary">End callers and homeowners</span>{' '}
                    who call a business using Vireek's AI receptionist &ldquo;Sarah.&rdquo;
                  </span>
                </li>
              </ul>
            </SectionBody>

            {/* Section 2 */}
            <SectionHeading id="information-we-collect" number="2" title="Information We Collect" />
            <SectionBody>
              <h3 className="text-lg font-semibold text-text-primary">From business customers</h3>
              <ul className="ml-1 space-y-1.5">
                <li>• Full name</li>
                <li>• Email address</li>
                <li>• Company name</li>
                <li>• Phone number</li>
                <li>• Best time to call</li>
                <li>• Billing information when subscribing to a paid plan</li>
              </ul>
              <h3 className="pt-2 text-lg font-semibold text-text-primary">From end callers</h3>
              <ul className="ml-1 space-y-1.5">
                <li>• Call audio recordings</li>
                <li>• AI-generated call transcripts</li>
                <li>• Caller phone number</li>
                <li>
                  • Information provided during the call, such as name, address, and service
                  request details needed to book or dispatch a job
                </li>
              </ul>
              <h3 className="pt-2 text-lg font-semibold text-text-primary">
                Automatically collected
              </h3>
              <ul className="ml-1 space-y-1.5">
                <li>• Website usage data</li>
                <li>• Pages visited</li>
                <li>• Browser type</li>
                <li>• General location information from IP address through analytics tools</li>
              </ul>
            </SectionBody>

            {/* Section 3 — Callout */}
            <div className="mt-10">
              <SectionHeading
                id="call-recording-ai-processing"
                number="3"
                title="Call Recording and AI Processing Disclosure"
              />
              <div className="mt-5">
                <CalloutCard icon={AlertTriangle}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      Calls handled by Sarah are <strong className="text-text-primary">recorded and processed by AI technologies</strong>,
                      including speech-to-text and natural language understanding, to answer,
                      qualify, route, and assist with customer calls.
                    </p>
                    <p>
                      Vireek uses third-party AI voice infrastructure and telephony providers to
                      operate the service. Call audio and transcripts may be processed by these
                      providers under their own privacy and security obligations. Vireek maintains
                      appropriate safeguards for protecting this information.
                    </p>
                    <p>
                      Where required by applicable state laws, callers are notified that calls may
                      be recorded and handled by an automated AI system.
                    </p>
                    <div className="rounded-xl border border-accent/30 bg-accent/[0.06] px-4 py-3">
                      <p>
                        <strong className="text-text-primary">Business customer responsibility:</strong>{' '}
                        Vireek's business customers are responsible for complying with applicable
                        call recording consent laws in their operating locations, including
                        two-party consent states such as California.
                      </p>
                    </div>
                  </div>
                </CalloutCard>
              </div>
            </div>

            {/* Section 4 */}
            <SectionHeading id="how-we-use-information" number="4" title="How We Use Information" />
            <SectionBody>
              <p>We use the information we collect for the following purposes:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Providing and improving the Vireek service</li>
                <li>• Answering, routing, and booking appointments</li>
                <li>• Sending SMS confirmations</li>
                <li>• Customer support</li>
                <li>• Billing</li>
                <li>• Legal compliance</li>
                <li>
                  • Improving AI call handling quality — only through aggregated and anonymized data
                </li>
              </ul>
            </SectionBody>

            {/* Section 5 — Callout */}
            <div className="mt-10">
              <SectionHeading id="sms-consent" number="5" title="SMS / Text Messaging Consent" />
              <div className="mt-5">
                <CalloutCard icon={MessageSquareText}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      Vireek sends SMS confirmations related <strong className="text-text-primary">only</strong> to
                      service appointments on behalf of business customers.
                    </p>
                    <ul className="ml-1 space-y-2">
                      <li>• Message and data rates may apply.</li>
                      <li>
                        • Recipients can reply <strong className="text-text-primary">STOP</strong> at
                        any time to opt out of SMS messages.
                      </li>
                      <li>
                        • SMS opt-in information is never shared with third parties for marketing
                        purposes.
                      </li>
                    </ul>
                  </div>
                </CalloutCard>
              </div>
            </div>

            {/* Section 6 */}
            <SectionHeading
              id="how-we-share-information"
              number="6"
              title="How We Share Information"
            />
            <SectionBody>
              <p>We may share information with the following categories of recipients:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• AI voice and telephony infrastructure providers</li>
                <li>• Hosting providers</li>
                <li>• Payment processors</li>
                <li>• CRM and calendar integrations</li>
                <li>
                  • The business customer that Sarah is answering calls for — because caller
                  information must be shared with the relevant contractor to provide the requested
                  service
                </li>
                <li>• Legal or compliance authorities when required</li>
                <li>• Business transfer situations such as acquisition or merger</li>
              </ul>
              <div className="mt-5 rounded-xl border border-border bg-bg-tertiary px-5 py-4">
                <p className="text-base font-semibold text-text-primary">
                  Vireek never sells personal data to third parties for advertising purposes.
                </p>
              </div>
            </SectionBody>

            {/* Section 7 */}
            <SectionHeading id="data-retention" number="7" title="Data Retention" />
            <SectionBody>
              <ul className="ml-1 space-y-2">
                <li>
                  • Call recordings and transcripts are retained for{' '}
                  <strong className="text-text-primary">12 months</strong> to support quality
                  review, troubleshooting, and dispute resolution.
                </li>
                <li>• After this period, information is deleted or anonymized.</li>
                <li>
                  • Business account information is retained during the subscription period and
                  for a reasonable period after cancellation for legal and business purposes.
                </li>
              </ul>
            </SectionBody>

            {/* Section 8 */}
            <SectionHeading id="your-rights" number="8" title="Your Rights and Choices" />
            <SectionBody>
              <p>You have the following rights regarding your personal information:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Requests to access, correct, or delete personal information</li>
                <li>
                  • California residents' CCPA rights, including the right to know, delete, and opt
                  out of sale
                </li>
                <li>
                  • Vireek does not sell personal data — so there is nothing to opt out of in that
                  regard
                </li>
                <li>• SMS recipients can opt out by replying STOP</li>
              </ul>
              <p className="pt-2">
                You can submit privacy requests by emailing{' '}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="font-semibold text-accent hover:underline"
                >
                  {CONTACT_EMAIL}
                </a>
                .
              </p>
            </SectionBody>

            {/* Section 9 */}
            <SectionHeading id="data-security" number="9" title="Data Security" />
            <SectionBody>
              <p>
                Vireek uses reasonable technical and organizational security measures to protect
                your information. Data is protected using encryption in transit and access controls.
              </p>
              <p>
                However, no internet-based system can guarantee 100% security. We continuously
                work to improve our safeguards, but we cannot guarantee absolute security of your
                information.
              </p>
            </SectionBody>

            {/* Section 10 */}
            <SectionHeading id="childrens-privacy" number="10" title="Children's Privacy" />
            <SectionBody>
              <p>
                Vireek is not directed toward children under 16. We do not knowingly collect personal
                information from children. If you believe a child has provided us with personal
                information, please contact us and we will take steps to delete it.
              </p>
            </SectionBody>

            {/* Section 11 */}
            <SectionHeading id="changes-to-policy" number="11" title="Changes to This Policy" />
            <SectionBody>
              <p>
                We may update this Privacy Policy from time to time. The updated date will always
                appear at the top of this page. Material changes will be communicated to business
                customers by email.
              </p>
            </SectionBody>

            {/* Section 12 */}
            <SectionHeading id="contact-us" number="12" title="Contact Us" />
            <SectionBody>
              <p>Questions about this policy? Email us and we'll get back to you.</p>
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

            {/* Cross-link to Terms of Service */}
            <div className="mt-12 rounded-2xl border border-border bg-bg-secondary p-6 md:p-8">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">
                Related
              </p>
              <Link
                to="/terms"
                className="mt-3 flex items-center gap-2 text-base font-semibold text-accent hover:underline"
              >
                Terms of Service &rarr;
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

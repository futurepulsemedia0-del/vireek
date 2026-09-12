import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Ban, Mail } from 'lucide-react';
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
  { id: 'who-this-applies-to', number: '2', title: 'Who This Applies To' },
  { id: 'prohibited-conduct', number: '3', title: 'Prohibited Conduct' },
  { id: 'calling-and-messaging', number: '4', title: 'Calling & Messaging Rules' },
  { id: 'content-restrictions', number: '5', title: 'Content Restrictions' },
  { id: 'account-security', number: '6', title: 'Account Security Responsibilities' },
  { id: 'enforcement', number: '7', title: 'Enforcement' },
  { id: 'reporting-violations', number: '8', title: 'Reporting a Violation' },
  { id: 'changes-to-policy', number: '9', title: 'Changes to This Policy' },
  { id: 'contact-us', number: '10', title: 'Contact Us' },
];

function CalloutCard({ icon: Icon, children }: { icon: typeof Ban; children: ReactNode }) {
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
            Zero Tolerance
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

export function AcceptableUseContent() {
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
                Acceptable Use Policy
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: September 12, 2026</p>
            </motion.div>

            <SectionHeading id="introduction" number="1" title="Introduction" />
            <SectionBody>
              <p>
                This Acceptable Use Policy ("AUP") describes how Vireek's AI voice receptionist
                platform may and may not be used. It applies in addition to our{' '}
                <Link to="/terms" className="font-semibold text-accent hover:underline">
                  Terms of Service
                </Link>
                , and violating it may result in suspension or termination of your account.
              </p>
            </SectionBody>

            <SectionHeading id="who-this-applies-to" number="2" title="Who This Applies To" />
            <SectionBody>
              <p>
                This policy applies to every customer, team member, and any third party who uses
                the Vireek dashboard, API, phone numbers, or any feature of the service on a
                customer's behalf.
              </p>
            </SectionBody>

            <div className="mt-10">
              <SectionHeading id="prohibited-conduct" number="3" title="Prohibited Conduct" />
              <div className="mt-5">
                <CalloutCard icon={Ban}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>You may not use Vireek to:</p>
                    <ul className="ml-1 space-y-2">
                      <li>• Break any applicable law or regulation</li>
                      <li>• Send unsolicited bulk calls, robocalls, or messages ("spam") in violation of the TCPA, CAN-SPAM, CTIA guidelines, or equivalent laws in your jurisdiction</li>
                      <li>• Harass, threaten, defraud, or impersonate any person or organization</li>
                      <li>• Deceive call recipients about the nature of the service in a way prohibited by law</li>
                      <li>• Attempt to gain unauthorized access to our systems, other accounts, or interfere with the service's normal operation</li>
                      <li>• Reverse engineer, scrape, or resell access to the platform without our written authorization</li>
                      <li>• Upload or transmit malware, viruses, or other harmful code</li>
                    </ul>
                  </div>
                </CalloutCard>
              </div>
            </div>

            <SectionHeading id="calling-and-messaging" number="4" title="Calling & Messaging Rules" />
            <SectionBody>
              <p>Because Vireek places and answers real phone calls and messages on your behalf, you agree that you:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Have the legal right and any required consent to contact the numbers you upload or call</li>
                <li>• Will honor opt-out requests (such as replies of "STOP") promptly</li>
                <li>• Will not use the platform to impersonate emergency services or government agencies</li>
                <li>• Are responsible for complying with Do-Not-Call, TCPA, and any local telemarketing/consent laws that apply to your business</li>
              </ul>
            </SectionBody>

            <SectionHeading id="content-restrictions" number="5" title="Content Restrictions" />
            <SectionBody>
              <p>
                Business profile information, call scripts, and any content you configure within
                Vireek must not contain unlawful, hateful, sexually explicit, or deceptive content,
                and must accurately represent your business.
              </p>
            </SectionBody>

            <SectionHeading id="account-security" number="6" title="Account Security Responsibilities" />
            <SectionBody>
              <ul className="ml-1 space-y-1.5">
                <li>• Keep your login credentials confidential and use a strong, unique password</li>
                <li>• Promptly remove team members who no longer need access</li>
                <li>• Notify us immediately if you suspect unauthorized access to your account</li>
              </ul>
            </SectionBody>

            <SectionHeading id="enforcement" number="7" title="Enforcement" />
            <SectionBody>
              <p>
                Vireek may investigate suspected violations of this policy and may suspend or
                terminate access &mdash; with or without notice, depending on severity &mdash; for
                accounts found to be in violation. Where practical, we will attempt to notify you
                and give you an opportunity to correct the issue first.
              </p>
            </SectionBody>

            <SectionHeading id="reporting-violations" number="8" title="Reporting a Violation" />
            <SectionBody>
              <p>
                If you believe a Vireek customer is misusing the platform &mdash; for example,
                sending unwanted calls or messages &mdash; email us with as much detail as possible
                (phone number, date/time, and nature of the contact) and we will investigate.
              </p>
            </SectionBody>

            <SectionHeading id="changes-to-policy" number="9" title="Changes to This Policy" />
            <SectionBody>
              <p>
                We may update this policy from time to time. Material changes will be communicated
                to active customers by email.
              </p>
            </SectionBody>

            <SectionHeading id="contact-us" number="10" title="Contact Us" />
            <SectionBody>
              <p>Questions about this policy, or want to report misuse? Email us.</p>
              <div className="mt-2 flex items-center gap-3">
                <Mail size={18} className="text-accent" />
                
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
                <Link to="/terms" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Terms of Service &rarr;
                </Link>
                <Link to="/vulnerability-disclosure" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Vulnerability Disclosure Policy &rarr;
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

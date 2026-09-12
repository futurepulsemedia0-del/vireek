import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, TriangleAlert as AlertTriangle, Scale, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, viewport } from '@/lib/motion';

const CONTACT_EMAIL = 'ali@vireek.com';

interface Section {
  id: string;
  number: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'agreement-to-terms', number: '1', title: 'Agreement to Terms' },
  { id: 'description-of-service', number: '2', title: 'Description of Service' },
  { id: 'account-registration', number: '3', title: 'Account Registration' },
  { id: 'subscription-plans-and-billing', number: '4', title: 'Subscription Plans and Billing' },
  { id: 'free-trial-terms', number: '5', title: 'Free Trial Terms' },
  { id: 'customer-responsibilities', number: '6', title: 'Customer Responsibilities' },
  { id: 'ai-service-disclaimer', number: '7', title: 'AI Service Disclaimer' },
  { id: 'intellectual-property', number: '8', title: 'Intellectual Property' },
  { id: 'data-and-privacy', number: '9', title: 'Data and Privacy' },
  { id: 'termination', number: '10', title: 'Termination' },
  { id: 'limitation-of-liability', number: '11', title: 'Limitation of Liability' },
  { id: 'indemnification', number: '12', title: 'Indemnification' },
  { id: 'governing-law', number: '13', title: 'Governing Law' },
  { id: 'changes-to-terms', number: '14', title: 'Changes to These Terms' },
  { id: 'contact', number: '15', title: 'Contact' },
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

export function TermsContent() {
  const [activeId, setActiveId] = useState<string>('agreement-to-terms');
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
                Terms of Service
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: August 20, 2026</p>
            </motion.div>

            {/* Intro paragraph */}
            <div className="mt-8 rounded-2xl border border-border bg-bg-secondary p-6 text-base leading-relaxed text-text-secondary md:p-8">
              These Terms of Service govern your use of Vireek, an AI voice receptionist service for
              home service businesses. By signing up for or using Vireek, you agree to the terms
              outlined below.
            </div>

            {/* Section 1 */}
            <SectionHeading id="agreement-to-terms" number="1" title="Agreement to Terms" />
            <SectionBody>
              <p>
                By signing up for or using Vireek, the business customer (&ldquo;Customer,&rdquo;
                &ldquo;you,&rdquo; or &ldquo;your&rdquo;) agrees to these Terms of Service
                (&ldquo;Terms&rdquo;). If you do not agree with these terms, you should not use the
                service.
              </p>
              <p>
                Using Vireek means you accept these Terms on behalf of your business. If you are
                accepting these Terms on behalf of a company, you confirm that you have the authority
                to do so.
              </p>
            </SectionBody>

            {/* Section 2 */}
            <SectionHeading id="description-of-service" number="2" title="Description of Service" />
            <SectionBody>
              <p>
                Vireek provides an AI voice receptionist service (&ldquo;Sarah&rdquo;) for home
                service businesses, including HVAC, plumbing, roofing, electrical, and restoration
                companies. Sarah answers incoming calls on behalf of your business and helps manage
                customer interactions.
              </p>
              <p>The service includes:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Answering incoming phone calls</li>
                <li>• Qualifying leads</li>
                <li>• Detecting potential emergencies</li>
                <li>• Booking appointments</li>
                <li>• Providing call summaries</li>
                <li>• Sending SMS confirmations</li>
                <li>• CRM and calendar integrations</li>
              </ul>
            </SectionBody>

            {/* Section 3 */}
            <SectionHeading id="account-registration" number="3" title="Account Registration" />
            <SectionBody>
              <ul className="ml-1 space-y-2">
                <li>
                  • Customers must provide <strong className="text-text-primary">accurate and complete</strong>{' '}
                  information during signup, including full name, email, company name, phone number,
                  and best time to call.
                </li>
                <li>
                  • Customers are responsible for maintaining the{' '}
                  <strong className="text-text-primary">security of their account credentials</strong>{' '}
                  and should not share them with unauthorized parties.
                </li>
                <li>
                  • Customers are responsible for{' '}
                  <strong className="text-text-primary">all activity performed through their account</strong>,
                  whether by the customer or by anyone they have authorized to access the account.
                </li>
              </ul>
            </SectionBody>

            {/* Section 4 */}
            <SectionHeading
              id="subscription-plans-and-billing"
              number="4"
              title="Subscription Plans and Billing"
            />
            <SectionBody>
              <p>Vireek offers the following subscription plans:</p>

              <div className="space-y-4">
                <div className="rounded-xl border border-border bg-bg-secondary p-5">
                  <h3 className="text-lg font-semibold text-text-primary">Starter</h3>
                  <ul className="mt-2 ml-1 space-y-1.5">
                    <li>• $0/month</li>
                    <li>• Includes 50 minutes</li>
                    <li>• Includes a 14-day trial period</li>
                  </ul>
                </div>
                <div className="rounded-xl border-2 border-accent/40 bg-accent/[0.04] p-5">
                  <h3 className="text-lg font-semibold text-text-primary">Professional</h3>
                  <ul className="mt-2 ml-1 space-y-1.5">
                    <li>• $199/month</li>
                    <li>• Includes 1,500 minutes</li>
                    <li>• Additional usage is billed at $0.15/minute</li>
                  </ul>
                </div>
              </div>

              <h3 className="pt-2 text-lg font-semibold text-text-primary">Billing terms</h3>
              <ul className="ml-1 space-y-1.5">
                <li>• Billing occurs monthly in advance.</li>
                <li>• Subscriptions automatically renew unless canceled.</li>
                <li>
                  • Customers may cancel anytime, effective at the end of the current billing period.
                </li>
                <li>• There are no long-term contracts.</li>
                                <li>
                  • No refunds are provided for partial months except where required by law. See
                  our{' '}
                  <Link to="/refund-policy" className="font-semibold text-accent hover:underline">
                    Refund & Cancellation Policy
                  </Link>{' '}
                  for full details.
                </li>
                <li>• Pricing may change with 30 days notice to active subscribers.</li>
              </ul>
            </SectionBody>

            {/* Section 5 */}
            <SectionHeading id="free-trial-terms" number="5" title="Free Trial Terms" />
            <SectionBody>
              <ul className="ml-1 space-y-2">
                <li>
                  • The Starter plan or any available free trial{' '}
                  <strong className="text-text-primary">does not require a credit card</strong> to
                  begin.
                </li>
                <li>
                  • Vireek may limit{' '}
                  <strong className="text-text-primary">one free trial per business</strong> to
                  prevent abuse of trial offerings.
                </li>
              </ul>
            </SectionBody>

            {/* Section 6 */}
            <SectionHeading id="customer-responsibilities" number="6" title="Customer Responsibilities" />
            <SectionBody>
              <p>Customers are responsible for:</p>
              <ul className="ml-1 space-y-2">
                <li>
                  • Having the <strong className="text-text-primary">legal right to allow calls</strong>{' '}
                  to their business number to be answered and recorded by Vireek.
                </li>
                <li>
                  • Following all applicable laws regarding{' '}
                  <strong className="text-text-primary">call recording consent</strong>,
                  including two-party consent states.
                </li>
                <li>
                  • Following applicable{' '}
                  <strong className="text-text-primary">telemarketing, SMS, and TCPA requirements</strong>{' '}
                  for any outbound communications.
                </li>
                <li>
                  • Providing{' '}
                  <strong className="text-text-primary">accurate business information</strong>,
                  including services offered, service areas, pricing, and availability, so Sarah can
                  accurately represent the business.
                </li>
                <li>
                  • Not using Vireek for{' '}
                  <strong className="text-text-primary">unlawful, fraudulent, abusive, or harmful</strong>{' '}
                  purposes.
                </li>
              </ul>
            </SectionBody>

            {/* Section 7 — Callout */}
            <div className="mt-10">
              <SectionHeading id="ai-service-disclaimer" number="7" title="AI Service Disclaimer" />
              <div className="mt-5">
                <CalloutCard icon={AlertTriangle}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      Sarah is an AI system designed to answer, qualify, and route calls.{' '}
                      <strong className="text-text-primary">
                        AI may occasionally misunderstand callers or provide inaccurate information.
                      </strong>
                    </p>
                    <p>
                      Vireek does not guarantee that every call will be handled perfectly or that every
                      emergency situation will always be detected correctly. Customers should
                      maintain reasonable oversight, including reviewing call summaries when
                      appropriate.
                    </p>
                    <div className="rounded-xl border border-accent/30 bg-accent/[0.06] px-4 py-3">
                      <p>
                        <strong className="text-text-primary">Limitation of AI liability:</strong> To
                        the maximum extent permitted by law, Vireek is not responsible for lost
                        business, missed emergencies, or damages caused by AI limitations or errors.
                      </p>
                    </div>
                  </div>
                </CalloutCard>
              </div>
            </div>

            {/* Section 8 */}
            <SectionHeading id="intellectual-property" number="8" title="Intellectual Property" />
            <SectionBody>
              <ul className="ml-1 space-y-2">
                <li>
                  • Vireek owns all rights to its{' '}
                  <strong className="text-text-primary">software, brand, AI technology, and platform</strong>.
                  Customers receive a limited, revocable license to use the service during their
                  subscription.
                </li>
                <li>
                  • Customers{' '}
                  <strong className="text-text-primary">
                    retain ownership of their own business data
                  </strong>{' '}
                  and information provided to Vireek, including business details, service offerings,
                  and call preferences.
                </li>
              </ul>
            </SectionBody>

            {/* Section 9 */}
            <SectionHeading id="data-and-privacy" number="9" title="Data and Privacy" />
            <SectionBody>
              <p>
                Customer and caller information is handled according to the Vireek Privacy Policy.
                The Privacy Policy explains what data we collect, how we use it, how long we retain
                it, and the choices available to you.
              </p>
              <p>
                <Link
                  to="/privacy"
                  className="font-semibold text-accent hover:underline"
                >
                  Read the full Privacy Policy &rarr;
                </Link>
              </p>
            </SectionBody>

            {/* Section 10 */}
            <SectionHeading id="termination" number="10" title="Termination" />
            <SectionBody>
              <ul className="ml-1 space-y-2">
                <li>
                  • Vireek may suspend or terminate accounts for{' '}
                  <strong className="text-text-primary">
                    violations of these terms, non-payment, unlawful use, or abuse of the service
                  </strong>.
                </li>
                <li>
                  • Vireek will provide{' '}
                  <strong className="text-text-primary">reasonable notice where practical</strong>{' '}
                  before suspension or termination.
                </li>
                <li>
                  • Customers may{' '}
                  <strong className="text-text-primary">cancel anytime</strong> according to the
                  billing terms described in Section 4.
                </li>
              </ul>
            </SectionBody>

            {/* Section 11 — Callout */}
            <div className="mt-10">
              <SectionHeading id="limitation-of-liability" number="11" title="Limitation of Liability" />
              <div className="mt-5">
                <CalloutCard icon={Scale}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      The service is provided{' '}
                      <strong className="text-text-primary">&ldquo;as is&rdquo;</strong> and{' '}
                      <strong className="text-text-primary">&ldquo;as available.&rdquo;</strong>
                    </p>
                    <p>
                      To the maximum extent permitted by law, Vireek's total liability for any claim
                      is limited to the{' '}
                      <strong className="text-text-primary">
                        amount paid by the customer during the 3 months before the claim occurred
                      </strong>.
                    </p>
                    <p>
                      Vireek is not responsible for{' '}
                      <strong className="text-text-primary">
                        indirect, incidental, special, or consequential damages
                      </strong>,
                      including lost profits, lost business opportunities, or missed jobs.
                    </p>
                  </div>
                </CalloutCard>
              </div>
            </div>

            {/* Section 12 */}
            <SectionHeading id="indemnification" number="12" title="Indemnification" />
            <SectionBody>
              <p>
                Customers agree to protect and indemnify Vireek from claims, damages, and expenses
                (including reasonable legal fees) resulting from:
              </p>
              <ul className="ml-1 space-y-1.5">
                <li>• Misuse of the service.</li>
                <li>• Violation of applicable laws.</li>
                <li>
                  • Failure to comply with call recording consent requirements or other regulations.
                </li>
              </ul>
            </SectionBody>

            {/* Section 13 */}
            <SectionHeading id="governing-law" number="13" title="Governing Law" />
            <SectionBody>
              <div className="rounded-xl border border-dashed border-border bg-bg-tertiary px-5 py-4">
                <p className="text-base leading-relaxed text-text-primary">
                  This agreement is governed by the laws of the State of{' '}
                  <span className="rounded-md bg-accent/15 px-2 py-0.5 font-semibold text-accent">
                    [State]
                  </span>
                  , United States.
                </p>
                <p className="mt-2 text-sm text-text-secondary">
                  Placeholder — to be completed after confirming the company's legal registration
                  details.
                </p>
              </div>
            </SectionBody>

            {/* Section 14 */}
            <SectionHeading id="changes-to-terms" number="14" title="Changes to These Terms" />
            <SectionBody>
              <ul className="ml-1 space-y-1.5">
                <li>
                  • Updates will be reflected by{' '}
                  <strong className="text-text-primary">changing the date</strong> on this page.
                </li>
                <li>
                  • Material changes may be{' '}
                  <strong className="text-text-primary">communicated to active customers by email</strong>.
                </li>
              </ul>
            </SectionBody>

            {/* Section 15 */}
            <SectionHeading id="contact" number="15" title="Contact" />
            <SectionBody>
              <p>Questions about these terms? Email us and we'll get back to you.</p>
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

            {/* Cross-link to Privacy Policy */}
            <div className="mt-12 rounded-2xl border border-border bg-bg-secondary p-6 md:p-8">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">
                Related
              </p>
                            <div className="mt-3 flex flex-col gap-2">
                <Link
                  to="/privacy"
                  className="flex items-center gap-2 text-base font-semibold text-accent hover:underline"
                >
                  Privacy Policy &rarr;
                </Link>
                <Link
                  to="/acceptable-use-policy"
                  className="flex items-center gap-2 text-base font-semibold text-accent hover:underline"
                >
                  Acceptable Use Policy &rarr;
                </Link>
                <Link
                  to="/refund-policy"
                  className="flex items-center gap-2 text-base font-semibold text-accent hover:underline"
                >
                  Refund & Cancellation Policy &rarr;
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

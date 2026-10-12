import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, FileText, Mail, Scale, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, viewport } from '@/lib/motion';

const CONTACT_EMAIL = 'ali@vireek.com';
const LINK_CLASS = 'font-semibold text-accent hover:underline';

interface Section {
  id: string;
  number: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'overview', number: '1', title: 'Overview and Scope' },
  { id: 'agreement-structure', number: '2', title: 'Agreement Structure' },
  { id: 'services-and-order-forms', number: '3', title: 'Services and Order Forms' },
  { id: 'customer-responsibilities', number: '4', title: 'Customer Responsibilities' },
  { id: 'fees-and-payment', number: '5', title: 'Fees and Payment' },
  { id: 'term-and-termination', number: '6', title: 'Term and Termination' },
  { id: 'service-levels', number: '7', title: 'Service Levels and Support' },
  { id: 'data-and-security', number: '8', title: 'Data Protection and Security' },
  { id: 'intellectual-property', number: '9', title: 'Intellectual Property' },
  { id: 'confidentiality', number: '10', title: 'Confidentiality' },
  { id: 'warranties', number: '11', title: 'Warranties and AI Disclaimer' },
  { id: 'limitation-of-liability', number: '12', title: 'Limitation of Liability' },
  { id: 'indemnification', number: '13', title: 'Indemnification' },
  { id: 'governing-law', number: '14', title: 'Governing Law' },
  { id: 'general-terms', number: '15', title: 'General Terms' },
  { id: 'changes-to-msa', number: '16', title: 'Changes to This MSA' },
  { id: 'contact-us', number: '17', title: 'Contact Us' },
];

const PRECEDENCE: { title: string; body: ReactNode }[] = [
  {
    title: 'Order Form',
    body: 'The signed order or subscription confirmation. It controls where it expressly differs from the documents below.',
  },
  {
    title: 'This MSA',
    body: 'The general legal terms that apply to every Order Form signed under it.',
  },
  {
    title: 'Incorporated policies',
    body: 'The DPA, SLA, Acceptable Use Policy, and Privacy Policy, each as linked in this MSA.',
  },
];

function CalloutCard({
  icon: Icon,
  label = 'Our Commitment',
  children,
}: {
  icon: typeof ShieldCheck;
  label?: string;
  children: ReactNode;
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
            <Icon size={20} aria-hidden="true" />
          </span>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-accent">{label}</p>
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

export function MsaContent() {
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
                aria-controls="msa-mobile-toc"
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
                  id="msa-mobile-toc"
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
                Master Services Agreement
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: October 8, 2026</p>
            </motion.div>

            <SectionHeading id="overview" number="1" title="Overview and Scope" />
            <SectionBody>
              <p>
                This Master Services Agreement (&ldquo;MSA&rdquo;) is between Vireek
                (&ldquo;Vireek,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) and the business that
                signs an Order Form or otherwise accepts it (&ldquo;Customer&rdquo;). It sets the
                legal terms for Vireek's AI voice receptionist platform and related services
                (the &ldquo;Services&rdquo;) when a Customer buys on a negotiated or enterprise
                basis.
              </p>
              <p>
                Customers who sign up online on a standard plan are governed by our{' '}
                <Link to="/terms" className={LINK_CLASS}>
                  Terms of Service
                </Link>{' '}
                instead, unless they sign an Order Form that references this MSA.
              </p>
            </SectionBody>

            <SectionHeading id="agreement-structure" number="2" title="Agreement Structure" />
            <div className="mt-5">
              <CalloutCard icon={FileText} label="Order of Precedence">
                <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                  <p>
                    If documents conflict, they apply in this order, highest first:
                  </p>
                  <ol className="space-y-3">
                    {PRECEDENCE.map((item, i) => (
                      <li key={item.title} className="flex gap-3">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent">
                          {i + 1}
                        </span>
                        <span>
                          <strong className="text-text-primary">{item.title}.</strong> {item.body}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              </CalloutCard>
            </div>

            <SectionHeading id="services-and-order-forms" number="3" title="Services and Order Forms" />
            <SectionBody>
              <p>
                Each Order Form identifies the Services, plan, usage allowances, fees, and term.
                Vireek provides the Services described in the Order Form and in the product
                documentation, and may improve or modify them over time without materially
                reducing their core functionality during a paid term.
              </p>
              <p>
                Customer may add locations, numbers, or features by signing an additional Order
                Form or by accepting an upgrade in the Vireek dashboard.
              </p>
            </SectionBody>

            <SectionHeading id="customer-responsibilities" number="4" title="Customer Responsibilities" />
            <SectionBody>
              <ul className="ml-1 space-y-1.5">
                <li>• Keep account credentials secure and limit access to authorized users</li>
                <li>• Provide accurate business information, scripts, pricing, and availability</li>
                <li>
                  • Comply with the{' '}
                  <Link to="/acceptable-use-policy" className={LINK_CLASS}>
                    Acceptable Use Policy
                  </Link>{' '}
                  and all laws that apply to its business and calls
                </li>
                <li>
                  • Obtain the consents and give the notices required by law for call recording,
                  automated calls, and messaging, as described in our{' '}
                  <Link to="/ai-disclosure" className={LINK_CLASS}>
                    AI Call Disclosure &amp; Recording Policy
                  </Link>
                </li>
                <li>• Review AI-generated quotes, summaries, and messages before relying on them for binding commitments</li>
              </ul>
            </SectionBody>

            <SectionHeading id="fees-and-payment" number="5" title="Fees and Payment" />
            <SectionBody>
              <ul className="ml-1 space-y-1.5">
                <li>• Fees, billing frequency, and payment terms are set out in the Order Form.</li>
                <li>• Fees are exclusive of applicable taxes, which Customer is responsible for, except taxes on Vireek's income.</li>
                <li>• Usage above the allowances in the Order Form may be billed at the rates stated there.</li>
                <li>• Unless the Order Form says otherwise, fees are fixed for the committed term; changes to pricing apply at renewal with prior notice.</li>
                <li>• Fees already paid are non-refundable except as stated in the Order Form, required by law, or provided in our{' '}
                  <Link to="/refund-policy" className={LINK_CLASS}>
                    Refund &amp; Cancellation Policy
                  </Link>
                  .
                </li>
              </ul>
              <p>
                Customer must notify us promptly of any good-faith billing dispute, and the
                parties will work together to resolve it. Undisputed amounts remain payable.
              </p>
            </SectionBody>

            <SectionHeading id="term-and-termination" number="6" title="Term and Termination" />
            <SectionBody>
              <p>
                This MSA starts when Customer first signs an Order Form and continues until all
                Order Forms have expired or been terminated. Each Order Form states its own term
                and renewal terms.
              </p>
              <ul className="ml-1 space-y-1.5">
                <li>• Either party may terminate an Order Form for the other's material breach that remains uncured 30 days after written notice.</li>
                <li>• Either party may terminate immediately if the other becomes insolvent or ceases business operations.</li>
                <li>• Vireek may suspend the Services where needed to stop a security threat, unlawful use, or a violation of the Acceptable Use Policy, and will limit suspension to what is necessary.</li>
              </ul>
              <p>
                On termination, Customer's access ends and Customer should export the data it
                needs beforehand. Deletion of Customer data follows the{' '}
                <Link to="/dpa" className={LINK_CLASS}>
                  Data Processing Agreement
                </Link>
                . Sections that by their nature should survive, including fees owed,
                confidentiality, intellectual property, liability, and governing law, survive
                termination.
              </p>
            </SectionBody>

            <SectionHeading id="service-levels" number="7" title="Service Levels and Support" />
            <SectionBody>
              <p>
                Our uptime commitment and service-credit remedy are described in the{' '}
                <Link to="/sla" className={LINK_CLASS}>
                  Service Level Agreement
                </Link>
                . Enterprise Customers may negotiate a custom commitment in their Order Form.
                Service credits, where available, are Customer's sole and exclusive remedy for
                Service unavailability.
              </p>
            </SectionBody>

            <SectionHeading id="data-and-security" number="8" title="Data Protection and Security" />
            <SectionBody>
              <p>
                Customer owns its business data and call content. Vireek processes personal
                data on Customer's behalf under the{' '}
                <Link to="/dpa" className={LINK_CLASS}>
                  Data Processing Agreement
                </Link>{' '}
                (and the{' '}
                <Link to="/gdpr-dpa" className={LINK_CLASS}>
                  GDPR Addendum
                </Link>{' '}
                where it applies), and handles other information as described in our{' '}
                <Link to="/privacy" className={LINK_CLASS}>
                  Privacy Policy
                </Link>
                .
              </p>
              <p>
                Vireek maintains administrative, technical, and organizational safeguards
                appropriate to the sensitivity of the data, and uses only the providers listed on
                the{' '}
                <Link to="/subprocessors" className={LINK_CLASS}>
                  Sub-processor List
                </Link>
                . Vireek does not use Customer call recordings or transcripts to train
                general-purpose AI models shared across customers. Security issues can be
                reported under our{' '}
                <Link to="/vulnerability-disclosure" className={LINK_CLASS}>
                  Vulnerability Disclosure
                </Link>{' '}
                policy, and our security documentation is in the{' '}
                <Link to="/trust" className={LINK_CLASS}>
                  Trust Center
                </Link>
                .
              </p>
            </SectionBody>

            <SectionHeading id="intellectual-property" number="9" title="Intellectual Property" />
            <SectionBody>
              <p>
                Vireek and its licensors own the Services, software, models, and documentation,
                and all improvements to them. Vireek grants Customer a limited, non-exclusive,
                non-transferable right to use the Services during the term for its internal
                business operations. Customer owns its data, content, and branding, and grants
                Vireek the rights needed to provide the Services. Feedback may be used by Vireek
                to improve the Services without obligation. Use of Vireek's name and logo is
                governed by the{' '}
                <Link to="/trademark-policy" className={LINK_CLASS}>
                  Trademark Policy
                </Link>
                .
              </p>
            </SectionBody>

            <SectionHeading id="confidentiality" number="10" title="Confidentiality" />
            <SectionBody>
              <p>
                Each party will protect the other's non-public business, technical, and pricing
                information with at least reasonable care, use it only to perform or receive the
                Services, and disclose it only to personnel and advisers who need it and are
                bound by similar duties. These duties do not apply to information that is public,
                already known, independently developed, or lawfully received from a third
                party, and a party may disclose information where required by law after giving
                notice where permitted. They continue for three years after the MSA ends, and for
                as long as trade secrets remain protected.
              </p>
            </SectionBody>

            <SectionHeading id="warranties" number="11" title="Warranties and AI Disclaimer" />
            <SectionBody>
              <p>
                Each party represents that it has authority to enter into this MSA. Vireek
                warrants that it will provide the Services with reasonable skill and care and in
                accordance with applicable law.
              </p>
              <p>
                Except as stated above, the Services are provided &ldquo;as is&rdquo; and
                &ldquo;as available,&rdquo; and Vireek disclaims all other warranties to the
                extent permitted by law, including implied warranties of merchantability,
                fitness for a particular purpose, and non-infringement. AI systems can mishear
                callers or produce inaccurate output, and the Services are not designed to handle
                emergencies or to give medical, legal, or financial advice. See our{' '}
                <Link to="/responsible-ai" className={LINK_CLASS}>
                  Responsible AI Policy
                </Link>
                .
              </p>
            </SectionBody>

            <SectionHeading id="limitation-of-liability" number="12" title="Limitation of Liability" />
            <div className="mt-5">
              <CalloutCard icon={Scale} label="Liability">
                <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                  <p>
                    To the maximum extent permitted by law, each party's total liability under
                    this MSA is limited to{' '}
                    <strong className="text-text-primary">
                      the fees paid by Customer in the 3 months before the event giving rise to
                      the claim
                    </strong>
                    , unless the Order Form states a different amount.
                  </p>
                  <p>
                    Neither party is liable for{' '}
                    <strong className="text-text-primary">
                      indirect, incidental, special, or consequential damages
                    </strong>
                    , including lost profits, lost business opportunities, or missed jobs.
                  </p>
                  <p>
                    These limits do not apply to Customer's obligation to pay fees, to either
                    party's indemnification obligations, to breach of confidentiality, or to
                    liability that cannot be limited by law, such as fraud or willful misconduct.
                  </p>
                </div>
              </CalloutCard>
            </div>

            <SectionHeading id="indemnification" number="13" title="Indemnification" />
            <SectionBody>
              <p>
                Customer will defend and indemnify Vireek against third-party claims arising from
                Customer's data, its instructions for use of the Services, or its violation of
                law or the Acceptable Use Policy, including call-recording, consent, and
                automated-calling laws.
              </p>
              <p>
                Vireek will defend and indemnify Customer against third-party claims that the
                Services, as provided by Vireek, infringe that party's intellectual property
                rights. Vireek has no obligation for claims caused by Customer's content,
                modifications, or use in breach of this MSA. The indemnified party must give
                prompt notice, allow the indemnifying party to control the defense, and
                reasonably cooperate.
              </p>
            </SectionBody>

            <SectionHeading id="governing-law" number="14" title="Governing Law" />
            <SectionBody>
              <div className="rounded-xl border border-dashed border-border bg-bg-tertiary px-5 py-4">
                <p className="text-base leading-relaxed text-text-primary">
                  This MSA is governed by the laws of the State of{' '}
                  <span className="rounded-md bg-accent/15 px-2 py-0.5 font-semibold text-accent">
                    [State]
                  </span>
                  , United States, and the courts located there have exclusive jurisdiction,
                  unless the Order Form states otherwise.
                </p>
                <p className="mt-2 text-sm text-text-secondary">
                  Placeholder — to be completed after confirming the company's legal registration
                  details.
                </p>
              </div>
            </SectionBody>

            <SectionHeading id="general-terms" number="15" title="General Terms" />
            <SectionBody>
              <ul className="ml-1 space-y-1.5">
                <li>• <strong className="text-text-primary">Assignment.</strong> Neither party may assign this MSA without the other's consent, except to a successor in a merger or sale of substantially all of its business.</li>
                <li>• <strong className="text-text-primary">Force majeure.</strong> Neither party is liable for delays caused by events beyond its reasonable control.</li>
                <li>• <strong className="text-text-primary">Independent parties.</strong> The parties are independent contractors; nothing creates a partnership or agency.</li>
                <li>• <strong className="text-text-primary">Notices.</strong> Notices must be in writing and sent to the contact details in the Order Form, or to {CONTACT_EMAIL} for Vireek.</li>
                <li>• <strong className="text-text-primary">Severability and waiver.</strong> If a term is unenforceable, the rest remains in effect, and failure to enforce a term is not a waiver.</li>
                <li>• <strong className="text-text-primary">Entire agreement.</strong> This MSA, the Order Form, and the incorporated policies are the entire agreement on their subject and replace earlier discussions.</li>
              </ul>
            </SectionBody>

            <SectionHeading id="changes-to-msa" number="16" title="Changes to This MSA" />
            <SectionBody>
              <p>
                We may update this MSA from time to time. A signed Order Form is governed by the
                version in effect when it was signed, and changes apply to that Order Form only
                when it renews or when the parties agree in writing. Material changes will be
                communicated to active customers by email.
              </p>
            </SectionBody>

            <SectionHeading id="contact-us" number="17" title="Contact Us" />
            <SectionBody>
              <p>
                To request a countersigned copy, negotiate terms, or ask a legal question, email
                us.
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
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">
                Related
              </p>
              <div className="mt-3 flex flex-col gap-2">
                <Link to="/terms" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Terms of Service &rarr;
                </Link>
                <Link to="/dpa" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Data Processing Agreement &rarr;
                </Link>
                <Link to="/sla" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Service Level Agreement &rarr;
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

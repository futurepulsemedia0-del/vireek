import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, TriangleAlert as AlertTriangle, ShieldCheck, Globe, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, viewport } from '@/lib/motion';

const CONTACT_EMAIL = 'ali@vireek.com';

interface Section {
  id: string;
  number: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'introduction-and-scope', number: '1', title: 'Introduction and Scope' },
  { id: 'definitions', number: '2', title: 'Definitions' },
  { id: 'roles-of-the-parties', number: '3', title: 'Roles of the Parties' },
  { id: 'subject-matter-and-duration', number: '4', title: 'Subject Matter and Duration' },
  { id: 'nature-and-purpose-of-processing', number: '5', title: 'Nature and Purpose of Processing' },
  { id: 'categories-of-data', number: '6', title: 'Categories of Data Subjects and Data' },
  { id: 'sub-processors', number: '7', title: 'Sub-processors' },
  { id: 'security-measures', number: '8', title: 'Security Measures' },
  { id: 'international-transfers', number: '9', title: 'International Data Transfers' },
  { id: 'data-subject-rights', number: '10', title: 'Assistance with Data Subject Rights' },
  { id: 'breach-notification', number: '11', title: 'Personal Data Breach Notification' },
  { id: 'return-or-deletion', number: '12', title: 'Return or Deletion of Data' },
  { id: 'audits', number: '13', title: 'Audits and Compliance' },
  { id: 'liability', number: '14', title: 'Liability' },
  { id: 'term-and-termination', number: '15', title: 'Term and Termination' },
  { id: 'requesting-a-copy', number: '16', title: 'Requesting a Countersigned Copy' },
  { id: 'contact', number: '17', title: 'Contact' },
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

export function DpaContent() {
  const [activeId, setActiveId] = useState<string>('introduction-and-scope');
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
                Data Processing Agreement
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: September 12, 2026</p>
            </motion.div>

            {/* Intro paragraph */}
            <div className="mt-8 rounded-2xl border border-border bg-bg-secondary p-6 text-base leading-relaxed text-text-secondary md:p-8">
              This Data Processing Agreement (&ldquo;DPA&rdquo;) forms part of the agreement between
              Vireek (&ldquo;Processor,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) and the business
              customer (&ldquo;Controller,&rdquo; &ldquo;you&rdquo;) for the provision of the Vireek AI
              voice receptionist service, and reflects the parties' agreement with respect to the
              processing of personal data.
            </div>

            {/* Section 1 */}
            <SectionHeading id="introduction-and-scope" number="1" title="Introduction and Scope" />
            <SectionBody>
              <p>
                This DPA applies whenever Vireek processes personal data on your behalf in the course
                of providing the service, including caller information captured during phone calls,
                lead and appointment details, and any other personal data submitted to Vireek through
                your account.
              </p>
              <p>
                In the event of a conflict between this DPA and the Terms of Service, this DPA controls
                with respect to the processing of personal data.
              </p>
            </SectionBody>

            {/* Section 2 */}
            <SectionHeading id="definitions" number="2" title="Definitions" />
            <SectionBody>
              <ul className="ml-1 space-y-2">
                <li>
                  • <strong className="text-text-primary">&ldquo;Personal Data&rdquo;</strong> means
                  any information relating to an identified or identifiable natural person processed
                  by Vireek on the Controller's behalf.
                </li>
                <li>
                  • <strong className="text-text-primary">&ldquo;Processing&rdquo;</strong> means any
                  operation performed on Personal Data, such as collection, recording, storage, use,
                  or deletion.
                </li>
                <li>
                  • <strong className="text-text-primary">&ldquo;Data Subject&rdquo;</strong> means the
                  individual to whom Personal Data relates, including callers and end customers.
                </li>
                <li>
                  • <strong className="text-text-primary">&ldquo;Sub-processor&rdquo;</strong> means any
                  third party engaged by Vireek to process Personal Data in support of the service.
                </li>
                <li>
                  • <strong className="text-text-primary">&ldquo;Applicable Data Protection Laws&rdquo;</strong>{' '}
                  means all laws and regulations applicable to the processing of Personal Data under
                  this DPA, including, where applicable, the GDPR and U.S. state privacy laws.
                </li>
              </ul>
            </SectionBody>

            {/* Section 3 */}
            <SectionHeading id="roles-of-the-parties" number="3" title="Roles of the Parties" />
            <SectionBody>
              <ul className="ml-1 space-y-2">
                <li>
                  • The Controller determines the purposes and means of processing Personal Data
                  collected through its use of Vireek.
                </li>
                <li>
                  • Vireek acts as a <strong className="text-text-primary">Processor</strong> (or
                  &ldquo;Service Provider&rdquo;/&ldquo;Processor&rdquo; under applicable U.S. state
                  law) and processes Personal Data only on the Controller's documented instructions,
                  as set out in this DPA and the underlying agreement.
                </li>
                <li>
                  • Vireek will not sell Personal Data or use it for any purpose other than providing
                  and improving the service, as permitted under Applicable Data Protection Laws.
                </li>
              </ul>
            </SectionBody>

            {/* Section 4 */}
            <SectionHeading id="subject-matter-and-duration" number="4" title="Subject Matter and Duration" />
            <SectionBody>
              <p>
                The subject matter of processing is the provision of the AI voice receptionist
                service. Processing will continue for the duration of the underlying agreement between
                the parties, and will terminate once that agreement ends and Personal Data has been
                returned or deleted in accordance with Section 12.
              </p>
            </SectionBody>

            {/* Section 5 */}
            <SectionHeading
              id="nature-and-purpose-of-processing"
              number="5"
              title="Nature and Purpose of Processing"
            />
            <SectionBody>
              <p>Vireek processes Personal Data to:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Answer, transcribe, and summarize incoming calls on the Controller's behalf</li>
                <li>• Qualify leads and detect potential emergencies</li>
                <li>• Book, reschedule, and confirm appointments</li>
                <li>• Send SMS and email confirmations</li>
                <li>• Sync data with the Controller's CRM and calendar integrations</li>
                <li>• Provide analytics, call history, and account support to the Controller</li>
              </ul>
            </SectionBody>

            {/* Section 6 */}
            <SectionHeading id="categories-of-data" number="6" title="Categories of Data Subjects and Data" />
            <SectionBody>
              <p>
                <strong className="text-text-primary">Data subjects</strong> may include the
                Controller's callers, customers, leads, and team members.
              </p>
              <p>
                <strong className="text-text-primary">Categories of Personal Data</strong> may include
                names, phone numbers, email addresses, service addresses, call recordings and
                transcripts, appointment details, and any other information a caller volunteers during
                a call. Vireek does not intentionally process special categories of data (such as
                health or financial account data) and asks Controllers not to route such information
                through the service.
              </p>
            </SectionBody>

            {/* Section 7 */}
            <SectionHeading id="sub-processors" number="7" title="Sub-processors" />
            <SectionBody>
              <p>
                The Controller provides general authorization for Vireek to engage Sub-processors to
                support the service, including categories such as:
              </p>
              <ul className="ml-1 space-y-1.5">
                <li>• Cloud hosting and database infrastructure</li>
                <li>• AI voice and telephony infrastructure</li>
                <li>• AI model providers used to process call transcripts and generate summaries</li>
                <li>• Payment processing</li>
                <li>• SMS and email delivery</li>
                <li>• Error monitoring and analytics</li>
              </ul>
              <ul className="ml-1 space-y-2 pt-2">
                <li>
                  • Vireek remains responsible for each Sub-processor's compliance with obligations
                  substantially similar to those in this DPA.
                </li>
                <li>
                  • Vireek will provide an up-to-date list of Sub-processors on request and will
                  notify Controllers of material changes to that list where required by Applicable
                  Data Protection Laws, giving the Controller an opportunity to object on reasonable
                  grounds.
                </li>
              </ul>
            </SectionBody>

            {/* Section 8 — Callout */}
            <div className="mt-10">
              <SectionHeading id="security-measures" number="8" title="Security Measures" />
              <div className="mt-5">
                <CalloutCard icon={ShieldCheck}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      Vireek maintains technical and organizational measures designed to protect
                      Personal Data against unauthorized access, loss, or disclosure, including:
                    </p>
                    <ul className="ml-1 space-y-1.5">
                      <li>• Encryption of data in transit and at rest</li>
                      <li>
                        • Row-level security so that one account can never access another account's
                        data
                      </li>
                      <li>• Access controls limiting internal access to Personal Data on a need-to-know basis</li>
                      <li>• Audit logging of sensitive account and security-relevant actions</li>
                      <li>• Regular review of vendor and infrastructure security practices</li>
                    </ul>
                  </div>
                </CalloutCard>
              </div>
            </div>

            {/* Section 9 — Callout */}
            <div className="mt-10">
              <SectionHeading id="international-transfers" number="9" title="International Data Transfers" />
              <div className="mt-5">
                <CalloutCard icon={Globe}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      Personal Data may be transferred to, and processed in, countries other than the
                      one in which it was originally collected, including the United States.
                    </p>
                    <p>
                      Where such transfers are subject to Applicable Data Protection Laws, Vireek will
                      rely on appropriate safeguards, such as Standard Contractual Clauses or an
                      equivalent lawful transfer mechanism, and will make details available to the
                      Controller on request.
                    </p>
                  </div>
                </CalloutCard>
              </div>
            </div>

            {/* Section 10 */}
            <SectionHeading id="data-subject-rights" number="10" title="Assistance with Data Subject Rights" />
            <SectionBody>
              <p>
                Taking into account the nature of the processing, Vireek will provide reasonable
                assistance to the Controller in responding to requests from data subjects seeking to
                exercise their rights (such as access, correction, or deletion) under Applicable Data
                Protection Laws. Requests received by Vireek directly from a data subject will be
                promptly forwarded to the relevant Controller.
              </p>
            </SectionBody>

            {/* Section 11 */}
            <SectionHeading id="breach-notification" number="11" title="Personal Data Breach Notification" />
            <SectionBody>
              <ul className="ml-1 space-y-2">
                <li>
                  • Vireek will notify the Controller{' '}
                  <strong className="text-text-primary">without undue delay</strong> after becoming
                  aware of a confirmed breach of security leading to the accidental or unlawful
                  destruction, loss, alteration, or unauthorized disclosure of Personal Data.
                </li>
                <li>
                  • The notification will describe, to the extent known at the time, the nature of the
                  breach, the categories and approximate number of data subjects and records
                  affected, and the measures taken or proposed to address the breach.
                </li>
                <li>
                  • Vireek will cooperate with the Controller and provide reasonably requested
                  information to help the Controller meet its own notification obligations.
                </li>
              </ul>
            </SectionBody>

            {/* Section 12 */}
            <SectionHeading id="return-or-deletion" number="12" title="Return or Deletion of Data" />
            <SectionBody>
              <p>
                Upon termination of the underlying agreement, and subject to any legal retention
                obligations, Vireek will delete or, at the Controller's written request, return
                Personal Data processed on the Controller's behalf within a commercially reasonable
                period.
              </p>
            </SectionBody>

            {/* Section 13 */}
            <SectionHeading id="audits" number="13" title="Audits and Compliance" />
            <SectionBody>
              <p>
                On reasonable request and no more than once per year, Vireek will make available
                information reasonably necessary to demonstrate compliance with this DPA, and will
                allow for, and contribute to, audits or inspections conducted by the Controller or an
                independent auditor mandated by the Controller, subject to reasonable confidentiality
                and scheduling safeguards.
              </p>
            </SectionBody>

            {/* Section 14 — Callout */}
            <div className="mt-10">
              <SectionHeading id="liability" number="14" title="Liability" />
              <div className="mt-5">
                <CalloutCard icon={AlertTriangle}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      Each party's liability arising out of or related to this DPA is subject to the
                      limitations of liability set out in the underlying agreement between the
                      parties, including the Terms of Service.
                    </p>
                  </div>
                </CalloutCard>
              </div>
            </div>

            {/* Section 15 */}
            <SectionHeading id="term-and-termination" number="15" title="Term and Termination" />
            <SectionBody>
              <p>
                This DPA takes effect on the date the Controller first begins using the service and
                remains in effect for as long as Vireek processes Personal Data on the Controller's
                behalf under the underlying agreement, unless terminated earlier in accordance with
                that agreement.
              </p>
            </SectionBody>

            {/* Section 16 */}
            <SectionHeading id="requesting-a-copy" number="16" title="Requesting a Countersigned Copy" />
            <SectionBody>
              <p>
                This page reflects Vireek's standard Data Processing Agreement terms and applies
                automatically to all customers. Enterprise customers who require a signed, downloadable
                copy for procurement or vendor-review purposes can request one — Vireek will
                countersign and return it.
              </p>
              <div className="mt-2 flex items-center gap-3">
                <Mail size={18} className="text-accent" />
                <a
                  href={`mailto:${CONTACT_EMAIL}?subject=DPA%20Countersignature%20Request`}
                  className="text-lg font-semibold text-accent hover:underline"
                >
                  {CONTACT_EMAIL}
                </a>
              </div>
            </SectionBody>

            {/* Section 17 */}
            <SectionHeading id="contact" number="17" title="Contact" />
            <SectionBody>
              <p>Questions about this DPA? Email us and we'll get back to you.</p>
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

            {/* Cross-links */}
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
                  to="/terms"
                  className="flex items-center gap-2 text-base font-semibold text-accent hover:underline"
                >
                  Terms of Service &rarr;
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

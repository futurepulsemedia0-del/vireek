import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, ShieldCheck, Mail } from 'lucide-react';
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
  { id: 'definitions', number: '2', title: 'Definitions' },
  { id: 'roles-of-the-parties', number: '3', title: 'Roles of the Parties' },
  { id: 'scope-and-duration', number: '4', title: 'Scope and Duration of Processing' },
  { id: 'sub-processors', number: '5', title: 'Sub-processors' },
  { id: 'security-measures', number: '6', title: 'Security Measures' },
  { id: 'international-transfers', number: '7', title: 'International Data Transfers' },
  { id: 'data-subject-rights', number: '8', title: 'Assistance With Data Subject Rights' },
  { id: 'breach-notification', number: '9', title: 'Data Breach Notification' },
  { id: 'audit-rights', number: '10', title: 'Audit Rights' },
  { id: 'requesting-a-copy', number: '11', title: 'Requesting a Countersigned Copy' },
  { id: 'contact-us', number: '12', title: 'Contact Us' },
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

function SectionBody({ children }: { children: ReactNode }) {
  return <div className="mt-4 space-y-4 text-base leading-relaxed text-text-secondary">{children}</div>;
}

export function DpaContent() {
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
                Data Processing Agreement
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: August 20, 2026</p>
            </motion.div>

            {/* Intro paragraph */}
            <div className="mt-8 rounded-2xl border border-border bg-bg-secondary p-6 text-base leading-relaxed text-text-secondary md:p-8">
              This Data Processing Agreement ("DPA") forms part of the agreement between Vireek
              ("Processor") and the business customer identified on the applicable order form or
              account ("Controller") and governs Vireek's processing of personal data on the
              Controller's behalf in connection with the Vireek AI voice receptionist service.
              Capitalized terms not otherwise defined here have the meaning given to them in
              Vireek's Terms of Service and Privacy Policy.
            </div>

            {/* Section 1 */}
            <SectionHeading id="introduction" number="1" title="Introduction" />
            <SectionBody>
              <p>
                Where the Controller's use of the Vireek service involves the processing of
                personal data that is subject to data protection laws such as the EU/UK GDPR or
                applicable US state privacy laws, this DPA sets out the terms on which that
                processing takes place, so the Controller can meet its own compliance obligations
                to regulators and to the individuals whose data is processed.
              </p>
              <p>
                This DPA does not replace or limit the commitments in Vireek's Privacy Policy — it
                supplements them with the specific contractual terms required between a data
                controller and its processor.
              </p>
            </SectionBody>

            {/* Section 2 */}
            <SectionHeading id="definitions" number="2" title="Definitions" />
            <SectionBody>
              <ul className="ml-1 space-y-1.5">
                <li>
                  • <strong className="text-text-primary">Personal Data</strong> — any information
                  relating to an identified or identifiable natural person that is processed by
                  Vireek on the Controller's behalf (e.g. a caller's name, phone number, or call
                  transcript).
                </li>
                <li>
                  • <strong className="text-text-primary">Processing</strong> — any operation
                  performed on Personal Data, including collection, storage, transcription,
                  analysis, and deletion.
                </li>
                <li>
                  • <strong className="text-text-primary">Sub-processor</strong> — any third party
                  engaged by Vireek to process Personal Data in order to provide the service.
                </li>
                <li>
                  • <strong className="text-text-primary">Data Subject</strong> — the individual to
                  whom Personal Data relates, typically a caller or a member of the Controller's
                  team.
                </li>
              </ul>
            </SectionBody>

            {/* Section 3 */}
            <SectionHeading id="roles-of-the-parties" number="3" title="Roles of the Parties" />
            <SectionBody>
              <p>
                For the purposes of applicable data protection law, the Controller is the data
                controller (or "business") and Vireek is the data processor (or "service
                provider") with respect to Personal Data processed through the Vireek service. The
                Controller determines the purposes and means of processing; Vireek processes
                Personal Data only on the Controller's documented instructions, as set out in this
                DPA and the underlying agreement.
              </p>
            </SectionBody>

            {/* Section 4 */}
            <SectionHeading id="scope-and-duration" number="4" title="Scope and Duration of Processing" />
            <SectionBody>
              <p>
                Vireek processes Personal Data for as long as necessary to provide the service to
                the Controller under the underlying agreement, and in accordance with the
                retention periods described in Vireek's Privacy Policy. Processing includes:
              </p>
              <ul className="ml-1 space-y-1.5">
                <li>• Answering, transcribing, and summarizing inbound calls</li>
                <li>• Detecting emergencies and routing live transfers</li>
                <li>• Booking, scheduling, and job/lead management</li>
                <li>• Sending SMS and email notifications on the Controller's behalf</li>
              </ul>
              <p>
                On termination of the underlying agreement, Vireek will delete or return Personal
                Data in accordance with the Controller's instructions, except where retention is
                required by law.
              </p>
            </SectionBody>

            {/* Section 5 */}
            <SectionHeading id="sub-processors" number="5" title="Sub-processors" />
            <SectionBody>
              <p>
                The Controller authorizes Vireek to engage sub-processors to provide the service —
                for example, cloud hosting, AI voice/telephony infrastructure, and payment
                processing providers. Vireek remains responsible for each sub-processor's
                compliance with data protection obligations equivalent to those in this DPA.
              </p>
              <p>
                Vireek will notify Controllers of any intended change involving the addition or
                replacement of a sub-processor, giving the Controller the opportunity to object on
                reasonable data-protection grounds.
              </p>
            </SectionBody>

            {/* Section 6 — Callout */}
            <div className="mt-10">
              <SectionHeading id="security-measures" number="6" title="Security Measures" />
              <div className="mt-5">
                <CalloutCard icon={ShieldCheck}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      Vireek maintains technical and organizational measures designed to protect
                      Personal Data against unauthorized access, loss, or disclosure, including:
                    </p>
                    <ul className="ml-1 space-y-2">
                      <li>• Encryption of data in transit and at rest</li>
                      <li>• Role-based access controls and least-privilege access to production systems</li>
                      <li>• Logging and monitoring of access to Personal Data</li>
                      <li>• Regular review of security practices as the service evolves</li>
                    </ul>
                  </div>
                </CalloutCard>
              </div>
            </div>

            {/* Section 7 */}
            <SectionHeading id="international-transfers" number="7" title="International Data Transfers" />
            <SectionBody>
              <p>
                Where Personal Data is transferred outside the country or region in which it was
                collected, Vireek relies on legally recognized transfer mechanisms — such as
                Standard Contractual Clauses — where required, to ensure the data continues to
                benefit from an equivalent level of protection.
              </p>
            </SectionBody>

            {/* Section 8 */}
            <SectionHeading id="data-subject-rights" number="8" title="Assistance With Data Subject Rights" />
            <SectionBody>
              <p>
                Taking into account the nature of the processing, Vireek will provide reasonable
                assistance to the Controller in responding to requests from Data Subjects seeking
                to exercise their rights (such as access, correction, or deletion), to the extent
                the Controller cannot reasonably fulfill such requests on its own.
              </p>
            </SectionBody>

            {/* Section 9 */}
            <SectionHeading id="breach-notification" number="9" title="Data Breach Notification" />
            <SectionBody>
              <p>
                Vireek will notify the Controller without undue delay after becoming aware of a
                confirmed breach of security leading to accidental or unlawful destruction, loss,
                alteration, or unauthorized disclosure of Personal Data processed on the
                Controller's behalf, and will provide information reasonably available to help the
                Controller meet its own notification obligations.
              </p>
            </SectionBody>

            {/* Section 10 */}
            <SectionHeading id="audit-rights" number="10" title="Audit Rights" />
            <SectionBody>
              <p>
                Vireek will make available to the Controller information reasonably necessary to
                demonstrate compliance with this DPA, and will allow for and contribute to audits,
                including inspections conducted by the Controller or an independent auditor
                mandated by the Controller, subject to reasonable notice and confidentiality
                safeguards.
              </p>
            </SectionBody>

            {/* Section 11 */}
            <SectionHeading id="requesting-a-copy" number="11" title="Requesting a Countersigned Copy" />
            <SectionBody>
              <p>
                Enterprise customers who need a fully executed, countersigned copy of this DPA for
                procurement or compliance purposes can request one by emailing our team with your
                company name and account details. We typically respond within one business day.
              </p>
            </SectionBody>

            {/* Section 12 */}
            <SectionHeading id="contact-us" number="12" title="Contact Us" />
            <SectionBody>
              <p>Questions about this DPA, or need a signed copy? Email us and we'll get back to you.</p>
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
              <Link
                to="/privacy"
                className="mt-3 flex items-center gap-2 text-base font-semibold text-accent hover:underline"
              >
                Privacy Policy &rarr;
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

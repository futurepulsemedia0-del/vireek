import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Globe, ShieldCheck, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, viewport } from '@/lib/motion';

const CONTACT_EMAIL = 'ali@vireek.com';

interface Section {
  id: string;
  number: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'introduction', number: '1', title: 'Introduction & Relationship to the DPA' },
  { id: 'roles-of-parties', number: '2', title: 'Roles of the Parties' },
  { id: 'transfer-mechanism', number: '3', title: 'International Transfer Mechanism' },
  { id: 'sub-processors', number: '4', title: 'Sub-processors' },
  { id: 'data-subject-rights', number: '5', title: 'Data Subject Rights Under GDPR' },
  { id: 'breach-notification', number: '6', title: 'Breach Notification' },
  { id: 'transfer-impact', number: '7', title: 'Transfer Impact Assessment' },
  { id: 'requesting-a-copy', number: '8', title: 'Requesting a Signed Copy' },
  { id: 'contact-us', number: '9', title: 'Contact Us' },
];

function CalloutCard({ icon: Icon, children }: { icon: typeof Globe; children: ReactNode }) {
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
            EU / UK / Swiss Data
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

export function GdprDpaContent() {
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
                EU/UK GDPR Data Processing Addendum
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: September 12, 2026</p>
            </motion.div>

            <SectionHeading id="introduction" number="1" title="Introduction & Relationship to the DPA" />
            <SectionBody>
              <p>
                This addendum applies specifically to personal data protected by the EU General
                Data Protection Regulation ("GDPR"), the UK GDPR, or the Swiss Federal Act on Data
                Protection. It supplements &mdash; and does not replace &mdash; our general{' '}
                <Link to="/dpa" className="font-semibold text-accent hover:underline">
                  Data Processing Agreement
                </Link>
                . Where a conflict exists between the two for EU/UK/Swiss personal data, this
                addendum controls.
              </p>
            </SectionBody>

            <SectionHeading id="roles-of-parties" number="2" title="Roles of the Parties" />
            <SectionBody>
              <p>
                For personal data subject to the GDPR, the Controller remains the data controller
                and Vireek acts as processor, processing personal data only on the Controller's
                documented instructions as described in the main DPA and this addendum.
              </p>
            </SectionBody>

            <div className="mt-10">
              <SectionHeading id="transfer-mechanism" number="3" title="International Transfer Mechanism" />
              <div className="mt-5">
                <CalloutCard icon={Globe}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      Where personal data originating in the EU, UK, or Switzerland is transferred
                      to a country that has not received an adequacy decision, the transfer is
                      governed by the{' '}
                      <strong className="text-text-primary">
                        European Commission's Standard Contractual Clauses ("SCCs")
                      </strong>
                      , incorporated by reference into this addendum, together with the UK
                      International Data Transfer Addendum where applicable.
                    </p>
                    <p>
                      Enterprise customers who need the fully executed SCC annexes for their own
                      records can request them using the contact details below.
                    </p>
                  </div>
                </CalloutCard>
              </div>
            </div>

            <SectionHeading id="sub-processors" number="4" title="Sub-processors" />
            <SectionBody>
              <p>
                Vireek's current list of sub-processors, including those that may process EU/UK/Swiss
                personal data, is published on our{' '}
                <Link to="/subprocessors" className="font-semibold text-accent hover:underline">
                  Sub-processor List
                </Link>
                . Vireek imposes data protection obligations on each sub-processor that are no less
                protective than those in this addendum, and will notify Controllers of any material
                change to that list.
              </p>
            </SectionBody>

            <SectionHeading id="data-subject-rights" number="5" title="Data Subject Rights Under GDPR" />
            <SectionBody>
              <p>
                Taking into account the nature of the processing, Vireek will assist the Controller,
                by appropriate technical and organizational measures, in fulfilling its obligation
                to respond to requests from data subjects exercising their GDPR rights (access,
                rectification, erasure, restriction, portability, and objection).
              </p>
            </SectionBody>

            <SectionHeading id="breach-notification" number="6" title="Breach Notification" />
            <SectionBody>
              <p>
                Vireek will notify the Controller without undue delay, and in any case within{' '}
                <strong className="text-text-primary">72 hours</strong> of becoming aware, of a
                confirmed personal data breach affecting EU/UK/Swiss personal data, so the
                Controller can meet its own regulatory notification obligations under Article 33
                GDPR.
              </p>
            </SectionBody>

            <SectionHeading id="transfer-impact" number="7" title="Transfer Impact Assessment" />
            <SectionBody>
              <p>
                Vireek will provide Controllers with reasonably requested information about the
                data protection laws and government access regimes applicable to the countries
                where sub-processors operate, to support the Controller's own transfer impact
                assessment where required.
              </p>
            </SectionBody>

            <SectionHeading id="requesting-a-copy" number="8" title="Requesting a Signed Copy" />
            <SectionBody>
              <p>
                Enterprise customers who need a countersigned copy of this addendum together with
                the SCC annexes for procurement or regulatory purposes can request one by emailing
                our team with their company name and account details.
              </p>
            </SectionBody>

            <SectionHeading id="contact-us" number="9" title="Contact Us" />
            <SectionBody>
              <p>Questions about this addendum, or need a signed copy? Email us.</p>
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
                <Link to="/dpa" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Data Processing Agreement &rarr;
                </Link>
                <Link to="/subprocessors" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Sub-processor List &rarr;
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Mail, ShieldAlert } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { EASE, viewport } from '@/lib/motion';
import { DmcaForm } from '@/components/dmca/DmcaForm';
import { DMCA_AGENT, type DmcaNoticeType } from '@/lib/dmca';

interface Section {
  id: string;
  number: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'overview', number: '1', title: 'Overview' },
  { id: 'what-to-include', number: '2', title: 'What a Copyright Notice Must Include' },
  { id: 'submit-notice', number: '3', title: 'Submit a Notice Online' },
  { id: 'what-happens-next', number: '4', title: 'What Happens Next' },
  { id: 'counter-notification', number: '5', title: 'Counter-Notification' },
  { id: 'repeat-infringers', number: '6', title: 'Repeat Infringers' },
  { id: 'misrepresentations', number: '7', title: 'False or Mistaken Claims' },
  { id: 'designated-agent', number: '8', title: 'Designated Copyright Agent' },
  { id: 'other-concerns', number: '9', title: 'Other Kinds of Complaints' },
];

function CalloutCard({ icon: Icon, label, children }: { icon: typeof ShieldAlert; label: string; children: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border-2 border-accent/40 bg-accent/[0.04] p-6 md:p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: 'radial-gradient(circle at 0% 0%, rgb(var(--accent-primary) / 0.10), transparent 50%)' }}
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
          <span className="ml-1 text-base font-normal text-text-secondary/0 transition-colors group-hover:text-text-secondary/60">#</span>
        </h2>
      </a>
    </div>
  );
}

function SectionBody({ children }: { children: ReactNode }) {
  return <div className="mt-4 space-y-4 text-base leading-relaxed text-text-secondary">{children}</div>;
}

export function DmcaContent() {
  const [activeId, setActiveId] = useState<string>('overview');
  const [mobileTocOpen, setMobileTocOpen] = useState(false);
  const [searchParams] = useSearchParams();
  const initialType: DmcaNoticeType = searchParams.get('type') === 'counter' ? 'counter' : 'takedown';

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-96px 0px -72% 0px' },
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  // Deep link: /dmca?type=counter jumps straight to the form.
  useEffect(() => {
    if (searchParams.get('type') !== 'counter') return;
    document.getElementById('submit-notice')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [searchParams]);

  const mailtoNotice = `mailto:${DMCA_AGENT.email}?subject=${encodeURIComponent('DMCA notice')}`;

  return (
    <section className="py-28 md:py-32">
      <div className="mx-auto max-w-7xl px-6">
        <div className="grid gap-12 lg:grid-cols-[16rem_1fr] lg:gap-16">
          <aside className="hidden lg:block">
            <div className="sticky top-28">
              <p className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">Table of Contents</p>
              <nav aria-label="Table of contents" className="flex flex-col gap-1 border-l border-border">
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

          <div className="min-w-0 max-w-3xl">
            <div className="mb-8 lg:hidden">
              <button
                type="button"
                aria-expanded={mobileTocOpen}
                onClick={() => setMobileTocOpen((v) => !v)}
                className="focus-ring flex min-h-[48px] w-full items-center justify-between rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm font-medium text-text-primary"
              >
                Jump to section
                <ChevronDown
                  size={18}
                  aria-hidden="true"
                  className={`text-text-secondary transition-transform ${mobileTocOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {mobileTocOpen && (
                <nav aria-label="Table of contents" className="mt-2 flex flex-col gap-1 rounded-xl border border-border bg-bg-secondary p-3">
                  {SECTIONS.map((s) => (
                    <a
                      key={s.id}
                      href={`#${s.id}`}
                      onClick={() => setMobileTocOpen(false)}
                      className={`rounded-lg px-3 py-2.5 text-sm transition-colors ${
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
                DMCA &amp; Copyright Complaints
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: October 8, 2026</p>
            </motion.div>

            {/* 1 */}
            <SectionHeading id="overview" number="1" title="Overview" />
            <SectionBody>
              <p>
                Vireek respects the intellectual property rights of others and expects everyone who uses our websites and
                services to do the same. This page explains how to report content you believe infringes your copyright, and how
                to respond if your own content was removed because of a complaint.
              </p>
              <p>
                We follow the notice-and-takedown process of the U.S. Digital Millennium Copyright Act (17 U.S.C. § 512).
                This page is general information, not legal advice. If you are unsure whether something is infringing, consider
                speaking with a lawyer first.
              </p>
            </SectionBody>
            <div className="mt-6">
              <CalloutCard icon={ShieldAlert} label="Fastest way to reach us">
                <div className="space-y-3 text-base leading-relaxed text-text-secondary">
                  <p>
                    Use the <a href="#submit-notice" className="font-semibold text-accent hover:underline">online form</a> below
                    — it collects everything the law requires, so your notice can be acted on without back-and-forth.
                  </p>
                  <p>
                    Prefer email? Write to our{' '}
                    <a href="#designated-agent" className="font-semibold text-accent hover:underline">designated copyright agent</a>.
                  </p>
                </div>
              </CalloutCard>
            </div>

            {/* 2 */}
            <SectionHeading id="what-to-include" number="2" title="What a Copyright Notice Must Include" />
            <SectionBody>
              <p>To be effective under the DMCA, a notice of claimed infringement must be in writing and include:</p>
              <ol className="ml-1 list-none space-y-2">
                <li>1. A physical or electronic signature of the copyright owner or a person authorized to act on their behalf.</li>
                <li>2. Identification of the copyrighted work you claim has been infringed (or a representative list, if one notice covers several works on the same site).</li>
                <li>3. Identification of the material you claim is infringing, with information reasonably sufficient for us to locate it — such as a link.</li>
                <li>4. Your contact information: name, mailing address, and, if available, telephone number and email.</li>
                <li>5. A statement that you have a good faith belief that the use is not authorized by the copyright owner, its agent, or the law.</li>
                <li>6. A statement that the information in the notice is accurate, and, under penalty of perjury, that you are the owner of an exclusive right that is allegedly infringed or are authorized to act on the owner’s behalf.</li>
              </ol>
              <p>
                A notice that doesn’t substantially include these elements may not be actionable, and we may contact you for
                more information before taking any action.
              </p>
            </SectionBody>

            {/* 3 */}
            <SectionHeading id="submit-notice" number="3" title="Submit a Notice Online" />
            <SectionBody>
              <p>
                Choose <strong className="text-text-primary">Report infringement</strong> if material on Vireek copies your
                work, or <strong className="text-text-primary">Submit a counter-notification</strong> if your own content was
                removed and you believe that was a mistake.
              </p>
              <p>
                Please note: we may forward your notice, including your name and contact details, to the user who posted the
                material. Only include information you are comfortable sharing. See our{' '}
                <Link to="/privacy" className="font-semibold text-accent hover:underline">Privacy Policy</Link> for how we
                handle personal data.
              </p>
            </SectionBody>
            <div className="mt-6 rounded-2xl border border-border bg-bg-secondary p-4 sm:p-6 md:p-8">
              <DmcaForm key={initialType} initialType={initialType} />
            </div>

            {/* 4 */}
            <SectionHeading id="what-happens-next" number="4" title="What Happens Next" />
            <SectionBody>
              <ol className="ml-1 list-none space-y-2">
                <li>1. <strong className="text-text-primary">Review.</strong> Our copyright agent checks your notice for completeness.</li>
                <li>2. <strong className="text-text-primary">Action.</strong> If the notice is complete, we act expeditiously to remove or disable access to the identified material.</li>
                <li>3. <strong className="text-text-primary">Notice to the user.</strong> We tell the user who posted the material, share a copy of the notice, and explain how to file a counter-notification.</li>
                <li>4. <strong className="text-text-primary">If there’s no counter-notification,</strong> the material stays down.</li>
                <li>5. <strong className="text-text-primary">If there is one,</strong> we forward it to you. Unless we first receive notice that you have filed a court action seeking to restrain the user, we may restore the material between 10 and 14 business days after receiving the counter-notification.</li>
              </ol>
            </SectionBody>

            {/* 5 */}
            <SectionHeading id="counter-notification" number="5" title="Counter-Notification" />
            <SectionBody>
              <p>
                If your content was removed and you believe the removal was a mistake or a misidentification, you may send us a
                counter-notification. It must be in writing and include:
              </p>
              <ol className="ml-1 list-none space-y-2">
                <li>1. Your physical or electronic signature.</li>
                <li>2. Identification of the material that was removed and where it appeared before removal.</li>
                <li>3. A statement, under penalty of perjury, that you have a good faith belief the material was removed because of mistake or misidentification.</li>
                <li>4. Your name, address, and telephone number, plus a statement that you consent to the jurisdiction of the Federal District Court for the district where you live (or, outside the United States, any district where Vireek may be found) and that you will accept service of process from the person who sent the original notice.</li>
              </ol>
              <p>
                <Link to="/dmca?type=counter" className="font-semibold text-accent hover:underline">
                  Open the counter-notification form &rarr;
                </Link>
              </p>
            </SectionBody>

            {/* 6 */}
            <SectionHeading id="repeat-infringers" number="6" title="Repeat Infringers" />
            <SectionBody>
              <p>
                In appropriate circumstances, Vireek will disable or terminate the accounts of users who are repeat
                infringers of copyright.
              </p>
            </SectionBody>

            {/* 7 */}
            <SectionHeading id="misrepresentations" number="7" title="False or Mistaken Claims" />
            <SectionBody>
              <p>
                Under 17 U.S.C. § 512(f), anyone who knowingly and materially misrepresents that material is infringing, or
                that it was removed by mistake, may be liable for damages — including costs and attorneys’ fees.
              </p>
              <p>
                Before you submit a notice, please consider whether the use could be a fair use or otherwise permitted by law.
                We may reject notices that are incomplete, abusive, or clearly unfounded.
              </p>
            </SectionBody>

            {/* 8 */}
            <SectionHeading id="designated-agent" number="8" title="Designated Copyright Agent" />
            <SectionBody>
              <p>Written notices and counter-notifications can also be sent to:</p>
              <address className="rounded-2xl border border-border bg-bg-secondary p-5 not-italic leading-relaxed text-text-primary">
                <span className="block font-semibold">{DMCA_AGENT.contactName}</span>
                <span className="block">{DMCA_AGENT.company}</span>
                {DMCA_AGENT.mailingAddress && <span className="block whitespace-pre-line">{DMCA_AGENT.mailingAddress}</span>}
                {DMCA_AGENT.phone && <span className="block">{DMCA_AGENT.phone}</span>}
              </address>
              <div className="mt-2 flex items-center gap-3">
                <Mail size={18} className="text-accent" aria-hidden="true" />
                <a href={mailtoNotice} className="break-all text-lg font-semibold text-accent hover:underline">
                  {DMCA_AGENT.email}
                </a>
              </div>
              <p>For the fastest processing, please use the online form above rather than email.</p>
            </SectionBody>

            {/* 9 */}
            <SectionHeading id="other-concerns" number="9" title="Other Kinds of Complaints" />
            <SectionBody>
              <p>This page is only for copyright. For anything else:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Misuse of the Vireek name or logo: see our <Link to="/trademark-policy" className="font-semibold text-accent hover:underline">Trademark Policy</Link>.</li>
                <li>• Abusive, unlawful, or harmful content: see our <Link to="/acceptable-use-policy" className="font-semibold text-accent hover:underline">Acceptable Use Policy</Link>.</li>
                <li>• A security vulnerability: see <Link to="/vulnerability-disclosure" className="font-semibold text-accent hover:underline">Vulnerability Disclosure</Link>.</li>
                <li>• Anything else: <Link to="/contact" className="font-semibold text-accent hover:underline">contact us</Link>.</li>
              </ul>
            </SectionBody>

            <div className="mt-12 rounded-2xl border border-border bg-bg-secondary p-6 md:p-8">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">Related</p>
              <div className="mt-3 flex flex-col gap-2">
                <Link to="/terms" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Terms of Service &rarr;
                </Link>
                <Link to="/acceptable-use-policy" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Acceptable Use Policy &rarr;
                </Link>
                <Link to="/trademark-policy" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Trademark Policy &rarr;
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

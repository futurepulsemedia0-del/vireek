import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Scale, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, viewport } from '@/lib/motion';

const CONTACT_EMAIL = 'ali@vireek.com';

interface Section {
  id: string;
  number: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'who-this-is-for', number: '1', title: 'Who This Page Is For' },
  { id: 'categories-collected', number: '2', title: 'Categories of Personal Information We Collect' },
  { id: 'your-rights', number: '3', title: 'Your Rights Under CCPA/CPRA' },
  { id: 'sale-and-sharing', number: '4', title: 'Do We Sell or Share Personal Information?' },
  { id: 'sensitive-information', number: '5', title: 'Sensitive Personal Information' },
  { id: 'authorized-agents', number: '6', title: 'Authorized Agents' },
  { id: 'non-discrimination', number: '7', title: 'Non-Discrimination' },
  { id: 'how-to-exercise', number: '8', title: 'How to Exercise Your Rights' },
  { id: 'contact-us', number: '9', title: 'Contact Us' },
];

function CalloutCard({ icon: Icon, children }: { icon: typeof Scale; children: ReactNode }) {
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
            Key Disclosure
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

export function CcpaContent() {
  const [activeId, setActiveId] = useState<string>('who-this-is-for');
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
                California Privacy Rights
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: September 12, 2026</p>
            </motion.div>

            <SectionHeading id="who-this-is-for" number="1" title="Who This Page Is For" />
            <SectionBody>
              <p>
                This page supplements our{' '}
                <Link to="/privacy" className="font-semibold text-accent hover:underline">
                  Privacy Policy
                </Link>{' '}
                and provides additional disclosures required by the California Consumer Privacy
                Act, as amended by the California Privacy Rights Act ("CCPA/CPRA"), for California
                residents.
              </p>
            </SectionBody>

            <SectionHeading id="categories-collected" number="2" title="Categories of Personal Information We Collect" />
            <SectionBody>
              <ul className="ml-1 space-y-1.5">
                <li>• Identifiers (name, email, phone number, account ID)</li>
                <li>• Customer records (billing name, business address, payment method details held by our payment processor)</li>
                <li>• Commercial information (subscription plan, billing history)</li>
                <li>• Audio/electronic information (call recordings and transcripts processed on your behalf)</li>
                <li>• Internet or network activity (dashboard usage and analytics, where enabled)</li>
              </ul>
            </SectionBody>

            <div className="mt-10">
              <SectionHeading id="your-rights" number="3" title="Your Rights Under CCPA/CPRA" />
              <div className="mt-5">
                <CalloutCard icon={Scale}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>If you are a California resident, you have the right to:</p>
                    <ul className="ml-1 space-y-2">
                      <li>• <strong className="text-text-primary">Know</strong> what personal information we collect, use, and disclose about you</li>
                      <li>• <strong className="text-text-primary">Delete</strong> personal information we hold about you, subject to certain exceptions</li>
                      <li>• <strong className="text-text-primary">Correct</strong> inaccurate personal information</li>
                      <li>• <strong className="text-text-primary">Opt out</strong> of the sale or sharing of your personal information</li>
                      <li>• <strong className="text-text-primary">Limit</strong> the use of sensitive personal information</li>
                      <li>• Not be discriminated against for exercising any of these rights</li>
                    </ul>
                  </div>
                </CalloutCard>
              </div>
            </div>

            <SectionHeading id="sale-and-sharing" number="4" title="Do We Sell or Share Personal Information?" />
            <SectionBody>
              <p>
                <strong className="text-text-primary">Vireek does not sell personal information</strong>{' '}
                for money, and does not share personal information with third parties for
                cross-context behavioral advertising. There is currently nothing to opt out of in
                this regard, and this page will be updated if that ever changes.
              </p>
            </SectionBody>

            <SectionHeading id="sensitive-information" number="5" title="Sensitive Personal Information" />
            <SectionBody>
              <p>
                We use sensitive personal information (such as account login credentials) only as
                reasonably necessary to provide the service, and not to infer characteristics about
                you. You may request that we limit this use by contacting us.
              </p>
            </SectionBody>

            <SectionHeading id="authorized-agents" number="6" title="Authorized Agents" />
            <SectionBody>
              <p>
                You may designate an authorized agent to submit a CCPA/CPRA request on your behalf.
                We may require proof of the agent's authorization and may still need to verify your
                identity directly.
              </p>
            </SectionBody>

            <SectionHeading id="non-discrimination" number="7" title="Non-Discrimination" />
            <SectionBody>
              <p>
                We will not deny you service, charge you a different price, or provide a different
                level of service because you exercised any right under the CCPA/CPRA.
              </p>
            </SectionBody>

            <SectionHeading id="how-to-exercise" number="8" title="How to Exercise Your Rights" />
            <SectionBody>
              <p>
                Email us with "CCPA Request" in the subject line, describing which right you'd like
                to exercise. We may ask you to verify your identity before processing your request,
                and we will respond within the timeframes required by law.
              </p>
            </SectionBody>

            <SectionHeading id="contact-us" number="9" title="Contact Us" />
            <SectionBody>
              <p>Questions about your California privacy rights? Email us.</p>
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
              <Link to="/privacy" className="mt-3 flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                Privacy Policy &rarr;
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

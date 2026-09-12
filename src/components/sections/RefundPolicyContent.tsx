import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, RotateCcw, Mail } from 'lucide-react';
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
  { id: 'billing-cycle', number: '2', title: 'Billing Cycle & Renewals' },
  { id: 'cancellation', number: '3', title: 'Cancellation' },
  { id: 'refund-eligibility', number: '4', title: 'Refund Eligibility' },
  { id: 'free-trial', number: '5', title: 'Free Trial & Onboarding Period' },
  { id: 'plan-changes', number: '6', title: 'Upgrades, Downgrades & Plan Changes' },
  { id: 'billing-errors', number: '7', title: 'Billing Errors & Duplicate Charges' },
  { id: 'chargebacks', number: '8', title: 'Chargebacks' },
  { id: 'how-to-request', number: '9', title: 'How to Request a Refund' },
  { id: 'contact-us', number: '10', title: 'Contact Us' },
];

function CalloutCard({ icon: Icon, children }: { icon: typeof RotateCcw; children: ReactNode }) {
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
            Key Takeaway
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

export function RefundPolicyContent() {
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
                Refund & Cancellation Policy
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: September 12, 2026</p>
            </motion.div>

            <SectionHeading id="introduction" number="1" title="Introduction" />
            <SectionBody>
              <p>
                This Refund and Cancellation Policy explains how billing works for Vireek
                subscriptions, how to cancel your account, and the circumstances under which a
                refund may be issued. It supplements, and should be read alongside, our{' '}
                <Link to="/terms" className="font-semibold text-accent hover:underline">
                  Terms of Service
                </Link>
                .
              </p>
            </SectionBody>

            <SectionHeading id="billing-cycle" number="2" title="Billing Cycle & Renewals" />
            <SectionBody>
              <ul className="ml-1 space-y-1.5">
                <li>• Paid plans are billed in advance, either monthly or annually depending on the billing cycle you select.</li>
                <li>• Subscriptions renew automatically at the end of each billing period unless canceled beforehand.</li>
                <li>• Usage beyond your plan's included minutes is billed at the overage rate listed on your plan.</li>
              </ul>
            </SectionBody>

            <SectionHeading id="cancellation" number="3" title="Cancellation" />
            <SectionBody>
              <p>
                You may cancel your subscription at any time from your account billing settings, or
                by emailing us. Cancellation takes effect at the{' '}
                <strong className="text-text-primary">end of your current billing period</strong> —
                you retain access to paid features until that date, and you will not be charged
                again afterward.
              </p>
              <p>There are no long-term contracts and no early-termination fees.</p>
            </SectionBody>

            <div className="mt-10">
              <SectionHeading id="refund-eligibility" number="4" title="Refund Eligibility" />
              <div className="mt-5">
                <CalloutCard icon={RotateCcw}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      As a general rule,{' '}
                      <strong className="text-text-primary">
                        fees already billed for a subscription period are non-refundable
                      </strong>{' '}
                      once that period has begun, except where required by applicable law or as
                      described below. This reflects that minutes, phone number provisioning, and
                      infrastructure costs are incurred by us as soon as a billing period starts.
                    </p>
                    <p>We will issue a refund at our discretion when:</p>
                    <ul className="ml-1 space-y-2">
                      <li>• You were billed due to a verified error on our part (see Section 7).</li>
                      <li>• You cancel within the first 7 days of your first paid subscription and have made minimal use of the service.</li>
                      <li>• A refund is required under the consumer protection law of your jurisdiction.</li>
                    </ul>
                  </div>
                </CalloutCard>
              </div>
            </div>

            <SectionHeading id="free-trial" number="5" title="Free Trial & Onboarding Period" />
            <SectionBody>
              <p>
                If you start on a free plan or a free trial, you are not charged until you actively
                choose to upgrade to a paid plan. Because no payment is collected during a free
                trial, there is nothing to refund for that period.
              </p>
            </SectionBody>

            <SectionHeading id="plan-changes" number="6" title="Upgrades, Downgrades & Plan Changes" />
            <SectionBody>
              <ul className="ml-1 space-y-1.5">
                <li>• Upgrading takes effect immediately; any price difference is prorated for the remainder of the current billing period.</li>
                <li>• Downgrading takes effect at the start of your next billing period; you keep your current plan's features until then.</li>
                <li>• We do not refund the difference in price when you downgrade mid-period.</li>
              </ul>
            </SectionBody>

            <SectionHeading id="billing-errors" number="7" title="Billing Errors & Duplicate Charges" />
            <SectionBody>
              <p>
                If you believe you were charged in error — such as a duplicate charge, an incorrect
                amount, or a charge after you already canceled — contact us right away. Verified
                billing errors are corrected and refunded in full, regardless of the general policy
                in Section 4.
              </p>
            </SectionBody>

            <SectionHeading id="chargebacks" number="8" title="Chargebacks" />
            <SectionBody>
              <p>
                We ask that you contact us before initiating a chargeback with your bank or card
                issuer, so we have the chance to resolve the issue directly. Accounts with an open
                chargeback may be suspended while the dispute is being investigated, and repeated or
                fraudulent chargebacks may result in permanent account termination.
              </p>
            </SectionBody>

            <SectionHeading id="how-to-request" number="9" title="How to Request a Refund" />
            <SectionBody>
              <p>
                Email us with your account email, the invoice or charge date, and the reason for
                your request. We aim to respond to all refund requests within 2 business days.
              </p>
            </SectionBody>

            <SectionHeading id="contact-us" number="10" title="Contact Us" />
            <SectionBody>
              <p>Questions about billing or a refund? Email us and we'll get back to you.</p>
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
                <Link to="/sla" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Service Level Agreement &rarr;
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

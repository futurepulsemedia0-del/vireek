import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Activity, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, viewport } from '@/lib/motion';

const CONTACT_EMAIL = 'ali@vireek.com';

interface Section {
  id: string;
  number: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'introduction', number: '1', title: 'Introduction & Scope' },
  { id: 'uptime-commitment', number: '2', title: 'Uptime Commitment' },
  { id: 'what-counts-as-downtime', number: '3', title: 'What Counts as Downtime' },
  { id: 'exclusions', number: '4', title: 'Exclusions' },
  { id: 'service-credits', number: '5', title: 'Service Credits' },
  { id: 'claiming-credits', number: '6', title: 'How to Claim a Credit' },
  { id: 'support-response', number: '7', title: 'Support Response Times' },
  { id: 'monitoring-status', number: '8', title: 'Monitoring & Status Reporting' },
  { id: 'changes-to-sla', number: '9', title: 'Changes to This SLA' },
  { id: 'contact-us', number: '10', title: 'Contact Us' },
];

function CalloutCard({ icon: Icon, children }: { icon: typeof Activity; children: ReactNode }) {
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
            Our Commitment
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

export function SlaContent() {
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
                Service Level Agreement
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: September 12, 2026</p>
            </motion.div>

            <SectionHeading id="introduction" number="1" title="Introduction & Scope" />
            <SectionBody>
              <p>
                This Service Level Agreement ("SLA") describes the uptime commitment Vireek makes
                to customers on paid subscription plans for the core Vireek platform (call
                answering, dashboard access, and the customer-facing API). It does not apply to
                customers on a free plan or during a free trial.
              </p>
            </SectionBody>

            <div className="mt-10">
              <SectionHeading id="uptime-commitment" number="2" title="Uptime Commitment" />
              <div className="mt-5">
                <CalloutCard icon={Activity}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      Vireek targets a{' '}
                      <strong className="text-text-primary">99.9% monthly uptime</strong> for the
                      core platform on all paid plans. Enterprise customers may negotiate a custom
                      uptime commitment and credit schedule as part of a signed order form.
                    </p>
                    <p>
                      Monthly uptime percentage is calculated as: (total minutes in the calendar
                      month &minus; minutes of Downtime) &divide; total minutes in the calendar
                      month &times; 100.
                    </p>
                  </div>
                </CalloutCard>
              </div>
            </div>

            <SectionHeading id="what-counts-as-downtime" number="3" title="What Counts as Downtime" />
            <SectionBody>
              <p>
                "Downtime" means the core platform is unavailable or fails to answer inbound calls
                for reasons within Vireek's reasonable control, as confirmed by our monitoring
                systems or a verified customer report. Brief periods of elevated latency that do
                not prevent calls from being answered do not count as Downtime.
              </p>
            </SectionBody>

            <SectionHeading id="exclusions" number="4" title="Exclusions" />
            <SectionBody>
              <p>The following are excluded from Downtime calculations:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Scheduled maintenance announced at least 24 hours in advance</li>
                <li>• Outages caused by the customer's own equipment, network, or misconfiguration</li>
                <li>• Outages of third-party telephony carriers, SMS gateways, or integration partners outside Vireek's infrastructure</li>
                <li>• Force majeure events (natural disasters, war, widespread internet or power outages, government action)</li>
                <li>• Suspension of an account for a Terms of Service violation or non-payment</li>
              </ul>
            </SectionBody>

            <SectionHeading id="service-credits" number="5" title="Service Credits" />
            <SectionBody>
              <p>If actual monthly uptime falls below the commitment in Section 2, eligible customers receive a credit toward a future invoice:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Below 99.9% but at or above 99.0% &mdash; 10% of that month's subscription fee</li>
                <li>• Below 99.0% but at or above 95.0% &mdash; 25% of that month's subscription fee</li>
                <li>• Below 95.0% &mdash; 50% of that month's subscription fee</li>
              </ul>
              <p>
                Service credits are the sole and exclusive remedy for a failure to meet the uptime
                commitment in this SLA, and cannot be exchanged for a cash refund.
              </p>
            </SectionBody>

            <SectionHeading id="claiming-credits" number="6" title="How to Claim a Credit" />
            <SectionBody>
              <p>
                To request a service credit, email us within 30 days of the end of the affected
                billing month with your account email and the dates/times of the outage you
                experienced. We will verify the claim against our monitoring data and apply any
                approved credit to your next invoice.
              </p>
            </SectionBody>

            <SectionHeading id="support-response" number="7" title="Support Response Times" />
            <SectionBody>
              <ul className="ml-1 space-y-1.5">
                <li>• Critical issues (platform-wide outage) &mdash; acknowledged within 4 hours</li>
                <li>• High-priority issues (major feature broken for one account) &mdash; acknowledged within 1 business day</li>
                <li>• General questions and feature requests &mdash; acknowledged within 2 business days</li>
              </ul>
              <p>Enterprise customers may have different response times as set out in their order form.</p>
            </SectionBody>

            <SectionHeading id="monitoring-status" number="8" title="Monitoring & Status Reporting" />
            <SectionBody>
              <p>
                Current platform status and historical uptime are published on our{' '}
                <Link to="/status" className="font-semibold text-accent hover:underline">
                  Status page
                </Link>
                . We recommend subscribing to status updates if uptime is critical to your
                operations.
              </p>
            </SectionBody>

            <SectionHeading id="changes-to-sla" number="9" title="Changes to This SLA" />
            <SectionBody>
              <p>
                We may update this SLA from time to time. Material reductions in the uptime
                commitment will be communicated to active paid customers at least 30 days in
                advance and will not apply retroactively.
              </p>
            </SectionBody>

            <SectionHeading id="contact-us" number="10" title="Contact Us" />
            <SectionBody>
              <p>Questions about this SLA or an uptime issue you experienced? Email us.</p>
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
                <Link to="/status" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  System Status &rarr;
                </Link>
                <Link to="/terms" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
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

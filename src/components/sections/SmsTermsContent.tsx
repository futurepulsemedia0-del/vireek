import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Mail, MessageSquareText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { EASE, viewport } from '@/lib/motion';

const CONTACT_EMAIL = 'ali@vireek.com';

interface Section {
  id: string;
  number: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'program-description', number: '1', title: 'Program Description' },
  { id: 'how-you-opt-in', number: '2', title: 'How You Opt In' },
  { id: 'message-types', number: '3', title: 'Message Types and Frequency' },
  { id: 'costs', number: '4', title: 'Costs' },
  { id: 'opt-out', number: '5', title: 'How to Opt Out' },
  { id: 'help', number: '6', title: 'Getting Help' },
  { id: 'carriers', number: '7', title: 'Carriers and Delivery' },
  { id: 'privacy', number: '8', title: 'Privacy and Data Sharing' },
  { id: 'changes', number: '9', title: 'Changes to These Terms' },
  { id: 'contact-us', number: '10', title: 'Contact Us' },
];

function CalloutCard({ icon: Icon, children }: { icon: typeof MessageSquareText; children: ReactNode }) {
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

const strong = 'text-text-primary';

export function SmsTermsContent() {
  const [activeId, setActiveId] = useState<string>('program-description');
  const [mobileTocOpen, setMobileTocOpen] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
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
                aria-expanded={mobileTocOpen}
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
                SMS Terms &amp; Conditions
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: October 9, 2026</p>
            </motion.div>

            <div className="mt-10">
              <SectionHeading id="program-description" number="1" title="Program Description" />
              <div className="mt-5">
                <CalloutCard icon={MessageSquareText}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>
                      <strong className={strong}>Vireek Appointment &amp; Service Messaging</strong> is a text
                      messaging program operated by Vireek on behalf of home-service businesses that use Vireek
                      (&ldquo;business customers&rdquo;). It sends you text messages about appointments and
                      service requests you have made with one of those businesses.
                    </p>
                    <ul className="ml-1 space-y-2">
                      <li>• <strong className={strong}>Message frequency varies</strong> based on your interactions with the business.</li>
                      <li>• <strong className={strong}>Message and data rates may apply.</strong></li>
                      <li>• Reply <strong className={strong}>STOP</strong> at any time to cancel. Reply <strong className={strong}>HELP</strong> for help.</li>
                      <li>• Consent to receive text messages is not a condition of any purchase.</li>
                    </ul>
                  </div>
                </CalloutCard>
              </div>
            </div>

            <SectionHeading id="how-you-opt-in" number="2" title="How You Opt In" />
            <SectionBody>
              <p>
                You opt in by giving your mobile number to a business that uses Vireek and agreeing to receive
                text messages about your appointment or service request. This can happen when you:
              </p>
              <ul className="ml-1 space-y-1.5">
                <li>• Provide your number by phone while booking with the business or its AI receptionist, and agree to receive texts</li>
                <li>• Submit your number in a booking or contact form that asks for your consent to receive texts</li>
                <li>• Text the business directly and ask it to continue the conversation by text</li>
              </ul>
              <p>
                Business customers are responsible for obtaining your consent before using Vireek to text you, as
                required by our{' '}
                <Link to="/terms" className="font-semibold text-accent hover:underline">
                  Terms of Service
                </Link>{' '}
                and applicable law, including the Telephone Consumer Protection Act (TCPA). We do not send text
                messages to numbers that have opted out.
              </p>
            </SectionBody>

            <SectionHeading id="message-types" number="3" title="Message Types and Frequency" />
            <SectionBody>
              <p>Messages sent through this program are limited to:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Appointment confirmations, reminders, and rescheduling or cancellation notices</li>
                <li>• Updates about a service request you made, such as arrival windows or job status</li>
                <li>• Replies to questions you sent to the business by call or text</li>
              </ul>
              <p>
                This program is not used for promotional or marketing messages. Message frequency varies; for most
                people it is a few messages per appointment.
              </p>
            </SectionBody>

            <SectionHeading id="costs" number="4" title="Costs" />
            <SectionBody>
              <p>
                Vireek does not charge you to receive messages. <strong className={strong}>Message and data rates
                may apply</strong>, depending on your mobile plan. Check with your wireless provider for details.
              </p>
            </SectionBody>

            <div className="mt-10">
              <SectionHeading id="opt-out" number="5" title="How to Opt Out" />
              <SectionBody>
                <p>
                  You can stop receiving text messages at any time by replying{' '}
                  <strong className={strong}>STOP</strong> to any message. You may also use{' '}
                  <strong className={strong}>STOPALL, UNSUBSCRIBE, CANCEL, END,</strong> or{' '}
                  <strong className={strong}>QUIT</strong>. You may receive one final message confirming your
                  request; after that, you will receive no further texts from that business through Vireek.
                </p>
                <p>
                  Opting out applies to the business whose number you replied to. If you receive texts from more than
                  one business that uses Vireek, reply STOP to each. An opt-out may also stop automated calls from
                  that business. If you want to receive messages again after opting out, ask the business to enroll
                  you again, and give your consent again.
                </p>
              </SectionBody>
            </div>

            <SectionHeading id="help" number="6" title="Getting Help" />
            <SectionBody>
              <p>
                Reply <strong className={strong}>HELP</strong> to any message for help, or email us at{' '}
                <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-accent hover:underline">
                  {CONTACT_EMAIL}
                </a>
                . For questions about a specific appointment, contact the business that texted you.
              </p>
            </SectionBody>

            <SectionHeading id="carriers" number="7" title="Carriers and Delivery" />
            <SectionBody>
              <p>
                Wireless carriers and Vireek are not liable for delayed or undelivered messages. Delivery depends
                on your carrier and device and is not guaranteed. This program is intended for mobile numbers in
                the United States.
              </p>
            </SectionBody>

            <SectionHeading id="privacy" number="8" title="Privacy and Data Sharing" />
            <SectionBody>
              <p>
                We collect and use your phone number and message content only to provide this program for the
                business you contacted. Your mobile number and SMS opt-in information are{' '}
                <strong className={strong}>not shared with third parties or affiliates for marketing or
                promotional purposes</strong>. We share information only with service providers that help us deliver
                messages (such as our messaging provider), and where required by law. Read our full{' '}
                <Link to="/privacy#sms-consent" className="font-semibold text-accent hover:underline">
                  Privacy Policy
                </Link>
                . To access, delete, or correct your data, use our{' '}
                <Link to="/data-request" className="font-semibold text-accent hover:underline">
                  data request form
                </Link>
                .
              </p>
            </SectionBody>

            <SectionHeading id="changes" number="9" title="Changes to These Terms" />
            <SectionBody>
              <p>
                We may update these terms from time to time. The &ldquo;Last updated&rdquo; date above shows when
                they last changed. If a change materially affects your rights, we will provide notice as required
                by law.
              </p>
            </SectionBody>

            <SectionHeading id="contact-us" number="10" title="Contact Us" />
            <SectionBody>
              <p>Questions about our text messaging program? Email us.</p>
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
              <Link to="/terms" className="mt-2 flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                Terms of Service &rarr;
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

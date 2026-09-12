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
  { id: 'introduction', number: '1', title: 'Introduction' },
  { id: 'our-trademarks', number: '2', title: 'Our Trademarks' },
  { id: 'permitted-uses', number: '3', title: 'Uses That Don\u2019t Require Permission' },
  { id: 'permission-required', number: '4', title: 'Uses That Require Written Permission' },
  { id: 'partner-badges', number: '5', title: 'Partner & Integration Badges' },
  { id: 'prohibited-uses', number: '6', title: 'Prohibited Uses' },
  { id: 'domains-and-handles', number: '7', title: 'Domain Names & Social Handles' },
  { id: 'press-and-media', number: '8', title: 'Press & Media' },
  { id: 'enforcement', number: '9', title: 'Enforcement' },
  { id: 'requesting-permission', number: '10', title: 'Requesting Permission' },
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
            Our Marks
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

export function TrademarkPolicyContent() {
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
                Trademark Usage Policy
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: September 12, 2026</p>
            </motion.div>

            <SectionHeading id="introduction" number="1" title="Introduction" />
            <SectionBody>
              <p>
                This policy explains how the Vireek name, logo, and other brand marks may and may
                not be used by anyone other than Vireek — including partners, integration
                developers, customers, media, and the general public. It supplements, and does not
                replace, our{' '}
                <Link to="/terms" className="font-semibold text-accent hover:underline">
                  Terms of Service
                </Link>
                .
              </p>
            </SectionBody>

            <div className="mt-10">
              <SectionHeading id="our-trademarks" number="2" title="Our Trademarks" />
              <div className="mt-5">
                <CalloutCard icon={Scale}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>The following are trademarks of Vireek, whether or not they appear with a &trade; or &reg; symbol:</p>
                    <ul className="ml-1 space-y-2">
                      <li>• The word mark &quot;Vireek&quot;</li>
                      <li>• The Vireek logo and app icon, in any color version</li>
                      <li>• The Vireek wordmark set in our display typeface (Sora)</li>
                      <li>• Any other names, logos, or slogans we use to identify our products</li>
                    </ul>
                  </div>
                </CalloutCard>
              </div>
            </div>

            <SectionHeading id="permitted-uses" number="3" title="Uses That Don't Require Permission" />
            <SectionBody>
              <p>You don&apos;t need our permission to:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Refer to Vireek by name in an accurate, factual way (e.g. &quot;we use Vireek to answer our calls&quot;)</li>
                <li>• Link to vireek.com from your own website or social profile</li>
                <li>• Use unmodified screenshots of the Vireek product in a review, comparison, or tutorial</li>
                <li>• Write news coverage, commentary, or criticism that mentions Vireek by name</li>
                <li>• Embed the unmodified &quot;Always Answered&quot; badge from{' '}
                  <Link to="/badge" className="font-semibold text-accent hover:underline">/badge</Link>{' '}
                  on your own website exactly as provided
                </li>
              </ul>
            </SectionBody>

            <SectionHeading id="permission-required" number="4" title="Uses That Require Written Permission" />
            <SectionBody>
              <p>Email us before you:</p>
              <ul className="ml-1 space-y-1.5">
                <li>• Use the Vireek logo in your own marketing material, ads, or on your website (outside the approved badge above)</li>
                <li>• Use &quot;Vireek&quot; in a paid search ad, domain name, or social handle</li>
                <li>• Reference Vireek in a press release, case study, or co-marketing material</li>
                <li>• Describe your business as a Vireek &quot;partner,&quot; &quot;certified,&quot; or &quot;official&quot; integration</li>
                <li>• Use our name or mark in a way not explicitly covered elsewhere in this policy</li>
              </ul>
            </SectionBody>

            <SectionHeading id="partner-badges" number="5" title="Partner & Integration Badges" />
            <SectionBody>
              <p>
                If we approve you as an integration partner, we&apos;ll provide the specific badge
                artwork and language you&apos;re authorized to use, along with any conditions (for
                example, always linking back to vireek.com). Using partner language or badge
                artwork you were not given directly by us is not authorized, even if it&apos;s
                visually similar to something we&apos;ve published elsewhere.
              </p>
            </SectionBody>

            <div className="mt-10">
              <SectionHeading id="prohibited-uses" number="6" title="Prohibited Uses" />
              <div className="mt-5">
                <CalloutCard icon={Scale}>
                  <div className="space-y-4 text-base leading-relaxed text-text-secondary">
                    <p>Regardless of permission status, never:</p>
                    <ul className="ml-1 space-y-2">
                      <li>• Modify, recolor, distort, or recreate the Vireek logo</li>
                      <li>• Use the Vireek name or mark in a way that implies endorsement, sponsorship, or partnership that doesn&apos;t exist</li>
                      <li>• Use the mark in connection with unlawful, hateful, or misleading content</li>
                      <li>• Incorporate &quot;Vireek&quot; into the name of your own company, product, app, or domain</li>
                      <li>• Use the mark in a way that disparages Vireek or damages its reputation</li>
                    </ul>
                  </div>
                </CalloutCard>
              </div>
            </div>

            <SectionHeading id="domains-and-handles" number="7" title="Domain Names & Social Handles" />
            <SectionBody>
              <p>
                Don&apos;t register domain names, social media handles, or app store listings that
                include &quot;Vireek&quot; or a confusingly similar variation, even if you are a
                genuine customer or fan. This protects everyone from impersonation and phishing
                attempts made in our name.
              </p>
            </SectionBody>

            <SectionHeading id="press-and-media" number="8" title="Press & Media" />
            <SectionBody>
              <p>
                Journalists and media covering Vireek can find our boilerplate, logo files, and a
                direct press contact on our{' '}
                <Link to="/press" className="font-semibold text-accent hover:underline">
                  Press &amp; Media page
                </Link>
                . Editorial use of our logo alongside factual reporting does not require separate
                permission, provided the mark is used unmodified.
              </p>
            </SectionBody>

            <SectionHeading id="enforcement" number="9" title="Enforcement" />
            <SectionBody>
              <p>
                Vireek reserves the right to request that any unauthorized or non-compliant use of
                our marks be corrected or removed, and to take further action — including legal
                action — where necessary to protect our brand and the people we serve.
              </p>
            </SectionBody>

            <SectionHeading id="requesting-permission" number="10" title="Requesting Permission" />
            <SectionBody>
              <p>To request permission for a use not covered above, email us with a description of the intended use, where it will appear, and how long it will run.</p>
              <div className="mt-2 flex items-center gap-3">
                <Mail size={18} className="text-accent" />
                <a
                  href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Trademark usage request')}`}
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
                <Link to="/brand" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Brand Guidelines &rarr;
                </Link>
                <Link to="/press" className="flex items-center gap-2 text-base font-semibold text-accent hover:underline">
                  Press &amp; Media Kit &rarr;
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

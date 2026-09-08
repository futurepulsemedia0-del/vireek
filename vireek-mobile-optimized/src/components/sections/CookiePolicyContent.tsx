import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Cookie, Mail, SlidersHorizontal } from 'lucide-react';
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
  { id: 'what-are-cookies', number: '2', title: 'What Are Cookies and Similar Technologies' },
  { id: 'how-we-use-cookies', number: '3', title: 'How We Use Cookies' },
  { id: 'essential-cookies', number: '4', title: 'Essential Cookies' },
  { id: 'analytics-cookies', number: '5', title: 'Analytics Cookies' },
  { id: 'personalization-cookies', number: '6', title: 'Personalization Cookies' },
  { id: 'marketing-cookies', number: '7', title: 'Marketing Cookies' },
  { id: 'ai-improvement-cookies', number: '8', title: 'AI Improvement Data' },
  { id: 'third-party-cookies', number: '9', title: 'Third-Party Cookies' },
  { id: 'how-long-cookies-last', number: '10', title: 'How Long Cookies Last' },
  { id: 'managing-preferences', number: '11', title: 'Managing Your Cookie Preferences' },
  { id: 'do-not-track', number: '12', title: 'Do Not Track Signals' },
  { id: 'changes-to-policy', number: '13', title: 'Changes to This Policy' },
  { id: 'contact-us', number: '14', title: 'Contact Us' },
];

function CalloutCard({ icon: Icon, children }: { icon: typeof Cookie; children: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border-2 border-accent/40 bg-accent/[0.04] p-6 md:p-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'radial-gradient(circle at 0% 0%, rgb(var(--accent-primary) / 0.10), transparent 50%)',
        }}
      />
      <div className="relative">
        <div className="mb-4 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
            <Icon size={20} />
          </span>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-accent">Manage anytime</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function SectionHeading({ id, number, title }: Section) {
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

interface CategoryRow {
  name: string;
  status: string;
  purpose: string;
}

const CATEGORY_TABLE: CategoryRow[] = [
  { name: 'Essential', status: 'Always active', purpose: 'Security, authentication, account access, and core site functionality.' },
  { name: 'Analytics', status: 'Optional — off by default', purpose: 'Understanding usage patterns to improve Vireek performance.' },
  { name: 'Personalization', status: 'Optional — off by default', purpose: 'Remembering preferences for a more tailored experience.' },
  { name: 'Marketing', status: 'Optional — off by default', purpose: 'Measuring campaigns and providing relevant communication.' },
  { name: 'AI Improvement', status: 'Optional — off by default', purpose: 'Improving AI experiences while respecting privacy preferences.' },
];

function openPrivacyCenter() {
  window.dispatchEvent(new Event('vireek:open-consent'));
}

export function CookiePolicyContent() {
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
              <button
                type="button"
                onClick={openPrivacyCenter}
                className="focus-ring mt-6 flex w-full items-center justify-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm font-semibold text-accent transition-colors hover:bg-accent/15"
              >
                <SlidersHorizontal size={15} />
                Manage cookie preferences
              </button>
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
              <button
                type="button"
                onClick={openPrivacyCenter}
                className="focus-ring mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm font-semibold text-accent transition-colors hover:bg-accent/15"
              >
                <SlidersHorizontal size={15} />
                Manage cookie preferences
              </button>
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
                Cookie Policy
              </h1>
              <p className="mt-4 text-sm text-text-secondary">Last updated: September 6, 2026</p>
            </motion.div>

            {/* Intro paragraph */}
            <div className="mt-8 rounded-2xl border border-border bg-bg-secondary p-6 text-base leading-relaxed text-text-secondary md:p-8">
              This Cookie Policy explains how Vireek (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or &ldquo;our&rdquo;) uses
              cookies and similar technologies on our website and dashboard, what each category is for, and how you
              can control them. It should be read together with our{' '}
              <Link to="/privacy" className="font-medium text-accent hover:underline">
                Privacy Policy
              </Link>
              .
            </div>

            {/* 1. Introduction */}
            <SectionHeading id="introduction" number="1" title="Introduction" />
            <SectionBody>
              <p>
                When you visit vireek.com or sign in to your Vireek dashboard, we and select service providers may
                store and access small pieces of data on your device — commonly known as cookies — to make the site
                work, remember your preferences, and, where you allow it, understand how the product is used.
              </p>
              <p>
                We ask for your consent before setting anything beyond strictly necessary cookies, and you can
                change your choice at any time from the &ldquo;Manage cookie preferences&rdquo; control on this page
                or the &ldquo;Cookie Preferences&rdquo; link in the site footer.
              </p>
            </SectionBody>

            {/* 2. What are cookies */}
            <SectionHeading id="what-are-cookies" number="2" title="What Are Cookies and Similar Technologies" />
            <SectionBody>
              <p>
                Cookies are small text files placed on your device by a website you visit. We also use closely
                related browser storage technologies — such as <code>localStorage</code> — that serve a similar
                purpose: remembering information between visits or between pages of the same visit.
              </p>
              <p>Depending on who sets them and how long they last, cookies and similar technologies fall into a few groups:</p>
              <ul className="ml-1 space-y-2">
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">First-party</span>
                  <span>Set directly by vireek.com.</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">Third-party</span>
                  <span>Set by a service we use to provide part of the site (see Section 9).</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">Session</span>
                  <span>Deleted automatically when you close your browser.</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">Persistent</span>
                  <span>Remain on your device for a set period, or until you delete them.</span>
                </li>
              </ul>
            </SectionBody>

            {/* 3. How we use cookies */}
            <SectionHeading id="how-we-use-cookies" number="3" title="How We Use Cookies" />
            <SectionBody>
              <p>
                We group cookies and similar technologies into five categories. Essential cookies are always active
                because the site cannot function without them; every other category is off until you turn it on.
              </p>
              <div className="overflow-hidden rounded-2xl border border-border">
                <table className="w-full border-collapse text-left text-sm">
                  <thead className="bg-bg-tertiary text-text-primary">
                    <tr>
                      <th className="px-4 py-3 font-semibold">Category</th>
                      <th className="px-4 py-3 font-semibold">Default</th>
                      <th className="px-4 py-3 font-semibold">Purpose</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CATEGORY_TABLE.map((row, i) => (
                      <tr key={row.name} className={i % 2 === 1 ? 'bg-bg-secondary/60' : ''}>
                        <td className="px-4 py-3 font-medium text-text-primary">{row.name}</td>
                        <td className="px-4 py-3 text-text-secondary">{row.status}</td>
                        <td className="px-4 py-3 text-text-secondary">{row.purpose}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionBody>

            {/* 4. Essential */}
            <SectionHeading id="essential-cookies" number="4" title="Essential Cookies" />
            <SectionBody>
              <p>
                These cookies and equivalent browser storage are required for the site and dashboard to work, and
                cannot be switched off. They include:
              </p>
              <ul className="ml-1 space-y-2">
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>Keeping you signed in to your Vireek dashboard between page loads.</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>Protecting the site against fraud and abuse, and enforcing security policies.</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>Remembering your cookie consent choices themselves, so we don&apos;t ask you repeatedly.</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>Core interface preferences, such as light or dark theme.</span>
                </li>
              </ul>
              <p>Because these are necessary for the service to operate, no consent toggle is offered for this category.</p>
            </SectionBody>

            {/* 5. Analytics */}
            <SectionHeading id="analytics-cookies" number="5" title="Analytics Cookies" />
            <SectionBody>
              <p>
                If enabled, analytics cookies help us understand which pages are used, how visitors move through
                the site, and where the product experience could be improved. Data is used in aggregate and is not
                used to identify you personally. This category stays off until you explicitly turn it on.
              </p>
            </SectionBody>

            {/* 6. Personalization */}
            <SectionHeading id="personalization-cookies" number="6" title="Personalization Cookies" />
            <SectionBody>
              <p>
                If enabled, personalization cookies let us remember choices you&apos;ve made — such as displayed
                content or interface settings — so future visits feel tailored to you rather than starting from
                scratch.
              </p>
            </SectionBody>

            {/* 7. Marketing */}
            <SectionHeading id="marketing-cookies" number="7" title="Marketing Cookies" />
            <SectionBody>
              <p>
                If enabled, marketing cookies help us measure the performance of our campaigns and show you more
                relevant communication about Vireek. We do not sell the information collected through these
                cookies.
              </p>
            </SectionBody>

            {/* 8. AI improvement */}
            <SectionHeading id="ai-improvement-cookies" number="8" title="AI Improvement Data" />
            <SectionBody>
              <p>
                If enabled, this category allows us to use certain interaction data to improve the AI experiences
                within Vireek&apos;s product, while continuing to respect the other privacy choices you&apos;ve
                made. This is distinct from call-recording and AI-processing disclosures for Sarah, the AI
                receptionist, which are covered in our{' '}
                <Link to="/privacy" className="font-medium text-accent hover:underline">
                  Privacy Policy
                </Link>
                .
              </p>
            </SectionBody>

            {/* 9. Third-party */}
            <SectionHeading id="third-party-cookies" number="9" title="Third-Party Cookies" />
            <SectionBody>
              <p>
                Some functionality on our site is provided by trusted third parties (for example, authentication
                and infrastructure providers), which may set their own cookies necessary to deliver that
                functionality. Where a non-essential third-party technology is used, it is only activated after you
                opt in through the categories above. We do not control third-party cookies directly — please refer
                to the relevant provider&apos;s own policy for details on how they handle data.
              </p>
            </SectionBody>

            {/* 10. Duration */}
            <SectionHeading id="how-long-cookies-last" number="10" title="How Long Cookies Last" />
            <SectionBody>
              <p>
                Session-based cookies and storage are cleared automatically when you close your browser. Persistent
                cookies and stored preferences — such as your consent choices or theme setting — remain on your
                device until they expire or you clear them, whichever comes first. You can clear stored data at any
                time from your browser settings.
              </p>
            </SectionBody>

            {/* 11. Managing preferences */}
            <SectionHeading id="managing-preferences" number="11" title="Managing Your Cookie Preferences" />
            <SectionBody>
              <p>You have full control over non-essential cookies at any time:</p>
              <ul className="ml-1 space-y-2">
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>
                    Use the &ldquo;Manage cookie preferences&rdquo; button on this page, or the &ldquo;Cookie
                    Preferences&rdquo; link in the footer of any page, to open the Privacy Center and toggle each
                    category individually.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>
                    Use your browser&apos;s own settings to block or delete cookies. Note that blocking essential
                    cookies may prevent parts of the dashboard, such as staying signed in, from working correctly.
                  </span>
                </li>
              </ul>
              <CalloutCard icon={Cookie}>
                <p className="text-base leading-relaxed text-text-primary">
                  Update your choices anytime — nothing beyond essential cookies runs until you say so.
                </p>
                <button
                  type="button"
                  onClick={openPrivacyCenter}
                  className="focus-ring mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-150 ease-out hover:brightness-110 hover:shadow-glow-accent active:brightness-90"
                >
                  <SlidersHorizontal size={16} />
                  Open Privacy Center
                </button>
              </CalloutCard>
            </SectionBody>

            {/* 12. DNT */}
            <SectionHeading id="do-not-track" number="12" title="Do Not Track Signals" />
            <SectionBody>
              <p>
                Some browsers offer a &ldquo;Do Not Track&rdquo; setting. There is currently no common industry
                standard for how sites should respond to that signal, so our site does not respond to it directly —
                instead, use the cookie category toggles described above, which give you more precise control.
              </p>
            </SectionBody>

            {/* 13. Changes */}
            <SectionHeading id="changes-to-policy" number="13" title="Changes to This Policy" />
            <SectionBody>
              <p>
                We may update this Cookie Policy from time to time to reflect changes in the technologies we use or
                for legal or regulatory reasons. We will update the &ldquo;Last updated&rdquo; date above when we
                do, and material changes will be reflected in the consent banner the next time you visit.
              </p>
            </SectionBody>

            {/* 14. Contact */}
            <SectionHeading id="contact-us" number="14" title="Contact Us" />
            <SectionBody>
              <p>If you have questions about this Cookie Policy or how we use cookies, contact us at:</p>
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="focus-ring inline-flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
              >
                <Mail size={15} className="text-accent" />
                {CONTACT_EMAIL}
              </a>
            </SectionBody>
          </div>
        </div>
      </div>
    </section>
  );
}

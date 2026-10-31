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
  { id: 'analytics-cookies', number: '5', title: 'Analytics' },
  { id: 'marketing-measurement', number: '6', title: 'Marketing Measurement' },
  { id: 'third-party-cookies', number: '7', title: 'Third-Party Cookies' },
  { id: 'how-long-cookies-last', number: '8', title: 'How Long Cookies Last' },
  { id: 'managing-preferences', number: '9', title: 'Managing Your Cookie Preferences' },
  { id: 'privacy-signals', number: '10', title: 'Global Privacy Control and Do Not Track' },
  { id: 'changes-to-policy', number: '11', title: 'Changes to This Policy' },
  { id: 'contact-us', number: '12', title: 'Contact Us' },
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
  { name: 'Essential', status: 'Always active', purpose: 'Sign-in, security, and remembering your choices, theme and language.' },
  { name: 'Analytics', status: 'Optional — off by default', purpose: 'Google Analytics 4 page-view statistics and A/B test stability. Not used for advertising.' },
  { name: 'Marketing measurement', status: 'Optional — off by default', purpose: 'Remembering which campaign link brought you to a landing page. No ad networks.' },
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
              <p className="mt-4 text-sm text-text-secondary">Last updated: October 31, 2026</p>
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
                  <span>Set by a service we use to provide part of the site (see Section 7).</span>
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
                We group cookies and similar technologies into three categories. Essential cookies are always active
                because the site cannot function without them; the other two are off until you turn them on.
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
                cannot be switched off:
              </p>
              <ul className="ml-1 space-y-2">
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>Your sign-in session (set by our authentication provider, Supabase).</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>
                    Your cookie choice, stored as <code>vireek-consent-v3</code> (see Section 9).
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>
                    Interface settings you choose yourself: theme (<code>vireek-theme</code>) and language (
                    <code>vireek-a11y-lang</code>).
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>Security and anti-abuse protections.</span>
                </li>
              </ul>
            </SectionBody>

            {/* 5. Analytics */}
            <SectionHeading id="analytics-cookies" number="5" title="Analytics" />
            <SectionBody>
              <p>
                Off until you turn it on. When enabled, we load Google Analytics 4 (Google LLC, United States) to
                count page views and understand how the site and product are used: pages visited, referrer, browser
                and device type, approximate location, and a random visitor ID. It is not used for advertising: we
                keep Google&apos;s advertising signals disabled and all Consent Mode v2 advertising storage
                permissions denied.
              </p>
              <ul className="ml-1 space-y-2">
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>
                    Cookies: <code>_ga</code> and <code>_ga_*</code> (up to 2 years). How long Google keeps reports is
                    set in our Google Analytics account.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>
                    Browser storage: <code>vireek-visitor-id</code> and <code>vireek-experiment-assignments</code>,
                    which keep your A/B test variant stable. Without analytics consent, test variants are chosen for
                    the current visit only and nothing is stored.
                  </span>
                </li>
              </ul>
              <p>
                No Google script is requested before you opt in. If you withdraw, events stop immediately, the{' '}
                <code>_ga</code> cookies and the storage above are deleted, and no reload is needed.
              </p>
            </SectionBody>

            {/* 6. Marketing measurement */}
            <SectionHeading id="marketing-measurement" number="6" title="Marketing Measurement" />
            <SectionBody>
              <p>
                Off until you turn it on. When enabled, on campaign landing pages we remember the campaign details of
                the link you arrived on (such as <code>utm_source</code>) and a random visitor ID, so we can measure
                which campaigns lead to sign-ups. This data goes to Vireek&apos;s own database (hosted by Supabase).
                We use no advertising networks, no advertising pixels and build no advertising profiles, and we do
                not sell or share this data with advertisers.
              </p>
              <ul className="ml-1 space-y-2">
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>
                    Browser storage: <code>vk_lp_vid</code> (until you withdraw or clear it) and{' '}
                    <code>vk_lp_attr:*</code> (30 days).
                  </span>
                </li>
              </ul>
              <p>
                Without this consent, campaign details and the visitor ID are held in memory for the current visit
                only and are not stored on your device.
              </p>
            </SectionBody>

            {/* 7. Third-party */}
            <SectionHeading id="third-party-cookies" number="7" title="Third-Party Cookies" />
            <SectionBody>
              <p>
                The only optional third-party technology that sets cookies is Google Analytics (Section 5), and only
                after you opt in. Authentication and infrastructure providers may set strictly necessary cookies to
                deliver the service. We do not control third-party cookies directly; please refer to the provider&apos;s
                own policy.
              </p>
            </SectionBody>

            {/* 8. Duration */}
            <SectionHeading id="how-long-cookies-last" number="8" title="How Long Cookies Last" />
            <SectionBody>
              <ul className="ml-1 space-y-2">
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>Sign-in session: until you sign out or it expires.</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>Cookie choice: we ask again after 12 months, or sooner if this policy materially changes.</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>Theme and language: until you clear your browser storage.</span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>Analytics and marketing items: as listed in Sections 5 and 6, or until you withdraw consent.</span>
                </li>
              </ul>
            </SectionBody>

            {/* 9. Managing preferences */}
            <SectionHeading id="managing-preferences" number="9" title="Managing Your Cookie Preferences" />
            <SectionBody>
              <p>You can change your choice at any time, and withdrawing is as easy as granting:</p>
              <ul className="ml-1 space-y-2">
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>
                    Use the &ldquo;Manage cookie preferences&rdquo; button on this page, or the &ldquo;Cookie
                    Preferences&rdquo; link in the site footer, to open the cookie settings.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="font-semibold text-text-primary">•</span>
                  <span>
                    Use your browser&apos;s own settings to block or delete cookies. Blocking essential cookies may
                    stop parts of the dashboard, such as staying signed in, from working.
                  </span>
                </li>
              </ul>
              <p>
                <strong className="text-text-primary">Record of your choice.</strong> To prove that consent was given
                or withdrawn, we store a record containing the date and time, the policy version, your choices, whether
                a Global Privacy Control or Do Not Track signal was present, and a random ID. It contains no name,
                email address, IP address or browser details. If you are signed in, it is linked to your account ID.
                These records are kept for as long as we need them to demonstrate compliance.
              </p>
              <CalloutCard icon={Cookie}>
                <p className="text-base leading-relaxed text-text-primary">
                  Update your choices anytime. Nothing optional runs until you say so.
                </p>
                <button
                  type="button"
                  onClick={openPrivacyCenter}
                  className="focus-ring mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-150 ease-out hover:brightness-110 hover:shadow-glow-accent active:brightness-90"
                >
                  <SlidersHorizontal size={16} />
                  Open cookie settings
                </button>
              </CalloutCard>
            </SectionBody>

            {/* 10. Privacy signals */}
            <SectionHeading id="privacy-signals" number="10" title="Global Privacy Control and Do Not Track" />
            <SectionBody>
              <p>
                We treat a Global Privacy Control (GPC) or Do Not Track signal from your browser as an opt-out of
                marketing measurement: that category stays off and cannot be switched on while the signal is present.
                These signals never switch anything on. Analytics remains your choice. We do not sell personal
                information or share it for cross-context behavioral advertising.
              </p>
            </SectionBody>

            {/* 11. Changes */}
            <SectionHeading id="changes-to-policy" number="11" title="Changes to This Policy" />
            <SectionBody>
              <p>
                We may update this Cookie Policy from time to time to reflect changes in the technologies we use or
                for legal or regulatory reasons. We will update the &ldquo;Last updated&rdquo; date above when we
                do, and material changes will be reflected in the consent banner the next time you visit.
              </p>
            </SectionBody>

            {/* 12. Contact */}
            <SectionHeading id="contact-us" number="12" title="Contact Us" />
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

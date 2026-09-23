import { Mail, ShieldCheck } from 'lucide-react';

const CONTACT_EMAIL = 'ali@vireek.com';

export function AccessibilityStatementContent() {
  return (
    <div className="mx-auto max-w-3xl px-6 pb-24 pt-4">
      <div className="mb-8 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <ShieldCheck size={20} aria-hidden="true" />
        </span>
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-accent">Accessibility</p>
      </div>

      <h1 className="text-3xl font-bold tracking-tight text-text-primary md:text-4xl">Accessibility Statement</h1>
      <p className="mt-4 text-base leading-relaxed text-text-secondary">
        Vireek is committed to making our product usable by everyone, including people who rely on
        assistive technology such as screen readers, keyboard-only navigation, or high-contrast
        display modes. We are actively working toward conformance with the{' '}
        <strong className="text-text-primary">Web Content Accessibility Guidelines (WCAG) 2.2, Level AA</strong>.
      </p>

      <section className="mt-10">
        <h2 className="text-xl font-semibold text-text-primary">What we've built</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-text-secondary">
          <li>Full keyboard operability across the dashboard, including modals, menus, and data tables.</li>
          <li>Visible, high-contrast focus indicators on every interactive element.</li>
          <li>Semantic landmarks, headings, and a "skip to main content" link on every page.</li>
          <li>Screen-reader announcements for async actions (saves, errors, loading states).</li>
          <li>A built-in accessibility toolbar (text size, contrast, motion, and reading preferences) available from any page.</li>
          <li>Color contrast checked against WCAG AA thresholds (4.5:1 text, 3:1 UI components) across our design tokens.</li>
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold text-text-primary">Ongoing work</h2>
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">
          Accessibility is an ongoing process, not a one-time audit. We test new features with
          keyboard navigation and screen readers (NVDA and VoiceOver) before release, and we run
          automated WCAG checks in our CI pipeline on every change.
        </p>
      </section>

      <section className="mt-10 rounded-2xl border border-border bg-bg-secondary p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
          <Mail size={18} aria-hidden="true" className="text-accent" />
          Let us know
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-text-secondary">
          If you encounter an accessibility barrier anywhere in Vireek, please tell us — we treat
          these reports as priority bugs. Include the page URL and, if possible, the assistive
          technology you were using.
        </p>
        
          href={`mailto:${CONTACT_EMAIL}?subject=Accessibility%20issue`}
          className="focus-ring mt-3 inline-block text-sm font-semibold text-accent underline underline-offset-2"
        >
          {CONTACT_EMAIL}
        </a>
      </section>
    </div>
  );
}

import { motion } from 'framer-motion';
import { SUBPROCESSOR_CATEGORIES, SUBPROCESSORS_LAST_UPDATED } from '@/lib/subprocessors';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { useSEO } from '@/lib/seo';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';

// ============================================================
// CONTENT — keep this list accurate and current
// ============================================================
//
// Every entry here must reflect a vendor Vireek actually uses today.
// Same rule as TrustCenterPage.tsx / SecurityPage.tsx: describe what's
// actually true, don't imply a certification a vendor (or Vireek) hasn't
// obtained. When you add, remove, or replace a processor:
//   1. Update this list.
//   2. Update `LAST_UPDATED` below.
//   3. If you have customers on a signed DPA, follow the notice process
//      in DpaContent.tsx Section 5 (Sub-processors) before the change
//      goes live for their account.

const CONTACT_EMAIL = 'ali@vireek.com';

export function SubprocessorsPage() {
  useSEO({
    title: 'Sub-processor List | Vireek',
    description:
      "The current list of third-party sub-processors Vireek uses to provide its AI voice receptionist service \u2014 what each one does, where it's located, and what data it touches.",
    canonical: 'https://vireek.com/subprocessors',
  });

  return (
    <>
      <Header />
      <main className="bg-bg-primary pt-24">
        <section className="py-16 md:py-20">
          <div className="mx-auto max-w-5xl px-6">
            <BackButton />

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mt-8"
            >
              <p className={eyebrowClass()}>Legal</p>
              <h1 className={`${sectionHeadingClass()} text-left`}>Sub-processor List</h1>
              <p className="mt-4 max-w-2xl text-base leading-relaxed text-text-secondary">
                This is the current list of third parties Vireek engages to process personal data on
                behalf of business customers, referenced in Section 5 of our{' '}
                <a href="/dpa" className="text-accent underline underline-offset-2">
                  Data Processing Agreement
                </a>
                . It covers the same commitments described in our{' '}
                <a href="/privacy" className="text-accent underline underline-offset-2">
                  Privacy Policy
                </a>
                , at the level of individual vendors.
              </p>
              <p className="mt-3 text-sm text-text-secondary/70">Last updated: {SUBPROCESSORS_LAST_UPDATED}</p>
            </motion.div>

            <div className="mt-12 space-y-10">
              {SUBPROCESSOR_CATEGORIES.map((category, ci) => (
                <motion.div
                  key={category.title}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.45, ease: EASE, delay: Math.min(ci * 0.05, 0.2) }}
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                      <category.icon size={18} />
                    </span>
                    <div>
                      <h2 className="text-lg font-semibold text-text-primary">{category.title}</h2>
                      <p className="text-sm text-text-secondary">{category.description}</p>
                    </div>
                  </div>

                  <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-border bg-bg-tertiary/60 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                          <th className="px-5 py-3">Processor</th>
                          <th className="px-5 py-3">Purpose</th>
                          <th className="hidden px-5 py-3 sm:table-cell">Location</th>
                          <th className="hidden px-5 py-3 md:table-cell">Data types</th>
                        </tr>
                      </thead>
                      <tbody>
                        {category.processors.map((p, pi) => (
                          <tr
                            key={p.name}
                            className={pi !== category.processors.length - 1 ? 'border-b border-border/60' : ''}
                          >
                            <td className="px-5 py-4 align-top font-medium text-text-primary">{p.name}</td>
                            <td className="px-5 py-4 align-top text-text-secondary">{p.purpose}</td>
                            <td className="hidden px-5 py-4 align-top text-text-secondary sm:table-cell">
                              {p.location}
                            </td>
                            <td className="hidden px-5 py-4 align-top text-text-secondary md:table-cell">
                              {p.dataTypes}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </motion.div>
              ))}
            </div>

            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mt-12 rounded-2xl border border-border bg-bg-secondary p-6 md:p-8"
            >
              <h2 className="text-base font-semibold text-text-primary">Changes to this list</h2>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                If you have a signed Data Processing Agreement with Vireek, we follow the
                notice-and-objection process described there before a new sub-processor starts
                handling your data. To receive email notice of changes, or to ask a question about
                any processor on this list, contact{' '}
                <a href={`mailto:${CONTACT_EMAIL}`} className="text-accent underline underline-offset-2">
                  {CONTACT_EMAIL}
                </a>
                .
              </p>
            </motion.div>
          </div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Check, Minus, X, ArrowRight, ShieldCheck, Sparkles,
  Building2, Wrench, ClipboardList, Headset, Bot, ChevronDown,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { Button } from '@/components/ui/Button';
import { BackButton } from '@/components/ui/BackButton';
import { CookieConsent } from '@/components/CookieConsent';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { useSEO } from '@/lib/seo';

// ============================================================
// DATA
// ============================================================
//
// This is a single, aggregated matrix across every named competitor in
// src/lib/competitors.ts. Keep the same honesty rule that file already
// documents: 'na' means "not a comparable claim / not publicly verified
// with a citable source" — it is deliberately NOT the same as 'no', and
// must never be used to imply a competitor lacks something we haven't
// actually confirmed. Avoca AI in particular is itself an AI voice
// product; most of its rows are 'na' on purpose (see competitors.ts for
// why) rather than guessed at. Re-verify against each competitor's
// current public site before updating any cell.

type CellValue = 'yes' | 'partial' | 'no' | 'na';

interface MatrixRow {
  feature: string;
  vireek: CellValue;
  servicetitan: CellValue;
  housecallPro: CellValue;
  jobber: CellValue;
  answeringService: CellValue;
  avocaAi: CellValue;
}

type ColumnKey = keyof Omit<MatrixRow, 'feature'>;

const MATRIX_ROWS: MatrixRow[] = [
  {
    feature: 'Answers every inbound call, 24/7/365',
    vireek: 'yes', servicetitan: 'no', housecallPro: 'no', jobber: 'no',
    answeringService: 'partial', avocaAi: 'yes',
  },
  {
    feature: 'Books appointments directly onto the calendar during the call',
    vireek: 'yes', servicetitan: 'no', housecallPro: 'no', jobber: 'no',
    answeringService: 'no', avocaAi: 'na',
  },
  {
    feature: 'Trained on home-service trade language (HVAC, plumbing, electrical…)',
    vireek: 'yes', servicetitan: 'na', housecallPro: 'no', jobber: 'no',
    answeringService: 'no', avocaAi: 'na',
  },
  {
    feature: 'Flags true emergencies from what the caller says',
    vireek: 'yes', servicetitan: 'no', housecallPro: 'no', jobber: 'no',
    answeringService: 'partial', avocaAi: 'na',
  },
  {
    feature: 'Syncs calls, leads & jobs to your dashboard without manual entry',
    vireek: 'yes', servicetitan: 'na', housecallPro: 'partial', jobber: 'na',
    answeringService: 'no', avocaAi: 'na',
  },
  {
    feature: 'Sends automated SMS confirmations after booking',
    vireek: 'yes', servicetitan: 'na', housecallPro: 'na', jobber: 'partial',
    answeringService: 'no', avocaAi: 'na',
  },
  {
    feature: 'Job scheduling, dispatch & invoicing',
    vireek: 'partial', servicetitan: 'yes', housecallPro: 'yes', jobber: 'yes',
    answeringService: 'no', avocaAi: 'na',
  },
  {
    feature: 'Quoting, mobile payments & client management',
    vireek: 'na', servicetitan: 'yes', housecallPro: 'yes', jobber: 'yes',
    answeringService: 'no', avocaAi: 'na',
  },
  {
    feature: 'Outbound calling / follow-up campaigns',
    vireek: 'yes', servicetitan: 'na', housecallPro: 'na', jobber: 'na',
    answeringService: 'na', avocaAi: 'yes',
  },
  {
    feature: 'CSR call coaching & QA scoring',
    vireek: 'na', servicetitan: 'na', housecallPro: 'na', jobber: 'na',
    answeringService: 'na', avocaAi: 'yes',
  },
  {
    feature: 'Built for single-location & small/growing teams, not just enterprise',
    vireek: 'yes', servicetitan: 'no', housecallPro: 'yes', jobber: 'yes',
    answeringService: 'yes', avocaAi: 'no',
  },
  {
    feature: 'Live in minutes, minimal setup or onboarding',
    vireek: 'yes', servicetitan: 'no', housecallPro: 'partial', jobber: 'partial',
    answeringService: 'yes', avocaAi: 'no',
  },
  {
    feature: 'Transparent, published pricing',
    vireek: 'yes', servicetitan: 'no', housecallPro: 'partial', jobber: 'yes',
    answeringService: 'no', avocaAi: 'no',
  },
  {
    feature: 'Live call analytics & dashboard insights',
    vireek: 'yes', servicetitan: 'yes', housecallPro: 'partial', jobber: 'partial',
    answeringService: 'no', avocaAi: 'yes',
  },
];

interface ColumnDef {
  key: ColumnKey;
  label: string;
  sublabel?: string;
  icon: typeof Sparkles;
  highlight?: boolean;
  href?: string;
}

const COLUMNS: ColumnDef[] = [
  { key: 'vireek', label: 'Vireek', icon: Sparkles, highlight: true },
  { key: 'servicetitan', label: 'ServiceTitan', icon: Building2, href: '/compare/servicetitan' },
  { key: 'housecallPro', label: 'Housecall Pro', icon: Wrench, href: '/compare/housecall-pro' },
  { key: 'jobber', label: 'Jobber', icon: ClipboardList, href: '/compare/jobber' },
  { key: 'answeringService', label: 'Answering Service', icon: Headset, href: '/compare/answering-service' },
  { key: 'avocaAi', label: 'Avoca AI', icon: Bot, href: '/compare/avoca-ai' },
];

// ============================================================
// CELL
// ============================================================

function Cell({ value, highlight }: { value: CellValue; highlight?: boolean }) {
  if (value === 'yes') {
    return (
      <span className={`mx-auto flex h-7 w-7 items-center justify-center rounded-full ${highlight ? 'bg-accent/15 text-accent' : 'bg-success-500/15 text-success-500'}`}>
        <Check size={15} strokeWidth={2.75} />
      </span>
    );
  }
  if (value === 'partial') {
    return (
      <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-warning-500/15 text-warning-500">
        <Minus size={15} strokeWidth={2.75} />
      </span>
    );
  }
  if (value === 'no') {
    return (
      <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-danger/10 text-danger">
        <X size={15} strokeWidth={2.75} />
      </span>
    );
  }
  // na — not a comparable claim / not publicly verified
  return <span className="mx-auto block text-center text-sm text-text-secondary/30">&mdash;</span>;
}

// ============================================================
// PAGE
// ============================================================

export function FeatureMatrixPage() {
  const [mobileCol, setMobileCol] = useState<ColumnKey>('vireek');

  useSEO({
    title: 'Vireek vs ServiceTitan vs Housecall Pro vs Jobber vs Avoca AI: Full Feature Matrix | Vireek',
    description:
      'One side-by-side matrix comparing Vireek to ServiceTitan, Housecall Pro, Jobber, traditional answering services, and Avoca AI across phone answering, booking, CRM sync, and field-service capabilities.',
    canonical: 'https://vireek.com/compare/matrix',
  });

  const activeColumn = COLUMNS.find((c) => c.key === mobileCol) ?? COLUMNS[0];

  return (
    <>
      <Header />
      <main className="min-h-screen overflow-hidden bg-bg-primary pt-24">
        {/* Hero */}
        <section className="relative bg-gradient-mesh bg-noise px-6 py-20 sm:py-24 lg:py-28">
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent" />
          <div className="mx-auto max-w-4xl">
            <div className="mb-8">
              <BackButton fallback="/compare" />
            </div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
              className="text-center"
            >
              <p className={eyebrowClass()}>The Full Picture</p>
              <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-text-primary sm:text-5xl lg:text-6xl">
                Every Option, Side by Side
              </h1>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-text-secondary sm:text-xl">
                One matrix comparing Vireek to field-service platforms, traditional answering
                services, and other AI voice agents &mdash; so you can see the full landscape at a
                glance before going deeper on any one comparison.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/login">
                  <Button variant="primary" size="lg">Start Free Trial</Button>
                </Link>
                <Link
                  to="/compare"
                  className="focus-ring inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold text-text-primary transition-colors hover:text-accent"
                >
                  Back to comparison overview
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </motion.div>
          </div>
        </section>

        {/* Matrix */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Feature Matrix</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center`}>
                Vireek vs every option, one table
              </h2>
              <p className={`${bodyClass()} mx-auto text-center`}>
                Scroll to see all six columns. A dash means the comparison isn&rsquo;t a fair
                apples-to-apples claim for that pair &mdash; not that the capability is missing.
              </p>
            </motion.div>

            {/* Desktop / tablet: scrollable table */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.6, ease: EASE, delay: 0.1 }}
              className="mt-12 hidden overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark md:block"
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="w-1/4 px-6 py-5 text-left text-sm font-semibold text-text-secondary">
                        Capability
                      </th>
                      {COLUMNS.map((col) => (
                        <th key={col.key} className={`px-3 py-5 text-center ${col.highlight ? 'bg-accent/5' : ''}`}>
                          {col.highlight ? (
                            <div className="mx-auto flex w-fit items-center gap-1.5 rounded-full bg-gradient-to-r from-accent to-cta px-3 py-1.5 text-xs font-bold text-white shadow-glow-accent">
                              <col.icon size={12} />
                              {col.label}
                            </div>
                          ) : (
                            <Link
                              to={col.href ?? '/compare'}
                              className="mx-auto flex w-fit flex-col items-center gap-1 text-xs font-semibold text-text-secondary transition-colors hover:text-accent"
                            >
                              <col.icon size={16} />
                              {col.label}
                            </Link>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <motion.tbody variants={staggerContainer} initial="initial" whileInView="whileInView" viewport={viewport}>
                    {MATRIX_ROWS.map((row, i) => (
                      <motion.tr
                        key={row.feature}
                        variants={fadeUpItem}
                        transition={{ duration: 0.35, ease: EASE }}
                        className={`${i !== MATRIX_ROWS.length - 1 ? 'border-b border-border/60' : ''} hover:bg-bg-tertiary/50`}
                      >
                        <td className="px-6 py-4 text-sm font-medium text-text-primary">{row.feature}</td>
                        {COLUMNS.map((col) => (
                          <td key={col.key} className={`px-3 py-4 text-center ${col.highlight ? 'bg-accent/5' : ''}`}>
                            <Cell value={row[col.key]} highlight={col.highlight} />
                          </td>
                        ))}
                      </motion.tr>
                    ))}
                  </motion.tbody>
                </table>
              </div>
            </motion.div>

            {/* Mobile: one column at a time via a picker */}
            <div className="mt-10 md:hidden">
              <div className="relative">
                <select
                  value={mobileCol}
                  onChange={(e) => setMobileCol(e.target.value as ColumnKey)}
                  className="focus-ring w-full appearance-none rounded-xl border border-border bg-bg-secondary px-4 py-3 pr-10 text-sm font-medium text-text-primary"
                >
                  {COLUMNS.map((col) => (
                    <option key={col.key} value={col.key}>
                      {col.highlight ? 'Vireek' : `Vireek vs ${col.label}`}
                    </option>
                  ))}
                </select>
                <ChevronDown size={18} className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-text-secondary" />
              </div>

              <div className="mt-4 space-y-4">
                {[COLUMNS[0], activeColumn].filter((c, i, arr) => arr.findIndex((x) => x.key === c.key) === i).map((col) => (
                  <div
                    key={col.key}
                    className={`rounded-xl border p-4 ${col.highlight ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg-tertiary/50'}`}
                  >
                    <h3 className={`flex items-center gap-2 text-sm font-bold ${col.highlight ? 'text-accent' : 'text-text-primary'}`}>
                      <col.icon size={16} />
                      {col.label}
                    </h3>
                    <ul className="mt-3 space-y-2.5">
                      {MATRIX_ROWS.map((row) => (
                        <li key={row.feature} className="flex items-center gap-2.5">
                          <Cell value={row[col.key]} highlight={col.highlight} />
                          <span className="text-xs text-text-secondary">{row.feature}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>

            {/* Legend */}
            <div className="mx-auto mt-8 flex max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-3 text-xs text-text-secondary">
              <span className="flex items-center gap-2">
                <Cell value="yes" /> Yes
              </span>
              <span className="flex items-center gap-2">
                <Cell value="partial" /> Partial / with extra setup
              </span>
              <span className="flex items-center gap-2">
                <Cell value="no" /> No
              </span>
              <span className="flex items-center gap-2">
                <Cell value="na" /> Not a comparable claim
              </span>
            </div>

            <p className="mx-auto mt-6 max-w-2xl text-center text-xs text-text-secondary/70">
              This matrix reflects each product&rsquo;s core, publicly described focus as of this
              writing. Feature sets and pricing change &mdash; see each competitor&rsquo;s own site for
              their current, complete details, and read our full{' '}
              <Link to="/compare/avoca-ai" className="font-medium text-accent hover:underline">
                Vireek vs Avoca AI
              </Link>{' '}
              comparison for nuance on the rows marked &ldquo;not a comparable claim&rdquo; there.
            </p>
          </div>
        </section>

        {/* Deep-dive links */}
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-5xl">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={viewport}
              transition={{ duration: 0.5, ease: EASE }}
              className="mx-auto max-w-2xl text-center"
            >
              <p className={`${eyebrowClass()} text-center`}>Go Deeper</p>
              <h2 className={`${sectionHeadingClass()} mt-3 text-center text-2xl sm:text-3xl`}>
                Read the full comparison for any tool
              </h2>
            </motion.div>

            <div className="mt-10 grid gap-4 sm:grid-cols-2">
              {COLUMNS.filter((c) => !c.highlight).map((col, index) => (
                <motion.div
                  key={col.key}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={viewport}
                  transition={{ duration: 0.45, delay: index * 0.08, ease: EASE }}
                >
                  <Link
                    to={col.href ?? '/compare'}
                    className="group flex items-center justify-between gap-4 rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
                  >
                    <span className="flex items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-tertiary text-text-secondary transition-colors group-hover:border-accent/30 group-hover:bg-accent/10 group-hover:text-accent">
                        <col.icon size={18} />
                      </span>
                      <span className="block text-sm font-semibold text-text-primary">
                        Vireek vs {col.label}
                      </span>
                    </span>
                    <ArrowRight className="h-4 w-4 shrink-0 text-text-secondary transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-accent" />
                  </Link>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="px-6 py-16 md:py-20">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
            className="bg-noise relative mx-auto flex max-w-6xl flex-col items-center overflow-hidden rounded-3xl bg-gradient-to-br from-accent-800 via-accent-700 to-cta-800 px-6 py-16 text-center shadow-glow-accent md:px-16 md:py-24"
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                backgroundImage:
                  'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.14), transparent 45%), radial-gradient(circle at 85% 80%, rgb(var(--accent-secondary) / 0.20), transparent 45%)',
              }}
            />
            <div className="relative">
              <h2 className="text-3xl font-bold leading-[1.15] tracking-tight text-white text-balance md:text-5xl">
                See how Sarah handles your calls
              </h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/85 md:text-lg text-pretty">
                No matter what you use today, a free trial shows you exactly what gets answered
                and booked that wasn&rsquo;t before.
              </p>
              <div className="mt-9 flex justify-center">
                <Link to="/login">
                  <Button variant="primary" size="lg" className="shadow-glow-cta">
                    Start Free Trial
                    <ArrowRight size={18} />
                  </Button>
                </Link>
              </div>
              <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-medium text-white/70">
                <ShieldCheck size={13} className="shrink-0" />
                Cancel anytime. No contracts.
              </p>
            </div>
          </motion.div>
        </section>
      </main>
      <Footer />
      <CookieConsent />
    </>
  );
}

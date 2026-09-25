import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  ArrowUpRight,
  FileWarning,
  Receipt,
  AlertTriangle,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { CountUp } from '@/components/ui/CountUp';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';

/* ------------------------------------------------------------------ */
/*  Mock data                                                          */
/* ------------------------------------------------------------------ */
//
// Same shape as the real Value-at-Risk Engine (/dashboard/value-at-risk)
// and Missed-Revenue Recovery Ledger, simplified to two categories for a
// marketing-page glance. No live calls made — this is a recreation, not
// a live data view (same convention as DashboardPreview.tsx).

type RiskCategory = 'all' | 'estimate' | 'invoice';

interface RiskItem {
  id: string;
  category: 'estimate' | 'invoice';
  customer: string;
  job: string;
  amount: number;
  age: string;
}

const RISK_ITEMS: RiskItem[] = [
  { id: '1', category: 'estimate', customer: 'Dana R.', job: 'Roofing estimate', amount: 2100, age: '11 days, no follow-up' },
  { id: '2', category: 'invoice', customer: 'Tom K.', job: 'HVAC tune-up', amount: 890, age: '24 days overdue' },
  { id: '3', category: 'estimate', customer: 'Priya S.', job: 'Water heater replacement', amount: 3400, age: '7 days, no follow-up' },
  { id: '4', category: 'invoice', customer: 'Marcus L.', job: 'Electrical panel upgrade', amount: 650, age: '18 days overdue' },
  { id: '5', category: 'estimate', customer: 'Wei C.', job: 'Fence installation', amount: 1850, age: '9 days, no follow-up' },
];

const TABS: { key: RiskCategory; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'estimate', label: 'Unfollowed Estimates' },
  { key: 'invoice', label: 'Overdue Invoices' },
];

function formatCurrency(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

/* ------------------------------------------------------------------ */
/*  Headline risk card                                                 */
/* ------------------------------------------------------------------ */

function RiskStat({
  icon: Icon,
  label,
  value,
  detail,
  tone,
  active,
  onClick,
}: {
  icon: typeof FileWarning;
  label: string;
  value: string;
  detail: string;
  tone: 'danger' | 'warning';
  active: boolean;
  onClick: () => void;
}) {
  const toneClass = tone === 'danger' ? 'text-danger' : 'text-warning-500';
  const toneBg = tone === 'danger' ? 'bg-danger/10' : 'bg-warning-500/10';
  const toneBorder = tone === 'danger' ? 'border-danger/30' : 'border-warning-500/30';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-xl border p-4 text-left transition-all sm:p-5 ${
        active ? `${toneBorder} bg-bg-secondary shadow-card dark:shadow-card-dark` : 'border-border bg-bg-secondary/60 hover:border-border'
      }`}
    >
      <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${toneBg} ${toneClass}`}>
        <Icon size={16} />
      </span>
      <p className={`mt-3 text-2xl font-bold tracking-tight sm:text-3xl ${toneClass}`}>
        <CountUp value={value} />
      </p>
      <p className="mt-1 text-xs font-semibold text-text-primary sm:text-sm">{label}</p>
      <p className="mt-0.5 text-[11px] text-text-secondary sm:text-xs">{detail}</p>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Main section                                                       */
/* ------------------------------------------------------------------ */

export function RevenueAtRiskPreview() {
  const [activeTab, setActiveTab] = useState<RiskCategory>('all');

  const filteredItems = useMemo(
    () => (activeTab === 'all' ? RISK_ITEMS : RISK_ITEMS.filter((i) => i.category === activeTab)),
    [activeTab]
  );

  const toggleFromStat = (category: RiskCategory) => setActiveTab((prev) => (prev === category ? 'all' : category));

  return (
    <section className="relative py-16 sm:py-24 md:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-2xl text-center"
        >
          <p className={eyebrowClass()}>Revenue at Risk</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>
            See Exactly What&apos;s Slipping Through the Cracks
          </h2>
          <p className={`${bodyClass()} mx-auto text-sm sm:text-base md:text-lg`}>
            The moment you log in, Vireek shows you money sitting on the table right now — not
            buried three reports deep.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.55, ease: EASE, delay: 0.1 }}
          className="mx-auto mt-10 max-w-4xl overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark sm:mt-14"
        >
          {/* Browser-style chrome, matching DashboardPreview.tsx's convention */}
          <div className="flex items-center gap-2 border-b border-border bg-bg-tertiary/60 px-4 py-3">
            <span className="h-2.5 w-2.5 rounded-full bg-danger/40" />
            <span className="h-2.5 w-2.5 rounded-full bg-warning-500/40" />
            <span className="h-2.5 w-2.5 rounded-full bg-success/40" />
            <span className="ml-2 text-xs font-medium text-text-secondary">Revenue at Risk — Dashboard</span>
            <span className="ml-auto flex items-center gap-1.5">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              <span className="text-[0.6875rem] font-semibold uppercase tracking-wide text-success">Live</span>
            </span>
          </div>

          <div className="p-5 sm:p-8">
            {/* Two headline numbers — doubles as a filter for the list below */}
            <div className="flex flex-col gap-3 sm:flex-row">
              <RiskStat
                icon={FileWarning}
                label="Estimates Unfollowed"
                value="$12,400"
                detail="14 estimates, avg. 9 days old"
                tone="danger"
                active={activeTab === 'estimate'}
                onClick={() => toggleFromStat('estimate')}
              />
              <RiskStat
                icon={Receipt}
                label="Invoices Overdue"
                value="$3,200"
                detail="6 invoices, avg. 21 days late"
                tone="warning"
                active={activeTab === 'invoice'}
                onClick={() => toggleFromStat('invoice')}
              />
            </div>

            {/* Tabs */}
            <div className="mt-6 flex flex-wrap gap-2 border-b border-border pb-4">
              {TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`focus-ring rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                    activeTab === tab.key
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-text-secondary hover:border-accent/40'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Itemized rows — a few representative examples, not the full ledger */}
            <div className="mt-4 flex flex-col divide-y divide-border/60">
              {filteredItems.map((item, i) => (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: i * 0.06, ease: EASE }}
                  className="flex items-center gap-3 py-3"
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                      item.category === 'estimate' ? 'bg-danger/10 text-danger' : 'bg-warning-500/10 text-warning-500'
                    }`}
                  >
                    {item.category === 'estimate' ? <FileWarning size={14} /> : <Receipt size={14} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-text-primary">
                      {item.customer} · {item.job}
                    </p>
                    <p className="text-xs text-text-secondary">{item.age}</p>
                  </div>
                  <span className="shrink-0 text-sm font-bold text-text-primary">{formatCurrency(item.amount)}</span>
                </motion.div>
              ))}
              {filteredItems.length === 0 && (
                <p className="py-6 text-center text-sm text-text-secondary">Nothing in this category.</p>
              )}
            </div>

            {/* CTA bar */}
            <div className="mt-6 flex flex-col items-start justify-between gap-4 rounded-xl border border-accent/30 bg-accent/10 px-5 py-4 sm:flex-row sm:items-center">
              <div className="flex items-start gap-2.5">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-accent" />
                <p className="text-sm text-text-secondary">
                  <span className="font-semibold text-accent">Vireek follows up automatically</span> — no
                  estimate or invoice sits this long unattended.
                </p>
              </div>
              <Link to="/signup" className="w-full shrink-0 sm:w-auto">
                <Button variant="primary" size="md" className="w-full gap-2 sm:w-auto">
                  See your own numbers
                  <ArrowRight size={16} />
                </Button>
              </Link>
            </div>
          </div>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-text-secondary/70"
        >
          <ArrowUpRight size={12} />
          Illustrative preview. Your real dashboard is powered by your own estimates and invoices.
        </motion.p>
      </div>
    </section>
  );
}

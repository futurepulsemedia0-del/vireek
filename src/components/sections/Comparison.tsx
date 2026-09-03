import { motion } from 'framer-motion';
import { Check, X, Minus, type LucideIcon } from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';

type CellValue = 'yes' | 'no' | 'partial';

interface FeatureRow {
  feature: string;
  vireek: CellValue;
  receptionist: CellValue;
  genericAI: CellValue;
  missed: CellValue;
}

const ROWS: FeatureRow[] = [
  { feature: 'Answers every call, 24/7', vireek: 'yes', receptionist: 'no', genericAI: 'yes', missed: 'no' },
  { feature: 'Detects emergencies automatically', vireek: 'yes', receptionist: 'partial', genericAI: 'no', missed: 'no' },
  { feature: 'Books appointments in real-time', vireek: 'yes', receptionist: 'yes', genericAI: 'partial', missed: 'no' },
  { feature: 'Understands industry terminology', vireek: 'yes', receptionist: 'yes', genericAI: 'no', missed: 'no' },
  { feature: 'Handles interruptions naturally', vireek: 'yes', receptionist: 'yes', genericAI: 'no', missed: 'no' },
  { feature: 'Syncs to your CRM & calendar', vireek: 'yes', receptionist: 'no', genericAI: 'partial', missed: 'no' },
  { feature: 'Sends SMS confirmations', vireek: 'yes', receptionist: 'partial', genericAI: 'partial', missed: 'no' },
  { feature: 'No salary, benefits, or sick days', vireek: 'yes', receptionist: 'no', genericAI: 'yes', missed: 'yes' },
  { feature: 'Monthly cost', vireek: 'yes', receptionist: 'no', genericAI: 'yes', missed: 'yes' },
];

const COLUMNS = [
  { key: 'vireek', label: 'Vireek', highlight: true },
  { key: 'receptionist', label: 'Human Receptionist' },
  { key: 'genericAI', label: 'Generic AI Assistant' },
  { key: 'missed', label: 'Missed Calls' },
] as const;

function CellIcon({ value, highlight }: { value: CellValue; highlight?: boolean }) {
  if (value === 'yes')
    return <Check size={18} className={`shrink-0 ${highlight ? 'text-accent' : 'text-success-500'}`} strokeWidth={2.5} />;
  if (value === 'partial')
    return <Minus size={18} className="shrink-0 text-text-secondary/40" strokeWidth={2.5} />;
  return <X size={18} className="shrink-0 text-danger/50" strokeWidth={2.5} />;
}

export function Comparison() {
  return (
    <section id="compare" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl text-center"
        >
          <p className={eyebrowClass()}>The comparison</p>
          <h2 className={sectionHeadingClass()}>Why Contractors Choose Vireek</h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
          className="mt-14 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark"
        >
          {/* Desktop table */}
          <div className="hidden md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-bg-tertiary">
                  <th className="px-6 py-5 text-left text-sm font-semibold text-text-secondary">
                    Capability
                  </th>
                  {COLUMNS.map((col) => (
                    <th
                      key={col.key}
                      className={`px-6 py-5 text-center text-sm font-semibold ${
                        col.highlight
                          ? 'rounded-t-xl bg-accent/5 text-accent'
                          : 'text-text-secondary'
                      }`}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row, i) => (
                  <tr
                    key={row.feature}
                    className={`border-b border-border/60 last:border-0 ${i % 2 === 0 ? 'bg-bg-secondary' : 'bg-bg-tertiary/30'}`}
                  >
                    <td className="px-6 py-4 text-sm font-medium text-text-primary">
                      {row.feature}
                    </td>
                    {COLUMNS.map((col) => (
                      <td
                        key={col.key}
                        className={`px-6 py-4 text-center ${col.highlight ? 'bg-accent/5' : ''}`}
                      >
                        <div className="flex justify-center">
                          <CellIcon value={row[col.key]} highlight={col.highlight} />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-4 p-5 md:hidden">
            {COLUMNS.map((col) => (
              <div
                key={col.key}
                className={`rounded-xl border p-4 ${
                  col.highlight ? 'border-accent/40 bg-accent/5' : 'border-border bg-bg-tertiary/50'
                }`}
              >
                <h3 className={`text-sm font-bold ${col.highlight ? 'text-accent' : 'text-text-primary'}`}>
                  {col.label}
                </h3>
                <ul className="mt-3 space-y-2.5">
                  {ROWS.map((row) => (
                    <li key={row.feature} className="flex items-center gap-2.5">
                      <CellIcon value={row[col.key as keyof FeatureRow] as CellValue} highlight={col.highlight} />
                      <span className="text-xs text-text-secondary">{row.feature}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}

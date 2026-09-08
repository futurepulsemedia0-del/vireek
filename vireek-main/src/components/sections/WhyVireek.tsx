import { motion } from 'framer-motion';
import { Check, X, Minus, Sparkles } from 'lucide-react';
import { EASE, sectionHeadingClass, eyebrowClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

// ============================================================
// DATA
// ============================================================
//
// Deliberately compares against generic categories ("Traditional
// Answering Service", "Voicemail / Missed Calls", "Generic AI Voice Bot")
// rather than any named competitor brand — every claim here is a factual,
// defensible statement about how each category of solution typically
// behaves. "Generic AI Voice Bot" covers the broad wave of general-purpose
// AI phone agents that can hold a conversation but weren't built for the
// trades — this is the comparison most buyers actually need in 2026, since
// "why not just use voicemail" is no longer the real objection.

type CellValue = 'yes' | 'no' | 'partial';

interface ComparisonRow {
  label: string;
  vireek: CellValue;
  answeringService: CellValue;
  voicemail: CellValue;
  genericAI: CellValue;
}

const ROWS: ComparisonRow[] = [
  { label: 'Answers every call, 24/7/365', vireek: 'yes', answeringService: 'partial', voicemail: 'no', genericAI: 'yes' },
  { label: 'Trained for home-service trades (HVAC, electrical, plumbing…)', vireek: 'yes', answeringService: 'partial', voicemail: 'no', genericAI: 'no' },
  { label: 'Books appointments automatically', vireek: 'yes', answeringService: 'no', voicemail: 'no', genericAI: 'partial' },
  { label: 'Captures & qualifies leads instantly', vireek: 'yes', answeringService: 'partial', voicemail: 'no', genericAI: 'partial' },
  { label: 'Syncs to your CRM in real time', vireek: 'yes', answeringService: 'no', voicemail: 'no', genericAI: 'partial' },
  { label: 'Flags true emergencies for dispatch', vireek: 'yes', answeringService: 'partial', voicemail: 'no', genericAI: 'no' },
  { label: 'No hold times or hiring / training', vireek: 'yes', answeringService: 'no', voicemail: 'yes', genericAI: 'yes' },
  { label: 'Live insights & call analytics', vireek: 'yes', answeringService: 'no', voicemail: 'no', genericAI: 'partial' },
];

function Cell({ value }: { value: CellValue }) {
  if (value === 'yes') {
    return (
      <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-success-500/15 text-success-500">
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
  return (
    <span className="mx-auto flex h-7 w-7 items-center justify-center rounded-full bg-danger/10 text-danger">
      <X size={15} strokeWidth={2.75} />
    </span>
  );
}

// ============================================================
// SECTION
// ============================================================

export function WhyVireek() {
  return (
    <section id="about" className="py-24 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-2xl text-center"
        >
          <p className={eyebrowClass()}>The Comparison</p>
          <h2 className={sectionHeadingClass()}>
            Why home service teams are switching to Vireek
          </h2>
          <p className="mt-4 text-base leading-relaxed text-text-secondary">
            See how an always-on, trade-trained AI receptionist stacks up against the ways
            most businesses handle calls today — including other AI voice tools.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, ease: EASE, delay: 0.1 }}
          className="mt-14 overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="w-2/5 px-6 py-5 text-left text-sm font-semibold text-text-secondary">
                    Capability
                  </th>
                  <th className="px-4 py-5">
                    <div className="mx-auto flex w-fit items-center gap-1.5 rounded-full bg-gradient-to-r from-accent to-cta px-3.5 py-1.5 text-xs font-bold text-white shadow-glow-accent">
                      <Sparkles size={12} />
                      Vireek
                    </div>
                  </th>
                  <th className="px-4 py-5 text-center text-xs font-semibold text-text-secondary">
                    Answering
                    <br />
                    Service
                  </th>
                  <th className="px-4 py-5 text-center text-xs font-semibold text-text-secondary">
                    Voicemail /<br />
                    Missed Calls
                  </th>
                  <th className="px-4 py-5 text-center text-xs font-semibold text-text-secondary">
                    Generic AI
                    <br />
                    Voice Bot
                  </th>
                </tr>
              </thead>
              <motion.tbody variants={staggerContainer} initial="initial" whileInView="whileInView" viewport={viewport}>
                {ROWS.map((row, i) => (
                  <motion.tr
                    key={row.label}
                    variants={fadeUpItem}
                    transition={{ duration: 0.35, ease: EASE }}
                    className={`${i !== ROWS.length - 1 ? 'border-b border-border/60' : ''} hover:bg-bg-tertiary/50`}
                  >
                    <td className="px-6 py-4 text-sm font-medium text-text-primary">{row.label}</td>
                    <td className="bg-accent/5 px-4 py-4 text-center">
                      <Cell value={row.vireek} />
                    </td>
                    <td className="px-4 py-4 text-center">
                      <Cell value={row.answeringService} />
                    </td>
                    <td className="px-4 py-4 text-center">
                      <Cell value={row.voicemail} />
                    </td>
                    <td className="px-4 py-4 text-center">
                      <Cell value={row.genericAI} />
                    </td>
                  </motion.tr>
                ))}
              </motion.tbody>
            </table>
          </div>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mt-5 text-center text-xs text-text-secondary/60"
        >
          &ldquo;Partial&rdquo; reflects that outcome typically depending on staffing, hours, manual
          follow-up, or additional setup and integration work.
        </motion.p>
      </div>
    </section>
  );
}

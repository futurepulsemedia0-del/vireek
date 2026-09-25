import { useMemo, useState } from 'react';
import { motion, useSpring, useTransform } from 'framer-motion';
import {
  ArrowRight,
  ClipboardList,
  Download,
  DollarSign,
  TrendingDown,
  TrendingUp,
  Users,
  CalendarCheck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';
import { downloadEstimateRoiCalculatorPdf } from '@/lib/pdf';

/* ------------------------------------------------------------------ */
/*  Assumptions                                                        */
/* ------------------------------------------------------------------ */
//
// Vireek's estimate-to-cash recovery agent follows up on every stalled
// estimate automatically (calls, texts, emails) until it closes or the
// customer declines. RECOVERY_RATE is a conservative, stated benchmark
// for how many of those stalled estimates a consistent follow-up
// process typically wins back — it is NOT user-editable, mirroring how
// MissedCallCalculator treats "Vireek answers 100% of calls" as a
// fixed assumption rather than a slider.
const RECOVERY_RATE = 0.3;

/* ------------------------------------------------------------------ */
/*  Animated number                                                     */
/* ------------------------------------------------------------------ */

function AnimatedDollar({ value }: { value: number }) {
  const spring = useSpring(value, { mass: 0.7, stiffness: 90, damping: 22 });
  const display = useTransform(spring, (v) => `$${Math.round(v).toLocaleString('en-US')}`);

  useMemo(() => {
    spring.set(value);
  }, [value, spring]);

  return <motion.span>{display}</motion.span>;
}

function AnimatedNumber({ value }: { value: number }) {
  const spring = useSpring(value, { mass: 0.7, stiffness: 90, damping: 22 });
  const display = useTransform(spring, (v) => Math.round(v).toLocaleString('en-US'));

  useMemo(() => {
    spring.set(value);
  }, [value, spring]);

  return <motion.span>{display}</motion.span>;
}

/* ------------------------------------------------------------------ */
/*  Slider                                                              */
/* ------------------------------------------------------------------ */

function CalcSlider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label className="text-sm font-medium text-text-secondary">{label}</label>
        <span className="font-mono text-sm font-semibold text-text-primary">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="accent-accent mt-3 h-2 w-full cursor-pointer appearance-none rounded-full bg-bg-tertiary"
        aria-label={label}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Result card                                                        */
/* ------------------------------------------------------------------ */

function ResultCard({
  icon: Icon,
  label,
  children,
  tone,
}: {
  icon: typeof TrendingDown;
  label: string;
  children: React.ReactNode;
  tone: 'danger' | 'success' | 'accent';
}) {
  const toneClass = {
    danger: 'text-danger',
    success: 'text-success',
    accent: 'text-accent',
  }[tone];

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <Icon size={16} className={toneClass} />
        <p className="text-xs font-medium text-text-secondary">{label}</p>
      </div>
      <p className={`mt-2 text-2xl font-bold tracking-tight sm:text-3xl ${toneClass}`}>
        {children}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main section                                                       */
/* ------------------------------------------------------------------ */

export function EstimateRoiCalculator() {
  const [technicians, setTechnicians] = useState(5);
  const [monthlyEstimates, setMonthlyEstimates] = useState(80);
  const [avgTicket, setAvgTicket] = useState(850);
  const [coldRate, setColdRate] = useState(35);

  const staleEstimatesPerMonth = monthlyEstimates * (coldRate / 100);
  const recoveredJobsPerMonth = Math.round(staleEstimatesPerMonth * RECOVERY_RATE);
  const monthlyLoss = staleEstimatesPerMonth * RECOVERY_RATE * avgTicket;
  const annualLoss = monthlyLoss * 12;
  const monthlyOpportunity = recoveredJobsPerMonth * avgTicket;
  const perTechAnnual = annualLoss / Math.max(technicians, 1);

  const handleDownloadPdf = () => {
    downloadEstimateRoiCalculatorPdf(
      { technicians, monthlyEstimates, avgTicket, coldRate },
      { monthlyLoss, annualLoss, recoveredJobsPerMonth, monthlyOpportunity, perTechAnnual }
    );
  };

  return (
    <section id="estimate-calculator" className="relative py-16 sm:py-24 md:py-28">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-2xl text-center"
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs font-semibold text-danger sm:px-4 sm:text-sm">
              <ClipboardList size={14} className="sm:size-4" />
              Most contractors never follow up on stalled estimates
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/10 px-3 py-1.5 text-xs font-semibold text-success">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
              </span>
              Live calculator — updates instantly
            </span>
          </div>
          <p className={`${eyebrowClass()} mt-6 sm:mt-8`}>{'Estimate ROI Calculator'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>
            {'How Much Are Stalled Estimates Costing You?'}
          </h2>
          <p className={`${bodyClass()} mx-auto text-sm sm:text-base md:text-lg`}>
            Plug in your team size, average ticket, and estimate volume. See what quotes that go
            cold are costing you every year — and what Vireek's automatic follow-up could recover.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.55, ease: EASE, delay: 0.1 }}
          className="mx-auto mt-10 grid max-w-5xl overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark sm:mt-14 md:grid-cols-2"
        >
          {/* Inputs */}
          <div className="flex flex-col gap-6 p-6 sm:gap-8 sm:p-10">
            <CalcSlider
              label="Technicians on your team"
              value={technicians}
              onChange={setTechnicians}
              min={1}
              max={50}
              step={1}
              format={(v) => `${v} ${v === 1 ? 'tech' : 'techs'}`}
            />
            <CalcSlider
              label="Estimates sent per month"
              value={monthlyEstimates}
              onChange={setMonthlyEstimates}
              min={10}
              max={500}
              step={10}
              format={(v) => `${v} estimates`}
            />
            <CalcSlider
              label="Average ticket value"
              value={avgTicket}
              onChange={setAvgTicket}
              min={200}
              max={10000}
              step={100}
              format={(v) => `$${v.toLocaleString('en-US')}`}
            />
            <CalcSlider
              label="% of estimates that go cold with no follow-up"
              value={coldRate}
              onChange={setColdRate}
              min={10}
              max={70}
              step={5}
              format={(v) => `${v}%`}
            />
            <p className="text-xs leading-relaxed text-text-secondary/70">
              Assumes Vireek's automatic follow-up recovers roughly 30% of stalled estimates — a
              conservative benchmark for consistent, fast follow-up. Adjust the sliders to match
              your own numbers.
            </p>
          </div>

          {/* Results */}
          <div className="flex flex-col justify-center gap-4 bg-bg-tertiary p-6 sm:gap-5 sm:p-10">
            {/* Annual loss — hero number */}
            <div>
              <p className="text-sm font-medium text-text-secondary">
                Estimated revenue lost per year
              </p>
              <div className="mt-2 flex items-center gap-3">
                <TrendingDown size={28} className="shrink-0 text-danger" />
                <span className="text-3xl font-bold tracking-tight text-danger sm:text-4xl md:text-5xl">
                  <AnimatedDollar value={annualLoss} />
                </span>
              </div>
              <p className="mt-2 text-sm text-text-secondary">
                That&apos;s roughly <AnimatedDollar value={monthlyLoss} /> every month.
              </p>
            </div>

            {/* Recovery stats */}
            <div className="grid grid-cols-2 gap-3">
              <ResultCard icon={CalendarCheck} label="Estimates recovered / mo" tone="success">
                <AnimatedNumber value={recoveredJobsPerMonth} />
              </ResultCard>
              <ResultCard icon={DollarSign} label="Monthly opportunity" tone="accent">
                <AnimatedDollar value={monthlyOpportunity} />
              </ResultCard>
            </div>

            {/* Per-technician breakdown */}
            <div className="rounded-xl border border-accent/30 bg-accent/10 px-5 py-4">
              <div className="flex items-center gap-2">
                <Users size={16} className="text-accent" />
                <p className="text-sm font-semibold text-accent">
                  ≈ <AnimatedDollar value={perTechAnnual} /> per technician, per year
                </p>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">
                Vireek follows up on every stalled estimate automatically — no technician has to
                remember to call back.
              </p>
            </div>

            <div className="rounded-xl border border-accent/30 bg-accent/10 px-5 py-4">
              <div className="flex items-center gap-2">
                <TrendingUp size={16} className="text-accent" />
                <p className="text-sm font-semibold text-accent">
                  Vireek chases every quote until it closes.
                </p>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">
                Even recovering a fraction of this number pays for a plan many times over — most
                customers see it pay for itself inside the first week.
              </p>
            </div>

            <Link to="/pricing">
              <Button variant="primary" size="lg" className="w-full gap-2">
                See the plan that stops this
                <ArrowRight size={18} />
              </Button>
            </Link>
            <Button type="button" variant="ghost" size="sm" className="w-full" onClick={handleDownloadPdf}>
              <Download size={16} /> Download PDF report
            </Button>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

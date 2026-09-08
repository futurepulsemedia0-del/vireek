import { useMemo, useState } from 'react';
import { motion, useSpring, useTransform } from 'framer-motion';
import { ArrowRight, PhoneMissed, TrendingDown, TrendingUp, DollarSign, PhoneCall, CalendarCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, viewport } from '@/lib/motion';

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

export function MissedCallCalculator() {
  const [callsPerWeek, setCallsPerWeek] = useState(50);
  const [missedPerWeek, setMissedPerWeek] = useState(10);
  const [jobValue, setJobValue] = useState(350);
  const [closeRate, setCloseRate] = useState(30);

  const monthlyLoss = (missedPerWeek * 52) / 12 * (closeRate / 100) * jobValue;
  const annualLoss = monthlyLoss * 12;
  const recoveredJobs = Math.round(missedPerWeek * 4 * (closeRate / 100));
  const monthlyOpportunity = recoveredJobs * jobValue;

  return (
    <section id="calculator" className="py-16 sm:py-24 md:py-28">
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-2xl text-center"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-danger/30 bg-danger/10 px-3 py-1.5 text-xs font-semibold text-danger sm:px-4 sm:text-sm">
            <PhoneMissed size={14} className="sm:size-4" />
            The average service business misses 6 in 10 calls
          </span>
          <p className={`${eyebrowClass()} mt-6 sm:mt-8`}>{'Revenue Calculator'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>{'How Much Revenue Could Vireek Recover?'}</h2>
          <p className={`${bodyClass()} mx-auto text-sm sm:text-base md:text-lg`}>
            Drag the sliders to match your business. See exactly how much revenue walks away
            every year — and what Vireek could recover.
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
              label="Total calls per week"
              value={callsPerWeek}
              onChange={setCallsPerWeek}
              min={10}
              max={200}
              step={5}
              format={(v) => `${v} calls`}
            />
            <CalcSlider
              label="Missed calls per week"
              value={missedPerWeek}
              onChange={setMissedPerWeek}
              min={1}
              max={100}
              step={1}
              format={(v) => `${v} calls`}
            />
            <CalcSlider
              label="Average job value"
              value={jobValue}
              onChange={setJobValue}
              min={50}
              max={2000}
              step={25}
              format={(v) => `$${v.toLocaleString('en-US')}`}
            />
            <CalcSlider
              label="Of those, % you'd likely close"
              value={closeRate}
              onChange={setCloseRate}
              min={5}
              max={80}
              step={5}
              format={(v) => `${v}%`}
            />
            <p className="text-xs leading-relaxed text-text-secondary/70">
              Based on industry benchmarks showing service businesses miss roughly 60% of inbound
              calls. Adjust the sliders to match your own numbers.
            </p>
          </div>

          {/* Results */}
          <div className="flex flex-col justify-center gap-4 bg-bg-tertiary p-6 sm:gap-5 sm:p-10">
            {/* Annual loss — hero number */}
            <div>
              <p className="text-sm font-medium text-text-secondary">Estimated revenue lost per year</p>
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
              <ResultCard icon={CalendarCheck} label="Jobs recovered / mo" tone="success">
                <AnimatedNumber value={recoveredJobs} />
              </ResultCard>
              <ResultCard icon={DollarSign} label="Monthly opportunity" tone="accent">
                <AnimatedDollar value={monthlyOpportunity} />
              </ResultCard>
            </div>

            {/* Vireek recovery box */}
            <div className="rounded-xl border border-accent/30 bg-accent/10 px-5 py-4">
              <div className="flex items-center gap-2">
                <TrendingUp size={16} className="text-accent" />
                <p className="text-sm font-semibold text-accent">Vireek answers 100% of calls, 24/7.</p>
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
          </div>
        </motion.div>
      </div>
    </section>
  );
}

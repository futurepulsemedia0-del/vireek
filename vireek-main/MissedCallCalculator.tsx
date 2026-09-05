import { useMemo, useState } from 'react';
import { motion, useSpring, useTransform } from 'framer-motion';
import { ArrowRight, PhoneMissed, TrendingDown } from 'lucide-react';
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
/*  Main section                                                       */
/* ------------------------------------------------------------------ */

export function MissedCallCalculator() {
  const [missedPerWeek, setMissedPerWeek] = useState(10);
  const [jobValue, setJobValue] = useState(350);
  const [closeRate, setCloseRate] = useState(30);

  const monthlyLoss = (missedPerWeek * 52) / 12 * (closeRate / 100) * jobValue;
  const annualLoss = monthlyLoss * 12;

  return (
    <section id="calculator" className="py-24 md:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-2xl text-center"
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-danger/30 bg-danger/10 px-4 py-1.5 text-sm font-semibold text-danger">
            <PhoneMissed size={16} />
            The average service business misses 6 in 10 calls
          </span>
          <p className={`${eyebrowClass()} mt-8`}>See your number</p>
          <h2 className={sectionHeadingClass()}>What are missed calls really costing you?</h2>
          <p className={`${bodyClass()} mx-auto`}>
            Drag the sliders to match your business. This is how much revenue walks away every
            year before Sarah ever picks up the phone.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.55, ease: EASE, delay: 0.1 }}
          className="mx-auto mt-14 grid max-w-5xl overflow-hidden rounded-2xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark md:grid-cols-2"
        >
          {/* Inputs */}
          <div className="flex flex-col gap-8 p-8 sm:p-10">
            <CalcSlider
              label="Missed calls per week"
              value={missedPerWeek}
              onChange={setMissedPerWeek}
              min={1}
              max={50}
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
              calls. Adjust the sliders to match your own numbers — this is your estimate, not
              ours.
            </p>
          </div>

          {/* Result */}
          <div className="flex flex-col justify-center gap-6 bg-bg-tertiary p-8 sm:p-10">
            <div>
              <p className="text-sm font-medium text-text-secondary">Estimated revenue lost per year</p>
              <div className="mt-2 flex items-center gap-3">
                <TrendingDown size={28} className="shrink-0 text-danger" />
                <span className="text-4xl font-bold tracking-tight text-danger sm:text-5xl">
                  <AnimatedDollar value={annualLoss} />
                </span>
              </div>
              <p className="mt-2 text-sm text-text-secondary">
                That's roughly <AnimatedDollar value={monthlyLoss} /> every single month —
                more than most Vireek plans cost.
              </p>
            </div>

            <div className="rounded-xl border border-accent/30 bg-accent/10 px-5 py-4">
              <p className="text-sm font-semibold text-accent">
                Vireek answers 100% of calls, 24/7.
              </p>
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">
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

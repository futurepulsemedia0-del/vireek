// Recreated: verify against original intent (recovered verbatim from homepage-redesign.patch)
import { useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { ButtonLink } from '@/components/ui/ButtonLink';
import { CALCULATOR_DEFAULTS, calculateMissedCallCost, type MissedCallInputs } from '@/lib/missedCallMath';
import { trackHomeCta } from '@/lib/homeAnalytics';
import { container, eyebrow, h2, lead, panel, sectionY } from './sectionStyles';

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const num = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US');

function Slider({
  label, value, min, max, step, onChange, format,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format: (v: number) => string;
}) {
  const id = useId();
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-text-primary">{label}</label>
        <output htmlFor={id} className="font-mono text-sm font-semibold text-text-primary">{format(value)}</output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 h-11 w-full cursor-pointer accent-accent"
      />
    </div>
  );
}

/** Replaces WhyNow + MissedCallCalculator on the homepage. Shows its own formula; invents no benchmark statistics. */
export function CostOfMissedCalls() {
  const [inputs, setInputs] = useState<MissedCallInputs>(CALCULATOR_DEFAULTS);
  const set = <K extends keyof MissedCallInputs>(k: K) => (v: number) => setInputs((p) => ({ ...p, [k]: v }));
  const r = calculateMissedCallCost(inputs);

  return (
    <section id="calculator" aria-labelledby="cost-heading" className={sectionY}>
      <div className={container}>
        <p className={eyebrow}>The cost of a missed call</p>
        <h2 id="cost-heading" className={h2}>What do unanswered calls cost your business?</h2>
        <p className={lead}>
          Callers who reach voicemail usually call the next company on the list. Enter your own numbers to see what
          that could mean for you.
        </p>

        <div className={`${panel} mt-10 grid overflow-hidden md:grid-cols-2`}>
          <div className="flex flex-col gap-5 p-6 sm:p-8">
            <Slider label="Calls per week" value={inputs.callsPerWeek} min={10} max={200} step={5} onChange={set('callsPerWeek')} format={(v) => `${v}`} />
            <Slider label="Share you miss" value={inputs.missedPercent} min={0} max={80} step={5} onChange={set('missedPercent')} format={(v) => `${v}%`} />
            <Slider label="Missed callers who would have booked" value={inputs.bookRatePercent} min={5} max={80} step={5} onChange={set('bookRatePercent')} format={(v) => `${v}%`} />
            <Slider label="Average job value" value={inputs.jobValue} min={50} max={2000} step={25} onChange={set('jobValue')} format={usd} />
          </div>

          <div className="flex flex-col justify-center gap-4 border-t border-border bg-bg-tertiary p-6 sm:p-8 md:border-s md:border-t-0">
            <p className="text-sm font-medium text-text-secondary">Revenue at stake each month</p>
            <p className="font-display text-4xl font-semibold tracking-tight text-text-primary sm:text-5xl" aria-live="polite" aria-atomic="true">
              {usd(r.monthlyRevenueAtStake)}
            </p>
            <p className="text-sm text-text-secondary">About {usd(r.annualRevenueAtStake)} a year.</p>

            <div className="rounded-xl border border-border bg-bg-secondary p-4 text-sm leading-relaxed text-text-secondary">
              <p className="font-semibold text-text-primary">How this is calculated</p>
              <p className="mt-1">
                {inputs.callsPerWeek} calls a week × {inputs.missedPercent}% missed × 52 ÷ 12 ={' '}
                <strong className="text-text-primary">{num(r.missedPerMonth)}</strong> missed calls a month.
              </p>
              <p className="mt-1">
                × {inputs.bookRatePercent}% booked = <strong className="text-text-primary">{num(r.bookedJobsPerMonth)}</strong> jobs
                × {usd(inputs.jobValue)} = <strong className="text-text-primary">{usd(r.monthlyRevenueAtStake)}</strong>.
              </p>
            </div>

            <p className="text-xs leading-relaxed text-text-secondary">
              This is an estimate from the numbers you entered, not a promise of results. Sarah can only recover the
              calls she is able to answer and book.
            </p>

            <ButtonLink to="/signup" size="lg" className="w-full" onClick={() => trackHomeCta('calculator_primary')}>
              Start free trial
              <ArrowRight size={18} aria-hidden="true" className="rtl:-scale-x-100" />
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}

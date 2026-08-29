import { motion } from 'framer-motion';
import { Phone, Star, Zap, Clock, ShieldCheck, ArrowRight, CheckCircle2, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { SARAH_PHONE } from '@/lib/site';

const TRUST_ITEMS = [
  { icon: Clock, label: 'Answers 24/7' },
  { icon: Zap, label: 'Flags urgent jobs' },
  { icon: ShieldCheck, label: '15-minute setup' },
  { icon: Star, label: 'No credit card' },
];

const CALL_STEPS = [
  { label: 'Intent', value: 'Emergency plumbing call' },
  { label: 'Action', value: 'Dispatch owner + capture job' },
  { label: 'Outcome', value: '$1,200 opportunity protected' },
];

const fadeUp = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
};

function ProductPreview() {
  return (
    <motion.div
      {...fadeUp}
      transition={{ duration: 0.6, delay: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="relative mx-auto mt-16 max-w-5xl"
      aria-label="Vireek AI receptionist product preview"
    >
      <div className="absolute -inset-6 rounded-[2rem] bg-gradient-to-r from-accent/15 via-cta/10 to-accent/15 blur-2xl" />
      <div className="relative overflow-hidden rounded-[1.75rem] border border-border/80 bg-bg-secondary/90 shadow-2xl backdrop-blur-xl dark:bg-bg-secondary/80">
        <div className="flex items-center justify-between border-b border-border/80 px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full bg-danger/70" />
            <span className="h-3 w-3 rounded-full bg-amber-400" />
            <span className="h-3 w-3 rounded-full bg-success-500" />
          </div>
          <span className="rounded-full border border-success-500/30 bg-success-500/10 px-3 py-1 text-xs font-semibold text-success-500">
            Live call handled
          </span>
        </div>

        <div className="grid gap-0 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="p-6 text-left md:p-8">
            <div className="flex items-center gap-3">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent text-white shadow-glow-accent">
                <Phone size={22} />
              </span>
              <div>
                <p className="text-sm font-semibold text-text-primary">Sarah answered in 1.8s</p>
                <p className="text-sm text-text-secondary">Inbound call from Palo Alto, CA</p>
              </div>
            </div>

            <div className="mt-7 space-y-4">
              <div className="max-w-[88%] rounded-2xl rounded-tl-sm border border-border bg-bg-tertiary px-4 py-3 text-sm leading-relaxed text-text-primary">
                “My water heater is leaking and I need someone today.”
              </div>
              <div className="ml-auto max-w-[88%] rounded-2xl rounded-tr-sm bg-accent px-4 py-3 text-sm leading-relaxed text-white">
                “I can help. I’m marking this as urgent and collecting the address so your team can respond immediately.”
              </div>
            </div>

            <div className="mt-7 grid gap-3 sm:grid-cols-3">
              {CALL_STEPS.map((step) => (
                <div key={step.label} className="rounded-2xl border border-border bg-bg-primary p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary">{step.label}</p>
                  <p className="mt-2 text-sm font-semibold leading-snug text-text-primary">{step.value}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-border/80 bg-bg-tertiary/80 p-6 text-left lg:border-l lg:border-t-0 md:p-8">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-text-secondary">Operator dashboard</p>
            <div className="mt-5 space-y-3">
              {['Caller captured', 'Emergency detected', 'SMS confirmation sent', 'Job summary ready'].map((item) => (
                <div key={item} className="flex items-center gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3">
                  <CheckCircle2 size={18} className="text-success-500" />
                  <span className="text-sm font-medium text-text-primary">{item}</span>
                </div>
              ))}
            </div>
            <div className="mt-5 rounded-2xl bg-slate-950 p-4 text-sm text-slate-200 shadow-inner">
              <p className="font-semibold text-white">AI summary</p>
              <p className="mt-2 leading-relaxed text-slate-300">
                Emergency water-heater leak. Customer available today. Address and callback number verified.
              </p>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export function Hero() {
  return (
    <section id="top" className="relative flex min-h-screen items-center overflow-hidden bg-noise bg-gradient-mesh pt-20">
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-bg-primary via-bg-primary to-bg-secondary" />
      <div className="mx-auto w-full max-w-7xl px-6 pb-20 pt-20 text-center md:pt-28">
        <motion.div {...fadeUp} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }} className="mx-auto mb-6 flex w-fit items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-4 py-2">
          <Sparkles size={15} className="text-accent" />
          <span className="text-sm font-semibold text-text-primary">AI receptionist for high-intent customer calls</span>
        </motion.div>

        <motion.h1 {...fadeUp} transition={{ duration: 0.5, delay: 0.05, ease: [0.16, 1, 0.3, 1] }} className="mx-auto max-w-5xl text-5xl font-extrabold leading-[1.02] tracking-[-0.045em] text-text-primary md:text-7xl lg:text-8xl">
          Never miss a customer because your team missed the phone.
        </motion.h1>

        <motion.p {...fadeUp} transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }} className="mx-auto mt-7 max-w-3xl text-lg leading-8 text-text-secondary md:text-xl">
          Vireek answers business calls with AI, qualifies every caller, detects urgent jobs, and turns missed calls into booked revenue — day, night, and after hours.
        </motion.p>

        <motion.div {...fadeUp} transition={{ duration: 0.5, delay: 0.15, ease: [0.16, 1, 0.3, 1] }} className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link to="/login" className="w-full sm:w-auto"><Button variant="primary" size="lg" className="w-full gap-2 px-8">Start free trial<ArrowRight size={18} /></Button></Link>
          <a href={SARAH_PHONE} className="w-full sm:w-auto"><Button variant="secondary" size="lg" className="w-full gap-2 px-8"><Phone size={18} />Call the AI now</Button></a>
        </motion.div>

        <motion.div {...fadeUp} transition={{ duration: 0.5, delay: 0.2, ease: [0.16, 1, 0.3, 1] }} className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm font-medium text-text-secondary">
          {TRUST_ITEMS.map((item) => (<span key={item.label} className="flex items-center gap-2"><item.icon size={16} className="text-accent" />{item.label}</span>))}
        </motion.div>

        <ProductPreview />
      </div>
    </section>
  );
}

import { motion } from 'framer-motion';
import { Building2, Globe2, LockKeyhole, Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

const STATS = [
  { value: '24/7', label: 'coverage for every inbound call' },
  { value: '<2 sec', label: 'AI answer experience for urgent callers' },
  { value: '300+', label: 'typical monthly calls included on Professional' },
];

const TRUST = [
  { icon: Building2, title: 'Built for operators', body: 'Designed around real service workflows: urgency, job details, address capture, and follow-up.' },
  { icon: LockKeyhole, title: 'Business-ready handoff', body: 'Every conversation becomes a structured summary your team can act on quickly.' },
  { icon: Globe2, title: 'Global SaaS standard', body: 'Clear onboarding, transparent pricing, responsive support, and product-led trial conversion.' },
];

export function SocialProof() {
  return (
    <section className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={viewport} transition={{ duration: 0.5, ease: EASE }} className="mx-auto max-w-3xl text-center">
          <p className={eyebrowClass()}>Trust layer</p>
          <h2 className={sectionHeadingClass()}>Enterprise-grade call coverage for teams that cannot afford voicemail.</h2>
        </motion.div>

        <motion.div variants={staggerContainer} initial="initial" whileInView="whileInView" viewport={viewport} className="mt-14 grid gap-6 md:grid-cols-3">
          {STATS.map(({ value, label }) => (
            <motion.div key={value} variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE }}>
              <Card className="h-full text-center">
                <p className="text-5xl font-extrabold tracking-tight text-accent md:text-6xl">{value}</p>
                <p className="mx-auto mt-4 max-w-xs text-base leading-relaxed text-text-secondary">{label}</p>
              </Card>
            </motion.div>
          ))}
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={viewport} transition={{ duration: 0.5, ease: EASE }} className="mt-16 overflow-hidden rounded-3xl border border-border bg-bg-secondary shadow-card dark:shadow-card-dark">
          <div className="grid lg:grid-cols-[0.9fr_1.1fr]">
            <div className="bg-slate-950 p-8 text-white md:p-10">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-white/80"><Sparkles size={13} />Early access</span>
              <h3 className="mt-6 text-3xl font-bold leading-tight md:text-4xl">A premium AI receptionist without enterprise complexity.</h3>
              <p className="mt-4 text-base leading-relaxed text-slate-300">Vireek is new, focused, and hands-on. Early customers get guided setup and direct influence on the roadmap.</p>
            </div>
            <div className="grid gap-0 md:grid-cols-3">
              {TRUST.map(({ icon: Icon, title, body }) => (
                <div key={title} className="border-b border-border p-7 last:border-b-0 md:border-b-0 md:border-r md:last:border-r-0">
                  <Icon size={24} className="text-accent" />
                  <h4 className="mt-5 text-lg font-semibold text-text-primary">{title}</h4>
                  <p className="mt-3 text-sm leading-relaxed text-text-secondary">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

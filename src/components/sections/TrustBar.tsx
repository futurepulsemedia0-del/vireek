import { motion } from 'framer-motion';
import { ShieldCheck, Lock, Server, Clock, Globe, Headphones } from 'lucide-react';

const TRUST_ITEMS = [
  { icon: ShieldCheck, label: 'SOC 2 Ready' },
  { icon: Lock, label: 'End-to-End Encrypted' },
  { icon: Server, label: '99.9% Uptime SLA' },
  { icon: Clock, label: '24/7 Availability' },
  { icon: Globe, label: 'Multi-Region' },
  { icon: Headphones, label: 'Human Support' },
];

const EASE = [0.16, 1, 0.0, 1] as const;

export function TrustBar() {
  return (
    <section className="border-y border-border/60 bg-bg-secondary/50 py-10">
      <div className="mx-auto max-w-7xl px-6">
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ duration: 0.5, ease: EASE }}
          className="text-center text-xs font-semibold uppercase tracking-[0.18em] text-text-secondary/60"
        >
          Enterprise-grade infrastructure, built for contractors
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
          className="mt-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-4 sm:gap-x-12"
        >
          {TRUST_ITEMS.map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="flex items-center gap-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
            >
              <Icon size={18} className="text-accent" />
              {label}
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

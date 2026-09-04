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
    <section className="border-y border-border/60 bg-bg-secondary/50 py-8 sm:py-10">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ duration: 0.5, ease: EASE }}
          className="text-center text-[0.65rem] font-semibold uppercase tracking-[0.15em] text-text-secondary/60 sm:text-xs sm:tracking-[0.18em]"
        >
          Enterprise-grade infrastructure, built for contractors
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-40px' }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.1 }}
          className="mt-5 grid grid-cols-3 gap-x-4 gap-y-4 sm:mt-6 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-x-8 sm:gap-y-4 lg:gap-x-12"
        >
          {TRUST_ITEMS.map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="flex items-center justify-center gap-2 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary sm:text-sm"
            >
              <Icon size={16} className="text-accent sm:size-[18px]" />
              <span className="text-center leading-tight">{label}</span>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

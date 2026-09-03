import { motion } from 'framer-motion';
import { ShieldCheck, Lock, FileCheck, Eye, Server, KeyRound } from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

const SECURITY_FEATURES = [
  {
    icon: Lock,
    title: 'End-to-End Encryption',
    body: 'Every call and message is encrypted in transit and at rest. Customer data never sits exposed.',
  },
  {
    icon: ShieldCheck,
    title: 'Privacy-First AI',
    body: 'Sarah processes conversations to do her job, but your data is never sold or shared with third parties.',
  },
  {
    icon: FileCheck,
    title: 'Compliance Ready',
    body: 'Built to align with SOC 2 and GDPR standards. Audit logs and data retention controls included.',
  },
  {
    icon: Server,
    title: 'Secure Infrastructure',
    body: 'Hosted on enterprise-grade cloud infrastructure with 99.9% uptime and automatic failover.',
  },
  {
    icon: KeyRound,
    title: 'Access Controls',
    body: 'Role-based permissions, team management, and audit trails — so you control who sees what.',
  },
  {
    icon: Eye,
    title: 'Transparent Data Practices',
    body: 'You own your data. Export or delete it anytime. No lock-in, no hidden data sharing.',
  },
];

export function SecurityPrivacy() {
  return (
    <section id="security" className="relative overflow-hidden py-24 md:py-28">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-50"
        style={{
          backgroundImage:
            'radial-gradient(circle at 80% 20%, rgb(var(--accent-primary) / 0.06), transparent 50%)',
        }}
      />
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>Security & Privacy</p>
          <h2 className={sectionHeadingClass()}>Your Calls. Your Data. Your Control.</h2>
          <p className={bodyClass()}>
            Vireek is built on a security-first foundation. From encryption to access controls,
            every layer is designed to protect your business and your customers.
          </p>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {SECURITY_FEATURES.map(({ icon: Icon, title, body }) => (
            <motion.div
              key={title}
              variants={fadeUpItem}
              transition={{ duration: 0.5, ease: EASE }}
              className="group rounded-2xl border border-border bg-bg-secondary p-6 shadow-card transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-accent/25 dark:shadow-card-dark"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent transition-colors duration-300 group-hover:bg-accent group-hover:text-white">
                <Icon size={20} />
              </span>
              <h3 className="mt-4 text-base font-semibold text-text-primary">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">{body}</p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

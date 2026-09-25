import { motion } from 'framer-motion';
import {
  ShieldCheck,
  Lock,
  FileCheck,
  Server,
  KeyRound,
  Eye,
  type LucideIcon,
} from 'lucide-react';
import {
  EASE,
  eyebrowClass,
  sectionHeadingClass,
  staggerContainer,
  fadeUpItem,
  viewport,
} from '@/lib/motion';

interface SecurityFeature {
  icon: LucideIcon;
  title: string;
  body: string;
}

const SECURITY_FEATURES: SecurityFeature[] = [
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
    body: 'Built with SOC 2 and GDPR principles in mind — encryption, audit logs, and data retention controls included.',
  },
  {
    icon: Server,
    title: 'Enterprise Infrastructure',
    body: 'Hosted on enterprise-grade cloud infrastructure, targeting 99.9% monthly uptime under our published SLA.',
  },
  {
    icon: KeyRound,
    title: 'Access Controls',
    body: 'Role-based permissions, team management, and audit trails — so you control who sees what.',
  },
  {
    icon: Eye,
    title: 'Responsible AI',
    body: 'You own your data. Export or delete it anytime. No lock-in, no hidden data sharing, full transparency.',
  },
];

const TRUST_BADGES = [
  { label: 'SOC 2', value: 'Aligned' },
  { label: 'GDPR', value: 'Aligned' },
  { label: 'Uptime SLA', value: '99.9% Target' },
  { label: 'Data Ownership', value: 'Yours' },
];

export function SecurityPrivacy() {
  return (
    <section
      id="security"
      className="relative overflow-hidden py-16 sm:py-24 md:py-28"
    >
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-50"
        style={{
          backgroundImage:
            'radial-gradient(circle at 80% 20%, rgb(var(--accent-primary) / 0.06), transparent 50%), radial-gradient(circle at 20% 80%, rgb(var(--success) / 0.04), transparent 50%)',
        }}
      />

      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>{'Security & Trust'}</p>

          <h2
            className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}
          >
            {'Built For Businesses That Depend On Every Call'}
          </h2>

          <p className="mt-4 text-sm leading-relaxed text-text-secondary sm:mt-5 sm:text-base md:text-lg">
            Vireek is built on a security-first foundation. From encryption to
            access controls, every layer is designed to protect your business
            and your customers.
          </p>
        </motion.div>

        {/* Trust badges */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
          className="mt-8 grid grid-cols-2 gap-3 sm:mt-10 sm:grid-cols-4 sm:gap-4"
        >
          {TRUST_BADGES.map((badge) => (
            <div
              key={badge.label}
              className="flex flex-col items-center justify-center rounded-xl border border-border bg-bg-secondary px-4 py-4 text-center shadow-sm sm:py-5"
            >
              <span className="text-lg font-bold tracking-tight text-text-primary sm:text-xl">
                {badge.value}
              </span>

              <span className="mt-0.5 text-xs text-text-secondary">
                {badge.label}
              </span>
            </div>
          ))}
        </motion.div>

        {/* Feature cards */}
        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-8 grid gap-4 sm:mt-10 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3"
        >
          {SECURITY_FEATURES.map(
            ({ icon: Icon, title, body }) => (
              <motion.div
                key={title}
                variants={fadeUpItem}
                transition={{ duration: 0.5, ease: EASE }}
                className="group relative overflow-hidden rounded-2xl border border-border bg-bg-secondary p-5 shadow-card transition-all duration-300 ease-out hover:-translate-y-0.5 hover:border-accent/25 hover:shadow-card-hover dark:shadow-card-dark sm:p-6"
              >
                <div
                  className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                  style={{
                    backgroundImage:
                      'radial-gradient(circle at 50% 0%, rgb(var(--accent-primary) / 0.05), transparent 60%)',
                  }}
                />

                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent transition-colors duration-300 group-hover:bg-accent group-hover:text-white">
                  <Icon size={20} />
                </span>

                <h3 className="mt-4 text-base font-semibold text-text-primary">
                  {title}
                </h3>

                <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                  {body}
                </p>
              </motion.div>
            ),
          )}
        </motion.div>
      </div>
    </section>
  );
}

import { motion } from 'framer-motion';
import {
  Calendar, Users, Cloud, Wrench, Zap, Plug,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

interface Integration {
  icon: LucideIcon;
  name: string;
  category: string;
}

const INTEGRATIONS: Integration[] = [
  { icon: Calendar, name: 'Google Calendar', category: 'Scheduling' },
  { icon: Users, name: 'HubSpot', category: 'CRM' },
  { icon: Cloud, name: 'Salesforce', category: 'CRM' },
  { icon: Wrench, name: 'ServiceTitan', category: 'Field Service' },
  { icon: Wrench, name: 'Housecall Pro', category: 'Field Service' },
  { icon: Wrench, name: 'Jobber', category: 'Field Service' },
  { icon: Zap, name: 'Zapier', category: 'Automation' },
  { icon: Plug, name: 'Custom Webhooks', category: 'Developer' },
];

export function Integrations() {
  return (
    <section id="integrations" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl text-center"
        >
          <p className={eyebrowClass()}>Integrations</p>
          <h2 className={sectionHeadingClass()}>Connects With the Tools You Already Use</h2>
          <p className={`${bodyClass()} mx-auto`}>
            Sarah doesn&apos;t just take calls — she writes straight into your calendar, CRM, and
            dispatch software. No double entry, no missed handoffs.
          </p>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-14 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
        >
          {INTEGRATIONS.map(({ icon: Icon, name, category }) => (
            <motion.div
              key={name}
              variants={fadeUpItem}
              transition={{ duration: 0.4, ease: EASE }}
              className="group flex flex-col items-center gap-3 rounded-2xl border border-border bg-bg-secondary p-6 text-center shadow-card transition-all duration-300 ease-out hover:-translate-y-1 hover:border-accent/30 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary transition-all duration-300 group-hover:bg-accent/10 group-hover:text-accent">
                <Icon size={26} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">{name}</h3>
                <p className="mt-0.5 text-xs text-text-secondary/60">{category}</p>
              </div>
            </motion.div>
          ))}
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mt-8 text-center text-sm text-text-secondary/70"
        >
          Don&apos;t see your tool? Sarah connects to any system that accepts webhooks or a Zapier trigger.
        </motion.p>
      </div>
    </section>
  );
}

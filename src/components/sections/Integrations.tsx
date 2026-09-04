import { motion } from 'framer-motion';
import {
  Calendar, Users, Cloud, Wrench, Zap, Plug, ArrowRight,
  type LucideIcon,
} from 'lucide-react';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

interface Integration {
  icon: LucideIcon;
  name: string;
  category: string;
  description: string;
}

const INTEGRATIONS: Integration[] = [
  { icon: Calendar, name: 'Google Calendar', category: 'Scheduling', description: 'Real-time two-way sync of appointments and availability.' },
  { icon: Users, name: 'HubSpot', category: 'CRM', description: 'Contacts, deals, and activity logs created automatically.' },
  { icon: Cloud, name: 'Salesforce', category: 'CRM', description: 'Enterprise CRM sync with custom field mapping.' },
  { icon: Wrench, name: 'ServiceTitan', category: 'Field Service', description: 'Jobs, dispatch, and customer data in sync.' },
  { icon: Wrench, name: 'Housecall Pro', category: 'Field Service', description: 'Booked jobs flow straight into your dispatch board.' },
  { icon: Wrench, name: 'Jobber', category: 'Field Service', description: 'Client and appointment data synced automatically.' },
  { icon: Zap, name: 'Zapier', category: 'Automation', description: 'Connect Vireek to 5,000+ apps with no code.' },
  { icon: Plug, name: 'Custom Webhooks', category: 'Developer', description: 'Fire webhooks on any event for custom integrations.' },
];

const DATA_FLOW_STEPS = [
  { label: 'Call Answered', detail: 'Sarah picks up' },
  { label: 'Data Captured', detail: 'Customer info + intent' },
  { label: 'CRM Updated', detail: 'Contact created or enriched' },
  { label: 'Calendar Synced', detail: 'Appointment booked' },
];

export function Integrations() {
  return (
    <section id="integrations" className="py-16 sm:py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="mx-auto max-w-3xl text-center"
        >
          <p className={eyebrowClass()}>{'Integrations'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>{'Works With Your Existing Tools'}</h2>
          <p className={`${bodyClass()} mx-auto text-sm sm:text-base md:text-lg`}>
            Sarah doesn&apos;t just take calls — she writes straight into your calendar, CRM, and
            dispatch software. No double entry, no missed handoffs.
          </p>
        </motion.div>

        {/* Data flow visualization */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.6, delay: 0.1, ease: EASE }}
          className="mt-10 overflow-hidden rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark sm:mt-12 sm:p-8"
        >
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
            {DATA_FLOW_STEPS.map((step, i) => (
              <div key={step.label} className="flex items-center gap-3 sm:flex-1 sm:flex-col">
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={viewport}
                  transition={{ duration: 0.4, delay: 0.15 + i * 0.1, ease: EASE }}
                  className="flex w-full items-center gap-3 rounded-xl border border-border bg-bg-tertiary px-4 py-3 sm:flex-col sm:items-center sm:gap-1 sm:py-4 sm:text-center"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-xs font-bold text-accent">
                    {i + 1}
                  </span>
                  <div className="sm:mt-0">
                    <p className="text-sm font-semibold text-text-primary">{step.label}</p>
                    <p className="text-xs text-text-secondary">{step.detail}</p>
                  </div>
                </motion.div>
                {i < DATA_FLOW_STEPS.length - 1 && (
                  <ArrowRight size={16} className="shrink-0 text-text-secondary/30 sm:mt-0 sm:rotate-90" />
                )}
              </div>
            ))}
          </div>
        </motion.div>

        {/* Integration cards */}
        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-8 grid grid-cols-2 gap-3 sm:mt-10 sm:gap-4 lg:grid-cols-4"
        >
          {INTEGRATIONS.map(({ icon: Icon, name, category, description }) => (
            <motion.div
              key={name}
              variants={fadeUpItem}
              transition={{ duration: 0.4, ease: EASE }}
              className="group relative overflow-hidden rounded-2xl border border-border bg-bg-secondary p-4 shadow-card transition-all duration-300 ease-out hover:-translate-y-1 hover:border-accent/30 hover:shadow-card-hover dark:shadow-card-dark dark:hover:shadow-card-hover-dark sm:p-5"
            >
              <div
                className="pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{
                  backgroundImage: 'radial-gradient(circle at 50% 0%, rgb(var(--accent-primary) / 0.06), transparent 60%)',
                }}
              />
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-bg-tertiary text-text-secondary transition-all duration-300 group-hover:bg-accent/10 group-hover:text-accent sm:h-12 sm:w-12">
                <Icon size={20} className="sm:size-5" />
              </span>
              <h3 className="mt-3 text-sm font-semibold text-text-primary sm:text-base">{name}</h3>
              <p className="mt-0.5 text-xs text-text-secondary/60">{category}</p>
              <p className="mt-2 text-xs leading-relaxed text-text-secondary">{description}</p>
            </motion.div>
          ))}
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mt-6 text-center text-xs text-text-secondary/70 sm:mt-8 sm:text-sm"
        >
          Don&apos;t see your tool? Sarah connects to any system that accepts webhooks or a Zapier trigger.
        </motion.p>
      </div>
    </section>
  );
}

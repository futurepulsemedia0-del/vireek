import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { INTEGRATIONS } from '@/lib/integrations';
import { EASE, eyebrowClass, sectionHeadingClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

export function IntegrationEcosystem() {
  const liveIntegrations = INTEGRATIONS.filter((i) => i.status === 'live');

  return (
    <section className="px-5 py-16 sm:px-6 sm:py-24">
      <div className="mx-auto max-w-5xl">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="text-center"
        >
          <p className={eyebrowClass()}>Works with your stack</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl`}>
            Works with the tools your business already uses
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-base text-text-secondary">
            Live pricing sync so Sarah always quotes accurate rates \u2014 plus webhooks that connect to Zapier, Make.com, or any tool that takes an incoming URL.
          </p>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-10 grid gap-5 sm:grid-cols-3"
        >
          {liveIntegrations.map((integration) => {
            const Icon = integration.icon;
            return (
              <motion.div key={integration.slug} variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
                <Link
                  to={`/integrations/${integration.slug}`}
                  className="focus-ring group flex h-full flex-col items-center rounded-2xl border border-border bg-bg-secondary p-6 text-center shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-card-hover dark:shadow-card-dark"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-4 text-base font-bold text-text-primary">{integration.name}</h3>
                  <p className="mt-1 text-xs text-text-secondary">{integration.tagline}</p>
                </Link>
              </motion.div>
            );
          })}
          <motion.div variants={fadeUpItem} transition={{ duration: 0.4, ease: EASE }}>
            <Link
              to="/integrations"
              className="focus-ring flex h-full flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-primary p-6 text-center transition-colors hover:border-accent/40"
            >
              <span className="text-sm font-semibold text-accent">More integrations on the way</span>
              <span className="mt-1 inline-flex items-center gap-1 text-xs text-text-secondary">
                See the roadmap <ArrowRight className="h-3.5 w-3.5" />
              </span>
            </Link>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}

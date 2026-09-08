import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/Card';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';
import { INDUSTRIES } from '@/lib/industries';

export function Industries() {
  return (
    <section id="industries" className="py-16 sm:py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-5 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>{'Industries'}</p>
          <h2 className={`${sectionHeadingClass()} text-2xl sm:text-3xl md:text-5xl`}>{'Built for Your Trade. Not a Generic Bot.'}</h2>
          <p className={`${bodyClass()} text-sm sm:text-base md:text-lg`}>
            {'Sarah speaks the language of home services. She knows the difference between a heat pump and a torsion spring.'}
          </p>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-10 grid gap-4 sm:mt-14 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3"
        >
          {INDUSTRIES.map(({ icon: Icon, name, slug, tagline, terms }) => (
            <motion.div key={name} variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE }}>
              <Card className="flex h-full flex-col overflow-hidden p-0">
                {/*
                  An on-brand gradient + icon panel rather than a stock or
                  placeholder photo — consistent with the rest of the page's
                  "no generic illustration" rule, and it never breaks like a
                  missing image asset would.
                */}
                <div className="relative flex h-28 w-full items-center overflow-hidden bg-bg-tertiary px-5 sm:h-32 sm:px-6">
                  <div
                    className="pointer-events-none absolute inset-0"
                    style={{
                      backgroundImage:
                        'radial-gradient(circle at 15% 30%, rgb(var(--accent-primary) / 0.16), transparent 60%), radial-gradient(circle at 85% 80%, rgb(var(--accent-secondary) / 0.12), transparent 55%)',
                    }}
                  />
                  <Icon
                    size={96}
                    strokeWidth={1}
                    className="pointer-events-none absolute -right-3 -top-3 text-accent/10"
                    aria-hidden="true"
                  />
                  <span className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-bg-primary/80 text-accent shadow-sm backdrop-blur-sm sm:h-11 sm:w-11">
                    <Icon size={18} className="sm:size-5" />
                  </span>
                </div>
                <div className="flex flex-1 flex-col p-5 sm:p-6">
                  <h3 className="text-lg font-semibold text-text-primary sm:text-xl md:text-2xl">{name}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{tagline}</p>
                  <ul className="mt-4 flex flex-wrap gap-2 sm:mt-5">
                    {terms.map((term) => (
                      <li
                        key={term}
                        className="rounded-lg border border-border bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary sm:px-3 sm:py-1.5 sm:text-sm"
                      >
                        {term}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to={`/industries/${slug}`}
                    className="focus-ring mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-accent transition-colors hover:text-cta sm:mt-6"
                  >
                    {'See how Vireek helps '}{name.toLowerCase()}
                    <ArrowRight size={14} />
                  </Link>
                </div>
              </Card>
            </motion.div>
          ))}
        </motion.div>

        {/* Mobile: link to all industries */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={viewport}
          transition={{ duration: 0.5, delay: 0.2, ease: EASE }}
          className="mt-6 text-center sm:hidden"
        >
          <Link
            to="/industries"
            className="focus-ring inline-flex items-center gap-1.5 text-sm font-semibold text-accent"
          >
            View all industries
            <ArrowRight size={14} />
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

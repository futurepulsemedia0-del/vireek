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
          {INDUSTRIES.map(({ icon: Icon, name, slug, terms }) => (
            <motion.div key={name} variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE }}>
              <Card className="flex h-full flex-col overflow-hidden p-0">
                <div className="relative h-28 w-full overflow-hidden bg-bg-tertiary sm:h-32">
                  <img
                    src={`/industries-${slug}.png`}
                    alt={`${name} technician using Vireek`}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover"
                  />
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-bg-primary/70 via-bg-primary/10 to-transparent" />
                  <span className="absolute bottom-2.5 left-3 flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-bg-primary/70 text-accent backdrop-blur-sm sm:h-9 sm:w-9">
                    <Icon size={16} className="sm:size-[18px]" />
                  </span>
                </div>
                <div className="flex flex-1 flex-col p-5 sm:p-6">
                <h3 className="text-lg font-semibold text-text-primary sm:text-xl md:text-2xl">{name}</h3>
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

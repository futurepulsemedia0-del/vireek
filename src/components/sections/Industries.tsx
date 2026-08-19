import { motion } from 'framer-motion';
import { Flame, Droplets, Home, Zap, Wind } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EASE, eyebrowClass, sectionHeadingClass, bodyClass, staggerContainer, fadeUpItem, viewport } from '@/lib/motion';

const INDUSTRIES = [
  {
    icon: Wind,
    name: 'HVAC',
    terms: ['AC repair', 'furnace issues', 'heat pumps', 'no heat', 'no cool', 'thermostat problems'],
  },
  {
    icon: Droplets,
    name: 'Plumbing',
    terms: ['Burst pipes', 'leaks', 'drain cleaning', 'water heaters', 'sewer backup', 'low pressure'],
  },
  {
    icon: Home,
    name: 'Roofing',
    terms: ['Leak repair', 'storm damage', 'missing shingles', 'gutter issues', 'flashing', 'ice dams'],
  },
  {
    icon: Zap,
    name: 'Electrical',
    terms: ['Power issues', 'breaker problems', 'flickering lights', 'panel upgrades', 'GFCI'],
  },
  {
    icon: Flame,
    name: 'Restoration',
    terms: ['Flood extraction', 'structural drying', 'smoke damage', 'mold remediation', 'board-up'],
  },
];

export function Industries() {
  return (
    <section id="industries" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>Industries</p>
          <h2 className={sectionHeadingClass()}>Built for Your Trade. Not a Generic Bot.</h2>
          <p className={bodyClass()}>
            Sarah speaks the language of home services. She knows the difference between a heat
            pump and a torsion spring.
          </p>
        </motion.div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          whileInView="whileInView"
          viewport={viewport}
          className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
        >
          {INDUSTRIES.map(({ icon: Icon, name, terms }) => (
            <motion.div key={name} variants={fadeUpItem} transition={{ duration: 0.5, ease: EASE }}>
              <Card className="h-full">
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <Icon size={20} />
                  </span>
                  <h3 className="text-xl font-semibold text-text-primary md:text-2xl">{name}</h3>
                </div>
                <ul className="mt-5 flex flex-wrap gap-2">
                  {terms.map((term) => (
                    <li
                      key={term}
                      className="rounded-lg border border-border bg-bg-tertiary px-3 py-1.5 text-sm text-text-secondary"
                    >
                      {term}
                    </li>
                  ))}
                </ul>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

import { motion } from 'framer-motion';
import { ArrowRight, HelpCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { EASE, sectionHeadingClass, viewport } from '@/lib/motion';

export function FAQCallout() {
  return (
    <section className="py-16 md:py-20">
      <div className="mx-auto max-w-3xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="flex flex-col items-center gap-6 rounded-2xl border border-border bg-bg-secondary p-10 text-center shadow-card dark:shadow-card-dark md:p-14"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-accent">
            <HelpCircle size={28} />
          </span>
          <h2 className={`${sectionHeadingClass()} mt-0`}>
            Still have questions?
          </h2>
          <p className="text-base leading-relaxed text-text-secondary">
            We&apos;ve answered the most common questions about Sarah, setup, pricing, and what to
            expect when you switch.
          </p>
          <Link to="/faq">
            <Button variant="secondary" size="lg" className="gap-2">
              Visit our FAQ
              <ArrowRight size={18} />
            </Button>
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

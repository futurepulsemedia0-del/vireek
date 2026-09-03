import { motion } from 'framer-motion';
import { CheckCircle, XCircle } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EASE, eyebrowClass, sectionHeadingClass, viewport } from '@/lib/motion';

const BEFORE = [
  'Voicemail',
  'Lost emergency calls',
  '$36K/year receptionist',
  'Manual note-taking',
  'Missed after-hours jobs',
];

const AFTER = [
  '24/7 AI Answer',
  'Instant emergency flagging',
  '$199/month AI',
  'Auto CRM entry',
  'Jobs booked while you sleep',
];

function Row({
  children,
  icon,
  tone,
}: {
  children: React.ReactNode;
  icon: 'x' | 'check';
  tone: 'before' | 'after';
}) {
  return (
    <li
      className={`flex items-center gap-3 border-b border-border px-1 py-3.5 last:border-0 ${
        tone === 'before' ? 'text-text-secondary' : 'text-text-primary'
      }`}
    >
      {icon === 'x' ? (
        <XCircle size={18} className="shrink-0 text-danger/70" />
      ) : (
        <CheckCircle size={18} className="shrink-0 text-success-500" />
      )}
      <span className="text-base">{children}</span>
    </li>
  );
}

export function BeforeAfter() {
  return (
    <section id="before-after" className="py-24 md:py-28">
      <div className="mx-auto max-w-7xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={viewport}
          transition={{ duration: 0.5, ease: EASE }}
          className="max-w-3xl"
        >
          <p className={eyebrowClass()}>The difference</p>
          <h2 className={sectionHeadingClass()}>Before Vireek vs After Vireek</h2>
        </motion.div>

        <div className="mt-14 grid gap-6 md:grid-cols-2">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <Card className="h-full border-danger/20 bg-danger/5">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-danger/10 text-danger">
                  <XCircle size={18} />
                </span>
                <h3 className="text-xl font-semibold text-text-primary md:text-2xl">Before</h3>
              </div>
              <ul className="mt-4">
                {BEFORE.map((item) => (
                  <Row key={item} icon="x" tone="before">
                    {item}
                  </Row>
                ))}
              </ul>
            </Card>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={viewport}
            transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
          >
            <Card className="h-full border-success-500/20 bg-success-500/5">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-success-500/10 text-success-500">
                  <CheckCircle size={18} />
                </span>
                <h3 className="text-xl font-semibold text-text-primary md:text-2xl">After</h3>
              </div>
              <ul className="mt-4">
                {AFTER.map((item) => (
                  <Row key={item} icon="check" tone="after">
                    {item}
                  </Row>
                ))}
              </ul>
            </Card>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

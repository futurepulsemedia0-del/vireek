import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { History, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { buildChangeRows, type ChangeRow } from '@/lib/changesSinceYesterday';
import { fetchChangeSnapshot } from '@/lib/changesSinceYesterdayApi';

const TONE_TEXT: Record<ChangeRow['tone'], string> = {
  good: 'text-success-500',
  bad: 'text-danger',
  neutral: 'text-text-primary',
};

export function SinceYesterdayCard() {
  const [rows, setRows] = useState<ChangeRow[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    fetchChangeSnapshot()
      .then((snapshot) => {
        if (cancelled) return;
        setRows(buildChangeRows(snapshot));
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'error') return null; // never show a broken card on the overview

  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      aria-label="What changed since yesterday"
      className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <History size={16} />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-text-primary">Since yesterday</h2>
          <p className="text-xs text-text-secondary/70">Last 24 hours vs. the 24 hours before</p>
        </div>
      </div>

      {status === 'loading' ? (
        <div className="mt-4 flex flex-wrap gap-3" aria-hidden="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-14 w-32 animate-pulse rounded-xl bg-bg-tertiary" />
          ))}
        </div>
      ) : rows && rows.length > 0 ? (
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {rows.map((row) => {
            const Arrow = row.direction === 'up' ? TrendingUp : TrendingDown;
            return (
              <li key={row.key} className="rounded-xl bg-bg-tertiary/60 px-4 py-3">
                <p className="text-xs font-medium text-text-secondary">{row.label}</p>
                <p className={`mt-1 flex items-center gap-1.5 text-xl font-bold tracking-tight ${TONE_TEXT[row.tone]}`}>
                  <Arrow size={16} aria-hidden="true" />
                  {row.display}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-4 flex items-center gap-2 text-sm text-text-secondary">
          <Minus size={16} aria-hidden="true" />
          Steady — nothing moved meaningfully since yesterday.
        </p>
      )}
    </motion.section>
  );
}

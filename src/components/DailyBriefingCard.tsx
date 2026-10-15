import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CheckCircle2, RefreshCw, Settings2, Sunrise } from 'lucide-react';
import type { Briefing, BriefingItem, Severity, Tone } from '@/lib/dailyBriefing';
import { fetchLatestBriefing, refreshBriefing } from '@/lib/dailyBriefingApi';

const TONE_TEXT: Record<Tone, string> = {
  good: 'text-success-500',
  bad: 'text-danger',
  warn: 'text-amber-600 dark:text-amber-400',
  neutral: 'text-text-primary',
};
const SEVERITY_BADGE: Record<Severity, { label: string; cls: string }> = {
  urgent: { label: 'Needs attention', cls: 'bg-danger/10 text-danger' },
  attention: { label: 'Worth a look', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
  calm: { label: 'All clear', cls: 'bg-success-500/10 text-success-500' },
};

function Item({ item }: { item: BriefingItem }) {
  const body = (
    <>
      <span>{item.text}</span>
      {item.tag === 'AI' && (
        <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-accent">
          AI
        </span>
      )}
    </>
  );
  return (
    <li className={`text-sm ${TONE_TEXT[item.tone]}`}>
      {item.href ? (
        <Link to={item.href} className="hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}

export function DailyBriefingCard() {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setBriefing(await fetchLatestBriefing());
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      if (await refreshBriefing()) await load();
    } finally {
      setRefreshing(false);
    }
  };

  if (status === 'error') return null; // never show a broken card on the overview

  const badge = briefing ? SEVERITY_BADGE[briefing.severity] : null;
  const withItems = briefing?.sections.filter((s) => s.items.length > 0) ?? [];
  const clear = briefing?.sections.filter((s) => s.items.length === 0).map((s) => s.title) ?? [];

  return (
    <motion.section
      id="briefing"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      aria-label="Daily briefing"
      className="rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <Sunrise size={16} />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Daily briefing</h2>
            <p className="text-xs text-text-secondary/70">
              {briefing ? briefing.date : 'Delivered every morning'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh briefing"
            className="rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary disabled:opacity-50"
          >
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <Link
            to="/dashboard/settings#daily-briefing"
            aria-label="Briefing settings"
            className="rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary"
          >
            <Settings2 size={15} />
          </Link>
        </div>
      </div>

      {status === 'loading' ? (
        <div className="mt-4 space-y-2" aria-hidden="true">
          <div className="h-5 w-2/3 animate-pulse rounded bg-bg-tertiary" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-bg-tertiary" />
        </div>
      ) : !briefing ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-text-secondary">
            Your first briefing is on its way. You can build today’s now.
          </p>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {refreshing ? 'Building…' : 'Build today’s briefing'}
          </button>
        </div>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <p className="text-base font-semibold text-text-primary">{briefing.headline}</p>
            {badge && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
                {badge.label}
              </span>
            )}
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {withItems.map((s) => (
              <div key={s.key}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  {s.title}
                </h3>
                <ul className="mt-1.5 space-y-1.5">
                  {s.items.map((it, i) => (
                    <Item key={`${s.key}-${i}`} item={it} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {clear.length > 0 && (
            <p className="mt-4 flex items-center gap-1.5 text-xs text-text-secondary">
              <CheckCircle2 size={13} className="text-success-500" aria-hidden="true" />
              All clear: {clear.join(', ')}
            </p>
          )}
        </>
      )}
    </motion.section>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CircleAlert, Clock, MessageSquare, Phone, PhoneCall, RefreshCw, Send } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { formatCents } from '@/lib/quotes';
import {
  OUTCOME_META,
  REASON_META,
  buildQueue,
  formatAge,
  isWithinCallingHours,
  queueSummary,
  smsHref,
  smsTemplate,
  snoozeUntilFor,
  telHref,
  type OutcomeRecord,
  type QueueItem,
  type QueueOutcome,
  type QueueReason,
} from '@/lib/callQueue';
import { loadQueueSnapshot, logQueueOutcome, sendQueueSms, type QueueSnapshot } from '@/lib/callQueueData';

const REFRESH_MS = 5 * 60_000;

const OUTCOME_GROUPS: Array<{ title: string; outcomes: QueueOutcome[] }> = [
  { title: 'Reached them', outcomes: ['reached_booked', 'reached_resolved', 'reached_follow_up'] },
  { title: 'Could not reach', outcomes: ['no_answer', 'left_voicemail'] },
  { title: 'Close out', outcomes: ['not_interested', 'wrong_number', 'do_not_contact'] },
];

const TIER_STYLE = {
  now: 'bg-danger-500/10 text-danger-500',
  today: 'bg-warning-500/10 text-warning-500',
  soon: 'bg-bg-tertiary text-text-secondary',
} as const;
const TIER_LABEL = { now: 'Call now', today: 'Today', soon: 'Soon' } as const;

export function CallQueuePage() {
  const { toast } = useToast();
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [local, setLocal] = useState<OutcomeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<QueueReason | 'all'>('all');
  const [logging, setLogging] = useState<string | null>(null);
  const [texting, setTexting] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (silent) setRefreshing(true);
      try {
        const snap = await loadQueueSnapshot();
        setSnapshot(snap);
        setLocal([]);
        setNow(Date.now());
        if (snap.failedSources.length > 0) toast(`Some sources could not load: ${snap.failedSources.join(', ')}.`, 'error');
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not load the call queue.', 'error');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    load();
    const id = window.setInterval(() => load(true), REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && load(true);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const queue = useMemo(
    () => (snapshot ? buildQueue(snapshot.candidates, [...snapshot.outcomes, ...local], now) : []),
    [snapshot, local, now],
  );
  const summary = useMemo(() => queueSummary(queue), [queue]);
  const reasonCounts = useMemo(() => {
    const m = new Map<QueueReason, number>();
    for (const i of queue) m.set(i.reason, (m.get(i.reason) ?? 0) + 1);
    return m;
  }, [queue]);
  const visible = filter === 'all' ? queue : queue.filter((i) => i.reason === filter || i.alsoReasons.includes(filter));
  const businessName = snapshot?.businessName ?? '';
  const afterHours = !isWithinCallingHours(new Date(now));

  const record = useCallback(
    async (item: QueueItem, outcome: QueueOutcome, channel: 'call' | 'sms' | 'none', note?: string) => {
      const snoozeUntil = snoozeUntilFor(outcome);
      const optimistic: OutcomeRecord = { itemKey: item.key, outcome, snoozeUntil, createdAt: new Date().toISOString() };
      setLocal((prev) => [...prev, optimistic]);
      setLogging(null);
      setTexting(null);
      try {
        await logQueueOutcome({ item, outcome, channel, note, snoozeUntil });
        toast(`Logged: ${OUTCOME_META[outcome].label}`, 'success');
      } catch (err) {
        setLocal((prev) => prev.filter((o) => o !== optimistic));
        toast(err instanceof Error ? err.message : 'Could not save the outcome.', 'error');
      }
    },
    [toast],
  );

  const [head, ...rest] = visible;

  return (
    <DashboardLayout activeLabel="Call Queue">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><PhoneCall size={24} /></span>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Call Queue</h1>
            <p className="text-sm text-text-secondary">Who to contact next, ranked by urgency and revenue.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={refreshing || loading}
          className="focus-ring flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Updating…' : 'Refresh'}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading your queue…</p>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Call now" value={String(summary.now)} />
            <Stat label="Today" value={String(summary.today)} />
            <Stat label="Soon" value={String(summary.soon)} />
            <Stat label="Revenue in queue" value={formatCents(summary.valueCents)} />
          </div>

          {afterHours && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-secondary">
              <Clock size={14} className="shrink-0" /> It&rsquo;s outside 8am–9pm local time. A text is usually better than a call right now.
            </div>
          )}

          <div className="mb-4 flex flex-wrap gap-2" role="tablist" aria-label="Filter by reason">
            <FilterChip active={filter === 'all'} onClick={() => setFilter('all')} label={`All ${queue.length}`} />
            {(Object.keys(REASON_META) as QueueReason[])
              .filter((r) => reasonCounts.has(r))
              .map((r) => (
                <FilterChip key={r} active={filter === r} onClick={() => setFilter(r)} label={`${REASON_META[r].label} ${reasonCounts.get(r)}`} />
              ))}
          </div>

          {!head ? (
            <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center">
              <p className="text-sm text-text-secondary">
                {queue.length === 0
                  ? 'You\u2019re all caught up — no callbacks, invoices, quotes, memberships or unhappy customers need a call right now.'
                  : 'Nothing in this filter. Choose “All” to see the rest.'}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Next call</p>
              <QueueCard
                item={head}
                rank={1}
                featured
                now={now}
                businessName={businessName}
                logging={logging === head.key}
                texting={texting === head.key}
                onLogging={(open) => setLogging(open ? head.key : null)}
                onTexting={(open) => setTexting(open ? head.key : null)}
                onRecord={record}
              />
              {rest.length > 0 && <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Then</p>}
              {rest.map((item, idx) => (
                <QueueCard
                  key={item.key}
                  item={item}
                  rank={idx + 2}
                  now={now}
                  businessName={businessName}
                  logging={logging === item.key}
                  texting={texting === item.key}
                  onLogging={(open) => setLogging(open ? item.key : null)}
                  onTexting={(open) => setTexting(open ? item.key : null)}
                  onRecord={record}
                />
              ))}
            </div>
          )}
        </>
      )}
    </DashboardLayout>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary px-4 py-3">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-0.5 text-lg font-bold text-text-primary">{value}</p>
    </div>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${
        active ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  );
}

interface CardProps {
  item: QueueItem;
  rank: number;
  featured?: boolean;
  now: number;
  businessName: string;
  logging: boolean;
  texting: boolean;
  onLogging: (open: boolean) => void;
  onTexting: (open: boolean) => void;
  onRecord: (item: QueueItem, outcome: QueueOutcome, channel: 'call' | 'sms' | 'none', note?: string) => Promise<void>;
}

function QueueCard({ item, rank, featured, now, businessName, logging, texting, onLogging, onTexting, onRecord }: CardProps) {
  const { toast } = useToast();
  const meta = REASON_META[item.reason];
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (texting) setMessage(smsTemplate(item.reason, item.customerName, businessName));
  }, [texting, item.reason, item.customerName, businessName]);

  const close = (outcome: QueueOutcome) => {
    if (outcome === 'do_not_contact' && !window.confirm(`Mark ${item.customerName} as do-not-contact? They will be blocked from all texts and calls.`)) return;
    onRecord(item, outcome, 'call', note).then(() => setNote(''));
  };

  const send = async () => {
    if (!item.phone || !message.trim()) return;
    setSending(true);
    try {
      await sendQueueSms(item.phone, message.trim(), item.customerName);
      await onRecord(item, 'texted', 'sms', message.trim());
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send the text.', 'error');
    } finally {
      setSending(false);
    }
  };

  const btn = 'focus-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium';

  return (
    <article
      className={`rounded-2xl border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark ${featured ? 'border-accent/40' : 'border-border'}`}
      aria-label={`${rank}. ${item.customerName}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-text-secondary">#{rank}</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className}`}>{meta.label}</span>
            {item.alsoReasons.map((r) => (
              <span key={r} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary">+ {REASON_META[r].label}</span>
            ))}
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TIER_STYLE[item.tier]}`}>{TIER_LABEL[item.tier]}</span>
            {item.valueCents > 0 && <span className="text-xs font-semibold text-text-primary">{formatCents(item.valueCents)}</span>}
          </div>
          <h3 className={`mt-1.5 font-semibold text-text-primary ${featured ? 'text-lg' : 'text-sm'}`}>{item.customerName}</h3>
          <p className="mt-0.5 text-sm text-text-secondary">
            {item.detail || meta.label} · {formatAge(item.occurredAt, now)}
            {item.attempts > 0 && ` · ${item.attempts} attempt${item.attempts > 1 ? 's' : ''}`}
          </p>
          {item.phone && <p className="mt-0.5 text-xs text-text-secondary">{item.phone}</p>}
          <details className="mt-2 text-xs text-text-secondary">
            <summary className="focus-ring cursor-pointer select-none">Why #{rank}? Score {Math.round(item.score)}</summary>
            <ul className="mt-1.5 space-y-0.5">
              {item.factors.map((f) => (
                <li key={f.label} className="flex justify-between gap-6">
                  <span>{f.label}</span>
                  <span className={f.points < 0 ? 'text-danger-500' : 'text-text-primary'}>{f.points > 0 ? '+' : ''}{f.points}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
        {item.ctaHref && (
          <Link to={item.ctaHref} className="focus-ring flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary">
            Open <ArrowRight size={12} />
          </Link>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {item.callable && item.phone ? (
          <>
            <a href={telHref(item.phone)} onClick={() => onLogging(true)} className={`${btn} bg-accent text-white`}>
              <Phone size={14} /> Call
            </a>
            <button type="button" onClick={() => onTexting(!texting)} className={`${btn} border border-border text-text-primary`} aria-expanded={texting}>
              <MessageSquare size={14} /> Text
            </button>
          </>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-text-secondary">
            <CircleAlert size={14} /> No usable phone number — open the record to add one.
          </span>
        )}
        <button type="button" onClick={() => onLogging(!logging)} className={`${btn} text-text-secondary hover:text-text-primary`} aria-expanded={logging}>
          Log outcome
        </button>
      </div>

      {texting && item.phone && (
        <div className="mt-3 rounded-xl border border-border bg-bg-primary p-3">
          <label htmlFor={`sms-${item.key}`} className="sr-only">Text message</label>
          <textarea
            id={`sms-${item.key}`}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={640}
            rows={3}
            className="focus-ring w-full resize-none rounded-lg border border-border bg-bg-secondary p-2 text-sm text-text-primary"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={send} disabled={sending || !message.trim()} className={`${btn} bg-accent text-white disabled:opacity-50`}>
              <Send size={14} /> {sending ? 'Sending…' : 'Send text'}
            </button>
            <a
              href={smsHref(item.phone, message)}
              onClick={() => onLogging(true)}
              className={`${btn} border border-border text-text-secondary hover:text-text-primary`}
            >
              Use my Messages app
            </a>
          </div>
        </div>
      )}

      {logging && (
        <div className="mt-3 space-y-3 rounded-xl border border-border bg-bg-primary p-3">
          {OUTCOME_GROUPS.map((g) => (
            <div key={g.title}>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">{g.title}</p>
              <div className="flex flex-wrap gap-2">
                {g.outcomes.map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => close(o)}
                    className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-primary hover:border-accent hover:text-accent"
                  >
                    {OUTCOME_META[o].label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <label htmlFor={`note-${item.key}`} className="sr-only">Note</label>
          <input
            id={`note-${item.key}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Optional note"
            className="focus-ring w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary"
          />
        </div>
      )}
    </article>
  );
}

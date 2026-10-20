import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, Copy, Eye, EyeOff, Link2, Pause, Play, RefreshCw, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import {
  DETAIL_OPTIONS,
  buildFeedRows,
  describeFeed,
  feedWebcalUrl,
  googleSubscribeUrl,
  maskFeedUrl,
  outlookSubscribeUrl,
  type CalendarFeed,
  type DetailLevel,
  type FeedOverview,
  type FeedRow,
  type FeedTone,
} from '@/lib/calendarFeeds';
import {
  ensureCalendarFeed,
  fetchFeedOverview,
  feedUrlFor,
  regenerateCalendarFeed,
  updateCalendarFeed,
} from '@/lib/calendarFeedsApi';

const PAGE = 'Calendar Feeds';

const TONE_CLASS: Record<FeedTone, string> = {
  ok: 'bg-success/10 text-success',
  warn: 'bg-warning-500/10 text-warning-500',
  muted: 'bg-bg-tertiary text-text-secondary',
};

const linkButton =
  'focus-ring inline-flex items-center justify-center rounded-xl border border-border bg-bg-secondary px-3 py-2 text-xs font-semibold text-text-primary transition-colors hover:border-accent/40 hover:bg-bg-tertiary';

function FeedCard({
  row,
  busy,
  onCreate,
  onToggle,
  onDetail,
  onRegenerate,
}: {
  row: FeedRow;
  busy: boolean;
  onCreate: () => void;
  onToggle: (feed: CalendarFeed) => void;
  onDetail: (feed: CalendarFeed, level: DetailLevel) => void;
  onRegenerate: (feed: CalendarFeed) => void;
}) {
  const { toast } = useToast();
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const feed = row.feed;
  const status = describeFeed(feed);
  const url = feed ? feedUrlFor(feed) : '';
  const calendarName = `${row.title} (Vireek)`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast('Calendar link copied.', 'success');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setReveal(true);
      toast('Could not copy automatically — select the link and copy it.', 'error');
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6" aria-label={row.title}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-text-primary">{row.title}</h2>
          {row.subtitle && <p className="truncate text-xs text-text-secondary">{row.subtitle}</p>}
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${TONE_CLASS[status.tone]}`}>{status.label}</span>
      </div>

      {!feed ? (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-text-secondary">{status.detail}</p>
          <Button size="sm" onClick={onCreate} disabled={busy}>
            <Link2 size={14} /> Create link
          </Button>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-xs text-text-secondary">{status.detail}</p>

          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={reveal ? url : maskFeedUrl(url)}
              onFocus={(e) => e.currentTarget.select()}
              aria-label={`${row.title} private calendar link`}
              className="focus-ring min-w-0 flex-1 truncate rounded-xl border border-border bg-bg-primary px-3 py-2 font-mono text-xs text-text-primary"
            />
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setReveal((v) => !v)} aria-pressed={reveal} aria-label={reveal ? 'Hide link' : 'Show full link'}>
                {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
              <Button size="sm" onClick={copy}>
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">Add to your calendar</p>
            <div className="flex flex-wrap gap-2">
              <a className={linkButton} href={googleSubscribeUrl(url)} target="_blank" rel="noopener noreferrer">Google Calendar</a>
              <a className={linkButton} href={feedWebcalUrl(url)}>Apple Calendar</a>
              <a className={linkButton} href={outlookSubscribeUrl(url, calendarName, 'personal')} target="_blank" rel="noopener noreferrer">Outlook.com</a>
              <a className={linkButton} href={outlookSubscribeUrl(url, calendarName, 'work')} target="_blank" rel="noopener noreferrer">Microsoft 365</a>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="block text-xs font-medium text-text-secondary">
              Privacy
              <select
                value={feed.detail_level}
                disabled={busy}
                onChange={(e) => onDetail(feed, e.target.value as DetailLevel)}
                className="focus-ring mt-1 block w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              >
                {DETAIL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => onToggle(feed)} disabled={busy}>
                {feed.enabled ? <Pause size={14} /> : <Play size={14} />} {feed.enabled ? 'Pause' : 'Resume'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => onRegenerate(feed)} disabled={busy}>
                <RefreshCw size={14} /> Regenerate
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function CalendarFeedsPage() {
  const { toast } = useToast();
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [overview, setOverview] = useState<FeedOverview | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<CalendarFeed | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setOverview(await fetchFeedOverview());
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => (overview ? buildFeedRows(overview) : []), [overview]);

  const replaceFeed = useCallback((next: CalendarFeed) => {
    setOverview((prev) => {
      if (!prev) return prev;
      const exists = prev.feeds.some((f) => f.id === next.id);
      return { ...prev, feeds: exists ? prev.feeds.map((f) => (f.id === next.id ? next : f)) : [...prev.feeds, next] };
    });
  }, []);

  const keyOf = (feed: CalendarFeed) => (feed.scope === 'business' ? 'business' : `tech-${feed.team_member_id}`);

  const run = async (key: string, action: () => Promise<CalendarFeed>, success: string) => {
    setBusyKey(key);
    try {
      replaceFeed(await action());
      toast(success, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong. Please try again.', 'error');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <DashboardLayout activeLabel={PAGE}>
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
            <CalendarDays size={22} className="text-accent" /> Calendar feeds
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Subscribe Google, Apple or Outlook calendars to your Vireek jobs. Feeds are read-only and refresh automatically
            (calendar apps decide how often — usually every few hours).
          </p>
        </header>

        <div className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/5 p-3 text-xs text-text-secondary">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-500" />
          <span>Anyone with a link can see that calendar. Don't share it publicly — if a link leaks, press Regenerate and the old one stops working immediately.</span>
        </div>

        {status === 'loading' && <SkeletonCardList count={3} rows={3} />}

        {status === 'error' && (
          <EmptyStateError icon={CalendarDays} title="Couldn't load calendar links" onRetry={() => void load()} />
        )}

        {status === 'ready' && rows.length === 0 && (
          <EmptyState
            icon={CalendarDays}
            title="No calendar available for your account"
            description="Calendar links are available to account owners and to team members with a linked technician profile."
          />
        )}

        {status === 'ready' &&
          rows.map((row) => (
            <FeedCard
              key={row.key}
              row={row}
              busy={busyKey === row.key}
              onCreate={() => void run(row.key, () => ensureCalendarFeed(row.scope, row.memberId), 'Calendar link created.')}
              onToggle={(feed) =>
                void run(keyOf(feed), () => updateCalendarFeed(feed.id, { enabled: !feed.enabled }), feed.enabled ? 'Link paused.' : 'Link resumed.')
              }
              onDetail={(feed, level) => void run(keyOf(feed), () => updateCalendarFeed(feed.id, { detailLevel: level }), 'Privacy updated.')}
              onRegenerate={(feed) => setConfirming(feed)}
            />
          ))}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title="Regenerate this calendar link?"
        description="The current link stops working immediately. Everyone subscribed to it must add the new link to keep seeing jobs."
        confirmLabel="Yes, regenerate"
        onCancel={() => setConfirming(null)}
        onConfirm={async () => {
          const feed = confirming;
          setConfirming(null);
          if (feed) await run(keyOf(feed), () => regenerateCalendarFeed(feed.id), 'New link generated. The old one no longer works.');
        }}
      />
    </DashboardLayout>
  );
}

export default CalendarFeedsPage;

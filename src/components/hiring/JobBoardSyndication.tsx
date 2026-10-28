import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2, RefreshCw, Share2, TriangleAlert } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import type { JobPosting } from '@/lib/careers';
import { feedUrl, fetchBoardFeeds, updateBoardFeed, type BoardFeed } from '@/lib/jobFeedsApi';
import {
  BOARD_LABELS,
  FEED_BOARDS,
  boardConfigIssues,
  postingFeedIssues,
  validateBoardSettings,
  type FeedBoard,
  type FeedPosting,
} from '../../../supabase/functions/_shared/job-feeds/engine';

const BOARD_BLURB: Record<FeedBoard, string> = {
  indeed: 'Give this URL to Indeed (XML feed). It lists every open role on your careers page.',
  ziprecruiter: 'Give this URL to your ZipRecruiter account manager (Feed Import). They re-read it several times a day.',
  linkedin: 'Give this URL to LinkedIn (Basic Jobs XML feed). It needs your company ID and a poster email.',
};

function timeAgo(iso: string, now: number = Date.now()): string {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

interface BoardCardProps {
  board: FeedBoard;
  feed: BoardFeed;
  openPostings: FeedPosting[];
  busy: boolean;
  onToggle: (board: FeedBoard, next: boolean) => void;
  onSaveSettings: (board: FeedBoard, companyId: string, posterEmail: string) => Promise<boolean>;
}

function BoardCard({ board, feed, openPostings, busy, onToggle, onSaveSettings }: BoardCardProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const [companyId, setCompanyId] = useState(feed.linkedin_company_id ?? '');
  const [posterEmail, setPosterEmail] = useState(feed.poster_email ?? '');
  const [saving, setSaving] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const label = BOARD_LABELS[board];
  const url = feedUrl(board);

  const configProblems = boardConfigIssues(board, {
    linkedinCompanyId: feed.linkedin_company_id,
    posterEmail: feed.poster_email,
  });
  const settingErrors = validateBoardSettings({ companyId, posterEmail });
  const settingsDirty =
    companyId.trim() !== (feed.linkedin_company_id ?? '') || posterEmail.trim() !== (feed.poster_email ?? '');

  const { blocked, warned } = useMemo(() => {
    const blockedRows: { id: string; title: string; reasons: string[] }[] = [];
    let warnedCount = 0;
    for (const p of openPostings) {
      const r = postingFeedIssues(p, board);
      if (r.blocking.length) blockedRows.push({ id: p.id, title: p.title, reasons: r.blocking });
      else if (r.warnings.length) warnedCount += 1;
    }
    return { blocked: blockedRows, warned: warnedCount };
  }, [openPostings, board]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('Copy failed. Select the URL and copy it manually.', 'error');
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (settingErrors.companyId || settingErrors.posterEmail) return;
    setSaving(true);
    await onSaveSettings(board, companyId.trim(), posterEmail.trim());
    setSaving(false);
  };

  const status = !feed.enabled
    ? { text: 'Off', cls: 'bg-bg-tertiary text-text-secondary' }
    : configProblems.length
      ? { text: 'Needs setup', cls: 'bg-warning-500/10 text-warning-500' }
      : { text: 'Live', cls: 'bg-success-500/10 text-success-500' };
  const shown = showAll ? blocked : blocked.slice(0, 3);

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-text-primary">{label}</h3>
            <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${status.cls}`}>
              {status.text}
            </span>
          </div>
          <p className="mt-1 text-xs text-text-secondary">{BOARD_BLURB[board]}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={feed.enabled}
          aria-label={`${label} feed`}
          disabled={busy}
          onClick={() => onToggle(board, !feed.enabled)}
          className={`focus-ring relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            feed.enabled ? 'bg-accent' : 'bg-bg-tertiary'
          }`}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
              feed.enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 truncate rounded-xl border border-border bg-bg-primary px-3 py-2 text-xs text-text-primary">
          {url}
        </code>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void copy()} aria-label={`Copy ${label} feed URL`}>
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
          </Button>
          {feed.enabled && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring inline-flex items-center gap-1 rounded-xl border border-border px-3 text-xs font-medium text-accent hover:underline"
            >
              Preview <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
        </div>
      </div>

      <p className="mt-3 text-xs text-text-secondary" aria-live="polite">
        {!feed.enabled
          ? 'Turn this on to start serving the feed. Until then the URL returns 404.'
          : feed.last_fetched_at
            ? `Last read ${timeAgo(feed.last_fetched_at)} · ${feed.fetch_count} read${feed.fetch_count === 1 ? '' : 's'} · ${
                feed.last_job_count ?? 0
              } job${feed.last_job_count === 1 ? '' : 's'} served${
                feed.last_skipped_count ? ` · ${feed.last_skipped_count} skipped` : ''
              }`
            : `Not read yet. Send the URL to ${label} and it will start crawling.`}
      </p>

      {configProblems.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-xl border border-warning-500/30 bg-warning-500/5 p-3 text-xs text-text-secondary">
          {configProblems.map((m) => (
            <li key={m} className="flex gap-2">
              <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" /> {m}
            </li>
          ))}
        </ul>
      )}

      {blocked.length > 0 && (
        <div className="mt-3 rounded-xl border border-danger/30 bg-danger/5 p-3" role="status">
          <p className="text-xs font-medium text-text-primary">
            {blocked.length} open role{blocked.length === 1 ? '' : 's'} left out of this feed until fixed:
          </p>
          <ul className="mt-1.5 space-y-1 text-xs text-text-secondary">
            {shown.map((b) => (
              <li key={b.id}>
                <span className="font-medium text-text-primary">{b.title}</span>: {b.reasons.join(' ')}
              </li>
            ))}
          </ul>
          {blocked.length > 3 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="focus-ring mt-1.5 text-xs font-medium text-accent hover:underline"
            >
              {showAll ? 'Show less' : `Show ${blocked.length - 3} more`}
            </button>
          )}
        </div>
      )}
      {blocked.length === 0 && openPostings.length > 0 && warned > 0 && (
        <p className="mt-3 text-xs text-text-secondary">
          {warned} role{warned === 1 ? ' is' : 's are'} eligible but could reach more people with a pay range or state.
        </p>
      )}

      {board === 'linkedin' && (
        <form onSubmit={(e) => void saveSettings(e)} className="mt-4 grid gap-3 sm:grid-cols-2" noValidate>
          <Input
            label="LinkedIn company ID"
            inputMode="numeric"
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            error={settingsDirty ? settingErrors.companyId : undefined}
            helperText="Numeric ID in your LinkedIn Page admin URL."
            maxLength={20}
          />
          <Input
            label="Job poster email"
            type="email"
            value={posterEmail}
            onChange={(e) => setPosterEmail(e.target.value)}
            error={settingsDirty ? settingErrors.posterEmail : undefined}
            helperText="Shown to LinkedIn as the owner of each job."
            maxLength={254}
          />
          <div className="sm:col-span-2">
            <Button
              type="submit"
              size="sm"
              disabled={saving || !settingsDirty || Boolean(settingErrors.companyId || settingErrors.posterEmail)}
            >
              {saving && <Loader2 size={14} className="animate-spin" />} Save LinkedIn settings
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function JobBoardSyndication({ postings }: { postings: JobPosting[] }) {
  const { toast } = useToast();
  const [feeds, setFeeds] = useState<Record<FeedBoard, BoardFeed> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyBoard, setBusyBoard] = useState<FeedBoard | null>(null);
  const [confirmOff, setConfirmOff] = useState<FeedBoard | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchBoardFeeds();
      if (id !== requestRef.current) return;
      setFeeds(rows);
    } catch (err) {
      if (id !== requestRef.current) return;
      setError(err instanceof Error ? err.message : 'Could not load job-board settings.');
    } finally {
      if (id === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openPostings = useMemo(
    () => postings.filter((p) => p.status === 'open') as unknown as FeedPosting[],
    [postings],
  );

  const apply = useCallback((saved: BoardFeed) => {
    setFeeds((prev) => (prev ? { ...prev, [saved.board]: saved } : prev));
  }, []);

  const setEnabled = async (board: FeedBoard, next: boolean) => {
    setBusyBoard(board);
    try {
      apply(await updateBoardFeed(board, { enabled: next }));
      toast(next ? `${BOARD_LABELS[board]} feed is live` : `${BOARD_LABELS[board]} feed turned off`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not change this feed', 'error');
    } finally {
      setBusyBoard(null);
      setConfirmOff(null);
    }
  };

  const saveSettings = async (board: FeedBoard, companyId: string, posterEmail: string): Promise<boolean> => {
    try {
      apply(
        await updateBoardFeed(board, {
          linkedin_company_id: companyId || null,
          poster_email: posterEmail || null,
        }),
      );
      toast('LinkedIn settings saved', 'success');
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save settings', 'error');
      return false;
    }
  };

  return (
    <section className="mt-10" aria-labelledby="job-boards-heading">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Share2 size={18} aria-hidden="true" />
        </span>
        <div>
          <h2 id="job-boards-heading" className="text-lg font-semibold text-text-primary">
            Job boards
          </h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            Syndicate open roles to Indeed, ZipRecruiter and LinkedIn. Closing a role removes it from every feed.
          </p>
        </div>
      </div>

      <div className="mt-4">
        {loading ? (
          <SkeletonCardList count={3} rows={2} />
        ) : error || !feeds ? (
          <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-2xl border border-danger/30 bg-danger/5 px-6 py-10 text-center"
          >
            <TriangleAlert size={24} className="text-danger" aria-hidden="true" />
            <p className="text-sm text-text-secondary">{error ?? 'Could not load job-board settings.'}</p>
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              <RefreshCw size={14} /> Try again
            </Button>
          </div>
        ) : (
          <>
            {openPostings.length === 0 && (
              <p className="mb-3 rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm text-text-secondary">
                No open roles right now, so the feeds are empty. Publish a posting and it appears automatically.
              </p>
            )}
            <ul className="space-y-3">
              {FEED_BOARDS.map((board) =>
                feeds[board] ? (
                  <BoardCard
                    key={board}
                    board={board}
                    feed={feeds[board]}
                    openPostings={openPostings}
                    busy={busyBoard === board}
                    onToggle={(b, next) => (next ? void setEnabled(b, true) : setConfirmOff(b))}
                    onSaveSettings={saveSettings}
                  />
                ) : null,
              )}
            </ul>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmOff !== null}
        title={`Turn off the ${confirmOff ? BOARD_LABELS[confirmOff] : ''} feed?`}
        description="The feed URL will return 404, and the board will remove your roles the next time it crawls."
        confirmLabel="Yes, turn it off"
        onConfirm={() => (confirmOff ? setEnabled(confirmOff, false) : undefined)}
        onCancel={() => setConfirmOff(null)}
      />
    </section>
  );
}

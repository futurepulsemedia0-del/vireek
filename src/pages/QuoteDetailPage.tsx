/**
 * Quote detail — /dashboard/quotes/:id
 *
 *  - version history with a side-by-side diff of any two versions
 *  - tiered options (what the customer was offered / what they chose)
 *  - customer activity: opens, option views, accept / decline
 *  - follow-up schedule that stops itself when the quote closes
 *  - one-click, idempotent "convert to job" for accepted quotes
 *
 * Access: owner or a team member with can_view_billing. The same rule is
 * enforced server-side inside every RPC (see 20270301000000_quote_detail_workspace.sql);
 * the gate here only decides what to render.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Briefcase, CalendarClock, Check, Copy, ExternalLink, Eye, FileText, GitCompare, History, Lock,
  Mail, MapPin, MessageSquare, Phone, RefreshCw, SkipForward, TriangleAlert,
} from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { BackButton } from '@/components/ui/BackButton';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { SkeletonCard, SkeletonStatGrid } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { QUOTE_STATUS_COLORS, QUOTE_STATUS_LABELS, getQuoteLink } from '@/lib/quotes';
import {
  UUID_RE,
  buildFollowUpPlan,
  buildTimeline,
  canConvertToJob,
  canSchedulePlan,
  depositCentsFor,
  diffSnapshots,
  followUpChannelLabel,
  followUpDueState,
  formatSignedUsd,
  formatUsd,
  headlineOption,
  headlineTotalCents,
  isTiered,
  lineItemsSubtotalCents,
  nextPendingFollowUp,
  optionTotalCents,
  validityState,
  withTaxCents,
  type DiffChange,
  type FollowUpChannel,
  type QuoteFollowUp,
  type QuoteWorkspace,
  type SnapshotOption,
  type TimelineItem,
  type WorkspaceQuote,
} from '@/lib/quoteWorkspace';
import {
  completeQuoteFollowUp,
  convertQuoteToJob,
  fetchQuoteWorkspace,
  scheduleQuoteFollowUps,
} from '@/lib/quoteWorkspaceApi';

// ============================================================
// SMALL HELPERS
// ============================================================

const SECTION = 'rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5';
const SELECT_CLASS =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';
const LINK_BTN =
  'focus-ring inline-flex min-h-[40px] items-center justify-center gap-1.5 rounded-xl border border-border bg-bg-secondary px-4 py-2 text-sm font-semibold text-text-primary hover:border-accent/40 hover:bg-bg-tertiary';

function fmtDateTime(iso: string | null): string {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '\u2014';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** 'YYYY-MM-DD' -> local calendar date (no timezone shift). */
function fmtDate(date: string | null): string {
  if (!date) return '\u2014';
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

const CHANNEL_ICON: Record<FollowUpChannel, typeof Phone> = {
  call: Phone, sms: MessageSquare, email: Mail, visit: MapPin,
};

const KIND_BADGE: Record<DiffChange['kind'], string> = {
  added: 'bg-success-500/10 text-success-500',
  removed: 'bg-danger/10 text-danger',
  changed: 'bg-warning-500/10 text-warning-500',
};

const DOT: Record<TimelineItem['kind'], string> = {
  created: 'bg-text-secondary/50',
  version: 'bg-text-secondary/50',
  sent: 'bg-accent',
  viewed: 'bg-accent',
  option_selected: 'bg-accent',
  accepted: 'bg-success-500',
  declined: 'bg-danger',
  followup: 'bg-warning-500',
  job: 'bg-success-500',
};

// ============================================================
// SECTIONS
// ============================================================

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs text-text-secondary">{label}</p>
      <p className="mt-1 text-lg font-bold text-text-primary">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

function OptionsSection({ quote }: { quote: WorkspaceQuote }) {
  const tiered = isTiered(quote);
  const headline = headlineOption(quote);

  if (!tiered) {
    const subtotal = lineItemsSubtotalCents(quote.line_items);
    const total = withTaxCents(subtotal, quote.tax_percent);
    return (
      <section className={SECTION} aria-labelledby="qd-options">
        <h2 id="qd-options" className="mb-3 text-sm font-semibold text-text-primary">Estimate</h2>
        {quote.line_items.length === 0 ? (
          <p className="text-sm text-text-secondary">This quote has no line items yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {quote.line_items.map((li, i) => (
              <li key={`${li.description}-${i}`} className="flex items-start justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 break-words text-text-primary">
                  {li.description || 'Untitled item'}
                  <span className="block text-xs text-text-secondary">
                    {li.quantity} {'\u00d7'} {formatUsd(li.unit_price_cents)}
                  </span>
                </span>
                <span className="shrink-0 font-medium text-text-primary">{formatUsd(li.quantity * li.unit_price_cents)}</span>
              </li>
            ))}
          </ul>
        )}
        <dl className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
          <div className="flex justify-between"><dt className="text-text-secondary">Subtotal</dt><dd>{formatUsd(subtotal)}</dd></div>
          <div className="flex justify-between"><dt className="text-text-secondary">Tax ({quote.tax_percent}%)</dt><dd>{formatUsd(total - subtotal)}</dd></div>
          <div className="flex justify-between font-semibold text-text-primary"><dt>Total</dt><dd>{formatUsd(total)}</dd></div>
          {quote.deposit_percent > 0 ? (
            <div className="flex justify-between text-text-secondary">
              <dt>Deposit ({quote.deposit_percent}%)</dt><dd>{formatUsd(depositCentsFor(total, quote.deposit_percent))}</dd>
            </div>
          ) : null}
        </dl>
      </section>
    );
  }

  return (
    <section className={SECTION} aria-labelledby="qd-options">
      <h2 id="qd-options" className="mb-3 text-sm font-semibold text-text-primary">
        Options offered ({quote.options.length})
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {quote.options.map((o: SnapshotOption) => {
          const chosen = quote.selected_option_id === o.id;
          const total = optionTotalCents(o, quote.tax_percent);
          return (
            <article
              key={o.id}
              className={`rounded-xl border p-4 ${chosen ? 'border-success-500/50 bg-success-500/5' : 'border-border bg-bg-primary'}`}
            >
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{o.tier}</span>
                {headline?.id === o.id ? (
                  <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">Recommended</span>
                ) : null}
                {chosen ? (
                  <span className="rounded-full bg-success-500/10 px-2 py-0.5 text-[11px] font-medium text-success-500">Chosen</span>
                ) : null}
              </div>
              <p className="break-words text-sm font-semibold text-text-primary">{o.name || 'Unnamed option'}</p>
              <p className="mt-0.5 text-xl font-bold text-text-primary">{formatUsd(total)}</p>
              {o.summary ? <p className="mt-1 text-xs text-text-secondary">{o.summary}</p> : null}
              <ul className="mt-3 space-y-1 text-xs text-text-secondary">
                {o.line_items.map((li, i) => (
                  <li key={`${li.description}-${i}`} className="flex justify-between gap-2">
                    <span className="min-w-0 break-words">{li.quantity} {'\u00d7'} {li.description || 'Untitled item'}</span>
                    <span className="shrink-0">{formatUsd(li.quantity * li.unit_price_cents)}</span>
                  </li>
                ))}
              </ul>
              {o.warranty_label ? <p className="mt-2 text-xs text-text-secondary">Warranty: {o.warranty_label}</p> : null}
            </article>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-text-secondary">
        Prices include {quote.tax_percent}% tax{quote.deposit_percent > 0 ? ` \u00b7 ${quote.deposit_percent}% deposit` : ''}.
      </p>
    </section>
  );
}

function VersionDiffSection({ ws }: { ws: QuoteWorkspace }) {
  const { versions } = ws;
  const [fromNo, setFromNo] = useState<number | null>(null);
  const [toNo, setToNo] = useState<number | null>(null);

  const latest = versions[0]?.version_number ?? null;
  const previous = versions[1]?.version_number ?? null;
  const effectiveTo = toNo !== null && versions.some((v) => v.version_number === toNo) ? toNo : latest;
  const effectiveFrom = fromNo !== null && versions.some((v) => v.version_number === fromNo) ? fromNo : previous;

  const diff = useMemo(() => {
    if (effectiveFrom === null || effectiveTo === null || effectiveFrom === effectiveTo) return null;
    const a = versions.find((v) => v.version_number === Math.min(effectiveFrom, effectiveTo));
    const b = versions.find((v) => v.version_number === Math.max(effectiveFrom, effectiveTo));
    return a && b ? diffSnapshots(a.snapshot, b.snapshot) : null;
  }, [versions, effectiveFrom, effectiveTo]);

  return (
    <section className={SECTION} aria-labelledby="qd-versions">
      <h2 id="qd-versions" className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
        <GitCompare size={14} aria-hidden="true" /> Version history
      </h2>

      {versions.length === 0 ? (
        <p className="text-sm text-text-secondary">No version history recorded for this quote.</p>
      ) : versions.length === 1 ? (
        <p className="text-sm text-text-secondary">
          Only one version so far. Every edit to the price, items, options or terms is saved as a new version here.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {([['Compare', effectiveFrom, setFromNo], ['With', effectiveTo, setToNo]] as const).map(([label, value, set]) => (
              <label key={label} className="block text-xs text-text-secondary">
                {label}
                <select
                  className={`${SELECT_CLASS} mt-1`}
                  value={value ?? ''}
                  onChange={(e) => set(Number(e.target.value))}
                >
                  {versions.map((v) => (
                    <option key={v.id} value={v.version_number}>
                      v{v.version_number} {'\u00b7'} {fmtDateTime(v.created_at)} {'\u00b7'} {formatUsd(v.total_cents)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {diff === null ? (
            <p className="mt-4 text-sm text-text-secondary">Pick two different versions to compare.</p>
          ) : (
            <div className="mt-4" aria-live="polite">
              <p className="text-sm text-text-primary">
                {formatUsd(diff.totalBeforeCents)} {'\u2192'} {formatUsd(diff.totalAfterCents)}{' '}
                <span className={diff.totalDeltaCents > 0 ? 'text-success-500' : diff.totalDeltaCents < 0 ? 'text-danger' : 'text-text-secondary'}>
                  ({formatSignedUsd(diff.totalDeltaCents)})
                </span>
              </p>
              {!diff.hasChanges ? (
                <p className="mt-2 text-sm text-text-secondary">No differences between these versions.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {diff.changes.map((c) => (
                    <li key={c.id} className="rounded-xl border border-border bg-bg-primary p-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${KIND_BADGE[c.kind]}`}>{c.kind}</span>
                        <span className="min-w-0 break-words font-medium text-text-primary">{c.label}</span>
                        <span className="text-xs text-text-secondary">{c.scope}</span>
                        {c.deltaCents !== null ? (
                          <span className="ml-auto text-xs font-medium text-text-secondary">{formatSignedUsd(c.deltaCents)}</span>
                        ) : null}
                      </div>
                      {c.before !== null || c.after !== null ? (
                        <p className="mt-1 break-words text-xs text-text-secondary">
                          {c.before !== null ? <span className="line-through">{c.before}</span> : null}
                          {c.before !== null && c.after !== null ? ' \u2192 ' : null}
                          {c.after !== null ? <span className="text-text-primary">{c.after}</span> : null}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function TimelineSection({ items }: { items: TimelineItem[] }) {
  return (
    <section className={SECTION} aria-labelledby="qd-activity">
      <h2 id="qd-activity" className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
        <History size={14} aria-hidden="true" /> Activity
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-text-secondary">No activity yet.</p>
      ) : (
        <ol className="space-y-3">
          {items.map((item) => (
            <li key={item.id} className="flex gap-3">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[item.kind]}`} aria-hidden="true" />
              <div className="min-w-0">
                <p className="break-words text-sm text-text-primary">{item.title}</p>
                {item.detail ? <p className="break-words text-xs text-text-secondary">{item.detail}</p> : null}
                <p className="text-xs text-text-secondary/80">{fmtDateTime(item.at)}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function FollowUpRow({
  f, busy, onComplete,
}: {
  f: QuoteFollowUp;
  busy: boolean;
  onComplete: (f: QuoteFollowUp, status: 'done' | 'skipped', outcome: string | null) => void;
}) {
  const [logging, setLogging] = useState(false);
  const [outcome, setOutcome] = useState('');
  const state = followUpDueState(f);
  const Icon = CHANNEL_ICON[f.channel];
  const pending = f.status === 'pending';

  const stateLabel: Record<typeof state, { text: string; cls: string }> = {
    overdue: { text: 'Overdue', cls: 'bg-danger/10 text-danger' },
    today: { text: 'Due today', cls: 'bg-warning-500/10 text-warning-500' },
    upcoming: { text: 'Upcoming', cls: 'bg-bg-tertiary text-text-secondary' },
    done: { text: 'Done', cls: 'bg-success-500/10 text-success-500' },
    skipped: { text: 'Skipped', cls: 'bg-bg-tertiary text-text-secondary' },
    cancelled: { text: 'Cancelled', cls: 'bg-bg-tertiary text-text-secondary' },
  };

  return (
    <li className={`rounded-xl border border-border bg-bg-primary p-3 ${pending ? '' : 'opacity-70'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon size={14} className="text-text-secondary" aria-hidden="true" />
        <span className="text-sm font-medium text-text-primary">{followUpChannelLabel(f.channel)}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${stateLabel[state].cls}`}>{stateLabel[state].text}</span>
        <span className="ml-auto text-xs text-text-secondary">{fmtDateTime(f.due_at)}</span>
      </div>
      {f.suggested_message ? <p className="mt-2 break-words text-xs text-text-secondary">{f.suggested_message}</p> : null}
      {f.outcome ? <p className="mt-2 break-words text-xs text-text-primary">Outcome: {f.outcome}</p> : null}

      {pending && !logging ? (
        <div className="mt-3 flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => setLogging(true)}>
            <Check size={14} aria-hidden="true" /> Done
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => onComplete(f, 'skipped', null)}>
            <SkipForward size={14} aria-hidden="true" /> Skip
          </Button>
        </div>
      ) : null}

      {pending && logging ? (
        <div className="mt-3 space-y-2">
          <Textarea
            label="What happened? (optional)"
            rows={2}
            maxLength={500}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="e.g. Left a voicemail, will call back Friday"
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => onComplete(f, 'done', outcome.trim() || null)}>
              Save as done
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setLogging(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function FollowUpSection({
  ws, busyId, planBusy, onSchedule, onComplete,
}: {
  ws: QuoteWorkspace;
  busyId: string | null;
  planBusy: boolean;
  onSchedule: () => void;
  onComplete: (f: QuoteFollowUp, status: 'done' | 'skipped', outcome: string | null) => void;
}) {
  const { quote, followups } = ws;
  const pending = followups.filter((f) => f.status === 'pending');
  const next = nextPendingFollowUp(followups);
  const canPlan = canSchedulePlan(quote);

  return (
    <section className={SECTION} aria-labelledby="qd-followups">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="qd-followups" className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <CalendarClock size={14} aria-hidden="true" /> Follow-up schedule
        </h2>
        {canPlan ? (
          <Button size="sm" variant="secondary" disabled={planBusy} onClick={onSchedule}>
            {planBusy ? 'Scheduling\u2026' : pending.length > 0 ? 'Rebuild plan' : 'Create plan'}
          </Button>
        ) : null}
      </div>

      {followups.length === 0 ? (
        <p className="text-sm text-text-secondary">
          {canPlan
            ? 'No follow-ups scheduled. Create a plan and the next touches are timed from when this quote was sent.'
            : quote.status === 'draft'
              ? 'Send the quote first \u2014 follow-ups are timed from the send date.'
              : 'This quote is closed, so no follow-ups are needed.'}
        </p>
      ) : (
        <>
          {next ? (
            <p className="mb-3 text-xs text-text-secondary">
              Next: {followUpChannelLabel(next.channel)} {'\u00b7'} {fmtDateTime(next.due_at)}
            </p>
          ) : null}
          <ul className="space-y-2">
            {followups.map((f) => (
              <FollowUpRow key={f.id} f={f} busy={busyId === f.id} onComplete={onComplete} />
            ))}
          </ul>
          {ws.lead ? (
            <p className="mt-3 text-xs text-text-secondary">
              Lead tracker: {ws.lead.follow_up_count} follow-up{ws.lead.follow_up_count === 1 ? '' : 's'} logged
              {ws.lead.last_follow_up_at ? ` \u00b7 last ${timeAgo(ws.lead.last_follow_up_at)}` : ''}.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function ConvertSection({
  ws, busy, onConvert,
}: {
  ws: QuoteWorkspace;
  busy: boolean;
  onConvert: (scheduledAt: string | null, address: string | null) => void;
}) {
  const [when, setWhen] = useState('');
  const [address, setAddress] = useState('');
  const { quote, job } = ws;

  if (job) {
    return (
      <section className={SECTION} aria-labelledby="qd-convert">
        <h2 id="qd-convert" className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Briefcase size={14} aria-hidden="true" /> Job
        </h2>
        <p className="text-sm text-text-primary">
          Converted {fmtDateTime(job.created_at)} {'\u00b7'} <span className="capitalize">{job.job_status.replace(/_/g, ' ')}</span>
        </p>
        {job.scheduled_datetime ? <p className="text-xs text-text-secondary">Scheduled {fmtDateTime(job.scheduled_datetime)}</p> : null}
        <Link to="/dashboard/jobs" className={`${LINK_BTN} mt-3`}>
          Open jobs board <ExternalLink size={13} aria-hidden="true" />
        </Link>
      </section>
    );
  }

  if (!canConvertToJob(quote, job)) {
    return (
      <section className={SECTION} aria-labelledby="qd-convert">
        <h2 id="qd-convert" className="mb-2 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Briefcase size={14} aria-hidden="true" /> Convert to job
        </h2>
        <p className="text-sm text-text-secondary">
          {quote.status === 'declined' || quote.status === 'expired'
            ? `This quote was ${quote.status}, so it can't be converted.`
            : 'Available as soon as the customer accepts.'}
        </p>
      </section>
    );
  }

  return (
    <section className={`${SECTION} border-success-500/40`} aria-labelledby="qd-convert">
      <h2 id="qd-convert" className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Briefcase size={14} aria-hidden="true" /> Convert to job
      </h2>
      <p className="mb-3 text-xs text-text-secondary">
        Creates a scheduled job from the accepted scope
        {quote.accepted_total_cents != null ? ` (${formatUsd(quote.accepted_total_cents)})` : ''}. Safe to click twice {'\u2014'} you can never get a duplicate.
      </p>
      <div className="space-y-3">
        <Input
          type="datetime-local"
          label="Date and time (optional)"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
        <Input
          type="text"
          label="Job address (optional)"
          maxLength={300}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Street, city"
        />
        <Button
          className="w-full"
          disabled={busy}
          onClick={() => onConvert(when ? new Date(when).toISOString() : null, address.trim() || null)}
        >
          {busy ? 'Creating job\u2026' : 'Convert to job'}
        </Button>
      </div>
    </section>
  );
}

// ============================================================
// PAGE
// ============================================================

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; ws: QuoteWorkspace }
  | { kind: 'error'; reason: 'forbidden' | 'not_found' | 'failed' };

const STALE_MS = 30_000;

export function QuoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { accountOwnerId, permissions, loading: authLoading, profileLoading } = useAuth();
  const canView = permissions.can_view_billing;

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [planBusy, setPlanBusy] = useState(false);
  const [busyFollowUp, setBusyFollowUp] = useState<string | null>(null);
  const [convertBusy, setConvertBusy] = useState(false);

  const requestRef = useRef(0);
  const loadedAtRef = useRef(0);

  const load = useCallback(
    async (silent: boolean) => {
      if (!id || !UUID_RE.test(id)) {
        setState({ kind: 'error', reason: 'not_found' });
        return;
      }
      const req = ++requestRef.current;
      if (!silent) setState({ kind: 'loading' });

      const res = await fetchQuoteWorkspace(id);
      if (req !== requestRef.current) return; // a newer request owns the screen

      loadedAtRef.current = Date.now();
      if (!res.ok) {
        // A failed background refresh must never wipe a page the user is reading.
        setState((prev) => (silent && prev.kind === 'ready' ? prev : { kind: 'error', reason: res.reason }));
        return;
      }
      // Defence in depth on top of the RPC's own account scoping.
      if (accountOwnerId && res.data.quote.user_id !== accountOwnerId) {
        setState({ kind: 'error', reason: 'not_found' });
        return;
      }
      setState({ kind: 'ready', ws: res.data });
    },
    [id, accountOwnerId],
  );

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!accountOwnerId) {
      setState({ kind: 'error', reason: 'failed' });
      return undefined;
    }
    if (!canView) {
      setState({ kind: 'error', reason: 'forbidden' });
      return undefined;
    }
    void load(false);
    return () => {
      requestRef.current++; // discard any in-flight response after unmount / id change
    };
  }, [authLoading, profileLoading, accountOwnerId, canView, load]);

  // Come back to the tab later -> quietly pick up new opens / accepts.
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - loadedAtRef.current > STALE_MS) void load(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [state.kind, load]);

  const ws = state.kind === 'ready' ? state.ws : null;
  const timeline = useMemo(() => (ws ? buildTimeline(ws) : []), [ws]);

  const handleCopyLink = async (quote: WorkspaceQuote) => {
    try {
      await navigator.clipboard.writeText(getQuoteLink(quote.quote_token));
      toast('Customer link copied', 'success');
    } catch {
      toast('Could not copy the link \u2014 copy it from the address bar of the customer view instead.', 'error');
    }
  };

  const handleSchedule = async () => {
    if (!ws) return;
    const steps = buildFollowUpPlan({
      customerName: ws.quote.customer_name,
      sentAt: ws.quote.sent_at,
      viewCount: ws.quote.view_count,
      validUntil: ws.quote.valid_until,
    });
    if (steps.length === 0) {
      toast("Nothing to schedule \u2014 this quote's valid-until date has already passed.", 'error');
      return;
    }
    setPlanBusy(true);
    const res = await scheduleQuoteFollowUps(ws.quote.id, steps);
    setPlanBusy(false);
    if (!res.ok) {
      toast(
        res.reason === 'invalid_state' ? 'This quote is no longer open, so it can\u2019t be scheduled.'
        : res.reason === 'forbidden' ? 'You don\u2019t have permission to do that.'
        : 'Could not create the follow-up plan.',
        'error',
      );
      if (res.reason === 'invalid_state') void load(true);
      return;
    }
    toast('Follow-up plan created', 'success');
    void load(true);
  };

  const handleCompleteFollowUp = async (f: QuoteFollowUp, status: 'done' | 'skipped', outcome: string | null) => {
    setBusyFollowUp(f.id);
    const res = await completeQuoteFollowUp(f.id, status, outcome);
    setBusyFollowUp(null);
    if (!res.ok) {
      toast(
        res.reason === 'invalid_state' ? 'That follow-up was already updated \u2014 refreshing.' : 'Could not update the follow-up.',
        'error',
      );
      if (res.reason === 'invalid_state') void load(true);
      return;
    }
    toast(status === 'done' ? 'Follow-up logged' : 'Follow-up skipped', 'success');
    void load(true);
  };

  const handleConvert = async (scheduledAt: string | null, address: string | null) => {
    if (!ws || convertBusy) return;
    setConvertBusy(true);
    const res = await convertQuoteToJob(ws.quote.id, { scheduledAt, address });
    setConvertBusy(false);
    if (!res.ok) {
      toast(
        res.reason === 'invalid_state' ? 'Only accepted quotes can be converted \u2014 refreshing.' : 'Could not create the job.',
        'error',
      );
      if (res.reason === 'invalid_state') void load(true);
      return;
    }
    toast('Job created', 'success');
    void load(true);
  };

  // ---------- non-ready states ----------
  if (state.kind === 'loading') {
    return (
      <DashboardLayout activeLabel="Quotes">
        <div className="mx-auto max-w-6xl p-4 sm:p-6" role="status" aria-busy="true" aria-label="Loading quote">
          <SkeletonStatGrid count={4} className="mb-6" />
          <SkeletonCard rows={4} />
        </div>
      </DashboardLayout>
    );
  }

  if (state.kind === 'error') {
    const view =
      state.reason === 'forbidden'
        ? {
            icon: Lock,
            title: 'You don\u2019t have access to quote details',
            description: 'Quote pricing and customer activity are limited to the account owner and team members with billing access. Ask the owner to grant it.',
          }
        : state.reason === 'not_found'
          ? {
              icon: FileText,
              title: 'Quote not found',
              description: 'It may have been deleted, or the link is wrong.',
            }
          : {
              icon: TriangleAlert,
              title: 'Couldn\u2019t load this quote',
              description: 'Check your connection and try again.',
            };
    return (
      <DashboardLayout activeLabel="Quotes">
        <div className="mx-auto max-w-3xl p-4 sm:p-6">
          <EmptyState
            icon={view.icon}
            title={view.title}
            description={view.description}
            action={
              state.reason === 'failed'
                ? { label: 'Try again', onClick: () => void load(false) }
                : { label: 'Back to quotes', onClick: () => navigate('/dashboard/quotes') }
            }
          />
        </div>
      </DashboardLayout>
    );
  }

  // ---------- ready ----------
  const { quote } = state.ws;
  const total = quote.status === 'accepted' && quote.accepted_total_cents != null ? quote.accepted_total_cents : headlineTotalCents(quote);
  const validity = validityState(quote.valid_until);
  const pendingFollowUps = state.ws.followups.filter((f) => f.status === 'pending').length;
  const doneFollowUps = state.ws.followups.filter((f) => f.status === 'done').length;
  const views =
    quote.status === 'draft'
      ? 'Not sent'
      : quote.view_count === 0
        ? 'Not opened'
        : `${quote.view_count} open${quote.view_count === 1 ? '' : 's'}`;

  return (
    <DashboardLayout activeLabel="Quotes">
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-3">
            <BackButton label="Quotes" fallback="/dashboard/quotes" />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="break-words text-xl font-bold text-text-primary sm:text-2xl">{quote.customer_name || 'Unnamed customer'}</h1>
                <span className={`rounded-full px-3 py-1 text-xs font-medium ${QUOTE_STATUS_COLORS[quote.status]}`}>
                  {QUOTE_STATUS_LABELS[quote.status]}
                </span>
              </div>
              <p className="mt-1 break-words text-xs text-text-secondary">
                {[quote.customer_phone, quote.customer_email].filter(Boolean).join(' \u00b7 ') || 'No contact details'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void load(true)} aria-label="Refresh quote">
              <RefreshCw size={14} aria-hidden="true" /> Refresh
            </Button>
            {quote.status !== 'draft' ? (
              <>
                <Button size="sm" variant="secondary" onClick={() => void handleCopyLink(quote)}>
                  <Copy size={14} aria-hidden="true" /> Copy link
                </Button>
                <a className={LINK_BTN} href={getQuoteLink(quote.quote_token)} target="_blank" rel="noopener noreferrer">
                  <Eye size={14} aria-hidden="true" /> Customer view
                </a>
              </>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label={quote.status === 'accepted' ? 'Accepted total' : 'Quote total'} value={formatUsd(total)} hint={quote.deposit_percent > 0 ? `${quote.deposit_percent}% deposit` : null} />
          <StatCard
            label="Valid until"
            value={fmtDate(quote.valid_until)}
            hint={validity === 'expired' ? 'Past due date' : validity === 'expiring_soon' ? 'Expires within 3 days' : null}
          />
          <StatCard label="Customer views" value={views} hint={quote.last_viewed_at ? `Last ${timeAgo(quote.last_viewed_at)}` : null} />
          <StatCard
            label="Follow-ups"
            value={state.ws.followups.length === 0 ? 'None' : `${doneFollowUps} done`}
            hint={pendingFollowUps > 0 ? `${pendingFollowUps} pending` : null}
          />
        </div>

        {quote.status === 'sent' && validity === 'expired' ? (
          <div role="status" className="flex items-start gap-2 rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-sm text-text-primary">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning-500" aria-hidden="true" />
            This estimate is past its valid-until date but still open for the customer to accept.
          </div>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <OptionsSection quote={quote} />
            <VersionDiffSection ws={state.ws} />
          </div>
          <div className="space-y-6">
            <ConvertSection ws={state.ws} busy={convertBusy} onConvert={handleConvert} />
            <FollowUpSection
              ws={state.ws}
              busyId={busyFollowUp}
              planBusy={planBusy}
              onSchedule={handleSchedule}
              onComplete={handleCompleteFollowUp}
            />
            <TimelineSection items={timeline} />
          </div>
        </div>
      </div>
    </DashboardLayout>
  );

}

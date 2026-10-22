/**
 * Recall & Safety Center — /dashboard/recalls
 *
 * Every OEM recall / service bulletin that touches this account's equipment becomes a campaign with a
 * prioritized outreach list. Matching, scoring and status rules run in SQL
 * (supabase/migrations/20271018000000_recall_safety_matching.sql); logic here lives in lib/recallMatching.ts.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ClipboardCopy, Mail, MessageSquare, Phone, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import {
  fetchOutreachEvents,
  fetchRecallCampaigns,
  fetchRecallOutreach,
  logRecallOutreach,
  scanMyAccountForRecalls,
  setRecallCampaignStatus,
} from '@/lib/recallMatchingApi';
import {
  ACTION_LABELS,
  CAMPAIGN_STATUS_LABELS,
  CHANNEL_LABELS,
  FILTER_LABELS,
  MATCH_LABELS,
  SEVERITY_LABELS,
  STATUS_LABELS,
  actionRequirements,
  allowedActions,
  buildOutreachMessage,
  campaignProgress,
  contactLinks,
  countByFilter,
  equipmentLabel,
  filterOutreach,
  followUpFromDate,
  formatFollowUp,
  friendlyRecallError,
  isOverdue,
  isTerminal,
  reasonLabel,
  summarizeCampaigns,
  urgencyOf,
  validateAction,
  type OutreachAction,
  type OutreachChannel,
  type OutreachEvent,
  type OutreachFilter,
  type OutreachRow,
  type RecallCampaign,
  type RecallSeverity,
} from '@/lib/recallMatching';

const FIELD =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary/70';
const FILTERS = Object.keys(FILTER_LABELS) as OutreachFilter[];
const CHANNELS = Object.keys(CHANNEL_LABELS) as OutreachChannel[];

const SEVERITY_STYLE: Record<RecallSeverity, string> = {
  critical: 'bg-danger/10 text-danger',
  high: 'bg-danger/10 text-danger',
  medium: 'bg-warning-500/10 text-warning-500',
  low: 'bg-bg-tertiary text-text-secondary',
};

function StatTile({ label, value, tone }: { label: string; value: number; tone?: 'danger' }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone === 'danger' && value > 0 ? 'text-danger' : 'text-text-primary'}`}>{value}</p>
    </div>
  );
}

function ProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${percent}%` }} />
    </div>
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------------------------------------------------------------- one unit

function OutreachCard({
  row,
  campaign,
  now,
  busy,
  onSubmit,
}: {
  row: OutreachRow;
  campaign: RecallCampaign;
  now: Date;
  busy: boolean;
  onSubmit: (row: OutreachRow, input: { action: OutreachAction; channel: OutreachChannel | null; note: string; followUpAt: string | null }) => Promise<boolean>;
}) {
  const { toast } = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [events, setEvents] = useState<OutreachEvent[] | null>(null);
  const [eventsError, setEventsError] = useState(false);
  const actions = useMemo(() => allowedActions(row.status, row.attempts), [row.status, row.attempts]);
  const [action, setAction] = useState<OutreachAction>(actions[0]);
  const [channel, setChannel] = useState<OutreachChannel | ''>('');
  const [note, setNote] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Keep the selected action valid when the row's status changes after a save.
  useEffect(() => {
    if (!actions.includes(action)) setAction(actions[0]);
  }, [actions, action]);

  const req = actionRequirements(action);
  const urgency = urgencyOf(row.priority_score);
  const overdue = isOverdue(row, now);
  const followText = isTerminal(row.status) ? null : formatFollowUp(row.next_follow_up_at, now);
  const ctx = { campaign, row, businessName: null };
  const email = buildOutreachMessage('email', ctx);
  const sms = buildOutreachMessage('sms', ctx);
  const links = contactLinks(row.customer, email.subject, email.body);
  const smsLink = contactLinks(row.customer, '', sms.body).sms;

  const copy = async (kind: 'sms' | 'email' | 'phone') => {
    const m = buildOutreachMessage(kind, ctx);
    try {
      await navigator.clipboard.writeText(kind === 'email' ? `${m.subject}\n\n${m.body}` : m.body);
      toast(kind === 'phone' ? 'Call script copied' : 'Message copied', 'success');
    } catch {
      toast('Copy is not available in this browser', 'error');
    }
  };

  const toggleHistory = async () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && events === null) {
      try {
        setEventsError(false);
        setEvents(await fetchOutreachEvents(row.id));
      } catch {
        setEventsError(true);
      }
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateAction(row, { action, channel: channel || null, note });
    if (err) {
      setFormError(err);
      return;
    }
    if (followUp && !followUpFromDate(followUp)) {
      setFormError('Enter a valid follow-up date.');
      return;
    }
    setFormError(null);
    const ok = await onSubmit(row, { action, channel: channel || null, note, followUpAt: req.followUp ? followUpFromDate(followUp) : null });
    if (ok) {
      setFormOpen(false);
      setNote('');
      setFollowUp('');
      setChannel('');
      setEvents(null);
      setHistoryOpen(false);
    }
  };

  return (
    <li className="rounded-2xl border border-border bg-bg-secondary p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{row.customer.name}</p>
          <p className="truncate text-xs text-text-secondary">
            {equipmentLabel(row.equipment)} · {row.equipment.equipment_type}
            {row.equipment.serial_number ? ` · S/N ${row.equipment.serial_number}` : ''}
          </p>
          {row.customer.address && <p className="truncate text-xs text-text-secondary">{row.customer.address}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${urgency === 'urgent' ? 'bg-danger/10 text-danger' : urgency === 'high' ? 'bg-warning-500/10 text-warning-500' : 'bg-bg-tertiary text-text-secondary'}`}
            title="Priority score (0-100)"
          >
            {urgency === 'urgent' ? 'Urgent' : urgency === 'high' ? 'High' : 'Standard'} · {row.priority_score}
          </span>
          <span className="rounded-full bg-bg-tertiary px-2.5 py-1 text-xs font-medium text-text-primary">{STATUS_LABELS[row.status]}</span>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
        <span className={`rounded-full px-2 py-0.5 ${row.applicability === 'applies' ? 'bg-success-500/10 text-success-500' : 'bg-warning-500/10 text-warning-500'}`}>
          {row.applicability === 'applies' ? 'Confirmed affected' : 'Needs verification'} · {MATCH_LABELS[row.match_method]}
        </span>
        {row.priority_reasons
          .filter((r) => r !== 'confirmed_match' && r !== 'needs_verification')
          .map((r) => (
            <span key={r} className="rounded-full bg-bg-tertiary px-2 py-0.5 text-text-secondary">{reasonLabel(r)}</span>
          ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
        <span>{row.attempts} contact attempt{row.attempts === 1 ? '' : 's'}</span>
        {row.last_contacted_at && <span>Last: {formatDateTime(row.last_contacted_at)}</span>}
        {followText && <span className={overdue ? 'font-semibold text-danger' : ''}>{followText}</span>}
        {isTerminal(row.status) && row.resolution_note && <span>Note: {row.resolution_note}</span>}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {links.tel && (
          <a href={links.tel} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-medium text-text-primary hover:border-accent/40">
            <Phone size={14} aria-hidden="true" /> Call
          </a>
        )}
        {smsLink && (
          <a href={smsLink} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-medium text-text-primary hover:border-accent/40">
            <MessageSquare size={14} aria-hidden="true" /> Text
          </a>
        )}
        {links.mailto && (
          <a href={links.mailto} className="focus-ring inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-medium text-text-primary hover:border-accent/40">
            <Mail size={14} aria-hidden="true" /> Email
          </a>
        )}
        <Button variant="ghost" size="sm" onClick={() => void copy('phone')} aria-label="Copy call script">
          <ClipboardCopy size={14} aria-hidden="true" /> Script
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void toggleHistory()} aria-expanded={historyOpen}>
          History
        </Button>
        <Button variant={isTerminal(row.status) ? 'secondary' : 'primary'} size="sm" onClick={() => setFormOpen((v) => !v)} aria-expanded={formOpen} disabled={busy}>
          {isTerminal(row.status) ? 'Re-open / note' : 'Log outcome'}
        </Button>
      </div>

      {historyOpen && (
        <div className="mt-3 rounded-xl border border-border bg-bg-primary p-3 text-xs" aria-live="polite">
          {eventsError ? (
            <p className="text-danger">History could not be loaded.</p>
          ) : events === null ? (
            <p className="text-text-secondary">Loading…</p>
          ) : events.length === 0 ? (
            <p className="text-text-secondary">No activity yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {events.map((ev) => (
                <li key={ev.id} className="text-text-secondary">
                  <span className="font-medium text-text-primary">{ev.event_type === 'created' ? 'Matched' : ACTION_LABELS[ev.event_type as OutreachAction] ?? ev.event_type}</span>
                  {ev.channel ? ` · ${CHANNEL_LABELS[ev.channel]}` : ''} · {formatDateTime(ev.created_at)}
                  {ev.note ? ` — ${ev.note}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {formOpen && (
        <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-3 rounded-xl border border-border bg-bg-primary p-3" noValidate>
          <label className="block text-xs font-medium text-text-secondary">
            Outcome
            <select className={`${FIELD} mt-1`} value={action} onChange={(e) => setAction(e.target.value as OutreachAction)}>
              {actions.map((a) => (
                <option key={a} value={a}>{ACTION_LABELS[a]}</option>
              ))}
            </select>
          </label>
          {req.channel && (
            <label className="block text-xs font-medium text-text-secondary">
              How did you reach out?
              <select className={`${FIELD} mt-1`} value={channel} onChange={(e) => setChannel(e.target.value as OutreachChannel | '')} required>
                <option value="">Choose…</option>
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-xs font-medium text-text-secondary">
            Note{req.note ? ' (required)' : ' (optional)'}
            <textarea className={`${FIELD} mt-1`} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {req.followUp && (
            <label className="block text-xs font-medium text-text-secondary">
              Follow up on (optional)
              <input type="date" className={`${FIELD} mt-1`} value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
            </label>
          )}
          {formError && <p role="alert" className="text-xs text-danger">{formError}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>Save</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setFormOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- page

export function RecallCenterPage() {
  const { isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const allowed = isOwner || permissions.can_view_all_jobs;
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('campaign');

  const [campaigns, setCampaigns] = useState<RecallCampaign[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [rows, setRows] = useState<OutreachRow[] | null>(null);
  const [rowsError, setRowsError] = useState(false);
  const [filter, setFilter] = useState<OutreachFilter>('open');
  const [query, setQuery] = useState('');
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const now = useMemo(() => new Date(), [rows, campaigns]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadCampaigns = useCallback(async () => {
    try {
      setLoadError(false);
      setCampaigns(await fetchRecallCampaigns());
    } catch {
      setCampaigns((prev) => prev ?? []);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    if (allowed) void loadCampaigns();
  }, [allowed, loadCampaigns]);

  const selected = useMemo(() => campaigns?.find((c) => c.id === selectedId) ?? null, [campaigns, selectedId]);

  // Open the most urgent active campaign by default.
  useEffect(() => {
    if (!campaigns || selectedId || campaigns.length === 0) return;
    const first = campaigns.find((c) => c.status === 'active') ?? campaigns[0];
    const next = new URLSearchParams(params);
    next.set('campaign', first.id);
    setParams(next, { replace: true });
  }, [campaigns, selectedId, params, setParams]);

  const loadRows = useCallback(async (id: string) => {
    const mine = ++seq.current;
    try {
      setRowsError(false);
      const data = await fetchRecallOutreach(id);
      if (mine === seq.current) setRows(data);
    } catch {
      if (mine === seq.current) {
        setRows([]);
        setRowsError(true);
      }
    }
  }, []);

  useEffect(() => {
    setRows(null);
    if (selectedId && allowed) void loadRows(selectedId);
  }, [selectedId, allowed, loadRows]);

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('campaign', id);
    setParams(next);
  };

  const scan = async () => {
    setScanning(true);
    try {
      const r = await scanMyAccountForRecalls();
      toast(r.created > 0 ? `${r.created} new unit${r.created === 1 ? '' : 's'} need outreach` : 'No new affected units found', r.created > 0 ? 'success' : 'info');
      await loadCampaigns();
      if (selectedId) await loadRows(selectedId);
    } catch (e) {
      toast(friendlyRecallError(e, 'The scan failed. Please try again.'), 'error');
    } finally {
      setScanning(false);
    }
  };

  const submitOutcome = async (
    row: OutreachRow,
    input: { action: OutreachAction; channel: OutreachChannel | null; note: string; followUpAt: string | null },
  ): Promise<boolean> => {
    setBusy(true);
    try {
      await logRecallOutreach({ outreachId: row.id, ...input });
      toast('Saved', 'success');
      await Promise.all([loadCampaigns(), loadRows(row.campaign_id)]);
      return true;
    } catch (e) {
      toast(friendlyRecallError(e), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (c: RecallCampaign, status: 'active' | 'paused' | 'cancelled') => {
    if (status === 'cancelled' && !window.confirm('Cancel this campaign? Matching will stop adding units to it.')) return;
    setBusy(true);
    try {
      await setRecallCampaignStatus(c.id, status);
      await loadCampaigns();
    } catch (e) {
      toast(friendlyRecallError(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const summary = useMemo(() => summarizeCampaigns(campaigns ?? []), [campaigns]);
  const visible = useMemo(() => (rows ? filterOutreach(rows, filter, query, now) : []), [rows, filter, query, now]);
  const counts = useMemo(() => (rows ? countByFilter(rows, now) : null), [rows, now]);

  return (
    <DashboardLayout activeLabel="Recall Center">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <ShieldAlert size={22} className="text-accent" aria-hidden="true" /> Recall Center
            </h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-text-secondary">
              When a manufacturer issues a recall or service bulletin, Vireek finds every affected unit you service, ranks the customers by risk, and tracks outreach until each one is closed with a record.
            </p>
          </div>
          {allowed && (
            <Button variant="secondary" size="sm" onClick={() => void scan()} disabled={scanning}>
              <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} aria-hidden="true" /> {scanning ? 'Scanning…' : 'Scan now'}
            </Button>
          )}
        </div>

        {!allowed ? (
          <EmptyState icon={ShieldAlert} title="Not available for your role" description="Recall outreach is managed by owners and team members who can view all jobs." />
        ) : campaigns === null ? (
          <div className="space-y-4">
            <SkeletonStatGrid count={4} />
            <SkeletonCardList count={3} />
          </div>
        ) : (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile label="Active campaigns" value={summary.activeCampaigns} />
              <StatTile label="Units awaiting outreach" value={summary.openUnits} />
              <StatTile label="Urgent" value={summary.urgentOpen} tone="danger" />
              <StatTile label="Overdue follow-ups" value={summary.overdue} tone="danger" />
            </div>

            {loadError && (
              <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
                <span className="flex items-center gap-2"><AlertTriangle size={16} aria-hidden="true" /> Recalls could not be loaded.</span>
                <Button variant="secondary" size="sm" onClick={() => void loadCampaigns()}>Retry</Button>
              </div>
            )}

            {!loadError && campaigns.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="No recalls affect your customers"
                description="New recalls and bulletins are matched automatically. Press “Scan now” to check immediately after adding equipment."
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <section aria-label="Campaigns" className="min-w-0">
                  <ul className="space-y-2">
                    {campaigns.map((c) => {
                      const p = campaignProgress(c.counts);
                      const active = c.id === selectedId;
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => select(c.id)}
                            aria-current={active ? 'true' : undefined}
                            className={`focus-ring w-full rounded-2xl border p-3 text-left transition-colors ${active ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary hover:border-accent/40'}`}
                          >
                            <div className="flex items-center gap-1.5 text-[11px]">
                              <span className={`rounded-full px-2 py-0.5 font-semibold ${SEVERITY_STYLE[c.severity]}`}>{SEVERITY_LABELS[c.severity]}</span>
                              <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-text-secondary">{c.source_kind === 'recall' ? 'Recall' : 'Bulletin'} {c.number}</span>
                              <span className="ml-auto text-text-secondary">{CAMPAIGN_STATUS_LABELS[c.status]}</span>
                            </div>
                            <p className="mt-1.5 text-sm font-semibold text-text-primary">{c.title}</p>
                            <div className="mt-2"><ProgressBar percent={p.percent} label={`${c.title} progress`} /></div>
                            <p className="mt-1 text-[11px] text-text-secondary">
                              {p.closed} of {c.counts.total} closed
                              {c.urgent_open > 0 ? ` · ${c.urgent_open} urgent` : ''}
                              {c.overdue > 0 ? ` · ${c.overdue} overdue` : ''}
                            </p>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>

                <section aria-label="Outreach list" className="min-w-0" aria-live="polite">
                  {selected && (
                    <>
                      <div className="mb-3 rounded-2xl border border-border bg-bg-secondary p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-text-primary">{selected.title}</p>
                            <p className="text-xs text-text-secondary">
                              {selected.source_kind === 'recall' ? 'Recall' : 'Service bulletin'} {selected.number}
                              {selected.issued_date ? ` · issued ${selected.issued_date}` : ''}
                              {selected.auto_created ? ' · created automatically' : ''}
                            </p>
                          </div>
                          <div className="flex gap-2">
                            {selected.status === 'active' && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void changeStatus(selected, 'paused')}>Pause</Button>}
                            {(selected.status === 'paused' || selected.status === 'cancelled') && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void changeStatus(selected, 'active')}>Resume</Button>}
                            {(selected.status === 'active' || selected.status === 'paused') && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void changeStatus(selected, 'cancelled')}>Cancel</Button>}
                          </div>
                        </div>
                        {(selected.remedy || selected.description) && (
                          <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                            {selected.remedy ? `Manufacturer remedy: ${selected.remedy}` : selected.description}
                          </p>
                        )}
                        {selected.source_url && (
                          <a href={selected.source_url} target="_blank" rel="noopener noreferrer" className="focus-ring mt-1 inline-block text-xs font-medium text-accent underline-offset-2 hover:underline">
                            View the manufacturer notice
                          </a>
                        )}
                      </div>

                      <div className="relative mb-2">
                        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
                        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customer, address, model, serial" aria-label="Search units" className={`${FIELD} pl-9`} />
                      </div>
                      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter units">
                        {FILTERS.map((f) => (
                          <button
                            key={f}
                            type="button"
                            aria-pressed={filter === f}
                            onClick={() => setFilter(f)}
                            className={`focus-ring rounded-full border px-3 py-1 text-xs font-medium ${filter === f ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
                          >
                            {FILTER_LABELS[f]}{counts ? ` · ${counts[f]}` : ''}
                          </button>
                        ))}
                      </div>

                      {rows === null ? (
                        <SkeletonCardList count={3} />
                      ) : rowsError ? (
                        <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
                          <p>This campaign could not be loaded.</p>
                          <Button className="mt-2" variant="secondary" size="sm" onClick={() => void loadRows(selected.id)}>Retry</Button>
                        </div>
                      ) : visible.length === 0 ? (
                        <EmptyState icon={Search} title="Nothing matches" description="Try a different filter or search term." />
                      ) : (
                        <ul className="space-y-3">
                          {visible.map((r) => (
                            <OutreachCard key={r.id} row={r} campaign={selected} now={now} busy={busy} onSubmit={submitOutcome} />
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </section>
              </div>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

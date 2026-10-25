import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarCheck, ChevronRight, Mail, Play, Plus, Square, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { FadeIn, SkeletonCardList } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { ErrorBlock, cardClass, errMsg, iconBtn, labelClass, selectClass, type TabProps } from '@/components/cadence/shared';
import {
  advanceSegment,
  buildAgenda,
  buildScorecard,
  describeWeek,
  formatClock,
  previousValues,
  previousWeekStart,
  mondayOf,
  pastWeeks,
  segmentRemainingMs,
  totalMeetingMinutes,
  trendSeries,
  validateAction,
  type AgendaSegment,
  type Issue,
  type Priority,
  type Target,
} from '@/lib/cadence';
import {
  addActionItem,
  completeMeeting,
  deleteActionItem,
  fetchActionItems,
  fetchIssues,
  fetchLiveMeeting,
  fetchPriorities,
  fetchRecentMeetings,
  fetchScorecard,
  fetchSnapshots,
  fetchTargets,
  saveMeetingProgress,
  sendMeetingRecap,
  startMeeting,
  type ActionItem,
  type Meeting,
} from '@/lib/cadenceApi';

const TONE_DOT = { danger: 'bg-danger-500', success: 'bg-success-500', neutral: 'bg-text-secondary' } as const;

function useTick(active: boolean, ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [active, ms]);
  return now;
}

const duration = (m: Meeting) => (m.ended_at ? Math.max(1, Math.round((new Date(m.ended_at).getTime() - new Date(m.started_at).getTime()) / 60_000)) : null);

export function MeetingTab(props: TabProps) {
  const { toast } = useToast();
  const { today, tz, assignees, meId } = props;
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [error, setError] = useState('');
  const [live, setLive] = useState<Meeting | null>(null);
  const [recent, setRecent] = useState<Meeting[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);

  const load = useCallback(async (skeleton: boolean) => {
    if (skeleton) setState('loading');
    try {
      const [l, r] = await Promise.all([fetchLiveMeeting(), fetchRecentMeetings(8)]);
      const items = await fetchActionItems([...(l ? [l.id] : []), ...r.map((m) => m.id)]);
      setLive(l);
      setRecent(r);
      setActions(items);
      setState('ready');
    } catch (e) {
      setError(errMsg(e));
      setState('error');
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  // Another tab/device may have changed the live meeting; refresh when this one regains focus.
  useEffect(() => {
    const onFocus = () => void load(false);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  const recap = async (m: Meeting, resend: boolean) => {
    try {
      const { sent } = await sendMeetingRecap(m.id, resend);
      toast(sent ? `Recap sent to ${sent} ${sent === 1 ? 'person' : 'people'}.` : 'No attendees with an email address.', sent ? 'success' : 'info');
      await load(false);
    } catch (e) {
      toast(errMsg(e, 'Could not send the recap.'), 'error');
    }
  };

  if (state === 'loading') return <SkeletonCardList count={3} />;
  if (state === 'error') return <ErrorBlock message={error} onRetry={() => void load(true)} />;

  return (
    <FadeIn>
      {live ? (
        <LiveMeeting
          key={live.id}
          meeting={live}
          actions={actions.filter((a) => a.meeting_id === live.id)}
          assignees={assignees}
          today={today}
          onChanged={() => load(false)}
          onEnded={async () => {
            await load(false);
            toast('Meeting ended. You can send the recap now.', 'success');
          }}
        />
      ) : (
        <StartPanel {...props} onStarted={() => load(false)} />
      )}

      <section className="mt-8" aria-label="Past meetings">
        <h2 className="mb-3 text-lg font-semibold text-text-primary">Past meetings</h2>
        {recent.length === 0 ? (
          <EmptyState icon={CalendarCheck} title="No meetings yet" description="Finished meetings, notes and action items are kept here." />
        ) : (
          <ul className="space-y-3">
            {recent.map((m) => {
              const items = actions.filter((a) => a.meeting_id === m.id);
              const done = items.filter((a) => a.task_status === 'done').length;
              return (
                <li key={m.id} className={cardClass}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-text-primary">Week of {describeWeek(m.week_start)}</h3>
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {new Date(m.started_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz })}
                        {duration(m) ? ` · ${duration(m)} min` : ''} · {items.length} action {items.length === 1 ? 'item' : 'items'}
                        {items.length > 0 && items.some((a) => a.task_status) ? ` (${done} done)` : ''}
                      </p>
                    </div>
                    <Button size="sm" variant="secondary" onClick={() => void recap(m, Boolean(m.recap_sent_at))}>
                      <Mail size={14} /> {m.recap_sent_at ? 'Resend recap' : 'Send recap'}
                    </Button>
                  </div>
                  {m.notes && <p className="mt-3 whitespace-pre-wrap rounded-xl bg-bg-tertiary px-3 py-2 text-sm text-text-primary">{m.notes}</p>}
                  {items.length > 0 && (
                    <ul className="mt-3 space-y-1 text-sm">
                      {items.map((a) => (
                        <li key={a.id} className="flex flex-wrap items-center gap-2 text-text-secondary">
                          <span className={a.task_status === 'done' ? 'line-through' : 'text-text-primary'}>{a.title}</span>
                          <span className="text-xs">
                            {a.owner_name ?? 'Unassigned'}
                            {a.due_date ? ` · due ${a.due_date}` : ''}
                            {a.owner_user_id === meId ? ' · you' : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </FadeIn>
  );
}

// ---------------------------------------------------------------------------
// Start: preview the auto-generated agenda, pick attendees
// ---------------------------------------------------------------------------
function StartPanel({ today, tz, assignees, onStarted }: TabProps & { onStarted: () => Promise<void> }) {
  const { toast } = useToast();
  const thisWeek = mondayOf(today);
  const lastWeek = previousWeekStart(thisWeek);
  const [reviewWeek, setReviewWeek] = useState(lastWeek);
  const [prep, setPrep] = useState<{ status: 'loading' | 'error' | 'ready'; error?: string; agenda: AgendaSegment[] }>({ status: 'loading', agenda: [] });
  const [attendees, setAttendees] = useState<string[]>(() => assignees.map((a) => a.userId));
  const [starting, setStarting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => setAttendees((cur) => (cur.length ? cur : assignees.map((a) => a.userId))), [assignees]);

  useEffect(() => {
    let cancelled = false;
    setPrep({ status: 'loading', agenda: [] });
    (async () => {
      try {
        const weeks = pastWeeks(reviewWeek, 13);
        const [metrics, targets, snaps, priorities, issues] = await Promise.all([
          fetchScorecard(reviewWeek),
          fetchTargets(),
          fetchSnapshots(weeks),
          fetchPriorities(today.slice(0, 4) + '-01-01'),
          fetchIssues(),
        ]);
        if (cancelled) return;
        const history: Record<string, (number | null)[]> = {};
        for (const m of metrics) history[m.metric_key] = trendSeries(snaps, m.metric_key, weeks);
        const scorecard = buildScorecard({ current: metrics, previous: previousValues(snaps, previousWeekStart(reviewWeek)), targets: targets as Target[], history });
        setPrep({ status: 'ready', agenda: buildAgenda({ scorecard, priorities: priorities as Priority[], issues: issues as Issue[], today }) });
      } catch (e) {
        if (!cancelled) setPrep({ status: 'error', error: errMsg(e), agenda: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reviewWeek, today, reloadKey]);

  const start = async () => {
    if (starting || prep.status !== 'ready') return;
    setStarting(true);
    try {
      await startMeeting({ weekStart: reviewWeek, agenda: prep.agenda, attendeeIds: attendees });
      await onStarted();
    } catch (e) {
      toast(errMsg(e, 'Could not start the meeting.'), 'error');
      await onStarted(); // someone else may have started it — show it
    } finally {
      setStarting(false);
    }
  };

  const toggle = (id: string) => setAttendees((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  return (
    <section className={cardClass} aria-label="Start the weekly meeting">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Weekly meeting</h2>
          <p className="mt-0.5 text-sm text-text-secondary">
            {totalMeetingMinutes(prep.agenda) || 60} minutes · agenda is built from your scorecard, priorities and issues.
          </p>
        </div>
        <div>
          <label htmlFor="review-week" className="sr-only">
            Week to review
          </label>
          <select id="review-week" className="focus-ring rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary" value={reviewWeek} onChange={(e) => setReviewWeek(e.target.value)}>
            <option value={lastWeek}>Last week ({describeWeek(lastWeek)})</option>
            <option value={thisWeek}>This week so far ({describeWeek(thisWeek)})</option>
          </select>
        </div>
      </div>

      {prep.status === 'loading' && <div className="mt-4"><SkeletonCardList count={2} /></div>}
      {prep.status === 'error' && <div className="mt-4"><ErrorBlock message={prep.error ?? ''} onRetry={() => setReloadKey((k) => k + 1)} /></div>}
      {prep.status === 'ready' && (
        <>
          <ol className="mt-4 grid gap-2 sm:grid-cols-2">
            {prep.agenda.map((s, i) => (
              <li key={s.key} className="rounded-xl border border-border bg-bg-primary px-4 py-3">
                <p className="text-sm font-semibold text-text-primary">
                  {i + 1}. {s.title} <span className="font-normal text-text-secondary">· {s.minutes} min</span>
                </p>
                <p className="mt-0.5 text-xs text-text-secondary">{s.items.length ? `${s.items.length} item${s.items.length > 1 ? 's' : ''}` : 'Nothing queued'}</p>
              </li>
            ))}
          </ol>

          <fieldset className="mt-5">
            <legend className={labelClass}>Attendees (they get the recap)</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {assignees.map((a) => (
                <label key={a.userId} className="flex min-h-[40px] cursor-pointer items-center gap-2.5 text-sm text-text-primary">
                  <input type="checkbox" className="focus-ring h-5 w-5 rounded border-border accent-accent" checked={attendees.includes(a.userId)} onChange={() => toggle(a.userId)} />
                  {a.name}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-5 flex justify-end">
            <Button onClick={() => void start()} disabled={starting}>
              <Play size={16} /> {starting ? 'Starting…' : 'Start meeting'}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Live meeting
// ---------------------------------------------------------------------------
function LiveMeeting({
  meeting,
  actions,
  assignees,
  today,
  onChanged,
  onEnded,
}: {
  meeting: Meeting;
  actions: ActionItem[];
  assignees: TabProps['assignees'];
  today: string;
  onChanged: () => Promise<void>;
  onEnded: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [timer, setTimer] = useState({ current: meeting.current_segment, startedAt: meeting.segment_started_at, elapsed: meeting.segment_elapsed_ms });
  const [notes, setNotes] = useState(meeting.notes ?? '');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [ending, setEnding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const savedNotes = useRef(meeting.notes ?? '');
  const total = meeting.agenda.length;
  const now = useTick(timer.current < total);
  const seg = meeting.agenda[Math.min(timer.current, total - 1)];
  const remaining = seg ? segmentRemainingMs(seg.minutes, timer.startedAt, now) : 0;
  const finished = timer.current >= total;

  // Debounced autosave of notes.
  useEffect(() => {
    if (notes === savedNotes.current) return;
    setSaveState('saving');
    const t = window.setTimeout(async () => {
      try {
        await saveMeetingProgress(meeting.id, { notes: notes || null });
        savedNotes.current = notes;
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, 1200);
    return () => window.clearTimeout(t);
  }, [notes, meeting.id]);

  const next = async () => {
    if (advancing || finished) return;
    setAdvancing(true);
    const t = advanceSegment({ current: timer.current, segmentStartedAt: timer.startedAt, elapsedMs: timer.elapsed }, total, Date.now());
    const prev = timer;
    setTimer({ current: t.current, startedAt: t.segmentStartedAt, elapsed: t.elapsedMs });
    try {
      await saveMeetingProgress(meeting.id, { current_segment: t.current, segment_started_at: t.segmentStartedAt, segment_elapsed_ms: t.elapsedMs });
    } catch (e) {
      setTimer(prev);
      toast(errMsg(e, 'Could not move to the next section.'), 'error');
    } finally {
      setAdvancing(false);
    }
  };

  const end = async () => {
    if (ending) return;
    setEnding(true);
    try {
      let elapsed = timer.elapsed;
      if (timer.current < total && timer.startedAt) {
        elapsed = advanceSegment({ current: timer.current, segmentStartedAt: timer.startedAt, elapsedMs: timer.elapsed }, total, Date.now()).elapsedMs;
      }
      await completeMeeting(meeting.id, { notes: notes || null, segment_elapsed_ms: elapsed });
      setConfirmEnd(false);
      await onEnded();
    } catch (e) {
      toast(errMsg(e, 'Could not end the meeting.'), 'error');
    } finally {
      setEnding(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className={cardClass} aria-label="Meeting timer">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-accent">Meeting in progress · {describeWeek(meeting.week_start)}</p>
            <h2 className="mt-1 text-xl font-bold text-text-primary">{finished ? 'All sections covered' : seg?.title}</h2>
            {!finished && (
              <p className="text-sm text-text-secondary">
                Section {timer.current + 1} of {total} · {seg?.minutes} min planned
              </p>
            )}
          </div>
          {!finished && (
            <p
              role="timer"
              aria-label={remaining < 0 ? 'Over time' : 'Time remaining'}
              className={`text-4xl font-bold tabular-nums ${remaining < 0 ? 'text-danger' : remaining < 60_000 ? 'text-warning-500' : 'text-text-primary'}`}
            >
              {formatClock(remaining)}
            </p>
          )}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {meeting.agenda.map((s, i) => (
            <span
              key={s.key}
              aria-current={i === timer.current ? 'step' : undefined}
              className={`rounded-full px-3 py-1 text-xs font-medium ${i === timer.current ? 'bg-accent text-white' : i < timer.current ? 'bg-success-500/10 text-success-500' : 'bg-bg-tertiary text-text-secondary'}`}
            >
              {s.title}
            </span>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {!finished && (
            <Button size="sm" variant="secondary" onClick={() => void next()} disabled={advancing}>
              {timer.current === total - 1 ? 'Finish agenda' : 'Next section'} <ChevronRight size={16} />
            </Button>
          )}
          <Button size="sm" onClick={() => setConfirmEnd(true)} disabled={ending}>
            <Square size={14} /> End meeting
          </Button>
        </div>
      </section>

      {!finished && seg && (
        <section className={cardClass} aria-label={seg.title}>
          <h3 className="text-sm font-semibold text-text-primary">{seg.title}</h3>
          {seg.items.length === 0 ? (
            <p className="mt-2 text-sm text-text-secondary">Nothing queued for this section.</p>
          ) : (
            <ul className="mt-3 space-y-2.5">
              {seg.items.map((it) => (
                <li key={it.id} className="flex items-start gap-3">
                  <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${TONE_DOT[it.tone]}`} aria-hidden />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{it.title}</p>
                    <p className="text-xs text-text-secondary">{it.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className={cardClass} aria-label="Notes">
        <div className="mb-2 flex items-center justify-between">
          <label htmlFor="meeting-notes" className="text-sm font-semibold text-text-primary">
            Notes
          </label>
          <span className="text-xs text-text-secondary" aria-live="polite">
            {saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Couldn’t save — keep typing to retry' : 'Saved'}
          </span>
        </div>
        <Textarea id="meeting-notes" rows={6} maxLength={20000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Decisions, context, who said what…" />
      </section>

      <ActionItems meetingId={meeting.id} items={actions} assignees={assignees} today={today} onChanged={onChanged} />

      <ConfirmDialog
        open={confirmEnd}
        title="End the meeting?"
        description="Notes and action items are saved. You can send the recap to attendees right after."
        confirmLabel="End meeting"
        onConfirm={end}
        onCancel={() => setConfirmEnd(false)}
      />
    </div>
  );
}

function ActionItems({
  meetingId,
  items,
  assignees,
  today,
  onChanged,
}: {
  meetingId: string;
  items: ActionItem[];
  assignees: TabProps['assignees'];
  today: string;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const add = async () => {
    if (busy) return;
    const errs = validateAction({ title, ownerUserId: ownerId, dueDate: due }, today);
    if (errs.title || errs.dueDate) return setError(errs.title ?? errs.dueDate);
    const owner = assignees.find((a) => a.userId === ownerId);
    setBusy(true);
    try {
      await addActionItem({ meetingId, title, ownerUserId: owner?.userId ?? null, ownerName: owner?.name ?? null, dueDate: due || null });
      setTitle('');
      setDue('');
      setError(undefined);
      toast('Action item added and turned into a task.', 'success');
      await onChanged();
    } catch (e) {
      toast(errMsg(e, 'Could not add the action item.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setRemovingId(id);
    try {
      await deleteActionItem(id);
      await onChanged();
    } catch (e) {
      toast(errMsg(e, 'Could not remove the action item.'), 'error');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <section className={cardClass} aria-label="Action items">
      <h3 className="text-sm font-semibold text-text-primary">Action items</h3>
      <p className="mt-0.5 text-xs text-text-secondary">Each one becomes a task for its owner.</p>

      {items.length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {items.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{a.title}</p>
                <p className="text-xs text-text-secondary">
                  {a.owner_name ?? 'Unassigned'}
                  {a.due_date ? ` · due ${a.due_date}` : ''}
                </p>
              </div>
              <button type="button" onClick={() => void remove(a.id)} disabled={removingId === a.id} aria-label={`Remove ${a.title}`} className={`${iconBtn} hover:text-danger-500`}>
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_180px_160px_auto] sm:items-end">
        <Input label="New action" value={title} maxLength={200} error={error} onChange={(e) => { setTitle(e.target.value); setError(undefined); }} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <div>
          <label htmlFor="action-owner" className={labelClass}>Owner</label>
          <select id="action-owner" className={selectClass} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Unassigned</option>
            {assignees.map((a) => (
              <option key={a.userId} value={a.userId}>{a.name}</option>
            ))}
          </select>
        </div>
        <Input label="Due" type="date" min={today} value={due} onChange={(e) => setDue(e.target.value)} />
        <Button size="sm" onClick={() => void add()} disabled={busy} className="sm:mb-0.5">
          <Plus size={16} /> {busy ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </section>
  );
}

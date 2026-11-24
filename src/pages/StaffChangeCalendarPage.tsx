/**
 * Staff — /staff/change-calendar (wrapped in <StaffRoute>): Vireek's own pricing / terms / SLA / policy changes with owner,
 * approval, notice date and effective date. Platform staff only. Rules and reminders: docs/change-calendar.md.
 * The page never sends customer notices; "Record notice as sent" only records that a person sent one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useChangeCalendarT } from '@/i18n/changeCalendarNamespace';
import {
  AUDIENCES,
  CATEGORIES,
  actionsFor,
  emptyDraft,
  entryToDraft,
  hasErrors,
  noticeShortfallDays,
  sortEntries,
  summarize,
  todayUtc,
  urgencyOf,
  validateDraft,
  type ChangeDraft,
  type ChangeEntry,
  type DraftErrors,
} from '@/lib/changeCalendar';
import {
  cancelEntry,
  completeEntry,
  decideEntry,
  fetchEntries,
  fetchEvents,
  fetchStaffOptions,
  markNoticeSent,
  saveEntry,
  submitEntry,
  type CalendarEvent,
  type StaffOption,
} from '@/lib/changeCalendarApi';

const SELECT = 'focus-ring min-h-[44px] w-full rounded-xl border border-border bg-bg-primary px-3 text-sm text-text-primary';
const LEVEL_CLASS: Record<string, string> = {
  critical: 'text-danger',
  warning: 'text-warning',
  info: 'text-text-secondary',
  none: 'text-text-secondary',
  closed: 'text-text-secondary',
};

type Load = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; entries: ChangeEntry[] };
type Pending = { id: string; mode: 'reject' | 'cancel' } | null;

/** Maps a database error to a toast key. Unknown errors never leak raw messages to the screen. */
function errorKey(e: unknown): string {
  const m = e instanceof Error ? e.message : '';
  if (m.includes('maker_checker_violation')) return 'toast.selfApproval';
  if (m.includes('locked_after_notice')) return 'toast.locked';
  if (m.includes('not_yet_effective')) return 'toast.notYetEffective';
  if (m.includes('notice_not_recorded')) return 'toast.noticeFirst';
  if (m.includes('effective_date_in_past')) return 'toast.pastEffective';
  return 'toast.failed';
}

export function StaffChangeCalendarPage() {
  const { t, language } = useChangeCalendarT();
  const { user } = useAuth();
  const { toast } = useToast();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [showClosed, setShowClosed] = useState(false);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [form, setForm] = useState<ChangeDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [note, setNote] = useState('');
  const [history, setHistory] = useState<{ id: string; state: 'loading' | 'error' | 'ready'; events: CalendarEvent[] } | null>(null);
  const today = todayUtc();

  const dateFmt = useMemo(() => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }), [language]);
  const fmtDate = useCallback((iso: string) => { const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`); return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d); }, [dateFmt]);

  const refresh = useCallback(async () => {
    try {
      setLoad({ kind: 'ready', entries: await fetchEntries() });
    } catch {
      setLoad({ kind: 'error' });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void fetchStaffOptions().then(setStaff); }, []);

  const owners: StaffOption[] = useMemo(() => {
    const list = staff.length > 0 ? staff : user ? [{ id: user.id, label: user.email ?? user.id }] : [];
    return list;
  }, [staff, user]);
  const ownerLabel = useCallback((id: string) => owners.find((o) => o.id === id)?.label ?? `${id.slice(0, 8)}…`, [owners]);

  const entries = load.kind === 'ready' ? load.entries : [];
  const visible = useMemo(() => sortEntries(entries).filter((e) => showClosed || (e.status !== 'completed' && e.status !== 'cancelled')), [entries, showClosed]);
  const summary = useMemo(() => summarize(entries, today), [entries, today]);

  const run = async (id: string, okKey: string, fn: () => Promise<unknown>) => {
    if (busyId) return;
    setBusyId(id);
    try {
      await fn();
      toast(t(okKey), 'success');
      setPending(null);
      setNote('');
      await refresh();
    } catch (e) {
      toast(t(errorKey(e)), 'error');
      await refresh(); // another session may have changed it
    } finally {
      setBusyId(null);
    }
  };

  const openHistory = async (id: string) => {
    if (history?.id === id) { setHistory(null); return; }
    setHistory({ id, state: 'loading', events: [] });
    try { setHistory({ id, state: 'ready', events: await fetchEvents(id) }); } catch { setHistory({ id, state: 'error', events: [] }); }
  };

  const when = (days: number | null): string => {
    if (days === null) return '';
    if (days === 0) return t('when.today');
    return days > 0 ? t('when.inDays', { count: days }) : t('when.daysAgo', { count: -days });
  };

  let body;
  if (load.kind === 'loading') {
    body = <SkeletonCardList count={3} rows={3} />;
  } else if (load.kind === 'error') {
    body = <EmptyStateError icon={WifiOff} title={t('page.loadError')} description={t('page.retry')} onRetry={() => { setLoad({ kind: 'loading' }); void refresh(); }} />;
  } else if (entries.length === 0) {
    body = <EmptyState icon={CalendarClock} title={t('page.emptyTitle')} description={t('page.emptyBody')} action={{ label: t('page.new'), onClick: () => setForm(emptyDraft(user?.id ?? '')) }} />;
  } else if (visible.length === 0) {
    body = <EmptyState compact title={t('page.noMatch')} />;
  } else {
    body = (
      <ul className="space-y-3" aria-label={t('page.title')}>
        {visible.map((e) => {
          const u = urgencyOf(e, today);
          const a = actionsFor(e, today);
          const short = noticeShortfallDays(e);
          const busy = busyId === e.id;
          return (
            <li key={e.id}>
              <Card className="space-y-3 p-4 hover:translate-y-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-text-primary">{e.title}</h2>
                    <p className="text-xs text-text-secondary">
                      {t(`category.${e.category}`)} · {t(`audience.${e.audience}`)} · {t('table.owner')}: {ownerLabel(e.owner_id)}
                    </p>
                  </div>
                  <span className="text-xs font-medium text-text-primary">{t(`status.${e.status}`)}</span>
                </div>
                <dl className="grid gap-2 text-sm sm:grid-cols-3">
                  <div><dt className="text-xs text-text-secondary">{t('table.notice')}</dt><dd>{fmtDate(e.notice_date)}{u.noticeInDays !== null && <span className="text-text-secondary"> · {when(u.noticeInDays)}</span>}</dd></div>
                  <div><dt className="text-xs text-text-secondary">{t('table.effective')}</dt><dd>{fmtDate(e.effective_date)}{u.effectiveInDays !== null && e.status !== 'completed' && e.status !== 'cancelled' && <span className="text-text-secondary"> · {when(u.effectiveInDays)}</span>}</dd></div>
                  <div><dt className="text-xs text-text-secondary">{t('table.attention')}</dt><dd className={LEVEL_CLASS[u.level]}>{u.kind ? t(`reminder.${u.kind}`) : t(`level.${u.level}`)}</dd></div>
                </dl>
                <p className="text-xs text-text-secondary">{e.notice_sent_at ? t('noticeSent', { date: fmtDate(e.notice_sent_at) }) : e.audience === 'internal' ? '' : t('noticeNotSent')}</p>
                {short > 0 && <p className="text-xs text-warning">{t('shortfall', { count: short })}</p>}
                {a.locked && <p className="text-xs text-text-secondary">{t('locked')}</p>}
                {e.summary && <p className="whitespace-pre-line text-sm text-text-secondary">{e.summary}</p>}
                {e.reference_url && <a className="focus-ring text-sm text-accent underline" href={e.reference_url} target="_blank" rel="noopener noreferrer">{e.reference_url}</a>}

                {pending?.id === e.id ? (
                  <div className="space-y-2">
                    <Input label={t('actions.noteLabel')} value={note} maxLength={500} helperText={t(pending.mode === 'reject' ? 'actions.noteRejectHelp' : 'actions.noteCancelHelp')} onChange={(ev) => setNote(ev.target.value)} />
                    <div className="flex flex-wrap gap-2">
                      <Button variant="danger" size="md" loading={busy} disabled={note.trim().length < 3} onClick={() => void run(e.id, pending.mode === 'reject' ? 'toast.rejected' : 'toast.cancelled', () => (pending.mode === 'reject' ? decideEntry(e.id, false, note.trim()) : cancelEntry(e.id, note.trim())))}>{t('actions.confirm')}</Button>
                      <Button variant="ghost" size="md" onClick={() => { setPending(null); setNote(''); }}>{t('actions.back')}</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {a.submit && <Button size="md" loading={busy} onClick={() => void run(e.id, 'toast.submitted', () => submitEntry(e.id))}>{t('actions.submit')}</Button>}
                    {a.approve && <Button size="md" loading={busy} onClick={() => void run(e.id, 'toast.approved', () => decideEntry(e.id, true, null))}>{t('actions.approve')}</Button>}
                    {a.reject && <Button variant="secondary" size="md" onClick={() => { setPending({ id: e.id, mode: 'reject' }); setNote(''); }}>{t('actions.reject')}</Button>}
                    {a.markNoticeSent && <Button variant="secondary" size="md" loading={busy} onClick={() => void run(e.id, 'toast.noticeRecorded', () => markNoticeSent(e.id))}>{t('actions.markNoticeSent')}</Button>}
                    {a.complete && <Button size="md" loading={busy} onClick={() => void run(e.id, 'toast.completed', () => completeEntry(e.id))}>{t('actions.complete')}</Button>}
                    {a.edit && <Button variant="ghost" size="md" onClick={() => setForm(entryToDraft(e))}>{t('actions.edit')}</Button>}
                    {a.cancel && <Button variant="ghost" size="md" onClick={() => { setPending({ id: e.id, mode: 'cancel' }); setNote(''); }}>{t('actions.cancel')}</Button>}
                    <Button variant="link" size="md" onClick={() => void openHistory(e.id)}>{t('actions.history')}</Button>
                  </div>
                )}
                {a.markNoticeSent && <p className="text-xs text-text-secondary">{t('actions.markNoticeHelp')}</p>}

                {history?.id === e.id && (
                  <div className="border-t border-border pt-3" aria-live="polite">
                    <h3 className="text-sm font-medium">{t('history.title')}</h3>
                    {history.state === 'loading' && <p className="text-xs text-text-secondary" aria-busy="true">…</p>}
                    {history.state === 'error' && <p className="text-xs text-danger">{t('history.loadError')}</p>}
                    {history.state === 'ready' && history.events.length === 0 && <p className="text-xs text-text-secondary">{t('history.empty')}</p>}
                    {history.state === 'ready' && history.events.length > 0 && (
                      <ol className="mt-1 space-y-1 text-xs text-text-secondary">
                        {history.events.map((ev) => (
                          <li key={ev.id}>{fmtDate(ev.at)} · {t(`event.${ev.action}`, { defaultValue: ev.action })}{ev.note ? ` — ${ev.note}` : ''}</li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6" aria-busy={load.kind === 'loading'}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold text-text-primary">{t('page.title')}</h1>
          <p className="text-sm text-text-secondary">{t('page.subtitle')}</p>
        </div>
        <Button size="md" onClick={() => setForm(emptyDraft(user?.id ?? ''))}>{t('page.new')}</Button>
      </header>

      {load.kind === 'ready' && entries.length > 0 && (
        <section aria-label={t('summary.open')} className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {(['open', 'critical', 'warning', 'awaitingApproval', 'noticeToSend'] as const).map((k) => (
            <Card key={k} className="p-3 hover:translate-y-0">
              <div className="text-xs text-text-secondary">{t(`summary.${k}`)}</div>
              <div className="text-xl font-semibold text-text-primary">{summary[k]}</div>
            </Card>
          ))}
        </section>
      )}

      {form && (
        <EntryForm
          key={form.id ?? 'new'}
          initial={form}
          owners={owners}
          t={t}
          today={today}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); toast(t('toast.saved'), 'success'); void refresh(); }}
          onError={(e) => toast(t(errorKey(e)), 'error')}
        />
      )}

      {load.kind === 'ready' && entries.length > 0 && (
        <div>
          <Button variant="ghost" size="md" selected={showClosed} onClick={() => setShowClosed((v) => !v)}>{t(showClosed ? 'page.hideClosed' : 'page.showClosed')}</Button>
        </div>
      )}

      {body}
      <p className="text-xs text-text-secondary">{t('page.disclaimer')}</p>
    </main>
  );
}

interface FormProps {
  initial: ChangeDraft;
  owners: StaffOption[];
  t: ReturnType<typeof useChangeCalendarT>['t'];
  today: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (e: unknown) => void;
}

function EntryForm({ initial, owners, t, today, onClose, onSaved, onError }: FormProps) {
  const [d, setD] = useState<ChangeDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const isNew = !d.id;
  const errors: DraftErrors = useMemo(() => validateDraft(d, { today, requireFuture: isNew }), [d, today, isNew]);
  const err = (k: keyof ChangeDraft) => (showErrors && errors[k] ? t(`errors.${errors[k]}`) : undefined);
  const set = <K extends keyof ChangeDraft>(k: K, v: ChangeDraft[K]) => setD((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setShowErrors(true);
    if (hasErrors(errors) || busy) return;
    setBusy(true);
    try {
      await saveEntry(d, { requireFuture: isNew });
      onSaved();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-4 p-5 hover:translate-y-0">
      <h2 className="text-base font-semibold text-text-primary">{t(isNew ? 'form.newTitle' : 'form.editTitle')}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="cc-cat" className="mb-1 block text-xs font-medium text-text-secondary">{t('form.category')}</label>
          <select id="cc-cat" className={SELECT} value={d.category} onChange={(e) => set('category', e.target.value as ChangeDraft['category'])}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="cc-aud" className="mb-1 block text-xs font-medium text-text-secondary">{t('form.audience')}</label>
          <select id="cc-aud" className={SELECT} value={d.audience} onChange={(e) => set('audience', e.target.value as ChangeDraft['audience'])}>
            {AUDIENCES.map((a) => <option key={a} value={a}>{t(`audience.${a}`)}</option>)}
          </select>
        </div>
        <div className="sm:col-span-2"><Input label={t('form.title')} value={d.title} maxLength={140} error={err('title')} onChange={(e) => set('title', e.target.value)} /></div>
        <div className="sm:col-span-2">
          <label htmlFor="cc-sum" className="mb-1 block text-xs font-medium text-text-secondary">{t('form.summary')}</label>
          <textarea id="cc-sum" className={`${SELECT} min-h-[96px] py-2`} value={d.summary} maxLength={2000} onChange={(e) => set('summary', e.target.value)} />
          {err('summary') && <p className="mt-1 text-xs text-danger" role="alert">{err('summary')}</p>}
        </div>
        <div>
          <label htmlFor="cc-owner" className="mb-1 block text-xs font-medium text-text-secondary">{t('form.owner')}</label>
          <select id="cc-owner" className={SELECT} value={d.owner_id} onChange={(e) => set('owner_id', e.target.value)}>
            {!owners.some((o) => o.id === d.owner_id) && <option value={d.owner_id}>{d.owner_id.slice(0, 8)}…</option>}
            {owners.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          {err('owner_id') && <p className="mt-1 text-xs text-danger" role="alert">{err('owner_id')}</p>}
        </div>
        <Input label={t('form.minNotice')} inputMode="numeric" value={d.min_notice_days} helperText={t('form.minNoticeHelp')} error={err('min_notice_days')} onChange={(e) => set('min_notice_days', e.target.value)} />
        <Input label={t('form.noticeDate')} type="date" value={d.notice_date} error={err('notice_date')} onChange={(e) => set('notice_date', e.target.value)} />
        <Input label={t('form.effectiveDate')} type="date" value={d.effective_date} error={err('effective_date')} onChange={(e) => set('effective_date', e.target.value)} />
        <Input label={t('form.referenceUrl')} type="url" dir="ltr" value={d.reference_url} error={err('reference_url')} onChange={(e) => set('reference_url', e.target.value)} />
        <Input label={t('form.noticeLink')} dir="ltr" value={d.price_change_notice_id} helperText={t('form.noticeLinkHelp')} error={err('price_change_notice_id')} onChange={(e) => set('price_change_notice_id', e.target.value)} />
      </div>
      {!isNew && <p className="text-xs text-text-secondary">{t('form.editResets')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="md" loading={busy} onClick={() => void submit()}>{t('form.save')}</Button>
        <Button variant="ghost" size="md" onClick={onClose}>{t('form.cancel')}</Button>
      </div>
    </Card>
  );
}

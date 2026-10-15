import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Banknote, CalendarCheck, Check, Copy, FileText, ListChecks, Lock, Mail, MessageSquare, Pause, Phone, Play,
  Plus, RefreshCw, Search, ShieldAlert, Trash2, X,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { EmptyState, EmptyStateError } from '@/components/EmptyState';
import { SkeletonCardList, FadeIn } from '@/components/Skeleton';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import {
  CHANNELS, ESCALATION_LEVELS, MAX_STEPS, TEMPLATE_TOKENS, addDaysIso, bucketMeta, bucketShares, cancelPromise, completeAction,
  contactHref, createPromise, describeTimelineEntry, describeTiming, ensureDefaultSequence, errMsg, escalationLabel, fetchActions, fetchCases,
  fetchOverview, fetchPromises, fetchSequences, fetchTimeline, hasSequenceErrors, isoToday, logContact, promiseKeptRate, renderTemplate,
  runCollectionsCycle, saveSequence, setEscalation, setHold, sortSteps, urgencyFor, usd, validatePromise, validateSequenceDraft,
  type ActionChannel, type ActionStatus, type Bucket, type CollectionAction, type CollectionCase, type CollectionPromise,
  type CollectionsOverview, type PromiseStatus, type Sequence, type SequenceDraft, type SequenceStep, type StepChannel, type TimelineEntry,
} from '@/lib/collections';

type Tab = 'cases' | 'queue' | 'promises' | 'sequences';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50';
const linkBtn =
  'focus-ring inline-flex items-center justify-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-bg-tertiary';

const URGENCY_TONE = {
  low: 'bg-bg-tertiary text-text-secondary',
  medium: 'bg-warning-500/10 text-warning-500',
  high: 'bg-danger/10 text-danger',
  critical: 'bg-danger text-white',
} as const;

const CHANNEL_ICON: Record<ActionChannel, ReactNode> = {
  email: <Mail size={16} />, sms: <MessageSquare size={16} />, call: <Phone size={16} />,
  letter: <FileText size={16} />, escalate: <ShieldAlert size={16} />, note: <FileText size={16} />,
};
const channelLabel = (c: ActionChannel) => (c === 'note' ? 'Note' : CHANNELS.find((x) => x.channel === c)?.label ?? c);

const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function Pill({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}>{children}</span>;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="!p-4">
      <p className="text-xs font-medium text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Small text-prompt dialog (mark done / skip / cancel promise)
// ---------------------------------------------------------------------------

function TextPromptDialog({
  title, description, label, confirmLabel, presets = [], required = false, onConfirm, onCancel,
}: {
  title: string; description: string; label: string; confirmLabel: string; presets?: string[]; required?: boolean;
  onConfirm: (text: string) => Promise<void>; onCancel: () => void;
}) {
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onCancel);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = !required || text.trim().length >= 3;
  return (
    <>
      <div className="fixed inset-0 z-[130] bg-black/40 backdrop-blur-sm" onClick={onCancel} aria-hidden="true" />
      <div
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="col-prompt-title"
        className="fixed left-1/2 top-1/2 z-[140] w-[92vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-bg-secondary p-6 shadow-card-hover"
      >
        <h2 id="col-prompt-title" className="text-base font-semibold text-text-primary">{title}</h2>
        <p className="mt-1.5 text-sm text-text-secondary">{description}</p>
        {presets.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {presets.map((p) => (
              <button key={p} type="button" onClick={() => setText(p)} className="focus-ring rounded-full border border-border px-3 py-1 text-xs text-text-secondary hover:text-text-primary">{p}</button>
            ))}
          </div>
        )}
        <div className="mt-3">
          <Textarea label={label} rows={3} maxLength={300} autoFocus value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="mt-5 flex gap-3">
          <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={onCancel}>Cancel</Button>
          <Button
            type="button" size="sm" className="flex-1" disabled={!valid || busy}
            onClick={async () => { setBusy(true); try { await onConfirm(text); } finally { setBusy(false); } }}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Case drawer
// ---------------------------------------------------------------------------

function CaseDrawer({ c, ownerId, onClose, onChanged }: { c: CollectionCase; ownerId: string | undefined; onClose: () => void; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const ref = useFocusTrap(true);
  const [cancelling, setCancelling] = useState(false);
  useEscapeToClose(!cancelling, onClose);
  const today = useMemo(() => isoToday(), []);

  const [timeline, setTimeline] = useState<TimelineEntry[] | null>(null);
  const [timelineFailed, setTimelineFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [promise, setPromise] = useState({ amount: (c.balance_cents / 100).toFixed(2), date: addDaysIso(today, 7), notes: '' });
  const [promiseTouched, setPromiseTouched] = useState(false);
  const [holdReason, setHoldReason] = useState('');
  const [escLevel, setEscLevel] = useState(c.escalation_level);
  const [escNote, setEscNote] = useState('');
  const [contact, setContact] = useState<{ channel: ActionChannel; outcome: string }>({ channel: 'call', outcome: '' });

  useEffect(() => { setEscLevel(c.escalation_level); }, [c.escalation_level]);

  const loadTimeline = useCallback(async () => {
    if (!ownerId) return;
    setTimelineFailed(false);
    try { setTimeline(await fetchTimeline(ownerId, c.invoice_id)); } catch { setTimelineFailed(true); }
  }, [ownerId, c.invoice_id]);
  useEffect(() => { void loadTimeline(); }, [loadTimeline]);

  const act = async (key: string, fn: () => Promise<void>, ok: string) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); toast(ok, 'success'); await onChanged(); await loadTimeline(); }
    catch (e) { toast(errMsg(e), 'error'); }
    finally { setBusy(null); }
  };

  const pv = validatePromise(promise, c.balance_cents, today);
  const submitPromise = () => {
    setPromiseTouched(true);
    if (pv.amountCents === null || pv.errors.date) return;
    const cents = pv.amountCents;
    void act('promise', async () => { await createPromise(c.invoice_id, cents, promise.date, promise.notes); setPromiseTouched(false); }, 'Promise to pay recorded.');
  };

  const emailHref = contactHref('email', { email: c.customer_email, phone: null, subject: `Invoice ${c.invoice_number}`, body: '' });
  const callHref = contactHref('call', { email: null, phone: c.customer_phone, subject: null, body: null });

  return (
    <>
      <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <aside
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="col-case-title"
        className="fixed inset-x-0 bottom-0 z-[120] max-h-[92vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[460px] sm:rounded-none sm:rounded-l-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="col-case-title" className="truncate text-lg font-semibold text-text-primary">{c.customer_name}</h2>
            <p className="text-sm text-text-secondary">Invoice {c.invoice_number} · due {fmtDate(c.due_date)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"><X size={18} /></button>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-bg-tertiary p-3"><p className="text-xs text-text-secondary">Open balance</p><p className="text-lg font-semibold text-text-primary">{usd(c.balance_cents)}</p></div>
          <div className="rounded-xl bg-bg-tertiary p-3"><p className="text-xs text-text-secondary">Days overdue</p><p className="text-lg font-semibold text-text-primary">{c.days_overdue}</p></div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {emailHref ? <a className={linkBtn} href={emailHref}><Mail size={14} /> Email</a> : <span className="text-xs text-text-secondary">No email on file</span>}
          {callHref ? <a className={linkBtn} href={callHref}><Phone size={14} /> Call</a> : <span className="text-xs text-text-secondary">No phone on file</span>}
        </div>

        {/* Promise to pay */}
        <section className="mt-6 border-t border-border pt-5">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Promise to pay</h3>
          {c.promise_id && c.promise_amount_cents && c.promise_date && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border p-3 text-sm">
              <span className="text-text-primary">{usd(c.promise_amount_cents)} by {fmtDate(c.promise_date)}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => setCancelling(true)}><Trash2 size={14} /> Cancel</Button>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Amount (USD)" inputMode="decimal" value={promise.amount} onChange={(e) => setPromise((p) => ({ ...p, amount: e.target.value }))} error={promiseTouched ? pv.errors.amount : undefined} />
            <Input label="Promised date" type="date" min={today} value={promise.date} onChange={(e) => setPromise((p) => ({ ...p, date: e.target.value }))} error={promiseTouched ? pv.errors.date : undefined} />
          </div>
          <div className="mt-3"><Input label="Notes (optional)" maxLength={300} value={promise.notes} onChange={(e) => setPromise((p) => ({ ...p, notes: e.target.value }))} /></div>
          <Button type="button" size="sm" className="mt-3 w-full" disabled={busy === 'promise'} onClick={submitPromise}>
            <CalendarCheck size={14} /> {c.promise_id ? 'Replace promise' : 'Record promise'}
          </Button>
          {c.broken_promises > 0 && <p className="mt-2 text-xs text-warning-500">{c.broken_promises} earlier promise{c.broken_promises === 1 ? '' : 's'} broken on this invoice.</p>}
        </section>

        {/* Hold */}
        <section className="mt-6 border-t border-border pt-5">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Dunning</h3>
          {c.on_hold ? (
            <div className="rounded-xl border border-border p-3">
              <p className="text-sm text-text-primary">Paused: {c.hold_reason}</p>
              <Button type="button" variant="secondary" size="sm" className="mt-3 w-full" disabled={busy === 'hold'} onClick={() => void act('hold', () => setHold(c.invoice_id, false), 'Collections resumed.')}>
                <Play size={14} /> Resume collections
              </Button>
            </div>
          ) : (
            <>
              <Input aria-label="Reason for pausing" placeholder="Reason, e.g. billing dispute" maxLength={200} value={holdReason} onChange={(e) => setHoldReason(e.target.value)} />
              <Button type="button" variant="secondary" size="sm" className="mt-3 w-full" disabled={busy === 'hold' || holdReason.trim().length < 3} onClick={() => void act('hold', async () => { await setHold(c.invoice_id, true, holdReason); setHoldReason(''); }, 'Collections paused.')}>
                <Pause size={14} /> Pause reminders
              </Button>
            </>
          )}
        </section>

        {/* Escalation */}
        <section className="mt-6 border-t border-border pt-5">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Escalation</h3>
          <select aria-label="Escalation level" className={selectClass} value={escLevel} onChange={(e) => setEscLevel(Number(e.target.value))}>
            {ESCALATION_LEVELS.map((l) => <option key={l.level} value={l.level}>{l.label}</option>)}
          </select>
          <div className="mt-3"><Input aria-label="Escalation note" placeholder="Note (optional)" maxLength={200} value={escNote} onChange={(e) => setEscNote(e.target.value)} /></div>
          <Button type="button" variant="secondary" size="sm" className="mt-3 w-full" disabled={busy === 'esc' || escLevel === c.escalation_level} onClick={() => void act('esc', async () => { await setEscalation(c.invoice_id, escLevel, escNote); setEscNote(''); }, 'Escalation updated.')}>
            <ShieldAlert size={14} /> Update level
          </Button>
        </section>

        {/* Log contact */}
        <section className="mt-6 border-t border-border pt-5">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">Log a contact</h3>
          <select aria-label="Contact channel" className={selectClass} value={contact.channel} onChange={(e) => setContact((x) => ({ ...x, channel: e.target.value as ActionChannel }))}>
            {CHANNELS.filter((x) => x.channel !== 'escalate').map((x) => <option key={x.channel} value={x.channel}>{x.label}</option>)}
            <option value="note">Note</option>
          </select>
          <div className="mt-3"><Textarea aria-label="What happened" rows={2} maxLength={300} placeholder="What happened? e.g. Spoke with the customer, will pay Friday." value={contact.outcome} onChange={(e) => setContact((x) => ({ ...x, outcome: e.target.value }))} /></div>
          <Button type="button" variant="secondary" size="sm" className="mt-3 w-full" disabled={busy === 'contact' || contact.outcome.trim().length < 3} onClick={() => void act('contact', async () => { await logContact(c.invoice_id, contact.channel, contact.outcome); setContact((x) => ({ ...x, outcome: '' })); }, 'Contact logged.')}>
            <Check size={14} /> Save contact
          </Button>
        </section>

        {/* Timeline */}
        <section className="mt-6 border-t border-border pt-5">
          <h3 className="mb-3 text-sm font-semibold text-text-primary">History</h3>
          {timelineFailed ? (
            <p className="text-sm text-text-secondary">Couldn't load history. <button type="button" className="text-accent underline" onClick={() => void loadTimeline()}>Retry</button></p>
          ) : timeline === null ? (
            <p className="text-sm text-text-secondary">Loading…</p>
          ) : timeline.length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing recorded yet for this invoice.</p>
          ) : (
            <ul className="space-y-3">
              {timeline.map((t) => (
                <li key={t.id} className="flex gap-3 text-sm">
                  <span className="mt-0.5 text-text-secondary">{CHANNEL_ICON[t.channel]}</span>
                  <div className="min-w-0">
                    <p className="text-text-primary">{describeTimelineEntry(t)}</p>
                    <p className="text-xs text-text-secondary">{channelLabel(t.channel)} · {t.status === 'pending' ? 'Pending' : t.status === 'skipped' ? 'Skipped' : fmtDateTime(t.completed_at ?? t.created_at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {cancelling && c.promise_id && (
          <TextPromptDialog
            title="Cancel this promise?" description="The promise is closed without counting as kept or broken." label="Reason (optional)" confirmLabel="Cancel promise"
            onCancel={() => setCancelling(false)}
            onConfirm={async (reason) => { const id = c.promise_id as string; setCancelling(false); await act('cancel', () => cancelPromise(id, reason), 'Promise cancelled.'); }}
          />
        )}
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sequence editor
// ---------------------------------------------------------------------------

type EditStep = SequenceStep & { _k: number };

function SequenceEditor({ initial, onClose, onSaved }: { initial: SequenceDraft; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const ref = useFocusTrap(true);
  useEscapeToClose(true, onClose);
  const keyRef = useRef(initial.steps.length);
  const [name, setName] = useState(initial.name);
  const [isDefault, setIsDefault] = useState(initial.is_default);
  const [isActive, setIsActive] = useState(initial.is_active);
  const [steps, setSteps] = useState<EditStep[]>(() => initial.steps.map((s, i) => ({ ...s, _k: i })));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  const draft: SequenceDraft = useMemo(
    () => ({ id: initial.id, name, is_default: isDefault, is_active: isActive, steps }),
    [initial.id, name, isDefault, isActive, steps],
  );
  const errors = useMemo(() => validateSequenceDraft(draft), [draft]);
  const today = useMemo(() => isoToday(), []);

  const patch = (k: number, p: Partial<SequenceStep>) => setSteps((all) => all.map((s) => (s._k === k ? { ...s, ...p } : s)));
  const addStep = () => {
    const last = steps.length ? Math.max(...steps.map((s) => s.days_after_due)) : 0;
    keyRef.current += 1;
    setSteps((all) => [...all, { _k: keyRef.current, days_after_due: Math.min(last + 7, 365), channel: 'email', subject: '', template: '', escalation_level: null }]);
  };

  const submit = async () => {
    setTouched(true);
    if (hasSequenceErrors(errors) || saving) return;
    setSaving(true);
    setServerError('');
    try {
      await saveSequence({ ...draft, steps: sortSteps(steps) });
      toast('Sequence saved.', 'success');
      onSaved();
    } catch (e) {
      setServerError(errMsg(e));
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[110] bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="col-seq-title"
        className="fixed inset-x-0 bottom-0 z-[120] max-h-[94vh] overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 shadow-card-hover sm:inset-x-auto sm:left-1/2 sm:top-1/2 sm:bottom-auto sm:w-[94vw] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="col-seq-title" className="text-lg font-semibold text-text-primary">{initial.id ? 'Edit sequence' : 'New sequence'}</h2>
            <p className="mt-0.5 text-sm text-text-secondary">Steps become tasks in the queue when they come due, in order of timing (relative to the invoice due date).</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-lg p-1 text-text-secondary hover:text-text-primary"><X size={18} /></button>
        </div>

        <div className="mt-5 space-y-4">
          <Input label="Name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} error={touched ? errors.name : undefined} />
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4" checked={isDefault} disabled={initial.is_default} onChange={(e) => setIsDefault(e.target.checked)} />
              <span className="text-text-primary">Default for all invoices{initial.is_default ? ' (make another sequence the default to change)' : ''}</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4" checked={isActive} disabled={isDefault} onChange={(e) => setIsActive(e.target.checked)} />
              <span className="text-text-primary">Active</span>
            </label>
          </div>

          <div className="space-y-3">
            {steps.map((s, idx) => {
              const err = touched ? errors.stepErrors[idx] : undefined;
              const dueDate = addDaysIso(today, -s.days_after_due);
              return (
                <Card key={s._k} className="!p-4">
                  <div className="grid gap-3 sm:grid-cols-[7rem_1fr_auto]">
                    <Input label="Days from due" type="number" min={-30} max={365} value={Number.isFinite(s.days_after_due) ? String(s.days_after_due) : ''} onChange={(e) => patch(s._k, { days_after_due: e.target.value === '' ? NaN : Number(e.target.value) })} />
                    <div>
                      <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor={`col-ch-${s._k}`}>Action</label>
                      <select
                        id={`col-ch-${s._k}`} className={selectClass} value={s.channel}
                        onChange={(e) => { const ch = e.target.value as StepChannel; patch(s._k, { channel: ch, escalation_level: ch === 'escalate' ? 1 : null }); }}
                      >
                        {CHANNELS.map((c) => <option key={c.channel} value={c.channel}>{c.label}</option>)}
                      </select>
                    </div>
                    <div className="flex items-end">
                      <Button type="button" variant="ghost" size="sm" aria-label="Remove step" disabled={steps.length <= 1} onClick={() => setSteps((all) => all.filter((x) => x._k !== s._k))}><Trash2 size={14} /></Button>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">{Number.isFinite(s.days_after_due) ? describeTiming(s.days_after_due) : 'Enter a number of days'}</p>

                  {s.channel === 'escalate' && (
                    <div className="mt-3">
                      <label className="mb-1.5 block text-sm font-medium text-text-primary" htmlFor={`col-lv-${s._k}`}>Escalate to</label>
                      <select id={`col-lv-${s._k}`} className={selectClass} value={s.escalation_level ?? 1} onChange={(e) => patch(s._k, { escalation_level: Number(e.target.value) })}>
                        {ESCALATION_LEVELS.filter((l) => l.level > 0).map((l) => <option key={l.level} value={l.level}>{l.label}</option>)}
                      </select>
                    </div>
                  )}
                  {s.channel !== 'sms' && (
                    <div className="mt-3"><Input label={s.channel === 'email' ? 'Subject' : 'Title'} maxLength={120} value={s.subject ?? ''} onChange={(e) => patch(s._k, { subject: e.target.value })} /></div>
                  )}
                  <div className="mt-3">
                    <Textarea label={s.channel === 'call' || s.channel === 'escalate' ? 'Instructions for staff' : 'Message'} rows={3} maxLength={1000} value={s.template} onChange={(e) => patch(s._k, { template: e.target.value })} />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {TEMPLATE_TOKENS.map((t) => (
                      <button key={t} type="button" onClick={() => patch(s._k, { template: `${s.template}{{${t}}}` })} className="focus-ring rounded-full border border-border px-2 py-0.5 text-[11px] text-text-secondary hover:text-text-primary">{`{{${t}}}`}</button>
                    ))}
                  </div>
                  {s.template.trim() && Number.isFinite(s.days_after_due) && (
                    <p className="mt-3 rounded-xl bg-bg-tertiary p-3 text-xs text-text-secondary">
                      <span className="font-medium text-text-primary">Preview: </span>
                      {renderTemplate(s.template, { customer_name: 'Dana Smith', invoice_number: 'INV-1042', balance_cents: 125000, due_date: dueDate, days_overdue: s.days_after_due, company_name: 'Your company' })}
                    </p>
                  )}
                  {err && <p role="alert" className="mt-2 text-xs text-danger">{err}</p>}
                </Card>
              );
            })}
          </div>

          {touched && errors.steps && <p role="alert" className="text-xs text-danger">{errors.steps}</p>}
          <Button type="button" variant="secondary" size="sm" disabled={steps.length >= MAX_STEPS} onClick={addStep}><Plus size={14} /> Add step</Button>

          {serverError && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-text-primary">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" /><span>{serverError}</span>
            </div>
          )}
        </div>

        <div className="mt-6 flex gap-3">
          <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button type="button" size="sm" className="flex-1" disabled={saving} onClick={() => void submit()}>{saving ? 'Saving…' : 'Save sequence'}</Button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CollectionsPage() {
  const { user, profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const canAccess = isOwner || permissions.can_view_billing;
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;

  const [tab, setTab] = useState<Tab>('cases');
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [overview, setOverview] = useState<CollectionsOverview | null>(null);
  const [sequences, setSequences] = useState<Sequence[]>([]);

  const [bucket, setBucket] = useState<Bucket | null>(null);
  const [cases, setCases] = useState<CollectionCase[]>([]);
  const [totalCases, setTotalCases] = useState(0);
  const [casesLoading, setCasesLoading] = useState(false);
  const [casesFailed, setCasesFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CollectionCase | null>(null);

  const [queueView, setQueueView] = useState<ActionStatus>('pending');
  const [queue, setQueue] = useState<CollectionAction[] | null>(null);
  const [queueFailed, setQueueFailed] = useState(false);
  const [prompt, setPrompt] = useState<{ action: CollectionAction; mode: 'done' | 'skipped' } | null>(null);

  const [promiseView, setPromiseView] = useState<PromiseStatus | 'all'>('open');
  const [promises, setPromises] = useState<CollectionPromise[] | null>(null);
  const [promisesFailed, setPromisesFailed] = useState(false);

  const [editor, setEditor] = useState<SequenceDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [bootstrapped, setBootstrapped] = useState(false);
  const casesRef = useRef<CollectionCase[]>([]);
  const caseReq = useRef(0);
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const loadOverview = useCallback(async () => { setOverview(await fetchOverview()); }, []);

  const loadCases = useCallback(async (reset: boolean) => {
    const req = ++caseReq.current;
    setCasesLoading(true);
    setCasesFailed(false);
    try {
      const rows = await fetchCases(bucket, reset ? 0 : casesRef.current.length);
      if (req !== caseReq.current) return;
      const merged = reset ? rows : [...casesRef.current, ...rows.filter((r) => !casesRef.current.some((x) => x.invoice_id === r.invoice_id))];
      casesRef.current = merged;
      setCases(merged);
      setTotalCases(rows[0]?.total_count ?? (reset ? 0 : merged.length));
      setSelected((cur) => (cur ? merged.find((m) => m.invoice_id === cur.invoice_id) ?? cur : cur));
    } catch {
      if (req === caseReq.current) setCasesFailed(true);
    } finally {
      if (req === caseReq.current) setCasesLoading(false);
    }
  }, [bucket]);

  const loadQueue = useCallback(async () => {
    setQueueFailed(false);
    try { setQueue(await fetchActions(queueView)); } catch { setQueueFailed(true); }
  }, [queueView]);

  const loadPromises = useCallback(async () => {
    setPromisesFailed(false);
    try { setPromises(await fetchPromises(promiseView === 'all' ? null : promiseView)); } catch { setPromisesFailed(true); }
  }, [promiseView]);

  const loadSequences = useCallback(async () => { setSequences(await fetchSequences()); }, []);

  const init = useCallback(async () => {
    if (!user || !canAccess) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      try { await runCollectionsCycle(); } catch (e) { toastRef.current(`Couldn't refresh dunning tasks: ${errMsg(e)}`, 'error'); }
      await Promise.all([loadOverview(), loadSequences()]);
      setBootstrapped(true);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [user, canAccess, loadOverview, loadSequences]);

  useEffect(() => { void init(); }, [init]);
  useEffect(() => { if (bootstrapped) void loadCases(true); }, [bootstrapped, loadCases]);
  useEffect(() => { if (bootstrapped && tab === 'queue') void loadQueue(); }, [bootstrapped, tab, loadQueue]);
  useEffect(() => { if (bootstrapped && tab === 'promises') void loadPromises(); }, [bootstrapped, tab, loadPromises]);

  const reloadAfterChange = useCallback(async () => {
    await Promise.all([
      loadOverview(), loadCases(true),
      queue !== null ? loadQueue() : Promise.resolve(),
      promises !== null ? loadPromises() : Promise.resolve(),
    ]).catch(() => undefined);
  }, [loadOverview, loadCases, loadQueue, loadPromises, queue, promises]);

  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    if (busy) return;
    setBusy(key);
    try { await fn(); toast(ok, 'success'); }
    catch (e) { toast(errMsg(e), 'error'); }
    finally { setBusy(null); }
  };

  const refresh = () => run('refresh', async () => {
    await runCollectionsCycle();
    await Promise.all([loadOverview(), loadCases(true), loadSequences(), queue !== null ? loadQueue() : Promise.resolve(), promises !== null ? loadPromises() : Promise.resolve()]);
  }, 'Up to date.');

  const createStandard = () => run('seed', async () => {
    await ensureDefaultSequence();
    await runCollectionsCycle();
    await Promise.all([loadSequences(), loadOverview(), loadCases(true), queue !== null ? loadQueue() : Promise.resolve()]);
  }, 'Standard dunning sequence created.');

  const filteredCases = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? cases.filter((c) => c.customer_name.toLowerCase().includes(q) || c.invoice_number.toLowerCase().includes(q)) : cases;
  }, [cases, query]);

  const shares = useMemo(() => (overview ? bucketShares(overview.buckets) : []), [overview]);
  const keptRate = overview ? promiseKeptRate(overview.promises.kept_90d, overview.promises.broken_90d) : null;

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Collections">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm text-text-secondary">Ask your account owner for the "View Billing" permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  const TABS: { id: Tab; label: string; badge?: number }[] = [
    { id: 'cases', label: 'Cases' },
    { id: 'queue', label: 'Action queue', badge: overview?.totals.pending_actions },
    { id: 'promises', label: 'Promises', badge: overview?.promises.open },
    { id: 'sequences', label: 'Sequences' },
  ];

  return (
    <DashboardLayout activeLabel="Collections">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Banknote size={22} /></span>
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">Collections</h1>
            <p className="text-sm text-text-secondary">Age your receivables, work the dunning queue, track promises to pay and escalate what's stuck.</p>
          </div>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading || busy === 'refresh'}>
          <RefreshCw size={14} className={busy === 'refresh' ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      {loading ? (
        <SkeletonCardList count={3} rows={3} />
      ) : loadFailed || !overview ? (
        <EmptyStateError icon={AlertTriangle} title="Couldn't load collections" description="Check your connection and try again." onRetry={() => void init()} />
      ) : (
        <FadeIn>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Overdue" value={usd(overview.totals.overdue_balance_cents)} sub={`${overview.totals.overdue_invoices} invoice${overview.totals.overdue_invoices === 1 ? '' : 's'}`} />
            <Stat label="Open receivables" value={usd(overview.totals.open_balance_cents)} sub={`${overview.totals.open_invoices} open`} />
            <Stat label="Collected (30 days)" value={usd(overview.totals.collected_30d_cents)} />
            <Stat label="Promises kept (90 days)" value={keptRate === null ? '—' : `${Math.round(keptRate * 100)}%`} sub={`${overview.promises.kept_90d} kept · ${overview.promises.broken_90d} broken`} />
          </div>

          {/* Aging */}
          <Card className="mb-6 !p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-text-primary">AR aging</h2>
              {bucket && <button type="button" onClick={() => setBucket(null)} className="focus-ring rounded-full border border-border px-3 py-1 text-xs text-text-secondary hover:text-text-primary">Showing {bucketMeta(bucket).label} · Clear</button>}
            </div>
            {overview.totals.open_invoices === 0 ? (
              <p className="text-sm text-text-secondary">Nothing is owed right now.</p>
            ) : (
              <>
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-bg-tertiary" role="img" aria-label="Receivables by age">
                  {shares.map((s) => s.pct > 0 && <div key={s.bucket} className={bucketMeta(s.bucket).tone} style={{ width: `${s.pct}%` }} />)}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {overview.buckets.map((b) => (
                    <button
                      key={b.bucket} type="button" aria-pressed={bucket === b.bucket} onClick={() => setBucket(bucket === b.bucket ? null : b.bucket)}
                      className={`focus-ring rounded-xl border p-3 text-left transition-colors ${bucket === b.bucket ? 'border-accent bg-accent/5' : 'border-border hover:bg-bg-tertiary'}`}
                    >
                      <span className="flex items-center gap-2 text-xs text-text-secondary"><span className={`h-2 w-2 rounded-full ${bucketMeta(b.bucket).tone}`} />{bucketMeta(b.bucket).label}</span>
                      <span className="mt-1 block text-sm font-semibold text-text-primary">{usd(b.balance_cents)}</span>
                      <span className="block text-xs text-text-secondary">{b.count} invoice{b.count === 1 ? '' : 's'}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {(overview.totals.on_hold > 0 || overview.totals.escalated > 0) && (
              <p className="mt-3 text-xs text-text-secondary">{overview.totals.on_hold} on hold · {overview.totals.escalated} escalated</p>
            )}
          </Card>

          <div role="tablist" aria-label="Collections sections" className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-border bg-bg-secondary p-1">
            {TABS.map((t) => (
              <button
                key={t.id} type="button" role="tab" aria-selected={tab === t.id} id={`col-tab-${t.id}`} aria-controls={`col-panel-${t.id}`} onClick={() => setTab(t.id)}
                className={`focus-ring shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'}`}
              >
                {t.label}
                {!!t.badge && <span className={`ml-1.5 rounded-full px-1.5 text-[11px] font-semibold ${tab === t.id ? 'bg-white/20' : 'bg-warning-500/20 text-warning-500'}`}>{t.badge}</span>}
              </button>
            ))}
          </div>

          {/* ------------------------------- CASES ------------------------------- */}
          {tab === 'cases' && (
            <section role="tabpanel" id="col-panel-cases" aria-labelledby="col-tab-cases">
              {sequences.length === 0 && overview.totals.open_invoices > 0 && (
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning-500/30 bg-warning-500/5 p-4 text-sm">
                  <span className="text-text-primary">No dunning sequence yet, so no reminder tasks are being created.</span>
                  <Button type="button" size="sm" disabled={busy === 'seed'} onClick={() => void createStandard()}>Create standard sequence</Button>
                </div>
              )}
              <div className="mb-4 lg:w-80"><Input icon={Search} aria-label="Search cases" placeholder="Search customer or invoice" value={query} onChange={(e) => setQuery(e.target.value)} /></div>

              {casesLoading && cases.length === 0 ? (
                <SkeletonCardList count={4} rows={2} />
              ) : casesFailed && cases.length === 0 ? (
                <EmptyStateError icon={AlertTriangle} title="Couldn't load cases" onRetry={() => void loadCases(true)} />
              ) : cases.length === 0 ? (
                <EmptyState icon={Banknote} title={bucket ? 'No invoices in this age range' : 'Nothing to collect'} description={bucket ? 'Try another range.' : 'Open invoices will appear here as soon as they exist.'} action={bucket ? { label: 'Show all', onClick: () => setBucket(null) } : undefined} />
              ) : filteredCases.length === 0 ? (
                <EmptyState icon={Search} title="No matching cases" description="Try a different search." action={{ label: 'Clear search', onClick: () => setQuery('') }} />
              ) : (
                <>
                  <div className="hidden overflow-x-auto rounded-2xl border border-border md:block">
                    <table className="w-full text-sm">
                      <thead className="bg-bg-tertiary text-left text-xs uppercase tracking-wide text-text-secondary">
                        <tr>
                          <th scope="col" className="px-4 py-3">Customer</th>
                          <th scope="col" className="px-4 py-3 text-right">Balance</th>
                          <th scope="col" className="px-4 py-3">Age</th>
                          <th scope="col" className="px-4 py-3">Status</th>
                          <th scope="col" className="px-4 py-3">Last contact</th>
                          <th scope="col" className="px-4 py-3 text-right"><span className="sr-only">Open</span></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border bg-bg-secondary">
                        {filteredCases.map((c) => (
                          <tr key={c.invoice_id}>
                            <td className="px-4 py-3"><p className="font-medium text-text-primary">{c.customer_name}</p><p className="text-xs text-text-secondary">{c.invoice_number} · due {fmtDate(c.due_date)}</p></td>
                            <td className="px-4 py-3 text-right tabular-nums font-medium text-text-primary">{usd(c.balance_cents)}</td>
                            <td className="px-4 py-3"><Pill className={URGENCY_TONE[urgencyFor(c.days_overdue, c.escalation_level)]}>{c.days_overdue > 0 ? `${c.days_overdue}d overdue` : 'Current'}</Pill></td>
                            <td className="px-4 py-3"><div className="flex flex-wrap gap-1"><CaseStatus c={c} /></div></td>
                            <td className="px-4 py-3 text-xs text-text-secondary">{c.last_contact_at ? fmtDateTime(c.last_contact_at) : 'Never'}</td>
                            <td className="px-4 py-3 text-right"><Button type="button" variant="secondary" size="sm" onClick={() => setSelected(c)}>Open</Button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <ul className="space-y-3 md:hidden">
                    {filteredCases.map((c) => (
                      <li key={c.invoice_id}>
                        <Card className="!p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0"><p className="truncate font-medium text-text-primary">{c.customer_name}</p><p className="text-xs text-text-secondary">{c.invoice_number} · due {fmtDate(c.due_date)}</p></div>
                            <p className="shrink-0 text-sm font-semibold tabular-nums text-text-primary">{usd(c.balance_cents)}</p>
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            <Pill className={URGENCY_TONE[urgencyFor(c.days_overdue, c.escalation_level)]}>{c.days_overdue > 0 ? `${c.days_overdue}d overdue` : 'Current'}</Pill>
                            <CaseStatus c={c} />
                          </div>
                          <p className="mt-2 text-xs text-text-secondary">Last contact: {c.last_contact_at ? fmtDateTime(c.last_contact_at) : 'never'}</p>
                          <Button type="button" variant="secondary" size="sm" className="mt-3 w-full" onClick={() => setSelected(c)}>Open case</Button>
                        </Card>
                      </li>
                    ))}
                  </ul>

                  {cases.length < totalCases && !query && (
                    <div className="mt-4 text-center">
                      <Button type="button" variant="secondary" size="sm" disabled={casesLoading} onClick={() => void loadCases(false)}>{casesLoading ? 'Loading…' : `Load more (${totalCases - cases.length} left)`}</Button>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {/* ------------------------------- QUEUE ------------------------------- */}
          {tab === 'queue' && (
            <section role="tabpanel" id="col-panel-queue" aria-labelledby="col-tab-queue">
              <div className="mb-4 flex gap-2">
                {(['pending', 'done', 'skipped'] as ActionStatus[]).map((s) => (
                  <button key={s} type="button" aria-pressed={queueView === s} onClick={() => { setQueue(null); setQueueView(s); }}
                    className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium ${queueView === s ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>
                    {s === 'pending' ? 'To do' : s === 'done' ? 'Done' : 'Skipped'}
                  </button>
                ))}
              </div>
              {queueFailed ? (
                <EmptyStateError icon={AlertTriangle} title="Couldn't load the queue" onRetry={() => void loadQueue()} />
              ) : queue === null ? (
                <SkeletonCardList count={3} rows={3} />
              ) : queue.length === 0 ? (
                <EmptyState icon={ListChecks} title={queueView === 'pending' ? 'All caught up' : 'Nothing here yet'} description={queueView === 'pending' ? 'New reminder tasks appear as invoices reach each step of your sequence.' : 'Completed work shows up here.'} />
              ) : (
                <ul className="space-y-3">
                  {queue.map((a) => {
                    const href = contactHref(a.channel, { email: a.customer_email, phone: a.customer_phone, subject: a.subject, body: a.body });
                    const missing = a.channel === 'email' || a.channel === 'letter' ? 'No email on file' : a.channel === 'sms' || a.channel === 'call' ? 'No phone on file' : '';
                    return (
                      <li key={a.id}>
                        <Card className="!p-4">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                              <span className="text-accent">{CHANNEL_ICON[a.channel]}</span>{channelLabel(a.channel)}{a.escalation_level ? ` · ${escalationLabel(a.escalation_level)}` : ''}
                            </div>
                            <Pill className={URGENCY_TONE[urgencyFor(a.days_overdue)]}>{a.days_overdue}d overdue</Pill>
                          </div>
                          <p className="mt-1 text-sm text-text-primary">{a.customer_name} · {a.invoice_number} · {usd(a.balance_cents)}</p>
                          {a.subject && <p className="mt-2 text-sm font-medium text-text-primary">{a.subject}</p>}
                          {a.body && <p className="mt-1 whitespace-pre-wrap rounded-xl bg-bg-tertiary p-3 text-sm text-text-secondary">{a.body}</p>}
                          {a.status !== 'pending' && (
                            <p className="mt-2 text-xs text-text-secondary">{a.status === 'done' ? 'Done' : 'Skipped'}{a.completed_at ? ` · ${fmtDateTime(a.completed_at)}` : ''}{a.outcome ? ` — ${a.outcome}` : ''}</p>
                          )}
                          {a.status === 'pending' && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {href ? <a className={linkBtn} href={href}>{CHANNEL_ICON[a.channel]} {a.channel === 'call' ? 'Call' : a.channel === 'sms' ? 'Text' : 'Open email'}</a>
                                : missing && <span className="self-center text-xs text-text-secondary">{missing}</span>}
                              {a.body && (
                                <Button type="button" variant="ghost" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(a.body ?? ''); toast('Message copied.', 'success'); } catch { toast("Couldn't copy. Select the text manually.", 'error'); } }}>
                                  <Copy size={14} /> Copy
                                </Button>
                              )}
                              <Button type="button" size="sm" onClick={() => setPrompt({ action: a, mode: 'done' })}><Check size={14} /> {a.channel === 'escalate' ? 'Confirm escalation' : 'Mark done'}</Button>
                              <Button type="button" variant="ghost" size="sm" onClick={() => setPrompt({ action: a, mode: 'skipped' })}>Skip</Button>
                            </div>
                          )}
                        </Card>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {/* ------------------------------ PROMISES ------------------------------ */}
          {tab === 'promises' && (
            <section role="tabpanel" id="col-panel-promises" aria-labelledby="col-tab-promises">
              <div className="mb-4 flex flex-wrap gap-2">
                {(['open', 'kept', 'broken', 'cancelled', 'all'] as const).map((s) => (
                  <button key={s} type="button" aria-pressed={promiseView === s} onClick={() => { setPromises(null); setPromiseView(s); }}
                    className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium capitalize ${promiseView === s ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}>{s}</button>
                ))}
              </div>
              {promisesFailed ? (
                <EmptyStateError icon={AlertTriangle} title="Couldn't load promises" onRetry={() => void loadPromises()} />
              ) : promises === null ? (
                <SkeletonCardList count={3} rows={2} />
              ) : promises.length === 0 ? (
                <EmptyState icon={CalendarCheck} title="No promises here" description="Record a promise to pay from any case. It's marked kept when the payment arrives, or broken when the date passes." />
              ) : (
                <ul className="space-y-3">
                  {promises.map((p) => (
                    <li key={p.id}>
                      <Card className="!p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div><p className="font-medium text-text-primary">{p.customer_name}</p><p className="text-xs text-text-secondary">{p.invoice_number} · balance now {usd(p.balance_cents)}</p></div>
                          <Pill className={`capitalize ${p.status === 'kept' ? 'bg-success/10 text-success' : p.status === 'broken' ? 'bg-danger/10 text-danger' : p.status === 'open' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-secondary'}`}>{p.status}</Pill>
                        </div>
                        <p className="mt-2 text-sm text-text-primary">{usd(p.promised_amount_cents)} by {fmtDate(p.promised_date)}</p>
                        {p.notes && <p className="mt-1 text-xs text-text-secondary">{p.notes}</p>}
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ------------------------------ SEQUENCES ------------------------------ */}
          {tab === 'sequences' && (
            <section role="tabpanel" id="col-panel-sequences" aria-labelledby="col-tab-sequences">
              {sequences.length === 0 ? (
                <EmptyState
                  icon={ListChecks} title="No dunning sequence yet"
                  description="Start from the standard home-service sequence (reminder, text, call, firm notice, then escalation) and adjust it, or build your own."
                  action={{ label: busy === 'seed' ? 'Creating…' : 'Create standard sequence', onClick: () => void createStandard() }}
                  secondaryAction={{ label: 'Build my own', onClick: () => setEditor({ id: null, name: '', is_default: true, is_active: true, steps: [{ days_after_due: 1, channel: 'email', subject: '', template: '', escalation_level: null }] }) }}
                />
              ) : (
                <>
                  <div className="mb-4 flex justify-end">
                    <Button type="button" size="sm" onClick={() => setEditor({ id: null, name: '', is_default: false, is_active: true, steps: [{ days_after_due: 1, channel: 'email', subject: '', template: '', escalation_level: null }] })}><Plus size={14} /> New sequence</Button>
                  </div>
                  <ul className="space-y-3">
                    {sequences.map((s) => (
                      <li key={s.id}>
                        <Card className={`!p-4 ${s.is_active ? '' : 'opacity-60'}`}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <h3 className="font-medium text-text-primary">{s.name}</h3>
                              {s.is_default && <Pill className="bg-accent/10 text-accent">Default</Pill>}
                              {!s.is_active && <Pill className="bg-bg-tertiary text-text-secondary">Inactive</Pill>}
                            </div>
                            <Button type="button" variant="secondary" size="sm" onClick={() => setEditor({ id: s.id, name: s.name, is_default: s.is_default, is_active: s.is_active, steps: s.steps })}>Edit</Button>
                          </div>
                          <ol className="mt-3 space-y-1.5 text-sm">
                            {s.steps.map((st) => (
                              <li key={st.id} className="flex items-center gap-2 text-text-secondary">
                                <span className="text-accent">{CHANNEL_ICON[st.channel]}</span>
                                <span className="text-text-primary">{channelLabel(st.channel)}{st.escalation_level ? ` · L${st.escalation_level}` : ''}</span>
                                <span>— {describeTiming(st.days_after_due)}</span>
                              </li>
                            ))}
                          </ol>
                        </Card>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
          )}
        </FadeIn>
      )}

      {selected && <CaseDrawer c={selected} ownerId={ownerId} onClose={() => setSelected(null)} onChanged={reloadAfterChange} />}

      {editor && (
        <SequenceEditor
          initial={editor}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); void loadSequences(); void runCollectionsCycle().then(reloadAfterChange).catch(() => undefined); }}
        />
      )}

      {prompt && (
        <TextPromptDialog
          title={prompt.mode === 'done' ? (prompt.action.channel === 'escalate' ? 'Confirm escalation' : 'Mark as done') : 'Skip this task'}
          description={prompt.mode === 'done' ? 'Add a short outcome so the next person knows what happened.' : 'Skipped tasks stay in the history.'}
          label="Outcome (optional)" confirmLabel={prompt.mode === 'done' ? 'Save' : 'Skip task'}
          presets={prompt.mode === 'done' ? (prompt.action.channel === 'call' ? ['Spoke with customer', 'Left voicemail', 'No answer'] : ['Sent']) : ['Customer already paid', 'Dispute in progress']}
          onCancel={() => setPrompt(null)}
          onConfirm={async (text) => {
            const { action, mode } = prompt;
            setPrompt(null);
            await run(`act-${action.id}`, async () => { await completeAction(action.id, mode, text); await reloadAfterChange(); }, mode === 'done' ? 'Task completed.' : 'Task skipped.');
          }}
        />
      )}
    </DashboardLayout>
  );
}

function CaseStatus({ c }: { c: CollectionCase }) {
  return (
    <>
      {c.on_hold && <Pill className="bg-bg-tertiary text-text-secondary"><Pause size={10} />On hold</Pill>}
      {c.escalation_level > 0 && <Pill className="bg-danger/10 text-danger"><ShieldAlert size={10} />L{c.escalation_level}</Pill>}
      {c.promise_amount_cents && c.promise_date && <Pill className="bg-accent/10 text-accent"><CalendarCheck size={10} />{usd(c.promise_amount_cents)} by {fmtDate(c.promise_date)}</Pill>}
      {c.pending_actions > 0 && !c.on_hold && <Pill className="bg-warning-500/10 text-warning-500">{c.pending_actions} to do</Pill>}
      {c.broken_promises > 0 && <Pill className="bg-danger/10 text-danger">{c.broken_promises} broken</Pill>}
    </>
  );
}

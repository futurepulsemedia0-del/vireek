import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  FileBarChart,
  History,
  Lock,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { listReports, ENTITIES, type SavedReport } from '@/lib/reportBuilder';
import {
  DELIVERY_PAGE_SIZE,
  MAX_RECIPIENTS,
  MAX_SCHEDULES,
  WEEKDAYS,
  createSchedule,
  defaultScheduleInput,
  deleteSchedule,
  describeCadence,
  formatHour,
  formatInTimeZone,
  listDeliveries,
  listSchedules,
  listTimezones,
  ordinal,
  parseRecipients,
  sendScheduleNow,
  setScheduleActive,
  statusMeta,
  toScheduleInput,
  updateSchedule,
  validateScheduleInput,
  type Delivery,
  type DeliveryStatus,
  type ScheduleInput,
  type ScheduledReport,
} from '@/lib/scheduledReports';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary transition-colors focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50';

const STATUS_FILTERS: { value: '' | DeliveryStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'sent', label: 'Delivered' },
  { value: 'partial', label: 'Partly delivered' },
  { value: 'failed', label: 'Failed' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'pending', label: 'Sending' },
];

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

function StatusBadge({ status }: { status: DeliveryStatus | null }) {
  const meta = statusMeta(status);
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${meta.tone}`}>{meta.label}</span>;
}

function recipientsSummary(list: string[]): string {
  if (list.length <= 2) return list.join(', ');
  return `${list.slice(0, 2).join(', ')} +${list.length - 2}`;
}

function formatLocal(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export function ScheduledReportsPage() {
  const { profile, teamMember, isOwner, permissions, loading: authLoading, profileLoading } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const canAccess = isOwner || permissions.can_view_billing;
  const accountOwnerId = (isOwner ? profile?.id : teamMember?.account_owner_id) ?? null;
  const authPending = authLoading || profileLoading;

  // ---------- schedules + reports ----------
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [schedules, setSchedules] = useState<ScheduledReport[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    setLoadState('loading');
    try {
      const [r, s] = await Promise.all([listReports(accountOwnerId), listSchedules(accountOwnerId)]);
      setReports(r);
      setSchedules(s);
      setLoadState('ready');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load scheduled reports.');
      setLoadState('error');
    }
  }, [accountOwnerId, canAccess]);

  useEffect(() => {
    load();
  }, [load]);

  const reportName = useCallback((id: string) => reports.find((r) => r.id === id)?.name ?? 'Deleted report', [reports]);

  // ---------- delivery log ----------
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [logState, setLogState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [logError, setLogError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [scheduleFilter, setScheduleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | DeliveryStatus>('');
  const logRequest = useRef(0);
  const logRef = useRef<HTMLElement>(null);

  const loadLog = useCallback(
    async (append: boolean, before?: string) => {
      if (!accountOwnerId || !canAccess) return;
      const id = ++logRequest.current;
      if (append) setLoadingMore(true);
      else setLogState('loading');
      try {
        const rows = await listDeliveries(accountOwnerId, {
          scheduleId: scheduleFilter || undefined,
          status: statusFilter || undefined,
          before,
          limit: DELIVERY_PAGE_SIZE,
        });
        if (id !== logRequest.current) return;
        setDeliveries((prev) => (append ? [...prev, ...rows] : rows));
        setHasMore(rows.length === DELIVERY_PAGE_SIZE);
        setLogState('ready');
      } catch (err) {
        if (id !== logRequest.current) return;
        if (append) toast(err instanceof Error ? err.message : 'Could not load more.', 'error');
        else {
          setLogError(err instanceof Error ? err.message : 'Could not load the delivery log.');
          setLogState('error');
        }
      } finally {
        if (id === logRequest.current) setLoadingMore(false);
      }
    },
    [accountOwnerId, canAccess, scheduleFilter, statusFilter, toast],
  );

  useEffect(() => {
    loadLog(false);
    return () => {
      logRequest.current++;
    };
  }, [loadLog]);

  // ---------- form ----------
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [input, setInput] = useState<ScheduleInput>(() => defaultScheduleInput());
  const [recipientsText, setRecipientsText] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const timezones = useMemo(() => listTimezones(), []);

  const openNew = () => {
    setInput(defaultScheduleInput(reports[0]?.id ?? ''));
    setRecipientsText('');
    setFormError('');
    setEditing({ id: null });
  };
  const openEdit = (s: ScheduledReport) => {
    setInput(toScheduleInput(s));
    setRecipientsText(s.recipients.join('\n'));
    setFormError('');
    setEditing({ id: s.id });
  };
  const patch = (p: Partial<ScheduleInput>) => setInput((prev) => ({ ...prev, ...p }));

  const handleSave = async () => {
    if (!accountOwnerId || !editing || saving) return;
    const { emails, invalid } = parseRecipients(recipientsText);
    if (invalid.length > 0) {
      setFormError(`"${invalid[0]}" is not a valid email address.`);
      return;
    }
    const next: ScheduleInput = { ...input, recipients: emails };
    const problem = validateScheduleInput(next);
    if (problem) {
      setFormError(problem);
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const saved = editing.id ? await updateSchedule(accountOwnerId, editing.id, next) : await createSchedule(accountOwnerId, next);
      setSchedules((prev) => (editing.id ? prev.map((s) => (s.id === saved.id ? saved : s)) : [saved, ...prev]));
      setEditing(null);
      toast(editing.id ? 'Schedule updated.' : 'Schedule created.', 'success');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save the schedule.');
    } finally {
      setSaving(false);
    }
  };

  // ---------- row actions ----------
  const [busyId, setBusyId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledReport | null>(null);

  const handleToggle = async (s: ScheduledReport) => {
    if (!accountOwnerId || busyId) return;
    setBusyId(s.id);
    try {
      const saved = await setScheduleActive(accountOwnerId, s.id, !s.is_active);
      setSchedules((prev) => prev.map((x) => (x.id === saved.id ? saved : x)));
      toast(saved.is_active ? 'Schedule resumed.' : 'Schedule paused.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the schedule.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleSendNow = async (s: ScheduledReport) => {
    if (sendingId) return;
    setSendingId(s.id);
    try {
      const delivery = await sendScheduleNow(s.id);
      if (delivery?.status === 'sent') toast(`Sent to ${delivery.recipients_sent} recipient${delivery.recipients_sent === 1 ? '' : 's'}.`, 'success');
      else if (delivery?.status === 'partial') toast(`Delivered to ${delivery.recipients_sent} of ${delivery.recipients_total}. Check the log.`, 'error');
      else toast(delivery?.error || 'Delivery failed. Check the log for details.', 'error');
      if (accountOwnerId) {
        listSchedules(accountOwnerId).then(setSchedules).catch(() => undefined);
      }
      loadLog(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send the report.', 'error');
    } finally {
      setSendingId(null);
    }
  };

  const handleDelete = async () => {
    const target = deleteTarget;
    if (!target || !accountOwnerId) return;
    try {
      await deleteSchedule(accountOwnerId, target.id);
      setSchedules((prev) => prev.filter((s) => s.id !== target.id));
      if (scheduleFilter === target.id) setScheduleFilter('');
      toast('Schedule deleted.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the schedule.', 'error');
    } finally {
      setDeleteTarget(null);
    }
  };

  const showLog = (scheduleId: string) => {
    setScheduleFilter(scheduleId);
    logRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ---------- gates ----------
  if (authPending || (canAccess && !accountOwnerId)) {
    return (
      <DashboardLayout activeLabel="Scheduled Reports">
        <Skeleton className="mb-6 h-9 w-64" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-44 w-full rounded-2xl" />
          <Skeleton className="h-44 w-full rounded-2xl" />
        </div>
      </DashboardLayout>
    );
  }

  if (!canAccess) {
    return (
      <DashboardLayout activeLabel="Scheduled Reports">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary">
            <Lock size={26} />
          </span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">
            Scheduled reports are restricted. Ask your account owner to grant you the "View Billing" permission.
          </p>
        </div>
      </DashboardLayout>
    );
  }

  const noReports = loadState === 'ready' && reports.length === 0;
  const atLimit = schedules.length >= MAX_SCHEDULES;

  return (
    <DashboardLayout activeLabel="Scheduled Reports">
      <div className="mb-6">
        <Link to="/dashboard/reports" className="focus-ring mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary">
          <ArrowLeft size={15} /> Reports
        </Link>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <CalendarClock size={22} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-text-primary">Scheduled reports</h1>
              <p className="text-sm text-text-secondary">Email a saved report to your team or accountant every week or month.</p>
            </div>
          </div>
          <Button size="sm" onClick={openNew} disabled={loadState !== 'ready' || noReports || atLimit || editing !== null}>
            <Plus size={16} /> New schedule
          </Button>
        </div>
      </div>

      {/* ---------------- Form ---------------- */}
      {editing && (
        <Card className="mb-6 !p-5 hover:!translate-y-0 sm:!p-6">
          <h2 className="mb-5 text-base font-semibold text-text-primary">{editing.id ? 'Edit schedule' : 'New schedule'}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Report" className="sm:col-span-2">
              <select className={selectClass} value={input.reportId} onChange={(e) => patch({ reportId: e.target.value })}>
                {reports.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {ENTITIES[r.entity].label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Frequency">
              <select className={selectClass} value={input.frequency} onChange={(e) => patch({ frequency: e.target.value as ScheduleInput['frequency'] })}>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </Field>

            {input.frequency === 'weekly' ? (
              <Field label="Day of week">
                <select className={selectClass} value={input.weekday} onChange={(e) => patch({ weekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Day of month">
                <select className={selectClass} value={input.monthDay} onChange={(e) => patch({ monthDay: Number(e.target.value) })}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {ordinal(d)}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="Send time">
              <select className={selectClass} value={input.sendHour} onChange={(e) => patch({ sendHour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {formatHour(h)}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Timezone">
              <select className={selectClass} value={input.timezone} onChange={(e) => patch({ timezone: e.target.value })}>
                {timezones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Field>

            <div className="sm:col-span-2">
              <Textarea
                label="Recipients"
                rows={3}
                value={recipientsText}
                placeholder="owner@company.com, accountant@firm.com"
                helperText={`Separate with commas or new lines. Up to ${MAX_RECIPIENTS} addresses.`}
                onChange={(e) => {
                  setRecipientsText(e.target.value);
                  setFormError('');
                }}
              />
            </div>

            <label className="flex items-center gap-2.5 text-sm text-text-primary">
              <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={input.includeCsv} onChange={(e) => patch({ includeCsv: e.target.checked })} />
              Attach the full data as a CSV
            </label>
            <label className="flex items-center gap-2.5 text-sm text-text-primary">
              <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={input.isActive} onChange={(e) => patch({ isActive: e.target.checked })} />
              Active
            </label>
          </div>

          {formError && (
            <p className="mt-4 flex items-start gap-2 rounded-xl bg-danger/5 p-3 text-sm text-text-primary" role="alert">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-danger" /> {formError}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editing.id ? 'Save changes' : 'Create schedule'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <p className="text-xs text-text-secondary sm:ml-auto">The report is re-run with live data every time it is sent.</p>
          </div>
        </Card>
      )}

      {/* ---------------- Schedules ---------------- */}
      <section aria-label="Schedules">
        {loadState === 'loading' && (
          <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-44 w-full rounded-2xl" />
            ))}
          </div>
        )}

        {loadState === 'error' && (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4" role="alert">
            <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <AlertTriangle size={16} className="text-danger" /> {loadError}
            </p>
            <Button variant="secondary" size="sm" onClick={load}>
              <RefreshCw size={16} /> Try again
            </Button>
          </div>
        )}

        {noReports && (
          <EmptyState
            icon={FileBarChart}
            title="Save a report first"
            description="Schedules send one of your saved reports. Build and save a report, then come back here."
            action={{ label: 'Open the report builder', onClick: () => navigate('/dashboard/reports') }}
          />
        )}

        {loadState === 'ready' && !noReports && schedules.length === 0 && (
          <EmptyState
            icon={CalendarClock}
            title="No schedules yet"
            description="Pick a saved report, choose when it should go out, and add the people who should receive it."
            action={{ label: 'Create a schedule', onClick: openNew }}
          />
        )}

        {loadState === 'ready' && schedules.length > 0 && (
          <ul className="grid gap-4 md:grid-cols-2">
            {schedules.map((s) => (
              <li key={s.id}>
                <Card className="h-full !p-5 hover:!translate-y-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-base font-semibold text-text-primary" title={reportName(s.report_id)}>
                        {reportName(s.report_id)}
                      </h3>
                      <p className="mt-0.5 text-sm text-text-secondary">{describeCadence(s)}</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={s.is_active}
                      aria-label={s.is_active ? 'Pause schedule' : 'Resume schedule'}
                      onClick={() => handleToggle(s)}
                      disabled={busyId === s.id}
                      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${s.is_active ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}
                    >
                      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${s.is_active ? 'left-[22px]' : 'left-0.5'}`} />
                    </button>
                  </div>

                  <div className="mt-4 space-y-2 text-sm">
                    <div className="flex items-start gap-2">
                      <Mail size={15} className="mt-0.5 shrink-0 text-text-secondary" aria-label="Recipients" role="img" />
                      <p className="min-w-0 truncate text-text-primary" title={s.recipients.join(', ')}>
                        {recipientsSummary(s.recipients)}
                        {s.include_csv && <span className="ml-2 rounded-md bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-secondary">CSV</span>}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-text-secondary">
                      <span>
                        Next: <span className="text-text-primary">{s.is_active ? formatInTimeZone(s.next_run_at, s.timezone) : 'Paused'}</span>
                      </span>
                      <span className="inline-flex items-center gap-1.5">
                        Last: <StatusBadge status={s.last_status} />
                      </span>
                    </div>
                  </div>

                  {s.paused_reason && !s.is_active && (
                    <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning-500/10 p-2.5 text-xs text-text-primary" role="status">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning-500" /> {s.paused_reason}
                    </p>
                  )}

                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    <Button variant="secondary" size="sm" onClick={() => handleSendNow(s)} disabled={sendingId !== null}>
                      <Send size={15} /> {sendingId === s.id ? 'Sending…' : 'Send now'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(s)} aria-label="Edit schedule">
                      <Pencil size={15} />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => showLog(s.id)} aria-label="View delivery log for this schedule">
                      <History size={15} />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(s)} aria-label="Delete schedule" className="ml-auto !text-danger">
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {atLimit && <p className="mt-3 text-xs text-text-secondary">You've reached the {MAX_SCHEDULES}-schedule limit. Delete one to add another.</p>}
      </section>

      {/* ---------------- Delivery log ---------------- */}
      <section ref={logRef} aria-label="Delivery log" className="mt-10 scroll-mt-6">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Delivery log</h2>
            <p className="text-sm text-text-secondary">Every scheduled and manual send, newest first.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <select aria-label="Filter by schedule" className={`${selectClass} sm:w-52`} value={scheduleFilter} onChange={(e) => setScheduleFilter(e.target.value)}>
              <option value="">All schedules</option>
              {schedules.map((s) => (
                <option key={s.id} value={s.id}>
                  {reportName(s.report_id)}
                </option>
              ))}
            </select>
            <select aria-label="Filter by status" className={`${selectClass} sm:w-44`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as '' | DeliveryStatus)}>
              {STATUS_FILTERS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {logState === 'loading' && (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-xl" />
            ))}
          </div>
        )}

        {logState === 'error' && (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 p-4" role="alert">
            <p className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <AlertTriangle size={16} className="text-danger" /> {logError}
            </p>
            <Button variant="secondary" size="sm" onClick={() => loadLog(false)}>
              <RefreshCw size={16} /> Try again
            </Button>
          </div>
        )}

        {logState === 'ready' && deliveries.length === 0 && (
          <EmptyState
            icon={History}
            title="Nothing has been sent"
            description={scheduleFilter || statusFilter ? 'No deliveries match these filters.' : 'Deliveries appear here after a schedule runs or you press Send now.'}
            className="!py-10"
          />
        )}

        {logState === 'ready' && deliveries.length > 0 && (
          <>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead className="bg-bg-tertiary text-xs uppercase tracking-wide text-text-secondary">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-semibold">When</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Report</th>
                    <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Recipients</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-semibold">Rows</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {deliveries.map((d) => {
                    const failures = d.results.filter((r) => !r.ok);
                    return (
                      <tr key={d.id} className="align-top">
                        <td className="whitespace-nowrap px-4 py-2.5 text-text-primary">
                          {formatLocal(d.created_at)}
                          <span className="block text-xs text-text-secondary">{d.trigger === 'manual' ? 'Sent manually' : 'Scheduled'}</span>
                        </td>
                        <td className="max-w-[14rem] truncate px-4 py-2.5 text-text-primary" title={d.report_name}>
                          {d.report_name}
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusBadge status={d.status} />
                          {(d.error || failures.length > 0) && (
                            <details className="mt-1.5 text-xs text-text-secondary">
                              <summary className="focus-ring cursor-pointer select-none rounded font-medium text-accent">Details</summary>
                              {d.error && <p className="mt-1 max-w-xs break-words">{d.error}</p>}
                              {failures.map((f) => (
                                <p key={f.email} className="mt-1 max-w-xs break-words">
                                  {f.email}: {f.error ?? 'Not delivered'}
                                </p>
                              ))}
                            </details>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">
                          {d.recipients_sent}/{d.recipients_total}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-text-secondary">{d.row_count === null ? '—' : d.row_count.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {hasMore && (
              <div className="mt-4 flex justify-center">
                <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => loadLog(true, deliveries[deliveries.length - 1]?.created_at)}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this schedule?"
        description={`Emails for "${deleteTarget ? reportName(deleteTarget.report_id) : ''}" will stop. The saved report and past delivery log entries are kept.`}
        confirmLabel="Yes, delete schedule"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </DashboardLayout>
  );
}

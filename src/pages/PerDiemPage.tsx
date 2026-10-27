/**
 * Per diem & lodging — /dashboard/per-diem
 * Out-of-town job claims. Technicians file a trip and see the exact amount the rules allow;
 * managers review claims and edit the rules. Approval flows through Expenses, so the ledger,
 * reimbursement and job cost all stay in one place.
 * Anyone on the account can file; review needs View Billing; rules need View Billing + Edit
 * Business Profile (or the owner).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Paperclip, Plus, Route as RouteIcon, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FadeIn, SkeletonCardList, SkeletonStatGrid } from '@/components/Skeleton';
import { formatCents } from '@/lib/accounting';
import { centsToDollarsInput, dollarsToCents } from '@/lib/budgets';
import { fetchJobOptions, getReceiptUrl, uploadReceipt, validateReceiptFile, type JobOption } from '@/lib/expenses';
import {
  REASON_COPY,
  STATUS_LABEL,
  US_STATES,
  computePerDiem,
  deletePerDiemTrip,
  describeRate,
  errorMessage,
  fetchPerDiemPolicy,
  fetchPerDiemTrips,
  reviewPerDiemTrip,
  savePerDiemPolicy,
  savePerDiemTrip,
  tripSummary,
  type PerDiemPolicy,
  type PerDiemRate,
  type PerDiemTrip,
  type TripStatus,
} from '@/lib/perDiem';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-secondary px-3 py-2.5 text-sm text-text-primary disabled:opacity-60';

const BADGE: Record<TripStatus, string> = {
  draft: 'bg-bg-tertiary text-text-secondary',
  submitted: 'bg-warning-500/10 text-warning-500',
  approved: 'bg-success-500/10 text-success-500',
  rejected: 'bg-danger/10 text-danger',
};

type Tab = 'mine' | 'review' | 'rules';

interface TripForm {
  id: string | null;
  state: string;
  city: string;
  startDate: string;
  endDate: string;
  miles: string;
  lodging: string;
  jobId: string;
  notes: string;
  receiptPath: string | null;
  receiptMime: string | null;
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const emptyForm = (): TripForm => ({
  id: null, state: '', city: '', startDate: todayIso(), endDate: todayIso(), miles: '', lodging: '', jobId: '', notes: '',
  receiptPath: null, receiptMime: null,
});

function formFromTrip(t: PerDiemTrip): TripForm {
  return {
    id: t.id,
    state: t.destinationState,
    city: t.destinationCity ?? '',
    startDate: t.startDate,
    endDate: t.endDate,
    miles: String(t.oneWayMiles),
    lodging: t.lodgingActualCents > 0 ? centsToDollarsInput(t.lodgingActualCents) : '',
    jobId: t.jobId ?? '',
    notes: t.notes ?? '',
    receiptPath: t.receiptPath,
    receiptMime: null,
  };
}

function dateRange(t: Pick<PerDiemTrip, 'startDate' | 'endDate'>): string {
  const f = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return t.startDate === t.endDate ? f(t.startDate) : `${f(t.startDate)} – ${f(t.endDate)}`;
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4 sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-xl font-bold tabular-nums text-text-primary sm:text-2xl">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </Card>
  );
}

function TripRow({
  trip, showTraveler, onOpen, onReceipt,
}: { trip: PerDiemTrip; showTraveler: boolean; onOpen: () => void; onReceipt: () => void }) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <button type="button" onClick={onOpen} className="focus-ring min-w-0 rounded-lg text-left">
        <p className="truncate text-sm font-semibold text-text-primary">
          {trip.destinationCity ? `${trip.destinationCity}, ` : ''}{trip.destinationState} · {dateRange(trip)}
        </p>
        <p className="truncate text-xs text-text-secondary">
          {showTraveler ? `${trip.travelerName} · ` : ''}{trip.days} {trip.days === 1 ? 'day' : 'days'} · {trip.oneWayMiles} mi one way
          {trip.status === 'rejected' && trip.reviewNote ? ` · ${trip.reviewNote}` : ''}
        </p>
      </button>
      <div className="flex shrink-0 items-center gap-3">
        {trip.receiptPath && (
          <button type="button" onClick={onReceipt} className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary" aria-label="View lodging receipt">
            <Paperclip size={16} />
          </button>
        )}
        <span className="text-sm font-semibold tabular-nums text-text-primary">{formatCents(trip.totalCents)}</span>
        <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${BADGE[trip.status]}`}>{STATUS_LABEL[trip.status]}</span>
      </div>
    </div>
  );
}

export function PerDiemPage() {
  const navigate = useNavigate();
  const { user, profile, teamMember, isOwner, permissions } = useAuth();
  const { toast } = useToast();
  const uid = user?.id;
  const ownerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canReview = isOwner || permissions.can_view_billing;

  const [tab, setTab] = useState<Tab>('mine');
  const [policy, setPolicy] = useState<PerDiemPolicy | null>(null);
  const [trips, setTrips] = useState<PerDiemTrip[]>([]);
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<TripForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<PerDiemTrip | null>(null);
  const [rejecting, setRejecting] = useState<PerDiemTrip | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [rulesDraft, setRulesDraft] = useState<PerDiemPolicy | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!user) return;
    const id = ++requestId.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [p, t] = await Promise.all([fetchPerDiemPolicy(), fetchPerDiemTrips()]);
      if (id !== requestId.current) return;
      setPolicy(p);
      setRulesDraft(p);
      setTrips(t);
    } catch {
      if (id === requestId.current) setLoadFailed(true);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    void fetchJobOptions(ownerId).then((j) => { if (!cancelled) setJobs(j); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [ownerId]);

  useEffect(() => {
    if (form) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [form?.id, form === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const mine = useMemo(() => trips.filter((t) => t.submittedBy === uid), [trips, uid]);
  const awaiting = useMemo(() => trips.filter((t) => t.status === 'submitted' && (t.submittedBy !== uid || isOwner)), [trips, uid, isOwner]);
  const summary = useMemo(() => tripSummary(canReview ? trips : mine), [trips, mine, canReview]);

  const miles = Number(form?.miles);
  const lodgingCents = form?.lodging.trim() ? dollarsToCents(form.lodging) : 0;
  const preview = useMemo(() => {
    if (!policy || !form || !form.state || !Number.isFinite(miles) || miles < 0 || lodgingCents === null) return null;
    return computePerDiem(policy, { state: form.state, city: form.city, startDate: form.startDate, endDate: form.endDate, oneWayMiles: miles, lodgingActualCents: lodgingCents });
  }, [policy, form, miles, lodgingCents]);

  const handleFile = async (file: File | undefined) => {
    if (!file || !form || !uid || !ownerId) return;
    const problem = validateReceiptFile(file);
    if (problem) return setFormError(problem);
    setBusy(true);
    setFormError(null);
    try {
      const up = await uploadReceipt(ownerId, uid, file);
      setForm((f) => (f ? { ...f, receiptPath: up.path, receiptMime: up.mime } : f));
    } catch (e) {
      setFormError(errorMessage(e, 'Could not upload the receipt.'));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async (submit: boolean) => {
    if (!form) return;
    if (!form.state) return setFormError('Choose the destination state.');
    if (!form.miles.trim() || !Number.isFinite(miles) || miles < 0 || miles > 5000) return setFormError('Enter the one-way distance in miles (0 to 5000).');
    if (lodgingCents === null) return setFormError('Enter a valid lodging amount, like 420 or 420.50.');
    if (!preview) return setFormError('Check the trip dates (up to 61 days).');
    setBusy(true);
    setFormError(null);
    try {
      await savePerDiemTrip(
        form.id,
        {
          state: form.state, city: form.city, startDate: form.startDate, endDate: form.endDate, oneWayMiles: miles,
          lodgingActualCents: lodgingCents, jobId: form.jobId || null, notes: form.notes, receiptPath: form.receiptPath, receiptMime: form.receiptMime,
        },
        submit,
      );
      toast(submit ? 'Trip submitted for review.' : 'Draft saved.', 'success');
      setForm(null);
      await load();
    } catch (e) {
      setFormError(errorMessage(e, 'Could not save the trip.'));
    } finally {
      setBusy(false);
    }
  };

  const openReceipt = async (path: string) => {
    const url = await getReceiptUrl(path);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else toast('Could not open the receipt.', 'error');
  };

  const handleApprove = async (t: PerDiemTrip) => {
    setBusy(true);
    try {
      await reviewPerDiemTrip(t.id, 'approved');
      toast('Approved and added to Expenses.', 'success');
      await load();
    } catch (e) {
      toast(errorMessage(e, 'Could not approve the trip.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (!rejecting) return;
    if (rejectNote.trim().length < 3) return toast('Add a short reason for the rejection.', 'error');
    setBusy(true);
    try {
      await reviewPerDiemTrip(rejecting.id, 'rejected', rejectNote.trim());
      toast('Trip rejected.', 'success');
      setRejecting(null);
      setRejectNote('');
      await load();
    } catch (e) {
      toast(errorMessage(e, 'Could not reject the trip.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    try {
      await deletePerDiemTrip(deleting.id);
      toast('Trip deleted.', 'success');
      setDeleting(null);
      await load();
    } catch (e) {
      toast(errorMessage(e, 'Could not delete the trip.'), 'error');
      setDeleting(null);
    }
  };

  const handleSaveRules = async () => {
    if (!rulesDraft) return;
    setBusy(true);
    setRulesError(null);
    try {
      await savePerDiemPolicy(rulesDraft);
      toast('Per-diem rules saved.', 'success');
      await load();
    } catch (e) {
      setRulesError(errorMessage(e, 'Could not save the rules.'));
    } finally {
      setBusy(false);
    }
  };

  const patchRules = (p: Partial<PerDiemPolicy>) => setRulesDraft((d) => (d ? { ...d, ...p } : d));
  const patchRate = (i: number, p: Partial<PerDiemRate>) =>
    setRulesDraft((d) => (d ? { ...d, rates: d.rates.map((r, idx) => (idx === i ? { ...r, ...p } : r)) } : d));

  const tabs: { id: Tab; label: string; show: boolean; count?: number }[] = [
    { id: 'mine', label: 'My trips', show: true },
    { id: 'review', label: 'Review', show: canReview, count: awaiting.length },
    { id: 'rules', label: 'Rules', show: true },
  ];

  const rulesEditable = !!policy?.canEdit;

  return (
    <DashboardLayout activeLabel="Per Diem">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => navigate('/dashboard')} className="focus-ring flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-secondary hover:text-text-primary" aria-label="Back to dashboard">
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary">
              <RouteIcon size={22} className="text-accent" /> Per diem & lodging
            </h1>
            <p className="text-sm text-text-secondary">Meals and lodging for out-of-town jobs, calculated from your rules.</p>
          </div>
        </div>
        {policy?.enabled && !form && (
          <Button size="sm" onClick={() => { setTab('mine'); setFormError(null); setForm(emptyForm()); }} disabled={busy}>
            <Plus size={14} /> New trip
          </Button>
        )}
      </div>

      <div role="tablist" aria-label="Per diem sections" className="mb-6 flex gap-1 overflow-x-auto rounded-2xl border border-border bg-bg-secondary p-1">
        {tabs.filter((t) => t.show).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`focus-ring flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-4 text-sm font-semibold ${tab === t.id ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-tertiary'}`}
          >
            {t.label}
            {t.count ? <span className="rounded-full bg-white/20 px-1.5 text-[11px]">{t.count}</span> : null}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-6">
          <SkeletonStatGrid count={3} />
          <SkeletonCardList count={2} rows={3} />
        </div>
      ) : loadFailed || !policy || !rulesDraft ? (
        <EmptyState icon={AlertTriangle} title="Couldn't load per diem" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />
      ) : (
        <FadeIn>
          <div className="space-y-6">
            {tab !== 'rules' && !policy.enabled && (
              <EmptyState
                icon={RouteIcon}
                title="Per diem isn't turned on"
                description={policy.canEdit ? 'Set your rates and the minimum distance, then turn it on.' : 'Your account owner has not turned on per diem yet.'}
                action={policy.canEdit ? { label: 'Set up rules', onClick: () => setTab('rules') } : undefined}
              />
            )}

            {tab !== 'rules' && policy.enabled && (
              <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
                <Kpi label="Awaiting review" value={String(summary.awaiting)} hint={formatCents(summary.awaitingCents)} />
                <Kpi label="Approved" value={formatCents(summary.approvedCents)} hint="Added to Expenses" />
                <Kpi label="Minimum distance" value={`${policy.minDistanceMiles} mi`} hint={policy.requireOvernight ? 'Overnight required' : 'Day trips count'} />
              </div>
            )}

            {tab === 'mine' && policy.enabled && form && (
              <div ref={formRef}>
                <Card className="p-4 sm:p-5">
                  <h2 className="mb-4 text-sm font-semibold text-text-primary">{form.id ? 'Edit trip' : 'New trip'}</h2>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="pd-state" className="mb-1.5 block text-sm font-medium text-text-primary">State</label>
                      <select id="pd-state" className={selectClass} value={form.state} disabled={busy} onChange={(e) => setForm({ ...form, state: e.target.value })}>
                        <option value="">Select a state</option>
                        {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                    <Input label="City (optional)" maxLength={80} value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                    <Input label="First day" type="date" max={todayIso()} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: form.endDate < e.target.value ? e.target.value : form.endDate })} />
                    <Input label="Last day" type="date" min={form.startDate} max={todayIso()} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
                    <Input label="Distance, one way (miles)" inputMode="decimal" placeholder="120" value={form.miles} onChange={(e) => setForm({ ...form, miles: e.target.value })} />
                    <Input label="Lodging paid ($)" inputMode="decimal" placeholder="0.00" helperText="Total for the stay. Paid at actual cost up to the nightly cap." value={form.lodging} onChange={(e) => setForm({ ...form, lodging: e.target.value })} />
                    <div className="sm:col-span-2">
                      <label htmlFor="pd-job" className="mb-1.5 block text-sm font-medium text-text-primary">Job (optional)</label>
                      <select id="pd-job" className={selectClass} value={form.jobId} disabled={busy} onChange={(e) => setForm({ ...form, jobId: e.target.value })}>
                        <option value="">Not tied to a job</option>
                        {jobs.map((j) => <option key={j.id} value={j.id}>{j.customer_name}{j.service_type ? ` · ${j.service_type}` : ''}</option>)}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <Input label="Notes (optional)" maxLength={1000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                    </div>
                    {lodgingCents !== null && lodgingCents > 0 && (
                      <div className="sm:col-span-2">
                        <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" className="hidden" onChange={(e) => { void handleFile(e.target.files?.[0]); e.target.value = ''; }} />
                        <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
                          <Paperclip size={14} /> {form.receiptPath ? 'Replace lodging receipt' : 'Attach lodging receipt'}
                        </Button>
                        <p className="mt-1 text-xs text-text-secondary">
                          {form.receiptPath ? 'Receipt attached.' : policy.lodgingRequiresReceipt ? 'A receipt is required to submit lodging.' : 'Optional.'}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 rounded-xl bg-bg-tertiary/60 p-4" aria-live="polite">
                    {!preview ? (
                      <p className="text-sm text-text-secondary">Enter the state, dates and distance to see what you can claim.</p>
                    ) : !preview.eligible ? (
                      <p className="text-sm text-danger">{preview.reason ? REASON_COPY[preview.reason] : 'This trip does not qualify.'}</p>
                    ) : (
                      <div className="space-y-1 text-sm">
                        <div className="flex justify-between"><span className="text-text-secondary">Meals · {preview.days} {preview.days === 1 ? 'day' : 'days'} at {formatCents(preview.mealRateCents)}</span><span className="tabular-nums text-text-primary">{formatCents(preview.mealTotalCents)}</span></div>
                        <div className="flex justify-between"><span className="text-text-secondary">Lodging · {preview.nights} {preview.nights === 1 ? 'night' : 'nights'}, cap {formatCents(preview.lodgingCapCents)}</span><span className="tabular-nums text-text-primary">{formatCents(preview.lodgingAllowedCents)}</span></div>
                        {preview.lodgingOverCents > 0 && <p className="text-xs text-warning-500">{formatCents(preview.lodgingOverCents)} of lodging is over the cap and won't be paid.</p>}
                        <div className="flex justify-between border-t border-border pt-2 font-semibold"><span className="text-text-primary">You can claim</span><span className="tabular-nums text-text-primary">{formatCents(preview.totalCents)}</span></div>
                        <p className="text-xs text-text-secondary">{describeRate(preview.rateSource, form.state, form.city)}. The final amount is confirmed when you submit.</p>
                      </div>
                    )}
                  </div>

                  {formError && <p role="alert" className="mt-3 text-sm text-danger">{formError}</p>}
                  <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button variant="ghost" size="sm" onClick={() => setForm(null)} disabled={busy}>Cancel</Button>
                    <Button variant="secondary" size="sm" onClick={() => void handleSave(false)} disabled={busy}>Save draft</Button>
                    <Button size="sm" onClick={() => void handleSave(true)} disabled={busy || (!!preview && !preview.eligible)}>{busy ? 'Saving…' : 'Submit for review'}</Button>
                  </div>
                </Card>
              </div>
            )}

            {tab === 'mine' && policy.enabled && !form && (
              mine.length === 0 ? (
                <EmptyState
                  icon={RouteIcon}
                  title="No trips yet"
                  description={`Trips of ${policy.minDistanceMiles} miles or more${policy.requireOvernight ? ' with an overnight stay' : ''} qualify for per diem.`}
                  action={{ label: 'File your first trip', onClick: () => { setFormError(null); setForm(emptyForm()); } }}
                />
              ) : (
                <Card className="p-4 sm:p-5">
                  <div className="divide-y divide-border/60">
                    {mine.map((t) => (
                      <div key={t.id}>
                        <TripRow trip={t} showTraveler={false} onOpen={() => { if (t.status === 'draft' || t.status === 'rejected') { setFormError(null); setForm(formFromTrip(t)); } }} onReceipt={() => void openReceipt(t.receiptPath as string)} />
                        {(t.status === 'draft' || t.status === 'rejected') && (
                          <div className="-mt-1 mb-2 flex justify-end">
                            <Button variant="ghost" size="sm" onClick={() => setDeleting(t)}><Trash2 size={14} /> Delete</Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              )
            )}

            {tab === 'review' && canReview && policy.enabled && (
              awaiting.length === 0 ? (
                <EmptyState icon={RouteIcon} title="Nothing to review" description="Submitted trips from your team will show up here." />
              ) : (
                <Card className="p-4 sm:p-5">
                  <div className="divide-y divide-border/60">
                    {awaiting.map((t) => (
                      <div key={t.id}>
                        <TripRow trip={t} showTraveler onOpen={() => undefined} onReceipt={() => void openReceipt(t.receiptPath as string)} />
                        <p className="text-xs text-text-secondary">Meals {formatCents(t.mealTotalCents)} · Lodging {formatCents(t.lodgingAllowedCents)}{t.lodgingActualCents > t.lodgingAllowedCents ? ` (paid ${formatCents(t.lodgingActualCents)}, capped)` : ''}</p>
                        <div className="mb-3 mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                          <Button variant="ghost" size="sm" onClick={() => { setRejectNote(''); setRejecting(t); }} disabled={busy}>Reject</Button>
                          <Button size="sm" onClick={() => void handleApprove(t)} disabled={busy}>Approve</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )
            )}

            {tab === 'rules' && (
              <Card className="p-4 sm:p-5">
                {!rulesEditable && <p className="mb-4 rounded-xl bg-bg-tertiary/60 p-3 text-sm text-text-secondary">Only the account owner or someone with View Billing and Edit Business Profile can change these rules.</p>}
                <label className="flex items-start gap-3 text-sm text-text-primary">
                  <input type="checkbox" className="focus-ring mt-0.5 h-5 w-5 shrink-0 rounded border-border" checked={rulesDraft.enabled} disabled={!rulesEditable || busy} onChange={(e) => patchRules({ enabled: e.target.checked })} />
                  <span>Turn on per diem and lodging<span className="block text-xs text-text-secondary">Technicians can then file out-of-town trips.</span></span>
                </label>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <Input label="Minimum distance, one way (miles)" inputMode="numeric" disabled={!rulesEditable} value={String(rulesDraft.minDistanceMiles)} onChange={(e) => patchRules({ minDistanceMiles: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
                  <Input label="First and last day pay (%)" inputMode="numeric" disabled={!rulesEditable} helperText="Share of the daily meal rate paid on travel days." value={String(rulesDraft.firstLastDayPct)} onChange={(e) => patchRules({ firstLastDayPct: Math.min(100, Number(e.target.value.replace(/\D/g, '')) || 0) })} />
                  <Input label="Default daily meals ($)" inputMode="decimal" disabled={!rulesEditable} value={centsToDollarsInput(rulesDraft.defaultMealCents)} onChange={(e) => { const c = dollarsToCents(e.target.value); if (c !== null) patchRules({ defaultMealCents: c }); }} />
                  <Input label="Default nightly lodging cap ($)" inputMode="decimal" disabled={!rulesEditable} value={centsToDollarsInput(rulesDraft.defaultLodgingCapCents)} onChange={(e) => { const c = dollarsToCents(e.target.value); if (c !== null) patchRules({ defaultLodgingCapCents: c }); }} />
                </div>
                <div className="mt-4 space-y-3">
                  <label className="flex items-center gap-3 text-sm text-text-primary">
                    <input type="checkbox" className="focus-ring h-5 w-5 rounded border-border" checked={rulesDraft.requireOvernight} disabled={!rulesEditable || busy} onChange={(e) => patchRules({ requireOvernight: e.target.checked })} />
                    Require at least one overnight stay
                  </label>
                  <label className="flex items-center gap-3 text-sm text-text-primary">
                    <input type="checkbox" className="focus-ring h-5 w-5 rounded border-border" checked={rulesDraft.lodgingRequiresReceipt} disabled={!rulesEditable || busy} onChange={(e) => patchRules({ lodgingRequiresReceipt: e.target.checked })} />
                    Require a receipt for lodging
                  </label>
                </div>

                <h2 className="mt-6 text-sm font-semibold text-text-primary">Regional rates</h2>
                <p className="mt-0.5 text-xs text-text-secondary">A city rate wins over a state rate, which wins over the defaults. Check your rates against current GSA or your own policy.</p>
                {rulesDraft.rates.length === 0 ? (
                  <p className="mt-3 text-sm text-text-secondary">No regional rates. Every trip uses the defaults above.</p>
                ) : (
                  <ul className="mt-3 space-y-3">
                    {rulesDraft.rates.map((r, i) => (
                      <li key={`${r.state}-${r.city ?? ''}-${i}`} className="grid grid-cols-2 gap-3 rounded-xl border border-border p-3 sm:grid-cols-5">
                        <select aria-label="State" className={selectClass} value={r.state} disabled={!rulesEditable} onChange={(e) => patchRate(i, { state: e.target.value })}>
                          <option value="">State</option>
                          {US_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <Input aria-label="City (blank for whole state)" placeholder="City (optional)" maxLength={80} disabled={!rulesEditable} value={r.city ?? ''} onChange={(e) => patchRate(i, { city: e.target.value.trim() ? e.target.value : null })} />
                        <Input aria-label="Daily meals ($)" inputMode="decimal" placeholder="Meals $" disabled={!rulesEditable} value={centsToDollarsInput(r.mealCents)} onChange={(e) => { const c = dollarsToCents(e.target.value); if (c !== null) patchRate(i, { mealCents: c }); }} />
                        <Input aria-label="Nightly lodging cap ($)" inputMode="decimal" placeholder="Lodging $" disabled={!rulesEditable} value={centsToDollarsInput(r.lodgingCapCents)} onChange={(e) => { const c = dollarsToCents(e.target.value); if (c !== null) patchRate(i, { lodgingCapCents: c }); }} />
                        {rulesEditable && (
                          <Button variant="ghost" size="sm" onClick={() => patchRules({ rates: rulesDraft.rates.filter((_, idx) => idx !== i) })} aria-label="Remove regional rate"><Trash2 size={14} /></Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {rulesEditable && (
                  <div className="mt-3">
                    <Button variant="secondary" size="sm" onClick={() => patchRules({ rates: [...rulesDraft.rates, { state: '', city: null, mealCents: rulesDraft.defaultMealCents, lodgingCapCents: rulesDraft.defaultLodgingCapCents }] })}>
                      <Plus size={14} /> Add regional rate
                    </Button>
                  </div>
                )}
                {rulesError && <p role="alert" className="mt-3 text-sm text-danger">{rulesError}</p>}
                {rulesEditable && (
                  <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button variant="ghost" size="sm" onClick={() => setRulesDraft(policy)} disabled={busy}>Discard</Button>
                    <Button size="sm" onClick={() => void handleSaveRules()} disabled={busy}>{busy ? 'Saving…' : 'Save rules'}</Button>
                  </div>
                )}
              </Card>
            )}
          </div>
        </FadeIn>
      )}

      {rejecting && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label="Reject trip">
          <Card className="w-full max-w-md p-5">
            <h2 className="text-base font-semibold text-text-primary">Reject this trip?</h2>
            <p className="mt-1 text-sm text-text-secondary">{rejecting.travelerName} will see your reason and can fix and resubmit.</p>
            <div className="mt-3">
              <Input label="Reason" maxLength={500} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} />
            </div>
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" size="sm" onClick={() => setRejecting(null)} disabled={busy}>Cancel</Button>
              <Button size="sm" onClick={() => void handleReject()} disabled={busy}>Reject trip</Button>
            </div>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete this trip?"
        description={deleting ? `The ${deleting.destinationState} trip on ${dateRange(deleting)} will be removed.` : ''}
        confirmLabel="Yes, delete it"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </DashboardLayout>
  );
}

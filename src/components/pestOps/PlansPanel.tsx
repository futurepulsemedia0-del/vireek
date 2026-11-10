import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { fetchPlanCandidates, fetchRoutes, type PlanCandidate } from '@/lib/tradePacksApi';
import { cancelPlan, createPlan, fetchPlans, friendlyPestOpsError, renewPlan, type PestPlan } from '@/lib/pestOpsApi';
import { occurrenceDate, todayISO } from '@/lib/recurringJobs';
import {
  PEST_CADENCES, PEST_CADENCE_KEYS, assessRenewal, nextTerm, planVisits, cancellationEffectiveOn, addDaysISO, validateSchedule,
  type CancelPolicy, type PestCadence,
} from '@/lib/tradePacks/pestOps';
import { Pill, SelectField, fmtDate } from '@/components/tradePacks/shared';
import { useResource } from './useResource';

const STATUS_TONE: Record<PestPlan['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success', paused: 'neutral', renewal_due: 'warning', cancel_scheduled: 'warning', cancelled: 'danger', expired: 'neutral',
};

const dateLabel = (iso: string) => fmtDate(`${iso}T12:00:00`);

function defaultTermEnd(start: string): string {
  return addDaysISO(occurrenceDate(start, 'month', 12, 1), -1);
}

interface Props {
  ownerId: string;
  canManage: boolean;
}

export function PlansPanel({ ownerId, canManage }: Props) {
  const { toast } = useToast();
  const plans = useResource(() => fetchPlans(ownerId));
  const candidates = useResource(() => fetchPlanCandidates(ownerId));
  const routes = useResource(() => fetchRoutes(ownerId, 'pest_control'));
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<{ id: string; mode: 'preview' | 'cancel' } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const today = todayISO();

  const planned = useMemo(() => new Set((plans.data ?? []).map((p) => p.agreement_id)), [plans.data]);
  const free = useMemo(() => (candidates.data ?? []).filter((c) => !planned.has(c.id)), [candidates.data, planned]);

  const weekdaysFor = (agreementId: string | null): number[] => {
    if (!agreementId || !routes.data) return [];
    const stop = routes.data.stops.find((s) => s.agreement_id === agreementId);
    const route = stop ? routes.data.routes.find((r) => r.id === stop.route_id && r.active) : undefined;
    return route ? [route.weekday] : [];
  };

  const run = async (id: string, fn: () => Promise<void>, ok: string) => {
    setBusy(id);
    try {
      await fn();
      toast(ok, 'success');
      await plans.reload();
      await candidates.reload();
    } catch (e) {
      toast(friendlyPestOpsError(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  if (plans.loading && !plans.data) return <Skeleton className="h-40 w-full" />;
  if (plans.error) return <EmptyState variant="load-failed" title="Could not load plans" description={plans.error} onRetry={() => void plans.reload()} />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">Plans sit on top of Recurring Jobs: visits are still generated there. Renewals are never automatic.</p>
        {canManage && <Button size="sm" onClick={() => setShowCreate((v) => !v)}>{showCreate ? 'Close' : 'New plan'}</Button>}
      </div>

      {showCreate && canManage && (
        <CreatePlanForm
          candidates={free}
          onDone={async () => {
            setShowCreate(false);
            await plans.reload();
            await candidates.reload();
          }}
        />
      )}

      {(plans.data ?? []).length === 0 ? (
        <EmptyState compact title="No pest plans yet" description="Create one from an active recurring agreement." />
      ) : (
        <ul className="space-y-3" aria-label="Pest service plans">
          {(plans.data ?? []).map((p) => {
            const renewal = assessRenewal({ status: p.status, termEnd: p.term_end, today, noticeDays: p.renewal_notice_days });
            const canRenew = canManage && ['active', 'renewal_due', 'expired'].includes(p.status) && (renewal.state !== 'not_due');
            const isOpen = open?.id === p.id ? open.mode : null;
            return (
              <li key={p.id}>
                <Card className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-semibold text-text-primary">{p.agreement?.customer_name ?? 'Customer'} — {PEST_CADENCES[p.cadence].label}</p>
                      <p className="text-xs text-text-secondary">{p.agreement?.address ?? 'Agreement removed'}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Pill tone={STATUS_TONE[p.status]}>{p.status.replace('_', ' ')}</Pill>
                      {renewal.state === 'due' && <Pill tone="warning">renewal in {renewal.daysToEnd} d</Pill>}
                      {renewal.state === 'overdue' && <Pill tone="danger">ends today</Pill>}
                    </div>
                  </div>
                  <p className="text-sm text-text-secondary">
                    Term {dateLabel(p.term_start)} – {dateLabel(p.term_end)} · guarantee {p.guarantee_days} days
                    {p.cancel_effective_on ? ` · cancels ${dateLabel(p.cancel_effective_on)}` : ''}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setOpen(isOpen === 'preview' ? null : { id: p.id, mode: 'preview' })}>Upcoming visits</Button>
                    {canRenew && (
                      <Button
                        size="sm"
                        loading={busy === p.id}
                        onClick={() => {
                          const t = nextTerm({ start: p.term_start, end: p.term_end }, p.cadence, p.season_from && p.season_to ? { fromMonth: p.season_from, toMonth: p.season_to } : null, p.agreement?.start_date);
                          void run(p.id, () => renewPlan(p.id, t.start, t.end), `Renewed through ${t.end}`);
                        }}
                      >
                        Renew next term
                      </Button>
                    )}
                    {canManage && ['active', 'paused', 'renewal_due', 'cancel_scheduled'].includes(p.status) && (
                      <Button size="sm" variant="danger" onClick={() => setOpen(isOpen === 'cancel' ? null : { id: p.id, mode: 'cancel' })}>Cancel plan</Button>
                    )}
                  </div>
                  {isOpen === 'preview' && <VisitPreview plan={p} weekdays={weekdaysFor(p.agreement_id)} today={today} />}
                  {isOpen === 'cancel' && (
                    <CancelForm
                      plan={p}
                      today={today}
                      busy={busy === p.id}
                      onSubmit={(reason, effective) => run(p.id, async () => { await cancelPlan(p.id, reason, effective); setOpen(null); }, 'Cancellation recorded')}
                    />
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function VisitPreview({ plan, weekdays, today }: { plan: PestPlan; weekdays: number[]; today: string }) {
  const rows = useMemo(() => {
    if (!plan.agreement) return null;
    const season = plan.season_from && plan.season_to ? { fromMonth: plan.season_from, toMonth: plan.season_to } : null;
    const input = {
      startDate: plan.agreement.start_date, cadence: plan.cadence, season, timeZone: plan.agreement.timezone,
      localTime: plan.agreement.preferred_time.slice(0, 5), routeWeekdays: weekdays, endDate: plan.term_end, limit: 120,
    };
    if (validateSchedule(input).length) return null;
    return planVisits(input).filter((v) => v.date >= today).slice(0, 6);
  }, [plan, weekdays, today]);

  if (!rows) return <p className="text-sm text-danger" role="alert">This plan’s schedule could not be previewed.</p>;
  if (rows.length === 0) return <p className="text-sm text-text-secondary">No visits left in this term.</p>;
  return (
    <ul className="space-y-1 text-sm" aria-label="Upcoming visits">
      {weekdays.length === 0 && <li className="text-xs text-text-secondary">Not on a route yet — dates follow the cadence only.</li>}
      {rows.map((v) => (
        <li key={v.n} className="flex flex-wrap items-center gap-2">
          <span className="text-text-primary">{dateLabel(v.date)}</span>
          {v.status === 'shifted' && <Pill tone="warning">moved {v.shiftedDays > 0 ? '+' : ''}{v.shiftedDays} d for route day</Pill>}
          {v.status === 'needs_attention' && <Pill tone="danger">{v.reason}</Pill>}
        </li>
      ))}
    </ul>
  );
}

function CancelForm({ plan, today, busy, onSubmit }: { plan: PestPlan; today: string; busy: boolean; onSubmit: (reason: string, effective: string | null) => void }) {
  const [reason, setReason] = useState('');
  const [policy, setPolicy] = useState<CancelPolicy>('immediate');
  const effective = cancellationEffectiveOn({ requestedOn: today, termEnd: plan.term_end, policy, noticeDays: 30 });
  const bad = reason.trim().length < 3;
  return (
    <div className="space-y-3 rounded-xl border border-border p-3">
      <Textarea label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
      <SelectField label="Effective" value={policy} onChange={(v) => setPolicy(v as CancelPolicy)} helperText={`Effective ${dateLabel(effective)}. Visits after that date are cancelled.`}>
        <option value="immediate">Today</option>
        <option value="notice">After 30 days’ notice</option>
        <option value="term_end">End of term</option>
      </SelectField>
      <p className="text-xs text-text-secondary">Refunds, fees and customer cancellation rights are not calculated here. REQUIRES COUNSEL for your region.</p>
      <Button size="sm" variant="danger" loading={busy} disabled={bad} disabledReason={bad ? 'Enter a reason (3+ characters)' : undefined} onClick={() => onSubmit(reason.trim(), effective === today ? null : effective)}>
        Confirm cancellation
      </Button>
    </div>
  );
}

function CreatePlanForm({ candidates, onDone }: { candidates: PlanCandidate[]; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const [agreementId, setAgreementId] = useState('');
  const [cadence, setCadence] = useState<PestCadence>('quarterly');
  const [seasonFrom, setSeasonFrom] = useState('4');
  const [seasonTo, setSeasonTo] = useState('10');
  const [guarantee, setGuarantee] = useState('30');
  const [notice, setNotice] = useState('30');
  const [sameTarget, setSameTarget] = useState(true);
  const [saving, setSaving] = useState(false);
  const agreement = candidates.find((c) => c.id === agreementId);
  const compatible = agreement ? PEST_CADENCE_KEYS.filter((k) => PEST_CADENCES[k].intervalUnit === agreement.interval_unit && PEST_CADENCES[k].intervalCount === agreement.interval_count) : [];
  const activeCadence = compatible.includes(cadence) ? cadence : compatible[0];

  const submit = async () => {
    if (!agreement || !activeCadence) return;
    const g = Number(guarantee);
    const n = Number(notice);
    if (!Number.isInteger(g) || g < 0 || g > 365 || !Number.isInteger(n) || n < 1 || n > 120) {
      toast('Guarantee must be 0–365 days and renewal notice 1–120 days.', 'error');
      return;
    }
    setSaving(true);
    try {
      const seasonal = activeCadence === 'seasonal';
      await createPlan({
        agreementId: agreement.id, cadence: activeCadence, seasonFrom: seasonal ? Number(seasonFrom) : null, seasonTo: seasonal ? Number(seasonTo) : null,
        termStart: agreement.start_date, termEnd: defaultTermEnd(agreement.start_date), renewalNoticeDays: n, guaranteeDays: g, sameTarget, maxCallbacks: null,
      });
      toast('Plan created', 'success');
      await onDone();
    } catch (e) {
      toast(friendlyPestOpsError(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (candidates.length === 0) return <EmptyState compact title="No unplanned agreements" description="Create a recurring agreement first (Recurring Jobs)." />;
  return (
    <Card className="space-y-3 p-4">
      <SelectField label="Recurring agreement" value={agreementId} onChange={setAgreementId} required>
        <option value="">Choose…</option>
        {candidates.map((c) => <option key={c.id} value={c.id}>{c.customer_name} — {c.address}</option>)}
      </SelectField>
      {agreement && compatible.length === 0 && <p className="text-sm text-danger" role="alert">This agreement’s interval does not match any pest cadence.</p>}
      {agreement && compatible.length > 0 && (
        <>
          <SelectField label="Cadence" value={activeCadence ?? ''} onChange={(v) => setCadence(v as PestCadence)}>
            {compatible.map((k) => <option key={k} value={k}>{PEST_CADENCES[k].label}</option>)}
          </SelectField>
          {activeCadence === 'seasonal' && (
            <div className="grid grid-cols-2 gap-3">
              <Input label="Season from (month 1–12)" type="number" min={1} max={12} value={seasonFrom} onChange={(e) => setSeasonFrom(e.target.value)} />
              <Input label="Season to (month 1–12)" type="number" min={1} max={12} value={seasonTo} onChange={(e) => setSeasonTo(e.target.value)} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input label="Guarantee (days)" type="number" min={0} max={365} value={guarantee} onChange={(e) => setGuarantee(e.target.value)} />
            <Input label="Renewal prompt (days before end)" type="number" min={1} max={120} value={notice} onChange={(e) => setNotice(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" className="focus-ring h-4 w-4" checked={sameTarget} onChange={(e) => setSameTarget(e.target.checked)} />
            Guarantee covers the same target pest only
          </label>
          <p className="text-xs text-text-secondary">Term: {dateLabel(agreement.start_date)} – {dateLabel(defaultTermEnd(agreement.start_date))} (12 months).</p>
          <Button size="sm" loading={saving} onClick={() => void submit()}>Create plan</Button>
        </>
      )}
    </Card>
  );
}

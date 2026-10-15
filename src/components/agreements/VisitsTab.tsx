import { useMemo, useState } from 'react';
import { Check, Gauge, Plus, Ticket, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import {
  ENTITLEMENT_KIND_LABELS,
  ENTITLEMENT_KIND_OPTIONS,
  PERIOD_LABELS,
  PERIOD_OPTIONS,
  VISIT_STATUS_LABELS,
  VISIT_STATUS_OPTIONS,
  deleteAgreementRow,
  entitlementUsage,
  formatDate,
  formatMoney,
  formatPct,
  formatQty,
  insertAgreementRow,
  toDateKey,
  updateAgreementRow,
  type EntitlementKind,
  type EntitlementPeriod,
  type VisitStatus,
} from '@/lib/serviceAgreement';
import { CheckField, DeleteConfirm, FormActions, Panel, Pill, ProgressBar, RowActions, SelectField, centsToDollarsText, dollarsToCents, useInlineForm, type TabProps } from './AgreementUi';
import { useAgreementActions } from './useAgreementActions';

interface EntForm {
  kind: EntitlementKind;
  included: string;
  period: EntitlementPeriod;
  overage: string;
}
const EMPTY_ENT: EntForm = { kind: 'pm_visit', included: '', period: 'year', overage: '' };

interface VisitForm {
  kind: EntitlementKind;
  visit_date: string;
  status: VisitStatus;
  quantity: string;
  billable: boolean;
  job_id: string;
  notes: string;
}
const emptyVisit = (): VisitForm => ({ kind: 'pm_visit', visit_date: toDateKey(new Date()), status: 'completed', quantity: '1', billable: false, job_id: '', notes: '' });

const VISIT_STATUS_STYLES: Record<VisitStatus, string> = {
  scheduled: 'bg-accent/10 text-accent',
  completed: 'bg-success-500/10 text-success-500',
  missed: 'bg-danger/10 text-danger',
  cancelled: 'bg-bg-tertiary text-text-secondary',
};

export function VisitsTab({ data, derived, canManage, canSeeMoney, ownerId, reload }: TabProps) {
  const { busy, run } = useAgreementActions(reload);
  const entForm = useInlineForm<EntForm>(EMPTY_ENT);
  const visitForm = useInlineForm<VisitForm>(emptyVisit());
  const [deletingEnt, setDeletingEnt] = useState<{ id: string; label: string } | null>(null);
  const [deletingVisit, setDeletingVisit] = useState<{ id: string; label: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const usedKinds = new Set(data.entitlements.map((e) => e.kind));
  const planById = useMemo(() => new Map(data.pmPlans.map((p) => [p.id, p])), [data.pmPlans]);
  const jobOptions = useMemo(
    () => [{ value: '', label: 'Not linked to a job' }, ...data.jobs.slice(0, 150).map((j) => ({ value: j.id, label: `${formatDate(j.created_at)} · ${j.service_type ?? 'Job'}` }))],
    [data.jobs]
  );

  const submitEnt = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = entForm.form;
    const included = Number(f.included);
    const overage = dollarsToCents(f.overage);
    if (f.included.trim() === '' || !Number.isFinite(included) || included < 0) return setFormError('Enter how many are included (0 or more).');
    if (overage === null) return setFormError('Enter the overage rate as a positive dollar amount.');
    if (!entForm.editingId && usedKinds.has(f.kind)) return setFormError('This allowance already exists — edit it instead.');
    setFormError(null);
    const payload = { included_quantity: included, period: f.period, overage_rate_cents: overage ?? null };
    const ok = await run(
      () => (entForm.editingId ? updateAgreementRow('agreement_entitlements', entForm.editingId, payload) : insertAgreementRow('agreement_entitlements', ownerId, { ...payload, kind: f.kind, contract_id: data.contract.id })),
      entForm.editingId ? 'Allowance updated.' : 'Allowance added.'
    );
    if (ok) entForm.close();
  };

  const submitVisit = async (e: React.FormEvent) => {
    e.preventDefault();
    const f = visitForm.form;
    const qty = Number(f.quantity);
    if (!f.visit_date) return setFormError('Pick the visit date.');
    if (!Number.isFinite(qty) || qty <= 0) return setFormError('Quantity must be greater than 0.');
    setFormError(null);
    const payload = { entitlement_kind: f.kind, visit_date: f.visit_date, status: f.status, quantity: qty, billable: f.billable, job_id: f.job_id || null, notes: f.notes.trim() || null };
    const ok = await run(
      () => (visitForm.editingId ? updateAgreementRow('agreement_visits', visitForm.editingId, payload) : insertAgreementRow('agreement_visits', ownerId, { ...payload, contract_id: data.contract.id })),
      visitForm.editingId ? 'Visit updated.' : 'Visit recorded.'
    );
    if (ok) visitForm.close();
  };

  return (
    <>
      <Panel
        title="Included visits & hours"
        description="What the fee includes per period, and how much has been used in the current period."
        action={
          canManage && usedKinds.size < ENTITLEMENT_KIND_OPTIONS.length ? (
            <Button size="sm" onClick={() => entForm.start({ ...EMPTY_ENT, kind: ENTITLEMENT_KIND_OPTIONS.find((k) => !usedKinds.has(k)) ?? 'pm_visit' })} disabled={entForm.open}>
              <Plus size={14} aria-hidden="true" /> Add allowance
            </Button>
          ) : undefined
        }
      >
        {entForm.open && (
          <form onSubmit={submitEnt} className="mb-4 grid gap-3 rounded-lg border border-border bg-bg-primary p-4 sm:grid-cols-2">
            <SelectField
              label="What is included"
              value={entForm.form.kind}
              disabled={!!entForm.editingId}
              onChange={(v) => entForm.patch({ kind: v })}
              options={ENTITLEMENT_KIND_OPTIONS.filter((k) => !usedKinds.has(k) || k === entForm.form.kind).map((k) => ({ value: k, label: ENTITLEMENT_KIND_LABELS[k] }))}
            />
            <Input label="Quantity included" type="number" inputMode="decimal" min={0} step="0.5" required value={entForm.form.included} onChange={(e) => entForm.patch({ included: e.target.value })} />
            <SelectField label="Per" value={entForm.form.period} onChange={(v) => entForm.patch({ period: v })} options={PERIOD_OPTIONS.map((p) => ({ value: p, label: PERIOD_LABELS[p] }))} helperText="Periods restart on the agreement's start-date anniversary." />
            {canSeeMoney && <Input label="Overage rate ($ each)" inputMode="decimal" placeholder="Not billed" helperText="Charged per extra visit / hour beyond the allowance." value={entForm.form.overage} onChange={(e) => entForm.patch({ overage: e.target.value })} />}
            {formError && <p className="text-sm text-danger sm:col-span-2" role="alert">{formError}</p>}
            <div className="sm:col-span-2">
              <FormActions busy={busy} onCancel={() => { setFormError(null); entForm.close(); }} submitLabel={entForm.editingId ? 'Save changes' : 'Add allowance'} />
            </div>
          </form>
        )}

        {data.entitlements.length === 0 ? (
          <EmptyState icon={Gauge} title="No included visits defined" description="Add the visits or labor hours this agreement includes to track usage, catch overages and prove value at renewal." />
        ) : (
          <ul className="space-y-4">
            {data.entitlements.map((ent) => {
              const u = derived.usage.find((x) => x.kind === ent.kind) ?? entitlementUsage(ent, data.visits, data.contract);
              const tone = u.utilizationPct > 100 ? 'bg-danger' : u.utilizationPct >= 80 ? 'bg-warning-500' : 'bg-accent';
              return (
                <li key={ent.id}>
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <p className="flex-1 text-sm font-medium text-text-primary">
                      {ENTITLEMENT_KIND_LABELS[ent.kind]} <span className="font-normal text-text-secondary">· {formatQty(u.included)} {PERIOD_LABELS[ent.period]}</span>
                    </p>
                    {u.overage > 0 && <Pill className="bg-danger/10 text-danger">{formatQty(u.overage)} over{canSeeMoney && u.overageCostCents !== null ? ` · ${formatMoney(u.overageCostCents)} billable` : ''}</Pill>}
                    {u.overage === 0 && u.included > 0 && u.elapsedPct >= 50 && u.utilizationPct < 40 && <Pill className="bg-warning-500/10 text-warning-500">Under-used</Pill>}
                    {canManage && (
                      <RowActions
                        label={ENTITLEMENT_KIND_LABELS[ent.kind]}
                        onEdit={() => entForm.start({ kind: ent.kind, included: String(ent.included_quantity), period: ent.period, overage: centsToDollarsText(ent.overage_rate_cents) }, ent.id)}
                        onDelete={() => setDeletingEnt({ id: ent.id, label: ENTITLEMENT_KIND_LABELS[ent.kind] })}
                      />
                    )}
                  </div>
                  <ProgressBar pct={u.utilizationPct} tone={tone} label={`${ENTITLEMENT_KIND_LABELS[ent.kind]} used`} />
                  <p className="mt-1 text-xs text-text-secondary">
                    {formatQty(u.used)} used · {formatQty(u.remaining)} left{u.scheduled > 0 ? ` · ${formatQty(u.scheduled)} scheduled` : ''} · {formatPct(u.utilizationPct)} of allowance · window {formatDate(toDateKey(u.window.start))} – {formatDate(toDateKey(new Date(u.window.end.getTime() - 86_400_000)))}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="Visit ledger"
        description="Every visit and hour consumed against the agreement. Completing a maintenance visit also advances its plan."
        action={
          canManage ? (
            <Button size="sm" onClick={() => visitForm.start(emptyVisit())} disabled={visitForm.open}>
              <Plus size={14} aria-hidden="true" /> Record visit
            </Button>
          ) : undefined
        }
      >
        {visitForm.open && (
          <form onSubmit={submitVisit} className="mb-4 grid gap-3 rounded-lg border border-border bg-bg-primary p-4 sm:grid-cols-2">
            <SelectField label="Counts against" value={visitForm.form.kind} onChange={(v) => visitForm.patch({ kind: v })} options={ENTITLEMENT_KIND_OPTIONS.map((k) => ({ value: k, label: ENTITLEMENT_KIND_LABELS[k] }))} />
            <SelectField label="Status" value={visitForm.form.status} onChange={(v) => visitForm.patch({ status: v })} options={VISIT_STATUS_OPTIONS.map((s) => ({ value: s, label: VISIT_STATUS_LABELS[s] }))} />
            <Input label="Date" type="date" required value={visitForm.form.visit_date} onChange={(e) => visitForm.patch({ visit_date: e.target.value })} />
            <Input label={visitForm.form.kind === 'labor_hours' ? 'Hours' : 'Quantity'} type="number" inputMode="decimal" min={0.25} step="0.25" required value={visitForm.form.quantity} onChange={(e) => visitForm.patch({ quantity: e.target.value })} />
            <SelectField label="Linked job" value={visitForm.form.job_id} onChange={(v) => visitForm.patch({ job_id: v })} options={jobOptions} />
            <div className="flex items-end pb-3">
              <CheckField label="Billable (outside the allowance)" checked={visitForm.form.billable} onChange={(v) => visitForm.patch({ billable: v })} />
            </div>
            <div className="sm:col-span-2">
              <Textarea label="Notes" rows={2} maxLength={2000} value={visitForm.form.notes} onChange={(e) => visitForm.patch({ notes: e.target.value })} />
            </div>
            {formError && <p className="text-sm text-danger sm:col-span-2" role="alert">{formError}</p>}
            <div className="sm:col-span-2">
              <FormActions busy={busy} onCancel={() => { setFormError(null); visitForm.close(); }} submitLabel={visitForm.editingId ? 'Save changes' : 'Record visit'} />
            </div>
          </form>
        )}

        {data.visits.length === 0 ? (
          <EmptyState icon={Ticket} title="No visits recorded" description="Record visits as they happen, or schedule them from the maintenance plans." />
        ) : (
          <ul className="divide-y divide-border">
            {data.visits.slice(0, 60).map((v) => {
              const plan = v.pm_plan_id ? planById.get(v.pm_plan_id) : undefined;
              const label = `${ENTITLEMENT_KIND_LABELS[v.entitlement_kind]} · ${formatDate(v.visit_date)}`;
              return (
                <li key={v.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary">{label}</p>
                    <p className="truncate text-xs text-text-secondary">
                      {plan ? plan.name : 'Ad-hoc'} · qty {formatQty(v.quantity)}
                      {v.billable ? ' · billable' : ''}
                      {v.job_id ? ' · linked to a job' : ''}
                      {v.notes ? ` · ${v.notes}` : ''}
                    </p>
                  </div>
                  <Pill className={VISIT_STATUS_STYLES[v.status]}>{VISIT_STATUS_LABELS[v.status]}</Pill>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      {v.status === 'scheduled' && (
                        <>
                          <Button size="sm" variant="secondary" disabled={busy} aria-label={`Mark ${label} completed`} onClick={() => run(() => updateAgreementRow('agreement_visits', v.id, { status: 'completed' }), 'Visit completed.')}>
                            <Check size={14} aria-hidden="true" /> Complete
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busy} aria-label={`Mark ${label} missed`} onClick={() => run(() => updateAgreementRow('agreement_visits', v.id, { status: 'missed' }), 'Marked as missed.')}>
                            <X size={14} aria-hidden="true" /> Missed
                          </Button>
                        </>
                      )}
                      <RowActions
                        label={label}
                        onEdit={() => visitForm.start({ kind: v.entitlement_kind, visit_date: v.visit_date, status: v.status, quantity: String(v.quantity), billable: v.billable, job_id: v.job_id ?? '', notes: v.notes ?? '' }, v.id)}
                        onDelete={() => setDeletingVisit({ id: v.id, label })}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <DeleteConfirm target={deletingEnt} noun="allowance" onCancel={() => setDeletingEnt(null)} onConfirm={async (id) => { await run(() => deleteAgreementRow('agreement_entitlements', id), 'Allowance deleted.'); setDeletingEnt(null); }} />
      <DeleteConfirm target={deletingVisit} noun="visit" onCancel={() => setDeletingVisit(null)} onConfirm={async (id) => { await run(() => deleteAgreementRow('agreement_visits', id), 'Visit deleted.'); setDeletingVisit(null); }} />
    </>
  );
}

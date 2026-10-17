import { useMemo, useState } from 'react';
import { CalendarClock, Pencil, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyStateInline } from '@/components/EmptyState';
import { updateProject } from '@/lib/installProjectsApi';
import {
  SCHEDULE_LABEL,
  billingBalance,
  billingSummary,
  centsToDollarsInput,
  dollarsToCents,
  formatDate,
  formatMoney,
  formatPercent,
  marginForecast,
  materialsSummary,
  projectProgress,
  scheduleHealth,
  type ProjectFormValues,
} from '@/lib/installProjects';
import { ProjectForm } from './ProjectForm';
import { Pill, ProgressBar, SectionHeader, Stat, marginTone, panelClass, scheduleTone, useAction, type TabProps } from './projectUi';

export function OverviewTab({ ownerId, bundle, today, onChanged }: TabProps) {
  const { project, phases, milestones, billing, materials, invoices } = bundle;
  const { busyKey, run } = useAction(onChanged);
  const [editing, setEditing] = useState(false);

  const progress = projectProgress(project, phases, milestones);
  const health = useMemo(() => scheduleHealth(project, phases, milestones, today), [project, phases, milestones, today]);
  const bill = useMemo(() => billingSummary(project, billing, invoices, today), [project, billing, invoices, today]);
  const margin = useMemo(() => marginForecast(project, materialsSummary(materials).totalCents), [project, materials]);
  const balance = billingBalance(bill.billedPercent, progress);
  const phaseName = (id: string) => phases.find((p) => p.id === id)?.name ?? '';
  const upcoming = milestones
    .filter((m) => m.status === 'pending')
    .sort((a, b) => (a.due_date ?? '9999') .localeCompare(b.due_date ?? '9999'))
    .slice(0, 6);

  const initial: ProjectFormValues = {
    name: project.name,
    customerId: project.customer_id ?? '',
    customerName: project.customer_name,
    siteAddress: project.site_address ?? '',
    projectType: project.project_type,
    contractValue: centsToDollarsInput(project.contract_value_cents),
    laborEstimate: centsToDollarsInput(project.estimated_labor_cost_cents),
    retainagePercent: String(project.retainage_percent),
    startDate: project.start_date ?? '',
    targetEndDate: project.target_end_date ?? '',
    notes: project.notes ?? '',
    useTemplate: false,
  };

  const save = async (v: ProjectFormValues) => {
    const ok = await run(
      'edit',
      () =>
        updateProject(ownerId, project.id, {
          name: v.name.trim(),
          customer_name: v.customerName.trim(),
          site_address: v.siteAddress.trim() || null,
          contract_value_cents: dollarsToCents(v.contractValue) ?? 0,
          estimated_labor_cost_cents: dollarsToCents(v.laborEstimate) ?? 0,
          retainage_percent: Number(v.retainagePercent || 0),
          start_date: v.startDate || null,
          target_end_date: v.targetEndDate || null,
          notes: v.notes.trim() || null,
        }),
      'Project updated.',
    );
    if (ok) setEditing(false);
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Progress" value={`${progress}%`} hint={`${milestones.filter((m) => m.status === 'done').length} of ${milestones.filter((m) => m.status !== 'skipped').length} milestones`} />
        <Stat label="Contract" value={formatMoney(project.contract_value_cents, true)} hint={project.retainage_percent > 0 ? `${formatPercent(project.retainage_percent, 1)} retainage` : 'No retainage'} />
        <Stat label="Collected" value={formatMoney(bill.paidCents, true)} hint={`${formatMoney(bill.outstandingCents, true)} outstanding`} tone={bill.overdueCents > 0 ? 'danger' : undefined} />
        <Stat
          label="Forecast margin"
          value={margin.marginPercent === null ? '—' : formatPercent(margin.marginPercent, 1)}
          hint={`${formatMoney(margin.marginCents, true)} after ${formatMoney(margin.costCents, true)} cost`}
          tone={margin.level === 'at_risk' ? 'danger' : margin.level === 'thin' ? 'warning' : margin.level === 'healthy' ? 'success' : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={panelClass} aria-labelledby="schedule-heading">
          <SectionHeader title="Schedule health" action={<Pill tone={scheduleTone[health.state]}>{SCHEDULE_LABEL[health.state]}</Pill>} />
          <p id="schedule-heading" className="sr-only">Schedule health</p>
          <ProgressBar value={progress} label="Project progress" tone={health.state === 'late' ? 'danger' : health.state === 'at_risk' ? 'warning' : 'info'} />
          <p className="mt-3 text-sm text-text-secondary">{health.reason}</p>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-text-secondary">Start</dt><dd className="text-text-primary">{formatDate(project.start_date)}</dd></div>
            <div><dt className="text-xs text-text-secondary">Target end</dt><dd className="text-text-primary">{formatDate(project.target_end_date)}{health.daysToTarget !== null && project.status === 'active' ? ` (${health.daysToTarget >= 0 ? `${health.daysToTarget}d left` : `${-health.daysToTarget}d over`})` : ''}</dd></div>
          </dl>
        </section>

        <section className={panelClass}>
          <SectionHeader title="Billing vs. progress" />
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex justify-between text-xs text-text-secondary"><span>Invoiced</span><span>{formatPercent(bill.billedPercent, 0)}</span></div>
              <ProgressBar value={bill.billedPercent} label="Percent of contract invoiced" tone="info" />
            </div>
            <div>
              <div className="mb-1 flex justify-between text-xs text-text-secondary"><span>Work complete</span><span>{progress}%</span></div>
              <ProgressBar value={progress} label="Percent of work complete" tone="success" />
            </div>
          </div>
          {project.contract_value_cents > 0 && balance.state !== 'balanced' && (
            <p className={`mt-3 flex items-start gap-2 rounded-xl p-3 text-sm ${balance.state === 'ahead' ? 'bg-warning-500/10 text-warning-500' : 'bg-accent/10 text-accent'}`}>
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              {balance.state === 'ahead'
                ? `Billing is ${balance.gap} points ahead of completed work — a cash-flow and dispute risk if the job slips.`
                : `Work is ${-balance.gap} points ahead of billing — you may be able to invoice the next step.`}
            </p>
          )}
          {bill.overdueCents > 0 && <p className="mt-3 text-sm text-danger-500">{formatMoney(bill.overdueCents)} is past due.</p>}
        </section>
      </div>

      <section className={panelClass}>
        <SectionHeader title="Next milestones" />
        {upcoming.length === 0 ? (
          <EmptyStateInline text="All milestones are complete or none have been added yet." />
        ) : (
          <ul className="divide-y divide-border">
            {upcoming.map((m) => {
              const late = m.due_date !== null && m.due_date < today;
              return (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">{m.title}</p>
                    <p className="text-xs text-text-secondary">{phaseName(m.phase_id)}</p>
                  </div>
                  <span className={`flex items-center gap-1.5 text-xs ${late ? 'font-semibold text-danger-500' : 'text-text-secondary'}`}>
                    <CalendarClock size={14} aria-hidden="true" />
                    {m.due_date ? formatDate(m.due_date) : 'No due date'}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader
          title="Project details"
          action={!editing && <Button variant="secondary" size="sm" onClick={() => setEditing(true)}><Pencil size={14} aria-hidden="true" /> Edit</Button>}
        />
        {editing ? (
          <ProjectForm mode="edit" initial={initial} submitting={busyKey === 'edit'} onSubmit={save} onCancel={() => setEditing(false)} />
        ) : (
          <div className={`${panelClass} grid gap-4 text-sm sm:grid-cols-2`}>
            <div><p className="text-xs text-text-secondary">Customer</p><p className="text-text-primary">{project.customer_name}</p></div>
            <div><p className="text-xs text-text-secondary">Site</p><p className="text-text-primary">{project.site_address || '—'}</p></div>
            <div><p className="text-xs text-text-secondary">Estimated labor</p><p className="text-text-primary">{formatMoney(project.estimated_labor_cost_cents)}</p></div>
            <div><p className="text-xs text-text-secondary">Material cost</p><p className="text-text-primary">{formatMoney(materialsSummary(materials).totalCents)}</p></div>
            <div className="sm:col-span-2"><p className="text-xs text-text-secondary">Notes</p><p className="whitespace-pre-wrap text-text-primary">{project.notes || '—'}</p></div>
            <div><Pill tone={marginTone[margin.level]}>{margin.level === 'unknown' ? 'Margin unknown' : `Margin ${margin.level.replace('_', ' ')}`}</Pill></div>
          </div>
        )}
      </section>
    </div>
  );
}

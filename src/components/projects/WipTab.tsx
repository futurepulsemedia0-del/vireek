import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ClipboardList, Download, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyStateError } from '@/components/EmptyState';
import { Skeleton, SkeletonCard } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { COST_CATEGORY_LABELS } from '@/lib/jobCosting';
import { centsToDollarsInput, dollarsToCents, formatDate, formatMoney, formatPercent, friendlyError } from '@/lib/installProjects';
import { WIP_CATEGORIES, WIP_METHOD_LABEL, buildWipReport, wipCsvFilename, wipToCsv, type WipMethod } from '@/lib/projectWip';
import { fetchWipSourceData, type WipSourceData } from '@/lib/projectWipApi';
import { Pill, ProgressBar, SectionHeader, Stat, panelClass, selectClass, type TabProps } from './projectUi';

function Line({ label, value, hint, tone, strong }: { label: string; value: ReactNode; hint?: string; tone?: 'danger' | 'warning' | 'success'; strong?: boolean }) {
  const color = tone === 'danger' ? 'text-danger-500' : tone === 'warning' ? 'text-warning-500' : tone === 'success' ? 'text-success-500' : 'text-text-primary';
  return (
    <div className={`flex items-start justify-between gap-4 py-2.5 text-sm ${strong ? 'font-semibold' : ''}`}>
      <dt className="min-w-0 text-text-secondary">
        {label}
        {hint && <span className="block text-xs font-normal">{hint}</span>}
      </dt>
      <dd className={`shrink-0 tabular-nums ${color}`}>{value}</dd>
    </div>
  );
}

function downloadCsv(text: string, filename: string) {
  // UTF-8 BOM so Excel reads non-Latin customer names correctly.
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function WipTab({ ownerId, bundle, today }: TabProps) {
  const { project, phases, milestones, billing, materials, invoices, jobs } = bundle;
  const { toast } = useToast();
  const [source, setSource] = useState<WipSourceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [method, setMethod] = useState<WipMethod>('cost');
  const [includeMaterials, setIncludeMaterials] = useState(true);
  const [budgetInput, setBudgetInput] = useState('');

  const jobIdsKey = useMemo(() => jobs.map((j) => j.job_id).sort().join(','), [jobs]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    fetchWipSourceData(ownerId, jobIdsKey ? jobIdsKey.split(',') : [])
      .then((data) => {
        if (cancelled) return;
        setSource(data);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadFailed(true);
        setLoading(false);
        toast(friendlyError(e, 'Could not load job costs.'), 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, jobIdsKey, reloadKey, toast]);

  const budgetCents = budgetInput.trim() === '' ? null : dollarsToCents(budgetInput);
  const budgetInvalid = budgetInput.trim() !== '' && budgetCents === null;

  const report = useMemo(
    () =>
      source
        ? buildWipReport(
            {
              project,
              phases,
              milestones,
              billing,
              materials,
              invoices,
              costEntries: source.costEntries,
              expenseCents: source.expenseCents,
              expensesAvailable: source.expensesAvailable,
              linkedJobCount: jobs.length,
              today,
            },
            { method, includeProjectMaterials: includeMaterials, budgetOverrideCents: budgetCents },
          )
        : null,
    [source, project, phases, milestones, billing, materials, invoices, jobs.length, today, method, includeMaterials, budgetCents],
  );

  if (loadFailed && !source) {
    return <EmptyStateError icon={ClipboardList} title="Could not load the WIP report" onRetry={() => setReloadKey((k) => k + 1)} />;
  }
  if (!report) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading WIP report">
        <Skeleton className="h-6 w-48" />
        <SkeletonCard rows={3} />
        <SkeletonCard rows={4} />
      </div>
    );
  }

  const margin = report.projectedMarginPercent;
  const marginTone = margin === null ? undefined : margin >= 25 ? 'success' : margin >= 10 ? 'warning' : 'danger';
  const positionLabel = report.billingPosition === 'over' ? 'Overbilled' : report.billingPosition === 'under' ? 'Underbilled' : 'Billed = earned';
  const positionValue = report.billingPosition === 'over' ? report.overbilledCents : report.underbilledCents;
  const positionHint =
    report.billingPosition === 'over'
      ? 'Billings in excess of earned revenue (liability)'
      : report.billingPosition === 'under'
        ? 'Earned revenue not yet billed (asset)'
        : 'Billings match earned revenue';

  return (
    <div className="space-y-6">
      <SectionHeader
        title="WIP report"
        description={`Work in progress as of ${formatDate(today)} · ${WIP_METHOD_LABEL[report.method]}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" disabled={loading} onClick={() => setReloadKey((k) => k + 1)}>
              <RefreshCw size={14} aria-hidden="true" className={loading ? 'animate-spin' : undefined} /> Refresh
            </Button>
            <Button size="sm" onClick={() => downloadCsv(wipToCsv([report]), wipCsvFilename(report))}>
              <Download size={14} aria-hidden="true" /> Export CSV
            </Button>
          </div>
        }
      />

      <section className={`${panelClass} grid gap-4 sm:grid-cols-3`} aria-label="Report settings">
        <div>
          <label htmlFor="wip-method" className="mb-1.5 block text-sm font-medium text-text-primary">% complete method</label>
          <select id="wip-method" className={selectClass} value={method} onChange={(e) => setMethod(e.target.value as WipMethod)}>
            <option value="cost">{WIP_METHOD_LABEL.cost} (cost ÷ estimated cost)</option>
            <option value="milestone">{WIP_METHOD_LABEL.milestone} (phases &amp; milestones)</option>
          </select>
          {report.method !== report.methodRequested && <p className="mt-1.5 text-xs text-warning-500">Using milestone progress — no estimated cost is set.</p>}
        </div>
        <Input
          label="Estimated total cost ($)"
          inputMode="decimal"
          placeholder={centsToDollarsInput(report.budgetCents)}
          value={budgetInput}
          onChange={(e) => setBudgetInput(e.target.value)}
          error={budgetInvalid ? 'Enter a dollar amount, e.g. 12000 or 12,000.00.' : undefined}
          helperText={budgetInput.trim() === '' ? 'Default: estimated labor + project materials. Type to override (this view only).' : 'Override applies to this view only.'}
          className="py-2.5 text-sm"
        />
        <label className="flex cursor-pointer items-start gap-2.5 self-start pt-7 text-sm text-text-primary">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" checked={includeMaterials} onChange={(e) => setIncludeMaterials(e.target.checked)} />
          <span>
            Include delivered project materials
            <span className="block text-xs text-text-secondary">Turn off if the same purchases are already logged as job costs.</span>
          </span>
        </label>
      </section>

      {report.warnings.length > 0 && (
        <ul className="space-y-2" aria-label="Report notices">
          {report.warnings.map((w) => (
            <li key={w} className="flex items-start gap-2 rounded-xl bg-warning-500/10 p-3 text-sm text-warning-500">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              {w}
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Contract value" value={formatMoney(report.contractCents, true)} hint={`${formatMoney(report.backlogCents, true)} backlog`} />
        <Stat label="Cost to date" value={formatMoney(report.costToDateCents, true)} hint={`of ${formatMoney(report.budgetCents, true)} estimated`} tone={report.budgetCents > 0 && report.costToDateCents > report.budgetCents ? 'danger' : undefined} />
        <Stat label="% complete" value={formatPercent(report.percentComplete, 1)} hint={WIP_METHOD_LABEL[report.method]} />
        <Stat label="Earned revenue" value={formatMoney(report.earnedRevenueCents, true)} hint={`${formatMoney(report.grossProfitToDateCents, true)} gross profit to date`} tone={report.grossProfitToDateCents < 0 ? 'danger' : undefined} />
        <Stat label="Billed to date" value={formatMoney(report.billedToDateCents, true)} hint={`${formatMoney(report.collectedCents, true)} collected`} />
        <Stat label={positionLabel} value={formatMoney(positionValue, true)} hint={positionHint} tone={report.billingPosition === 'over' ? 'warning' : undefined} />
        <Stat label="Projected profit" value={formatMoney(report.projectedProfitCents, true)} hint={`${formatMoney(report.projectedCostCents, true)} projected cost`} tone={report.projectedProfitCents < 0 ? 'danger' : undefined} />
        <Stat
          label="Projected margin"
          value={margin === null ? '—' : formatPercent(margin, 1)}
          hint={report.marginDeltaPoints === null ? 'No bid margin to compare' : `${report.marginDeltaPoints > 0 ? '+' : ''}${report.marginDeltaPoints.toFixed(1)} pts vs. ${formatPercent(report.bidMarginPercent, 1)} bid`}
          tone={marginTone}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={panelClass} aria-labelledby="wip-cost-heading">
          <SectionHeader title="Cost to date" />
          <p id="wip-cost-heading" className="sr-only">Cost to date</p>
          <ProgressBar value={report.budgetCents > 0 ? (report.costToDateCents / report.budgetCents) * 100 : 0} label="Cost to date as a share of estimated cost" tone={report.budgetCents > 0 && report.costToDateCents > report.budgetCents ? 'danger' : 'info'} />
          <dl className="mt-2 divide-y divide-border">
            {WIP_CATEGORIES.filter((c) => report.costByCategory[c] !== 0).map((c) => (
              <Line key={c} label={`${COST_CATEGORY_LABELS[c]} (job costs)`} value={formatMoney(report.costByCategory[c])} />
            ))}
            {report.expensesCents > 0 && <Line label="Approved expenses" value={formatMoney(report.expensesCents)} />}
            {report.projectMaterialsCents > 0 && <Line label="Delivered project materials" value={formatMoney(report.projectMaterialsCents)} />}
            {report.costToDateCents === 0 && <Line label="No cost recorded yet" value={formatMoney(0)} />}
            <Line label="Total cost to date" value={formatMoney(report.costToDateCents)} strong />
          </dl>
        </section>

        <section className={panelClass} aria-labelledby="wip-schedule-heading">
          <SectionHeader title="WIP schedule" action={<Pill tone={report.billingPosition === 'over' ? 'warning' : report.billingPosition === 'under' ? 'info' : 'success'}>{positionLabel}</Pill>} />
          <p id="wip-schedule-heading" className="sr-only">WIP schedule</p>
          <dl className="divide-y divide-border">
            <Line label="Contract value" value={formatMoney(report.contractCents)} />
            <Line label="Earned revenue" value={formatMoney(report.earnedRevenueCents)} hint={`${formatPercent(report.percentComplete, 1)} complete`} />
            <Line label="Billed to date (gross)" value={formatMoney(report.billedToDateCents)} />
            <Line label={report.billingPosition === 'under' ? 'Underbilled' : 'Overbilled'} value={formatMoney(report.billingPosition === 'under' ? report.underbilledCents : report.overbilledCents)} tone={report.billingPosition === 'over' ? 'warning' : undefined} />
            <Line label="Estimated cost to complete" value={formatMoney(report.costToCompleteCents)} />
            <Line label="Projected total cost" value={formatMoney(report.projectedCostCents)} />
            <Line label="Projected profit" value={formatMoney(report.projectedProfitCents)} tone={report.projectedProfitCents < 0 ? 'danger' : undefined} strong />
            {report.lossProvisionCents > 0 && <Line label="Loss provision" hint="Additional loss to recognise now on a losing contract" value={formatMoney(report.lossProvisionCents)} tone="danger" />}
            <Line label="Collected" value={formatMoney(report.collectedCents)} />
            <Line label="Outstanding" value={formatMoney(report.outstandingCents)} />
            <Line label="Retainage held" value={formatMoney(report.retainageHeldCents)} />
          </dl>
        </section>
      </div>

      <p className="text-xs text-text-secondary">
        Cost to date counts job-cost entries on linked jobs, approved expense allocations on those jobs, and project materials marked delivered or installed. Earned revenue = contract value × % complete. Projected cost = cost to date + the part of the estimate not yet earned. Cost-to-cost holds projected cost at the estimate until it is overrun — switch to milestone progress to see overruns earlier.
      </p>
    </div>
  );
}

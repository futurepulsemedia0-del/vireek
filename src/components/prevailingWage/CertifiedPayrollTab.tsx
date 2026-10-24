import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calculator, Download, FileText, Info, ShieldCheck, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  certifyFresh,
  computeJobWeek,
  discardDraft,
  fetchReport,
  fetchReports,
  saveDraft,
  voidReport,
  type JobAssignment,
  type JobLite,
  type JobWeekComputation,
  type ReportRow,
  type RuleSetRow,
} from '@/lib/prevailingWageApi';
import { addDays, formatHours, formatMoney, isIsoDate, parseMoneyToCents, workweekEnding } from '@/lib/prevailingWage';
import { buildLinesCsv, buildWorkersCsv, reportFileName, type ReportDeductions } from '@/lib/prevailingWageExport';
import { generateCertifiedPayrollPdf, saveFile } from '@/lib/prevailingWagePdf';
import { Pill, SectionTitle, Select, errMsg, todayIso } from './shared';

interface Props {
  canEdit: boolean;
  jobs: JobLite[];
  assignments: JobAssignment[];
  ruleSets: RuleSetRow[];
  loading: boolean;
}

interface DedForm {
  fica: string;
  withholding: string;
  other: string;
}

const STATUS_TONE = { draft: 'warn', certified: 'good', void: 'neutral' } as const;
const shortDate = (iso: string) => iso.slice(5).replace('-', '/');

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg-secondary p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-secondary">{sub}</p>}
    </div>
  );
}

export function CertifiedPayrollTab({ canEdit, jobs, assignments, ruleSets, loading }: Props) {
  const { toast } = useToast();
  const [jobId, setJobId] = useState('');
  const [weekEnding, setWeekEnding] = useState('');
  const [comp, setComp] = useState<JobWeekComputation | null>(null);
  const [busy, setBusy] = useState<'calc' | 'save' | 'certify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ded, setDed] = useState<Record<string, DedForm>>({});
  const [isFinal, setIsFinal] = useState(false);
  const [noWork, setNoWork] = useState(false);
  const [showEntries, setShowEntries] = useState(false);
  const [certifyOpen, setCertifyOpen] = useState(false);
  const [signer, setSigner] = useState('');
  const [signerTitle, setSignerTitle] = useState('');
  const [ack, setAck] = useState(false);
  const [reports, setReports] = useState<ReportRow[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [voiding, setVoiding] = useState<ReportRow | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [discarding, setDiscarding] = useState<ReportRow | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  const assignedJobs = useMemo(() => {
    const ids = new Set(assignments.map((a) => a.jobId));
    return jobs.filter((j) => ids.has(j.id));
  }, [jobs, assignments]);
  const assignment = assignments.find((a) => a.jobId === jobId) ?? null;
  const startDow = ruleSets.find((r) => r.id === assignment?.ruleSetId)?.workweekStartDow ?? 0;

  const loadReports = useCallback(async (id: string) => {
    setReportsLoading(true);
    try {
      setReports(await fetchReports(id));
    } catch (e) {
      toast(errMsg(e, 'Could not load payroll history.'), 'error');
    } finally {
      setReportsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    setComp(null);
    setError(null);
    setCertifyOpen(false);
    setAck(false);
    setDed({});
    setIsFinal(false);
    setNoWork(false);
    if (jobId) {
      setWeekEnding(addDays(workweekEnding(todayIso(), startDow), -7));
      void loadReports(jobId);
    } else {
      setReports([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const dedCents = (): Record<string, ReportDeductions> | null => {
    const out: Record<string, ReportDeductions> = {};
    for (const [id, f] of Object.entries(ded)) {
      const fica = parseMoneyToCents(f.fica || '0');
      const wh = parseMoneyToCents(f.withholding || '0');
      const other = parseMoneyToCents(f.other || '0');
      if (fica === null || wh === null || other === null) return null;
      out[id] = { ficaCents: fica, withholdingCents: wh, otherCents: other };
    }
    return out;
  };

  const calculate = async () => {
    if (!jobId || !isIsoDate(weekEnding)) return setError('Choose a job and a week.');
    setBusy('calc');
    setError(null);
    setCertifyOpen(false);
    try {
      setComp(await computeJobWeek(jobId, weekEnding));
    } catch (e) {
      setComp(null);
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const guardedInput = () => {
    const deductions = dedCents();
    if (deductions === null) {
      setError('Deductions must be dollar amounts like 125.50.');
      return null;
    }
    return { jobId, weekEnding, isFinal, noWork, deductions };
  };

  const onSaveDraft = async () => {
    const input = guardedInput();
    if (!input) return;
    setBusy('save');
    setError(null);
    try {
      const r = await saveDraft(input);
      setComp(r.computation);
      toast('Draft saved. Download it from the history below.', 'success');
      await loadReports(jobId);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const onCertify = async () => {
    const input = guardedInput();
    if (!input) return;
    setBusy('certify');
    setError(null);
    try {
      await certifyFresh({ ...input, signerName: signer, signerTitle });
      toast('Payroll certified and locked.', 'success');
      setCertifyOpen(false);
      setAck(false);
      await Promise.all([loadReports(jobId), calculate()]);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const exportReport = async (r: ReportRow, kind: 'lines' | 'workers' | 'pdf') => {
    setExporting(`${r.id}:${kind}`);
    try {
      const full = await fetchReport(r.id);
      const snap = full.snapshot;
      if (kind === 'lines') saveFile(buildLinesCsv(snap, r.payrollNumber), reportFileName(snap, r.payrollNumber, 'lines', 'csv'));
      else if (kind === 'workers') saveFile(buildWorkersCsv(snap, r.payrollNumber), reportFileName(snap, r.payrollNumber, 'workers', 'csv'));
      else {
        const blob = await generateCertifiedPayrollPdf(snap, r.payrollNumber, { name: r.certifiedByName ?? '', title: r.certifiedByTitle, certifiedAt: r.certifiedAt, status: r.status });
        saveFile(blob, reportFileName(snap, r.payrollNumber, 'report', 'pdf'), 'application/pdf');
      }
    } catch (e) {
      toast(errMsg(e, 'Could not create the export.'), 'error');
    } finally {
      setExporting(null);
    }
  };

  const confirmVoid = async () => {
    if (!voiding) return;
    try {
      await voidReport(voiding.id, voidReason);
      toast('Payroll voided. You can now issue a corrected one for the same week.', 'success');
      setVoiding(null);
      setVoidReason('');
      await loadReports(jobId);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const confirmDiscard = async () => {
    if (!discarding) return;
    try {
      await discardDraft(discarding.id);
      toast('Draft discarded.', 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setDiscarding(null);
      await loadReports(jobId);
    }
  };

  if (loading) return <SkeletonCardList count={3} />;

  if (assignedJobs.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No jobs are set up for prevailing wage"
        description="Attach a wage table and overtime rule set to a job in the Job setup tab, then calculate its certified payroll here."
      />
    );
  }

  const r = comp?.result;
  const errors = r?.warnings.filter((w) => w.severity === 'error') ?? [];
  const others = r?.warnings.filter((w) => w.severity !== 'error') ?? [];
  const busyAny = busy !== null;

  return (
    <div className="space-y-6">
      <Card className="p-4 sm:p-5">
        <SectionTitle hint="Calculates from approved timesheets. All of a worker's hours that week count toward overtime, not just this job's.">Certified payroll</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-[1fr_220px_auto] sm:items-end">
          <Select label="Job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">Choose a job…</option>
            {assignedJobs.map((j) => <option key={j.id} value={j.id}>{j.customer_name}{j.service_type ? ` — ${j.service_type}` : ''}</option>)}
          </Select>
          <Input
            label="Week ending"
            type="date"
            value={weekEnding}
            onChange={(e) => { setComp(null); setWeekEnding(isIsoDate(e.target.value) ? workweekEnding(e.target.value, startDow) : e.target.value); }}
            helperText="Snaps to the end of the workweek"
            disabled={!jobId}
          />
          <Button onClick={calculate} disabled={!jobId || !isIsoDate(weekEnding) || busyAny}>
            <Calculator size={16} /> {busy === 'calc' ? 'Calculating…' : 'Calculate'}
          </Button>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      </Card>

      {comp && r && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Hours (this job)" value={formatHours(r.totals.hours)} sub={`${formatHours(r.totals.premiumHours)} premium`} />
            <Stat label="Gross cash wages" value={formatMoney(r.totals.grossCashCents)} sub={`incl. ${formatMoney(r.totals.fringeCashCents)} fringe in cash`} />
            <Stat label="Fringe to plans" value={formatMoney(r.totals.fringePlanCents)} sub="employer contribution" />
            <Stat label="Workers" value={String(r.totals.workerCount)} sub={r.totals.unresolvedHours > 0 ? `${formatHours(r.totals.unresolvedHours)} h not priced` : 'all hours priced'} />
          </div>

          {(errors.length > 0 || others.length > 0) && (
            <Card className="p-4 sm:p-5">
              <SectionTitle>Review before filing</SectionTitle>
              <ul className="space-y-2">
                {errors.map((w, i) => (
                  <li key={`e${i}`} className="flex items-start gap-2 text-sm text-danger"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{w.message}</li>
                ))}
                {others.map((w, i) => (
                  <li key={`w${i}`} className={`flex items-start gap-2 text-sm ${w.severity === 'warning' ? 'text-warning-500' : 'text-text-secondary'}`}>
                    {w.severity === 'warning' ? <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> : <Info size={16} className="mt-0.5 shrink-0" aria-hidden="true" />}
                    {w.message}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="p-4 sm:p-5">
            <SectionTitle hint="One row per worker, classification and hour type. S.T. = straight time; premium rows show overtime, double-time or weekend/holiday pay.">
              Payroll register — week {r.weekStart} to {r.weekEnding}
            </SectionTitle>
            {r.lines.length === 0 ? (
              <EmptyState icon={FileText} title="No priced hours this week" description="Either no approved timesheets were logged on this job, or hours are waiting on a classification or rate (see above)." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-border uppercase tracking-wide text-text-secondary">
                      <th className="py-2 pr-2 font-semibold">Worker</th>
                      <th className="py-2 pr-2 font-semibold">Classification</th>
                      <th className="py-2 pr-2 font-semibold">Type</th>
                      {r.days.map((d) => <th key={d} className="py-2 pr-1 text-right font-semibold">{shortDate(d)}</th>)}
                      <th className="py-2 pr-2 text-right font-semibold">Hours</th>
                      <th className="py-2 pr-2 text-right font-semibold">Rate/hr</th>
                      <th className="py-2 pr-2 text-right font-semibold">Gross cash</th>
                      <th className="py-2 text-right font-semibold">Plan fringe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.lines.map((l) => (
                      <tr key={l.key} className="border-b border-border/60">
                        <td className="py-2 pr-2 font-medium text-text-primary">{l.employeeName}</td>
                        <td className="py-2 pr-2 text-text-secondary">{l.classification}</td>
                        <td className="py-2 pr-2"><Pill tone={l.hourType === 'ST' ? 'neutral' : 'accent'}>{l.hourType}{l.multiplierX100 !== 100 ? ` ×${l.multiplierX100 / 100}` : ''}</Pill></td>
                        {l.dayHours.map((h, i) => <td key={i} className="py-2 pr-1 text-right tabular-nums text-text-secondary">{h === 0 ? '' : formatHours(h)}</td>)}
                        <td className="py-2 pr-2 text-right font-semibold tabular-nums">{formatHours(l.hours)}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(l.cashHourlyCents)}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(l.grossCashCents)}</td>
                        <td className="py-2 text-right tabular-nums">{formatMoney(l.fringePlanCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {r.workers.some((w) => w.hours > 0) && (
            <Card className="p-4 sm:p-5">
              <SectionTitle hint="Enter the deductions your payroll provider actually withheld. They print on the report; wages are not estimated for you.">Deductions and net pay</SectionTitle>
              <div className="space-y-3">
                {r.workers.filter((w) => w.hours > 0).map((w) => {
                  const f = ded[w.employeeId] ?? { fica: '', withholding: '', other: '' };
                  const set = (patch: Partial<DedForm>) => setDed({ ...ded, [w.employeeId]: { ...f, ...patch } });
                  return (
                    <div key={w.employeeId} className="grid gap-3 sm:grid-cols-[1.2fr_repeat(3,1fr)] sm:items-end">
                      <div>
                        <p className="text-sm font-medium text-text-primary">{w.name}</p>
                        <p className="text-xs text-text-secondary">{formatHours(w.hours)} h · gross {formatMoney(w.grossCashCents)}</p>
                      </div>
                      <Input label="FICA ($)" inputMode="decimal" value={f.fica} onChange={(e) => set({ fica: e.target.value })} />
                      <Input label="Withholding ($)" inputMode="decimal" value={f.withholding} onChange={(e) => set({ withholding: e.target.value })} />
                      <Input label="Other ($)" inputMode="decimal" value={f.other} onChange={(e) => set({ other: e.target.value })} />
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          <Card className="p-4 sm:p-5">
            <button type="button" onClick={() => setShowEntries((v) => !v)} aria-expanded={showEntries} className="focus-ring rounded-lg text-sm font-semibold text-text-primary">
              {showEntries ? 'Hide' : 'Show'} per-timesheet rate application ({r.entryResults.length})
            </button>
            {showEntries && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-xs">
                  <thead>
                    <tr className="border-b border-border uppercase tracking-wide text-text-secondary">
                      <th className="py-2 pr-2 font-semibold">Date</th>
                      <th className="py-2 pr-2 font-semibold">Worker</th>
                      <th className="py-2 pr-2 font-semibold">Classification</th>
                      <th className="py-2 pr-2 text-right font-semibold">Hours</th>
                      <th className="py-2 pr-2 font-semibold">Split</th>
                      <th className="py-2 pr-2 text-right font-semibold">Cash</th>
                      <th className="py-2 text-right font-semibold">Plan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.entryResults.map((e) => (
                      <tr key={e.entryId} className="border-b border-border/60">
                        <td className="py-2 pr-2 tabular-nums">{e.workDate}</td>
                        <td className="py-2 pr-2">{r.workers.find((w) => w.employeeId === e.employeeId)?.name ?? '—'}</td>
                        <td className="py-2 pr-2 text-text-secondary">{e.classification ?? <Pill tone="bad">Missing</Pill>}</td>
                        <td className="py-2 pr-2 text-right tabular-nums">{formatHours(e.hours)}</td>
                        <td className="py-2 pr-2 text-text-secondary">
                          {(['ST', 'OT', 'DT', 'PREM'] as const).filter((t) => e.hoursByType[t] > 0).map((t) => `${t} ${formatHours(e.hoursByType[t])}`).join(' · ') || '—'}
                        </td>
                        <td className="py-2 pr-2 text-right tabular-nums">{formatMoney(e.grossCashCents)}</td>
                        <td className="py-2 text-right tabular-nums">{formatMoney(e.fringePlanCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {canEdit && (
            <Card className="p-4 sm:p-5">
              <div className="flex flex-wrap gap-6">
                <label className="flex items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" checked={isFinal} onChange={(e) => setIsFinal(e.target.checked)} className="h-4 w-4 accent-accent" />
                  Final payroll for this project
                </label>
                <label className="flex items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" checked={noWork} onChange={(e) => setNoWork(e.target.checked)} disabled={r.lines.length > 0} className="h-4 w-4 accent-accent" />
                  No work performed this week
                </label>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={onSaveDraft} disabled={busyAny}>{busy === 'save' ? 'Saving…' : 'Save draft'}</Button>
                <Button onClick={() => setCertifyOpen((v) => !v)} disabled={busyAny}><ShieldCheck size={16} /> Certify…</Button>
              </div>

              {certifyOpen && (
                <div className="mt-4 rounded-xl border border-border bg-bg-primary p-4">
                  <p className="text-sm font-semibold text-text-primary">Statement of compliance</p>
                  <p className="mt-1 text-xs text-text-secondary">
                    By certifying you state that workers were paid the full wages earned, that no unlawful deductions or rebates were taken, and that every worker was paid at least the prevailing rate and fringe for their classification. Certifying locks the wage table and the report; a correction needs a void and reissue.
                  </p>
                  {r.certifyBlockers.length > 0 && (
                    <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm text-danger">{r.certifyBlockers.map((b) => <li key={b}>{b}</li>)}</ul>
                  )}
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Input label="Full name of signer" value={signer} onChange={(e) => setSigner(e.target.value)} maxLength={160} />
                    <Input label="Title" value={signerTitle} onChange={(e) => setSignerTitle(e.target.value)} maxLength={160} />
                  </div>
                  <label className="mt-3 flex items-start gap-2 text-sm text-text-primary">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 h-4 w-4 accent-accent" />
                    <span>I have had the rates and rules reviewed by qualified legal or compliance counsel and I am authorized to certify this payroll.</span>
                  </label>
                  <div className="mt-4">
                    <Button onClick={onCertify} disabled={busyAny || r.certifyBlockers.length > 0 || !ack || signer.trim().length < 2}>
                      {busy === 'certify' ? 'Certifying…' : 'Certify payroll'}
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}
        </>
      )}

      {jobId && (
        <Card className="p-4 sm:p-5">
          <SectionTitle hint="Drafts can be replaced or discarded. Certified payrolls are immutable; void and reissue to correct.">Payroll history</SectionTitle>
          {reportsLoading ? (
            <SkeletonCardList count={2} />
          ) : reports.length === 0 ? (
            <EmptyState icon={FileText} title="No payrolls saved for this job" description="Calculate a week and save a draft or certify it." />
          ) : (
            <ul className="divide-y divide-border/60">
              {reports.map((rep) => (
                <li key={rep.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">
                        Payroll #{rep.payrollNumber} · week ending {rep.weekEnding}
                        {rep.isFinal && <span className="ml-2"><Pill tone="accent">Final</Pill></span>}
                        <span className="ml-2"><Pill tone={STATUS_TONE[rep.status]}>{rep.status === 'draft' ? 'Draft' : rep.status === 'certified' ? 'Certified' : 'Void'}</Pill></span>
                      </p>
                      <p className="text-xs text-text-secondary">
                        {rep.noWork ? 'No work performed' : `${formatHours(rep.totalHours)} h · ${formatMoney(rep.totalGrossCents)} gross · ${rep.workerCount} worker${rep.workerCount === 1 ? '' : 's'}`}
                        {rep.certifiedByName ? ` · certified by ${rep.certifiedByName}` : ''}
                        {rep.voidReason ? ` · void: ${rep.voidReason}` : ''}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={() => exportReport(rep, 'pdf')} disabled={exporting !== null}><Download size={14} /> PDF</Button>
                      <Button size="sm" variant="secondary" onClick={() => exportReport(rep, 'lines')} disabled={exporting !== null}><Download size={14} /> Lines CSV</Button>
                      <Button size="sm" variant="secondary" onClick={() => exportReport(rep, 'workers')} disabled={exporting !== null}><Download size={14} /> Workers CSV</Button>
                      {canEdit && rep.status === 'draft' && <Button size="sm" variant="ghost" onClick={() => setDiscarding(rep)}><Trash2 size={14} /> Discard</Button>}
                      {canEdit && rep.status === 'certified' && <Button size="sm" variant="ghost" onClick={() => { setVoidReason(''); setVoiding(rep); }}>Void…</Button>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {voiding && (
        <Card className="p-4 sm:p-5">
          <SectionTitle>Void payroll #{voiding.payrollNumber}</SectionTitle>
          <Input label="Reason (required)" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} maxLength={500} />
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={confirmVoid} disabled={voidReason.trim().length < 5}>Void payroll</Button>
            <Button size="sm" variant="ghost" onClick={() => setVoiding(null)}>Cancel</Button>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={!!discarding}
        title="Discard this draft?"
        description="The draft is deleted. You can calculate and save the week again."
        confirmLabel="Discard draft"
        onConfirm={confirmDiscard}
        onCancel={() => setDiscarding(null)}
      />
    </div>
  );
}

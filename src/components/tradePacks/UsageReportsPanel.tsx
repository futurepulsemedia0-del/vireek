import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Eye, FileText, Loader2, Printer, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import {
  downloadCsv,
  fetchSavedReportPayload,
  fetchSavedReports,
  fetchUsageReport,
  finalizeUsageReport,
  friendlyReportError,
  markReportFiled,
  verifySavedReport,
  type SavedUsageReport,
} from '@/lib/pesticideReportsApi';
import {
  FLAG_LABELS,
  PERIOD_PRESET_LABELS,
  describeWindow,
  detailCsv,
  formatAmount,
  monthlyBreakdown,
  productSummaryCsv,
  readinessIssues,
  reportFileName,
  resolvePeriod,
  rowFlags,
  toDateInput,
  unitShort,
  type PeriodPreset,
  type UsageReport,
} from '@/lib/pesticideReports';
import { Pill, SelectField, fmtDate, fmtDateTime } from './shared';

const PRESETS = Object.keys(PERIOD_PRESET_LABELS) as PeriodPreset[];
const ROW_PREVIEW = 100;

type Status = 'loading' | 'ready' | 'error';
type VerifyState = 'checking' | 'ok' | 'bad';

function Kpi({ label, value, tone }: { label: string; value: number; tone?: 'warning' }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone === 'warning' && value > 0 ? 'text-warning' : 'text-text-primary'}`}>{value.toLocaleString()}</p>
    </div>
  );
}

const th = 'whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-text-secondary';
const td = 'px-3 py-2 align-top text-text-primary';

export function UsageReportsPanel({ ownerId, canManage }: { ownerId: string; canManage: boolean }) {
  const { toast } = useToast();

  // ---- controls ----
  const [preset, setPreset] = useState<PeriodPreset>('last_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState(toDateInput(new Date()));
  const [restrictedOnly, setRestrictedOnly] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // ---- current report ----
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [windowIso, setWindowIso] = useState<{ from: string; to: string } | null>(null);
  const [sealedId, setSealedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const reqId = useRef(0);

  // ---- sealing ----
  const [sealOpen, setSealOpen] = useState(false);
  const [jurisdiction, setJurisdiction] = useState('');
  const [note, setNote] = useState('');
  const [sealing, setSealing] = useState(false);

  // ---- saved reports ----
  const [saved, setSaved] = useState<SavedUsageReport[]>([]);
  const [savedLoading, setSavedLoading] = useState(true);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [verify, setVerify] = useState<Record<string, VerifyState>>({});
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);
  const [fileRef, setFileRef] = useState('');
  const [filing, setFiling] = useState(false);

  const loadSaved = useCallback(async () => {
    try {
      setSaved(await fetchSavedReports(ownerId));
      setSavedError(null);
    } catch (e) {
      setSavedError(friendlyReportError(e, 'Could not load saved reports.'));
    } finally {
      setSavedLoading(false);
    }
  }, [ownerId]);

  const run = useCallback(async () => {
    const period = resolvePeriod(preset, new Date(), { from: customFrom, to: customTo });
    if ('error' in period) {
      setFormError(period.error);
      return;
    }
    setFormError(null);
    const id = ++reqId.current;
    setStatus('loading');
    setError(null);
    try {
      const r = await fetchUsageReport(period.from, period.to, restrictedOnly);
      if (id !== reqId.current) return; // a newer request superseded this one
      setReport(r);
      setWindowIso({ from: period.from, to: period.to });
      setSealedId(null);
      setSealOpen(false);
      setShowAll(false);
      setStatus('ready');
    } catch (e) {
      if (id !== reqId.current) return;
      setError(friendlyReportError(e, 'Could not build the report.'));
      setStatus('error');
    }
  }, [preset, customFrom, customTo, restrictedOnly]);

  useEffect(() => {
    void run();
    void loadSaved();
    // First load only; later runs are explicit (Run report).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const months = useMemo(() => (report ? monthlyBreakdown(report.rows) : []), [report]);
  const issues = useMemo(() => (report ? readinessIssues(report) : []), [report]);
  const visibleRows = useMemo(() => (report ? (showAll ? report.rows : report.rows.slice(0, ROW_PREVIEW)) : []), [report, showAll]);
  const periodLabel = report ? describeWindow(report.period_from || windowIso?.from || '', report.period_to || windowIso?.to || '') : '';
  const canSeal = canManage && status === 'ready' && !!report && !sealedId && !report.truncated && report.entry_count > 0;

  const exportDetail = () => {
    if (!report) return;
    downloadCsv(reportFileName('detail', report.period_from, report.period_to), detailCsv(report));
  };
  const exportProducts = () => {
    if (!report) return;
    downloadCsv(reportFileName('products', report.period_from, report.period_to), productSummaryCsv(report));
  };

  const seal = async () => {
    if (!report || !windowIso) return;
    setSealing(true);
    try {
      await finalizeUsageReport({ fromIso: report.period_from, toIso: report.period_to, restrictedOnly: report.restricted_only, jurisdiction, note });
      toast('Report sealed and saved. It can no longer be edited.', 'success');
      setSealOpen(false);
      setJurisdiction('');
      setNote('');
      await loadSaved();
    } catch (e) {
      toast(friendlyReportError(e, 'Could not seal the report.'), 'error');
    } finally {
      setSealing(false);
    }
  };

  const openSaved = async (s: SavedUsageReport) => {
    setOpeningId(s.id);
    try {
      const r = await fetchSavedReportPayload(ownerId, s.id);
      reqId.current++; // drop any in-flight live request
      setReport(r);
      setWindowIso({ from: s.period_from, to: s.period_to });
      setSealedId(s.id);
      setSealOpen(false);
      setShowAll(false);
      setError(null);
      setStatus('ready');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      toast(friendlyReportError(e, 'Could not open that report.'), 'error');
    } finally {
      setOpeningId(null);
    }
  };

  const downloadSaved = async (s: SavedUsageReport) => {
    try {
      const r = await fetchSavedReportPayload(ownerId, s.id);
      downloadCsv(reportFileName('detail', s.period_from, s.period_to), detailCsv(r));
    } catch (e) {
      toast(friendlyReportError(e, 'Could not download that report.'), 'error');
    }
  };

  const doVerify = async (id: string) => {
    setVerify((v) => ({ ...v, [id]: 'checking' }));
    try {
      const ok = await verifySavedReport(id);
      setVerify((v) => ({ ...v, [id]: ok ? 'ok' : 'bad' }));
    } catch (e) {
      setVerify((v) => {
        const next = { ...v };
        delete next[id];
        return next;
      });
      toast(friendlyReportError(e, 'Could not verify that report.'), 'error');
    }
  };

  const doFile = async () => {
    if (!fileId) return;
    setFiling(true);
    try {
      await markReportFiled(fileId, fileRef);
      toast('Marked as filed.', 'success');
      setFileId(null);
      setFileRef('');
      await loadSaved();
    } catch (e) {
      toast(friendlyReportError(e, 'Could not mark the report as filed.'), 'error');
    } finally {
      setFiling(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ---------------- controls ---------------- */}
      <Card className="space-y-4 p-5 print:hidden">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
          <SelectField label="Reporting period" value={preset} onChange={(v) => setPreset(v as PeriodPreset)}>
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_PRESET_LABELS[p]}
              </option>
            ))}
          </SelectField>
          {preset === 'custom' && (
            <>
              <Input label="From" type="date" value={customFrom} max={customTo || undefined} onChange={(e) => setCustomFrom(e.target.value)} />
              <Input label="To" type="date" value={customTo} min={customFrom || undefined} max={toDateInput(new Date())} onChange={(e) => setCustomTo(e.target.value)} />
            </>
          )}
          <label className="flex min-h-[44px] items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={restrictedOnly} onChange={(e) => setRestrictedOnly(e.target.checked)} />
            Restricted-use products only
          </label>
        </div>
        {formError && (
          <p className="text-sm text-danger" role="alert">
            {formError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void run()} disabled={status === 'loading'} size="sm">
            {status === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} Run report
          </Button>
          <p className="text-xs text-text-secondary">Voided entries are excluded. Report formats differ by jurisdiction — check your agency’s requirements before filing.</p>
        </div>
      </Card>

      {/* ---------------- states ---------------- */}
      <div aria-live="polite">
        {status === 'loading' && (
          <div className="space-y-3" role="status" aria-label="Building report">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-20 w-full rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-48 w-full rounded-2xl" />
          </div>
        )}

        {status === 'error' && (
          <Card className="space-y-3 p-5">
            <p className="flex items-center gap-2 text-sm text-danger" role="alert">
              <AlertTriangle size={16} /> {error}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void run()}>
              <RefreshCw size={16} /> Try again
            </Button>
          </Card>
        )}

        {status === 'ready' && report && report.entry_count === 0 && (
          <EmptyState
            icon={FileText}
            title="No applications in this period"
            description={
              report.restricted_only
                ? 'No restricted-use applications were logged in this period. Try turning off the restricted-use filter or choosing a different period.'
                : 'Chemical applications logged from jobs appear here. Try a different period.'
            }
          />
        )}
      </div>

      {/* ---------------- report ---------------- */}
      {status === 'ready' && report && report.entry_count > 0 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <h3 className="flex items-center gap-2 text-lg font-semibold text-text-primary">
                Pesticide usage report <span className="text-sm font-normal text-text-secondary">{periodLabel}</span>
              </h3>
              <div className="flex flex-wrap items-center gap-2">
                {report.restricted_only && <Pill tone="warning">Restricted-use only</Pill>}
                {sealedId ? (
                  <Pill tone="success">
                    <ShieldCheck size={12} /> Sealed snapshot
                  </Pill>
                ) : (
                  <Pill>Live data</Pill>
                )}
                {report.voided_count > 0 && <Pill>{report.voided_count} voided excluded</Pill>}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 print:hidden">
              <Button variant="secondary" size="sm" onClick={exportDetail}>
                <Download size={16} /> Applications CSV
              </Button>
              <Button variant="secondary" size="sm" onClick={exportProducts}>
                <Download size={16} /> Product totals CSV
              </Button>
              <Button variant="secondary" size="sm" onClick={() => window.print()}>
                <Printer size={16} /> Print
              </Button>
              {canSeal && (
                <Button size="sm" onClick={() => setSealOpen((o) => !o)} aria-expanded={sealOpen}>
                  <ShieldCheck size={16} /> Seal &amp; save
                </Button>
              )}
            </div>
          </div>

          {report.truncated && (
            <p className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm text-danger" role="alert">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>This period has more applications than one report can hold, so the application list is cut off and the report cannot be sealed. Choose a shorter period (for example one month).</span>
            </p>
          )}

          {sealOpen && canSeal && (
            <Card className="space-y-3 p-5 print:hidden">
              <h4 className="font-semibold text-text-primary">Seal this report</h4>
              <p className="text-sm text-text-secondary">
                Sealing saves an unchangeable copy of this report with a verification code. Later corrections (voids) will not alter it. Review the gaps below first, and explain any in the note.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="Agency / jurisdiction (optional)" value={jurisdiction} maxLength={120} onChange={(e) => setJurisdiction(e.target.value)} />
                <Textarea label="Note for the record (optional)" rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void seal()} disabled={sealing}>
                  {sealing ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />} Seal report
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSealOpen(false)} disabled={sealing}>
                  Cancel
                </Button>
              </div>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Kpi label="Applications" value={report.entry_count} />
            <Kpi label="Restricted use" value={report.totals.restricted_applications} />
            <Kpi label="Products" value={report.totals.distinct_products} />
            <Kpi label="Applicators" value={report.totals.distinct_applicators} />
            <Kpi label="Sites" value={report.totals.distinct_sites} />
          </div>

          {issues.length > 0 && (
            <Card className="space-y-2 p-5">
              <h4 className="flex items-center gap-2 font-semibold text-text-primary">
                <AlertTriangle size={16} className="text-warning" /> Gaps to review before filing
              </h4>
              <ul className="space-y-1 text-sm text-text-secondary">
                {issues.map((i) => (
                  <li key={i.flag}>
                    <span className="font-medium text-text-primary">{i.count}</span> {i.label.toLowerCase()}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-text-secondary">Flagged applications are marked in the list below. Entries cannot be edited — void and re-enter, or explain the gap in the sealing note.</p>
            </Card>
          )}

          {/* by product */}
          <Card className="space-y-3 p-5">
            <h4 className="font-semibold text-text-primary">Use by product</h4>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <caption className="sr-only">Pesticide use by product and unit</caption>
                <thead className="border-b border-border">
                  <tr>
                    <th scope="col" className={th}>Product</th>
                    <th scope="col" className={th}>EPA reg. no.</th>
                    <th scope="col" className={`${th} text-right`}>Applications</th>
                    <th scope="col" className={`${th} text-right`}>Total used</th>
                    <th scope="col" className={`${th} text-right`}>Area (sq ft)</th>
                    <th scope="col" className={`${th} text-right`}>Jobs</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {report.by_product.map((p) => (
                    <tr key={`${p.product_id ?? p.product_name}-${p.amount_unit ?? ''}`}>
                      <td className={td}>
                        {p.product_name} {p.product_restricted && <Pill tone="warning">Restricted</Pill>}
                      </td>
                      <td className={td}>{p.product_epa_reg ?? '—'}</td>
                      <td className={`${td} text-right`}>{p.applications.toLocaleString()}</td>
                      <td className={`${td} text-right`}>
                        {formatAmount(p.total_amount)} {unitShort(p.amount_unit)}
                      </td>
                      <td className={`${td} text-right`}>{p.total_area_sqft > 0 ? formatAmount(p.total_area_sqft) : '—'}</td>
                      <td className={`${td} text-right`}>{p.jobs.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-text-secondary">Amounts are never added across different units.</p>
          </Card>

          {/* by applicator */}
          <Card className="space-y-3 p-5">
            <h4 className="font-semibold text-text-primary">Use by applicator</h4>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-sm">
                <caption className="sr-only">Applications by applicator and licence</caption>
                <thead className="border-b border-border">
                  <tr>
                    <th scope="col" className={th}>Applicator</th>
                    <th scope="col" className={th}>Licence</th>
                    <th scope="col" className={`${th} text-right`}>Applications</th>
                    <th scope="col" className={`${th} text-right`}>Restricted</th>
                    <th scope="col" className={`${th} text-right`}>Products</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {report.by_applicator.map((a) => (
                    <tr key={`${a.technician_id ?? a.technician_name}-${a.credential_number ?? 'none'}`}>
                      <td className={td}>{a.technician_name}</td>
                      <td className={td}>{a.credential_number ? a.credential_number : <Pill tone="danger">No licence on record</Pill>}</td>
                      <td className={`${td} text-right`}>{a.applications.toLocaleString()}</td>
                      <td className={`${td} text-right`}>{a.restricted_applications.toLocaleString()}</td>
                      <td className={`${td} text-right`}>{a.products.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* by month */}
          {months.length > 1 && (
            <Card className="space-y-3 p-5">
              <h4 className="font-semibold text-text-primary">By month</h4>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {months.map((m) => (
                  <li key={m.month} className="flex items-center justify-between rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm">
                    <span className="text-text-primary">{m.month}</span>
                    <span className="text-text-secondary">
                      {m.applications} applications{m.restricted > 0 ? ` · ${m.restricted} restricted` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* applications */}
          <Card className="space-y-3 p-5">
            <h4 className="font-semibold text-text-primary">Applications</h4>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-sm">
                <caption className="sr-only">Every application in the period</caption>
                <thead className="border-b border-border">
                  <tr>
                    <th scope="col" className={th}>When</th>
                    <th scope="col" className={th}>Applicator</th>
                    <th scope="col" className={th}>Site</th>
                    <th scope="col" className={th}>Product</th>
                    <th scope="col" className={`${th} text-right`}>Amount</th>
                    <th scope="col" className={`${th} text-right`}>Area (sq ft)</th>
                    <th scope="col" className={th}>Flags</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visibleRows.map((r) => {
                    const flags = rowFlags(r);
                    return (
                      <tr key={r.id}>
                        <td className={`${td} whitespace-nowrap`}>{fmtDateTime(r.performed_at)}</td>
                        <td className={td}>
                          {r.technician_name ?? '—'}
                          <span className="block text-xs text-text-secondary">{r.credential_number ?? ''}</span>
                        </td>
                        <td className={td}>{r.site_address ?? '—'}</td>
                        <td className={td}>
                          {r.product_name ?? '—'}
                          <span className="block text-xs text-text-secondary">{r.product_epa_reg ?? ''}</span>
                        </td>
                        <td className={`${td} whitespace-nowrap text-right`}>
                          {r.amount === null ? '—' : `${formatAmount(r.amount)} ${unitShort(r.amount_unit)}`}
                        </td>
                        <td className={`${td} text-right`}>{r.area_sqft === null ? '—' : formatAmount(r.area_sqft)}</td>
                        <td className={td}>
                          <div className="flex flex-wrap gap-1">
                            {r.product_restricted && <Pill tone="warning">Restricted</Pill>}
                            {flags.map((f) => (
                              <Pill key={f} tone="danger">
                                {FLAG_LABELS[f]}
                              </Pill>
                            ))}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!showAll && report.rows.length > ROW_PREVIEW && (
              <Button variant="ghost" size="sm" className="print:hidden" onClick={() => setShowAll(true)}>
                Show all {report.rows.length.toLocaleString()} applications
              </Button>
            )}
          </Card>
        </div>
      )}

      {/* ---------------- saved reports ---------------- */}
      <Card className="space-y-3 p-5 print:hidden">
        <h3 className="flex items-center gap-2 font-semibold text-text-primary">
          <ShieldCheck size={16} /> Sealed reports
        </h3>
        {savedLoading ? (
          <Skeleton className="h-16 w-full rounded-xl" />
        ) : savedError ? (
          <div className="space-y-2">
            <p className="text-sm text-danger" role="alert">
              {savedError}
            </p>
            <Button variant="secondary" size="sm" onClick={() => { setSavedLoading(true); void loadSaved(); }}>
              <RefreshCw size={16} /> Try again
            </Button>
          </div>
        ) : saved.length === 0 ? (
          <p className="text-sm text-text-secondary">
            Nothing sealed yet. Run a report and choose <span className="font-medium">Seal &amp; save</span> to keep an unchangeable copy for audits and filings.
          </p>
        ) : (
          <ul className="space-y-3">
            {saved.map((s) => {
              const v = verify[s.id];
              return (
                <li key={s.id} className="space-y-2 rounded-xl border border-border bg-bg-primary p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <p className="text-sm font-semibold text-text-primary">{describeWindow(s.period_from, s.period_to)}</p>
                      <p className="text-xs text-text-secondary">
                        {s.entry_count.toLocaleString()} applications · sealed {fmtDate(s.created_at)}
                        {s.prepared_by_email ? ` by ${s.prepared_by_email}` : ''}
                        {s.jurisdiction ? ` · ${s.jurisdiction}` : ''}
                      </p>
                      <p className="break-all font-mono text-[11px] text-text-secondary">SHA-256 {s.content_hash.slice(0, 16)}…</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {s.restricted_only && <Pill tone="warning">Restricted only</Pill>}
                      {s.filed_at ? <Pill tone="success">Filed {fmtDate(s.filed_at)}{s.filing_reference ? ` · ${s.filing_reference}` : ''}</Pill> : <Pill>Not filed</Pill>}
                    </div>
                  </div>
                  {s.note && <p className="text-sm text-text-secondary">{s.note}</p>}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void openSaved(s)} disabled={openingId === s.id}>
                      {openingId === s.id ? <Loader2 size={16} className="animate-spin" /> : <Eye size={16} />} Open
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => void downloadSaved(s)}>
                      <Download size={16} /> CSV
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void doVerify(s.id)} disabled={v === 'checking'}>
                      {v === 'checking' ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />} Verify
                    </Button>
                    {canManage && !s.filed_at && (
                      <Button variant="ghost" size="sm" onClick={() => { setFileId(fileId === s.id ? null : s.id); setFileRef(''); }} aria-expanded={fileId === s.id}>
                        <CheckCircle2 size={16} /> Mark as filed
                      </Button>
                    )}
                    {v === 'ok' && <Pill tone="success">Unchanged since sealing</Pill>}
                    {v === 'bad' && <Pill tone="danger">Does not match the sealed code — contact support</Pill>}
                  </div>
                  {fileId === s.id && (
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-[14rem] flex-1">
                        <Input label="Confirmation / filing number" value={fileRef} maxLength={120} onChange={(e) => setFileRef(e.target.value)} />
                      </div>
                      <Button size="sm" onClick={() => void doFile()} disabled={filing || fileRef.trim().length === 0}>
                        {filing ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} Save
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

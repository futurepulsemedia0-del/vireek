import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { AlertTriangle, ClipboardCopy, Download, FileSpreadsheet, Lock, ShieldCheck, Timer, Trash2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardNav';
import { SkeletonCard } from '@/components/Skeleton';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { downloadTextFile, readImportFile, ImportFileError, type ParsedTable } from '@/lib/importFile';
import {
  DEFAULT_HOURLY_COST, ESTIMATE_NOTE, MAX_AUDIT_ROWS, analyzeHours, buildShareSummary, defaultSettings, mappingError, suggestMapping,
  templateFits, type AuditMapping, type AuditSettings, type DateOrder, type DurationUnit,
} from '@/lib/hoursAudit';
import { buildSampleTable } from '@/lib/hoursAuditSample';
import { deleteAuditTemplate, listAuditTemplates, saveAuditTemplate, type AuditTemplate } from '@/lib/hoursAuditTemplates';

const selectCls = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-sm text-text-primary focus-visible:border-accent';
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const hrs = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const TIME_ZONES = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();

function ColumnSelect({ label, value, headers, onChange, optional }: { label: string; value: string; headers: string[]; onChange: (v: string) => void; optional?: boolean }) {
  return (
    <label className="block text-sm font-medium text-text-primary">
      {label}{optional && <span className="ml-1 font-normal text-text-secondary">(optional)</span>}
      <select className={`${selectCls} mt-1.5`} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{optional ? '— not in my file —' : '— choose a column —'}</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </label>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-primary p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</p>
      <p className="mt-1 text-2xl font-bold text-text-primary">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
    </div>
  );
}

export function HoursAuditPage() {
  const { isOwner, permissions, profile, teamMember, loading, profileLoading } = useAuth();
  const accountOwnerId = isOwner ? profile?.id : teamMember?.account_owner_id;
  const canAccess = isOwner || permissions.can_view_billing;

  const [table, setTable] = useState<ParsedTable | null>(null);
  const [isSample, setIsSample] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [mapping, setMapping] = useState<AuditMapping>(() => suggestMapping([]));
  const [settings, setSettings] = useState<AuditSettings>(() => defaultSettings());
  const [noSave, setNoSave] = useState(true);
  const [templates, setTemplates] = useState<AuditTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadTemplates = useCallback(async () => {
    if (!accountOwnerId || !canAccess) return;
    try { setTemplates(await listAuditTemplates(accountOwnerId)); } catch { setTemplates([]); }
  }, [accountOwnerId, canAccess]);
  useEffect(() => { void loadTemplates(); }, [loadTemplates]);

  const startWith = useCallback((t: ParsedTable, sample: boolean) => {
    setTable(t);
    setIsSample(sample);
    setNotice(null);
    const fit = templates.find((x) => templateFits(x.mapping, t.headers));
    if (fit && !sample) {
      setMapping(fit.mapping);
      setSettings(fit.settings);
      setNotice(`Applied your saved template “${fit.name}”.`);
    } else setMapping(suggestMapping(t.headers));
  }, [templates]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setReadError(null);
    try { startWith(await readImportFile(file, { maxRows: MAX_AUDIT_ROWS }), false); }
    catch (e) { setTable(null); setReadError(e instanceof ImportFileError ? e.message : 'Could not read this file.'); }
    finally { setReading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const useSample = () => {
    const { headers, rows } = buildSampleTable();
    startWith({ fileName: 'synthetic-sample.csv', fileType: 'csv', headers, rows, sheetNames: [], sheet: null }, true);
  };

  const dMapping = useDeferredValue(mapping);
  const dSettings = useDeferredValue(settings);
  const problem = table ? mappingError(mapping, table.headers) : null;
  const result = useMemo(
    () => (table && !mappingError(dMapping, table.headers) ? analyzeHours(table.headers, table.rows, dMapping, dSettings) : null),
    [table, dMapping, dSettings],
  );

  const setNum = (key: 'paidHoursPerDay' | 'hourlyCost' | 'driveGapCapMinutes' | 'maxJobHours') => (e: ChangeEvent<HTMLInputElement>) =>
    setSettings((s) => ({ ...s, [key]: e.target.value === '' ? 0 : Number(e.target.value) }));

  const saveTemplate = async () => {
    if (!accountOwnerId || noSave) return;
    try {
      await saveAuditTemplate(accountOwnerId, templateName, mapping, settings);
      setNotice(`Saved template “${templateName.trim()}”.`);
      setTemplateName('');
      void loadTemplates();
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Could not save the template.'); }
  };

  const copySummary = async () => {
    if (!result) return;
    try { await navigator.clipboard.writeText(buildShareSummary(result)); setNotice('Summary copied — it contains no names or addresses.'); }
    catch { setNotice('Copy is blocked in this browser — use Download instead.'); }
  };

  if (loading || profileLoading) return <DashboardLayout activeLabel="Hours Audit"><SkeletonCard rows={4} /></DashboardLayout>;

  if (!canAccess || !accountOwnerId) {
    return (
      <DashboardLayout activeLabel="Hours Audit">
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-bg-secondary/50 px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-bg-tertiary text-text-secondary"><Lock size={26} /></span>
          <h3 className="mt-4 text-lg font-semibold text-text-primary">You don't have access to this page</h3>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-text-secondary">The hours audit shows per-technician payroll-adjacent data, so it is limited to owners and managers with the “View Billing” permission.</p>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout activeLabel="Hours Audit">
      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent"><Timer size={24} /></span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary md:text-3xl">Hours Leak Audit</h1>
          <p className="text-sm text-text-secondary">Upload a job export and see how many paid technician hours never became billable hours — in under a minute.</p>
        </div>
      </div>

      <div className="space-y-6">
        <Card className="!p-5">
          <div className="flex flex-wrap items-center gap-3">
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx" className="sr-only" id="audit-file" onChange={(e) => void onFile(e.target.files?.[0])} />
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={reading}><FileSpreadsheet size={16} />{reading ? 'Reading…' : 'Choose CSV or Excel file'}</Button>
            <Button size="sm" variant="secondary" onClick={useSample}>Try with synthetic sample data</Button>
            {table && <span className="text-sm text-text-secondary">{table.fileName} · {table.rows.length.toLocaleString()} rows{isSample && ' · SYNTHETIC demo data'}</span>}
          </div>
          <label className="mt-4 flex items-start gap-2 text-sm text-text-secondary">
            <input type="checkbox" className="mt-0.5" checked={noSave} onChange={(e) => setNoSave(e.target.checked)} />
            <span><strong className="text-text-primary">Analyze without saving.</strong> Your file is processed in this browser and never uploaded. Turn this off only if you want to save a column-mapping template (no job data is saved either way).</span>
          </label>
          {readError && <p role="alert" className="mt-3 flex items-center gap-2 text-sm text-danger"><AlertTriangle size={16} />{readError}</p>}
        </Card>

        {table && (
          <Card className="!p-5">
            <h2 className="text-lg font-semibold text-text-primary">1 · Match your columns</h2>
            <p className="mt-1 text-sm text-text-secondary">Works with any export — tell us which column is which. Customer names and addresses are never read.</p>
            {templates.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-text-secondary">Saved templates:</span>
                {templates.map((t) => (
                  <span key={t.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-bg-primary py-1 pl-3 pr-1">
                    <button type="button" className="focus-ring rounded text-text-primary disabled:opacity-40" disabled={!templateFits(t.mapping, table.headers)} title={templateFits(t.mapping, table.headers) ? 'Apply' : 'Columns do not match this file'} onClick={() => { setMapping(t.mapping); setSettings(t.settings); }}>{t.name}</button>
                    <button type="button" aria-label={`Delete template ${t.name}`} className="focus-ring rounded-full p-1 text-text-secondary hover:text-danger" onClick={() => void deleteAuditTemplate(accountOwnerId, t.id).then(loadTemplates)}><Trash2 size={14} /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <ColumnSelect label="Technician" value={mapping.technician} headers={table.headers} onChange={(v) => setMapping({ ...mapping, technician: v })} />
              <ColumnSelect label="Job start" value={mapping.start} headers={table.headers} onChange={(v) => setMapping({ ...mapping, start: v })} />
              <ColumnSelect label="Job end" value={mapping.end} headers={table.headers} optional onChange={(v) => setMapping({ ...mapping, end: v })} />
              <ColumnSelect label="Duration (if no end time)" value={mapping.duration} headers={table.headers} optional onChange={(v) => setMapping({ ...mapping, duration: v })} />
              {mapping.duration && (
                <label className="block text-sm font-medium text-text-primary">Duration unit
                  <select className={`${selectCls} mt-1.5`} value={mapping.durationUnit} onChange={(e) => setMapping({ ...mapping, durationUnit: e.target.value as DurationUnit })}>
                    <option value="minutes">Minutes</option><option value="hours">Hours</option>
                  </select>
                </label>
              )}
              <ColumnSelect label="Billable flag (Yes/No)" value={mapping.billable} headers={table.headers} optional onChange={(v) => setMapping({ ...mapping, billable: v })} />
            </div>
            {problem && <p role="alert" className="mt-3 text-sm text-danger">{problem}</p>}

            <h2 className="mt-6 text-lg font-semibold text-text-primary">2 · Assumptions <span className="text-sm font-normal text-text-secondary">(estimates — edit to match your business)</span></h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Input label="Paid hours per working day" type="number" min={1} max={24} step={0.1} value={settings.paidHoursPerDay} onChange={setNum('paidHoursPerDay')} />
              <Input label="Hourly cost ($)" type="number" min={0} step={0.1} value={settings.hourlyCost} onChange={setNum('hourlyCost')}
                helperText={settings.hourlyCost === DEFAULT_HOURLY_COST ? 'Default: ACCA-cited truck-roll cost' : 'Custom value'} />
              <Input label="Drive time per gap, max (min)" type="number" min={0} max={240} value={settings.driveGapCapMinutes} onChange={setNum('driveGapCapMinutes')} helperText="Rest of a gap counts as idle" />
              <Input label="Ignore jobs longer than (h)" type="number" min={1} max={48} value={settings.maxJobHours} onChange={setNum('maxJobHours')} />
              <label className="block text-sm font-medium text-text-primary">Time zone of the file
                <input list="audit-tz" className={`${selectCls} mt-1.5`} value={settings.timeZone} onChange={(e) => setSettings({ ...settings, timeZone: e.target.value })} />
                <datalist id="audit-tz">{TIME_ZONES.map((z) => <option key={z} value={z} />)}</datalist>
              </label>
              <label className="block text-sm font-medium text-text-primary">Date order
                <select className={`${selectCls} mt-1.5`} value={settings.dateOrder} onChange={(e) => setSettings({ ...settings, dateOrder: e.target.value as DateOrder })}>
                  <option value="mdy">Month/Day/Year (US)</option><option value="dmy">Day/Month/Year</option>
                </select>
              </label>
              <label className="block text-sm font-medium text-text-primary">Job with no end time
                <select className={`${selectCls} mt-1.5`} value={settings.missingEnd} onChange={(e) => setSettings({ ...settings, missingEnd: e.target.value as AuditSettings['missingEnd'] })}>
                  <option value="median">Estimate from typical job length</option><option value="skip">Skip the row</option>
                </select>
              </label>
            </div>
            {!noSave && (
              <div className="mt-4 flex flex-wrap items-end gap-3">
                <div className="w-64"><Input label="Save mapping as template" value={templateName} maxLength={80} onChange={(e) => setTemplateName(e.target.value)} placeholder="e.g. Jobber export" /></div>
                <Button size="sm" variant="secondary" onClick={() => void saveTemplate()} disabled={!templateName.trim() || !!problem}>Save template</Button>
              </div>
            )}
            {notice && <p role="status" className="mt-3 text-sm text-text-secondary">{notice}</p>}
          </Card>
        )}

        {result && (
          <>
            <Card className="!p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-text-primary">Your estimated leak</h2>
                  <p className="text-sm text-text-secondary">{ESTIMATE_NOTE}</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void copySummary()}><ClipboardCopy size={16} />Copy shareable summary</Button>
                  <Button size="sm" variant="ghost" onClick={() => downloadTextFile('hours-audit-summary.txt', buildShareSummary(result), 'text/plain;charset=utf-8')}><Download size={16} />Download</Button>
                </div>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Leaked per month (est.)" value={usd(result.leakedCostPerMonth)} hint={`${hrs(result.leakedHoursPerMonth)} per month`} />
                <Stat label="Billable vs paid" value={`${result.totals.utilization}%`} hint={`${hrs(result.totals.billable)} of ${hrs(result.totals.paid)}`} />
                <Stat label="Drive + idle gaps" value={hrs(result.totals.drive + result.totals.idle)} hint={`drive ${hrs(result.totals.drive)} · idle ${hrs(result.totals.idle)}`} />
                <Stat label="Total leaked (est.)" value={usd(result.totals.leakedCost)} hint={`${hrs(result.totals.leaked)} over ${result.spanDays} days`} />
              </div>
              {result.warnings.map((w) => <p key={w} className="mt-3 flex items-center gap-2 text-sm text-warning-500"><AlertTriangle size={16} className="shrink-0" />{w}</p>)}
              <p className="mt-3 flex items-center gap-2 text-xs text-text-secondary"><ShieldCheck size={14} className="shrink-0" />Shown for owners and managers only. Technicians are listed alphabetically — this is an audit of time, not a ranking of people.</p>
            </Card>

            <Card className="!p-5">
              <h2 className="text-lg font-semibold text-text-primary">By technician</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-text-secondary"><tr>
                    {['Technician', 'Days', 'Paid', 'Billable', 'Billable %', 'Drive', 'Idle gaps', 'Leaked', 'Leaked $ / month'].map((h) => <th key={h} className="px-2 py-2 font-medium">{h}</th>)}
                  </tr></thead>
                  <tbody className="divide-y divide-border">
                    {result.techs.map((t) => (
                      <tr key={t.name} className="text-text-primary">
                        <td className="px-2 py-2 font-medium">{t.name}</td><td className="px-2 py-2">{t.workdays}</td><td className="px-2 py-2">{hrs(t.paid)}</td>
                        <td className="px-2 py-2">{hrs(t.billable)}</td><td className="px-2 py-2">{t.utilization}%</td><td className="px-2 py-2">{hrs(t.drive)}</td>
                        <td className="px-2 py-2">{hrs(t.idle)}</td><td className="px-2 py-2">{hrs(t.leaked)}</td><td className="px-2 py-2">{usd(t.leakedCostPerMonth)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card className="!p-5">
              <h2 className="text-lg font-semibold text-text-primary">By month</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-text-secondary"><tr>
                    {['Month', 'Tech-days', 'Paid', 'Billable', 'Leaked', 'Leaked $'].map((h) => <th key={h} className="px-2 py-2 font-medium">{h}</th>)}
                  </tr></thead>
                  <tbody className="divide-y divide-border">
                    {result.months.map((m) => (
                      <tr key={m.month} className="text-text-primary">
                        <td className="px-2 py-2 font-medium">{monthLabel(m.month)}</td><td className="px-2 py-2">{m.workdays}</td><td className="px-2 py-2">{hrs(m.paid)}</td>
                        <td className="px-2 py-2">{hrs(m.billable)}</td><td className="px-2 py-2">{hrs(m.leaked)}</td><td className="px-2 py-2">{usd(m.leakedCost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {result.rowsRejected > 0 && (
              <Card className="!p-5">
                <h2 className="text-lg font-semibold text-text-primary">{result.rowsRejected.toLocaleString()} rows were not used</h2>
                <p className="text-sm text-text-secondary">Row numbers match your spreadsheet (the header is row 1).{result.issues.length < result.rowsRejected && ` Showing the first ${result.issues.length}.`}</p>
                <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto text-sm text-text-primary">
                  {result.issues.map((i) => <li key={`${i.row}-${i.code}`}><span className="font-mono text-text-secondary">Row {i.row}</span> — {i.message}</li>)}
                </ul>
              </Card>
            )}
          </>
        )}
      </div>
    </DashboardLayout>
  );
}

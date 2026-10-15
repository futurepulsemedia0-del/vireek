import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FileSpreadsheet, Info, Loader2, Upload, Wand2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import {
  PRESETS, PRESET_BY_ID, REQUIRED_ANY, autoMap, detectPreset, fieldsFor, isMappingComplete,
  type FieldMapping, type ImportPresetId, type ImportType,
} from '@/lib/importPresets';
import { ImportFileError, readImportFile, tableToCsv, type ParsedTable } from '@/lib/importFile';
import {
  downloadTextFile, listImportRowErrors, rollbackImport, rowErrorsToCsv, runImport, validateImport,
  type DedupeStrategy, type RunResult, type ValidateResult,
} from '@/lib/importWizard';
import { ImportDoneStep, ImportReviewStep, defaultFilter, type RowFilter } from './ImportReviewStep';

type Step = 'source' | 'map' | 'review' | 'done';
const STEPS: { id: Step; label: string }[] = [
  { id: 'source', label: 'Upload' }, { id: 'map', label: 'Map columns' }, { id: 'review', label: 'Review' }, { id: 'done', label: 'Done' },
];
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');

function Stepper({ step }: { step: Step }) {
  const index = STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="mb-6 flex items-center gap-2" aria-label="Import progress">
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2" aria-current={i === index ? 'step' : undefined}>
          <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${i < index ? 'bg-success text-white' : i === index ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary'}`}>
            {i < index ? <Check size={14} /> : i + 1}
          </span>
          <span className={`${i === index ? 'inline' : 'hidden sm:inline'} text-sm font-medium ${i === index ? 'text-text-primary' : 'text-text-secondary'}`}>{s.label}</span>
          {i < STEPS.length - 1 && <span className="h-px w-4 bg-border sm:w-8" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

interface Props {
  accountOwnerId: string;
  onFinished: () => void;
}

export function ImportWizard({ accountOwnerId, onFinished }: Props) {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('source');
  const [importType, setImportType] = useState<ImportType>('customers');
  const [preset, setPreset] = useState<ImportPresetId>('csv');
  const [file, setFile] = useState<File | null>(null);
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [suggested, setSuggested] = useState<ImportPresetId | null>(null);

  const [mapping, setMapping] = useState<FieldMapping>({});
  const [autoKeys, setAutoKeys] = useState<string[]>([]);
  const [dedupe, setDedupe] = useState<DedupeStrategy>('fill_blanks');

  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RowFilter | null>(null);
  const [retryTick, setRetryTick] = useState(0);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const csvText = useMemo(() => (table ? tableToCsv(table.headers, table.rows) : ''), [table]);
  const params = useMemo(
    () => (table ? { source: preset, importType, fileName: table.fileName, fileType: table.fileType, csvText, mapping, dedupe } : null),
    [table, preset, importType, csvText, mapping, dedupe],
  );

  // ---- keep the tab alive while writing
  useEffect(() => {
    if (!running) return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [running]);

  // ---- server-side validation preview (re-runs when mapping / duplicate handling changes)
  useEffect(() => {
    if (step !== 'review' || !params) return;
    const controller = new AbortController();
    setValidating(true);
    setValidationError(null);
    validateImport(params, controller.signal)
      .then((r) => { setValidation(r); setFilter((f) => f ?? defaultFilter(r)); })
      .catch((e) => { if ((e as Error).name !== 'AbortError') setValidationError(errMsg(e)); })
      .finally(() => { if (!controller.signal.aborted) setValidating(false); });
    return () => controller.abort();
  }, [step, params, retryTick]);

  const remap = useCallback((t: ParsedTable, type: ImportType, presetId: ImportPresetId) => {
    const r = autoMap(t.headers, type, presetId);
    setMapping(r.mapping);
    setAutoKeys(r.auto);
    setValidation(null);
    setFilter(null);
  }, []);

  const loadFile = useCallback(async (f: File, sheet?: string) => {
    setReading(true);
    setFileError(null);
    try {
      const t = await readImportFile(f, { sheet });
      setFile(f);
      setTable(t);
      remap(t, importType, preset);
      const detected = detectPreset(t.headers);
      setSuggested(preset === 'csv' && detected ? detected : null);
    } catch (e) {
      setFile(null);
      setTable(null);
      setFileError(e instanceof ImportFileError ? e.message : 'Couldn’t read this file. Try saving it again as CSV.');
    } finally {
      setReading(false);
    }
  }, [importType, preset, remap]);

  const changePreset = (id: ImportPresetId) => {
    setPreset(id);
    setSuggested(null);
    if (table) remap(table, importType, id);
  };
  const changeType = (type: ImportType) => {
    setImportType(type);
    if (table) remap(table, type, preset);
  };
  const setField = (key: string, header: string) => {
    setMapping((m) => {
      const next = { ...m };
      if (header) next[key] = header; else delete next[key];
      return next;
    });
    setAutoKeys((k) => k.filter((x) => x !== key));
    setValidation(null);
    setFilter(null);
  };

  const reset = () => {
    setStep('source'); setFile(null); setTable(null); setMapping({}); setAutoKeys([]); setValidation(null); setFilter(null);
    setResult(null); setRunError(null); setFileError(null); setSuggested(null); setDedupe('fill_blanks');
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void loadFile(f);
  };

  const doImport = async () => {
    if (!params) return;
    setConfirmOpen(false);
    setRunning(true);
    setRunError(null);
    try {
      const r = await runImport(params);
      setResult(r);
      setStep('done');
      onFinished();
      toast(r.status === 'failed' ? 'Import failed — nothing was added.' : `Imported ${(r.created_count + r.updated_count).toLocaleString()} records.`, r.status === 'failed' ? 'error' : 'success');
    } catch (e) {
      setRunError(errMsg(e));
    } finally {
      setRunning(false);
    }
  };

  const downloadErrors = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const errors = await listImportRowErrors(accountOwnerId, result.import_job_id);
      downloadTextFile(`vireek-import-errors-${result.import_job_id.slice(0, 8)}.csv`, rowErrorsToCsv(errors));
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const r = await rollbackImport(result.import_job_id);
      toast(`Import undone: ${r.deleted} removed, ${r.restored} restored${r.kept_modified ? `, ${r.kept_modified} kept because they were edited` : ''}.`, 'success');
      setUndoOpen(false);
      onFinished();
      reset();
    } catch (e) {
      toast(errMsg(e), 'error');
      setUndoOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const fields = fieldsFor(importType);
  const mappingOk = isMappingComplete(importType, mapping);
  const writable = validation ? validation.summary.create + validation.summary.update : 0;
  const sample = (header?: string) => {
    if (!table || !header) return '';
    const i = table.headers.indexOf(header);
    return [...new Set(table.rows.map((r) => r[i]).filter(Boolean))].slice(0, 3).join(' · ');
  };

  // ------------------------------------------------------------------ render
  if (running) {
    return (
      <div className="rounded-2xl border border-border bg-bg-secondary p-8 text-center" role="status" aria-live="polite">
        <Loader2 size={20} className="mx-auto mb-3 animate-spin text-accent" />
        <p className="text-lg font-semibold text-text-primary">Importing {table?.rows.length.toLocaleString()} rows…</p>
        <p className="mt-1 text-sm text-text-secondary">Keep this tab open — large files can take a minute. Everything you import can be undone afterwards.</p>
        <div className="mx-auto mt-5 h-1.5 max-w-sm overflow-hidden rounded-full bg-bg-tertiary"><div className="h-full w-1/3 animate-pulse rounded-full bg-accent" /></div>
      </div>
    );
  }

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 md:p-6" aria-label="Import wizard">
      <Stepper step={step} />

      {step === 'source' && (
        <div className="space-y-6">
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-text-primary">What are you importing?</legend>
            <div className="inline-flex rounded-xl border border-border p-1" role="radiogroup">
              {(['customers', 'jobs'] as ImportType[]).map((t) => (
                <label key={t} className={`focus-within:ring-2 focus-within:ring-accent/40 cursor-pointer rounded-lg px-4 py-2 text-sm font-semibold ${importType === t ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                  <input type="radio" name="import-type" className="sr-only" checked={importType === t} onChange={() => changeType(t)} />
                  {t === 'customers' ? 'Customers' : 'Job history'}
                </label>
              ))}
            </div>
            {importType === 'jobs' && <p className="mt-2 text-xs text-text-secondary">Tip: import customers first, so each job links to its customer automatically.</p>}
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-text-primary">Where is your data coming from?</legend>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" role="radiogroup">
              {PRESETS.map((p) => (
                <label key={p.id} className={`focus-within:ring-2 focus-within:ring-accent/40 cursor-pointer rounded-xl border p-3 transition-colors ${preset === p.id ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/40'}`}>
                  <input type="radio" name="preset" className="sr-only" checked={preset === p.id} onChange={() => changePreset(p.id)} />
                  <span className="block text-sm font-semibold text-text-primary">{p.label}</span>
                  <span className="mt-0.5 block text-xs leading-snug text-text-secondary">{p.description}</span>
                </label>
              ))}
            </div>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-text-secondary">
              {PRESET_BY_ID[preset].howToExport[importType].map((line) => <li key={line}>{line}</li>)}
            </ol>
          </fieldset>

          {!table ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              className={`rounded-2xl border-2 border-dashed p-8 text-center transition-colors ${dragOver ? 'border-accent bg-accent/5' : 'border-border'}`}
            >
              {reading ? (
                <p className="flex items-center justify-center gap-2 text-sm text-text-secondary" role="status"><Loader2 size={18} className="animate-spin" /> Reading your file…</p>
              ) : (
                <>
                  <Upload size={28} className="mx-auto mb-2 text-accent" />
                  <p className="text-sm font-semibold text-text-primary">Drop your file here</p>
                  <p className="mb-3 text-xs text-text-secondary">.csv, .tsv or .xlsx · up to 10 MB and 5,000 rows</p>
                  <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>Choose file</Button>
                </>
              )}
              <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,.xlsx" className="sr-only" aria-label="Choose a CSV or Excel file"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadFile(f); e.target.value = ''; }} />
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border p-4">
              <div className="flex min-w-0 items-center gap-3">
                <FileSpreadsheet size={22} className="shrink-0 text-accent" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">{table.fileName}</p>
                  <p className="text-xs text-text-secondary">{table.rows.length.toLocaleString()} rows · {table.headers.length} columns</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {table.sheetNames.length > 1 && file && (
                  <select aria-label="Worksheet" value={table.sheet ?? ''} onChange={(e) => void loadFile(file, e.target.value)} className="focus-ring rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary">
                    {table.sheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                )}
                <button onClick={reset} className="focus-ring rounded-lg p-2 text-text-secondary hover:bg-bg-tertiary" aria-label="Remove file"><X size={16} /></button>
              </div>
            </div>
          )}

          {fileError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{fileError}</p>}
          {suggested && (
            <p className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/30 bg-accent/5 p-3 text-sm text-text-primary">
              <Wand2 size={16} className="text-accent" /> This looks like a {PRESET_BY_ID[suggested].label} export.
              <button className="focus-ring font-semibold text-accent underline" onClick={() => changePreset(suggested)}>Use the {PRESET_BY_ID[suggested].label} preset</button>
            </p>
          )}

          <div className="flex justify-end">
            <Button onClick={() => setStep('map')} disabled={!table}>Continue <ArrowRight size={16} /></Button>
          </div>
        </div>
      )}

      {step === 'map' && table && (
        <div className="space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Match your columns</h2>
            <p className="text-sm text-text-secondary">We matched what we could{autoKeys.length ? ` (${autoKeys.length} fields)` : ''}. Check each one and change anything that’s off.</p>
          </div>

          {!mappingOk && <p role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-text-primary">{REQUIRED_ANY[importType].message}</p>}

          <ul className="divide-y divide-border rounded-2xl border border-border">
            {fields.map((f) => (
              <li key={f.key} className="grid gap-2 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1fr)] md:items-center">
                <div>
                  <label htmlFor={`map-${f.key}`} className="text-sm font-medium text-text-primary">{f.label}</label>
                  {f.hint && <p className="text-xs text-text-secondary">{f.hint}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <select id={`map-${f.key}`} value={mapping[f.key] ?? ''} onChange={(e) => setField(f.key, e.target.value)} className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
                    <option value="">Don’t import</option>
                    {table.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                  {autoKeys.includes(f.key) && <span className="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent">Auto</span>}
                </div>
                <p className="truncate text-xs text-text-secondary" title={sample(mapping[f.key])}>{sample(mapping[f.key]) || '—'}</p>
              </li>
            ))}
          </ul>

          {!mapping.external_id && (
            <p className="flex items-start gap-2 text-xs text-text-secondary"><Info size={14} className="mt-0.5 shrink-0" /> No ID column mapped. Duplicates will be found by {importType === 'customers' ? 'phone, email or name + address' : 'customer + date + service + amount'}; an ID from your old system is the most reliable.</p>
          )}

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep('source')}><ArrowLeft size={16} /> Back</Button>
            <Button onClick={() => { setValidation(null); setFilter(null); setStep('review'); }} disabled={!mappingOk}>Check my data <ArrowRight size={16} /></Button>
          </div>
        </div>
      )}

      {step === 'review' && table && (
        <div className="space-y-5">
          <ImportReviewStep
            importType={importType} validation={validation} validating={validating} error={validationError}
            dedupe={dedupe} onDedupe={(s) => { setDedupe(s); setValidation(null); setFilter(null); }}
            filter={filter ?? (validation ? defaultFilter(validation) : 'all')} onFilter={setFilter} onRetry={() => setRetryTick((n) => n + 1)}
          />
          {runError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{runError}</p>}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep('map')} disabled={validating}><ArrowLeft size={16} /> Back</Button>
            <Button onClick={() => setConfirmOpen(true)} disabled={validating || !validation?.can_import}>
              Import {writable ? writable.toLocaleString() : ''} records <ArrowRight size={16} />
            </Button>
          </div>
        </div>
      )}

      {step === 'done' && result && (
        <ImportDoneStep result={result} importType={importType} busy={busy} onDownloadErrors={downloadErrors} onUndo={() => setUndoOpen(true)} onAnother={reset} />
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={`Import ${writable.toLocaleString()} records?`}
        description={`${validation?.summary.create.toLocaleString() ?? 0} will be added and ${validation?.summary.update.toLocaleString() ?? 0} updated. You can undo the whole import afterwards from the history.`}
        confirmLabel="Start import"
        onConfirm={doImport}
        onCancel={() => setConfirmOpen(false)}
      />
      <ConfirmDialog
        open={undoOpen}
        title="Undo this import?"
        description="Records this import added will be removed (unless you've edited them since) and records it updated will go back to their previous values."
        confirmPhrase="undo import"
        confirmLabel="Undo import"
        onConfirm={undo}
        onCancel={() => setUndoOpen(false)}
      />
    </section>
  );
}

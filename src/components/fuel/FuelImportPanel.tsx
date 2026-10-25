import { useMemo, useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { useCurrency } from '@/contexts/CurrencyContext';
import { formatMoney } from '@/lib/currency';
import { deleteImport, importTransactions } from '@/lib/fuelCardsApi';
import {
  FIELD_KEYS, FIELD_LABELS, IMPORT_TEMPLATE_CSV, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, PROVIDER_SUGGESTIONS,
  detectMapping, formatGallons, mappingIssues, normalizeImportRows, parseCsv, previewImport,
  type ColumnMapping, type DateOrder, type FieldKey, type FuelCard, type FuelImportRecord, type ImportResult,
} from '@/lib/fuelCards';
import { Section, SelectField, Stat, formatDateTime } from '@/components/vehicles/shared';

interface Props {
  cards: FuelCard[];
  imports: FuelImportRecord[];
  onImported: () => Promise<unknown> | void;
  onViewAnomalies: () => void;
}

interface Parsed { fileName: string; headers: string[]; body: string[][] }

export function FuelImportPanel({ cards, imports, onImported, onViewAnomalies }: Props) {
  const { toast } = useToast();
  const { currency } = useCurrency();
  const money = (n: number) => formatMoney(n, currency);
  const inputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [order, setOrder] = useState<DateOrder | 'auto'>('auto');
  const [provider, setProvider] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [pendingUndo, setPendingUndo] = useState<FuelImportRecord | null>(null);

  const issues = mapping ? mappingIssues(mapping) : [];
  const normalized = useMemo(
    () => (parsed && mapping && issues.length === 0 ? normalizeImportRows(parsed.body, mapping, order === 'auto' ? undefined : order) : null),
    [parsed, mapping, order, issues.length],
  );
  const preview = useMemo(() => (normalized ? previewImport(normalized.rows, cards) : null), [normalized, cards]);

  const reset = () => {
    setParsed(null); setMapping(null); setOrder('auto'); setFileError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setResult(null); setFileError(null);
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { reset(); setFileError('That file is larger than 5 MB. Split it into smaller files.'); return; }
    try {
      const rows = parseCsv(await file.text());
      if (rows.length < 2) { reset(); setFileError('We couldn’t find any data rows. Export your transactions as CSV and try again.'); return; }
      if (rows.length - 1 > MAX_IMPORT_ROWS) { reset(); setFileError(`This file has ${(rows.length - 1).toLocaleString()} rows. Import at most ${MAX_IMPORT_ROWS.toLocaleString()} at a time.`); return; }
      setParsed({ fileName: file.name, headers: rows[0].map((h, i) => h.trim() || `Column ${i + 1}`), body: rows.slice(1) });
      setMapping(detectMapping(rows[0]));
    } catch {
      reset(); setFileError('We couldn’t read that file. Make sure it is a CSV export.');
    }
  };

  const setField = (key: FieldKey, value: string) =>
    setMapping((m) => (m ? { ...m, [key]: value === '' ? null : Number(value) } : m));

  const submit = async () => {
    if (!parsed || !normalized || normalized.rows.length === 0 || importing) return;
    setImporting(true);
    try {
      const res = await importTransactions(parsed.fileName, normalized.rows, provider.trim() || null);
      setResult({ ...res, rejected: res.rejected + normalized.rejected.length });
      toast(`${res.inserted.toLocaleString()} transactions imported.`, 'success');
      reset();
      await onImported();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The import failed.', 'error');
    } finally {
      setImporting(false);
    }
  };

  const undo = async () => {
    const target = pendingUndo;
    setPendingUndo(null);
    if (!target) return;
    try {
      const n = await deleteImport(target.id);
      toast(`Import undone. ${n.toLocaleString()} transactions removed.`, 'success');
      await onImported();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not undo the import.', 'error');
    }
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([IMPORT_TEMPLATE_CSV], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'fuel-card-template.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Section
        title="Import transactions"
        action={<Button size="sm" variant="ghost" onClick={downloadTemplate}><Download size={14} /> CSV template</Button>}
      >
        <p className="mb-3 text-sm text-text-secondary">
          Export transactions from your fuel card provider (WEX, Fleetcor, Comdata, Voyager and others) as CSV and upload it here. Duplicates are skipped automatically, so it’s safe to re-import overlapping files.
        </p>
        <label htmlFor="fuel-file" className="flex min-h-[96px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-border bg-bg-primary px-4 py-6 text-center text-sm text-text-secondary transition-colors hover:border-accent/50 focus-within:border-accent">
          <Upload size={22} aria-hidden="true" />
          <span className="font-medium text-text-primary">{parsed ? parsed.fileName : 'Choose a CSV file'}</span>
          <span className="text-xs">Up to {MAX_IMPORT_ROWS.toLocaleString()} rows · 5 MB</span>
          <input id="fuel-file" ref={inputRef} type="file" accept=".csv,.tsv,.txt,text/csv" onChange={onFile} className="sr-only" />
        </label>
        {fileError && <p role="alert" className="mt-2 text-sm text-danger">{fileError}</p>}
      </Section>

      {parsed && mapping && (
        <Section title="Check the columns">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FIELD_KEYS.map((key) => (
              <SelectField key={key} label={FIELD_LABELS[key]} value={mapping[key] == null ? '' : String(mapping[key])} onChange={(e) => setField(key, e.target.value)}>
                <option value="">— not in file —</option>
                {parsed.headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
              </SelectField>
            ))}
            <SelectField label="Date format" value={order} onChange={(e) => setOrder(e.target.value as DateOrder | 'auto')}>
              <option value="auto">Detect automatically{normalized ? ` (${normalized.dateOrder === 'mdy' ? 'MM/DD' : 'DD/MM'})` : ''}</option>
              <option value="mdy">Month / Day / Year</option>
              <option value="dmy">Day / Month / Year</option>
            </SelectField>
            <div>
              <label htmlFor="fuel-provider" className="mb-1.5 block text-sm font-medium text-text-primary">Card provider (optional)</label>
              <input
                id="fuel-provider" list="fuel-import-providers" value={provider} onChange={(e) => setProvider(e.target.value)} maxLength={40}
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary focus-visible:border-accent"
                placeholder="Only needed if two providers share a last-4"
              />
              <datalist id="fuel-import-providers">{PROVIDER_SUGGESTIONS.map((p) => <option key={p} value={p} />)}</datalist>
            </div>
          </div>
          {issues.length > 0 && (
            <ul role="alert" className="mt-3 list-disc space-y-0.5 ps-5 text-sm text-danger">{issues.map((i) => <li key={i}>{i}</li>)}</ul>
          )}
        </Section>
      )}

      {preview && normalized && (
        <Section title="Preview">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Ready to import" value={preview.count.toLocaleString()} tone={preview.count ? 'success' : 'danger'} hint={preview.from ? `${preview.from} → ${preview.to}` : undefined} />
            <Stat label="Total spend" value={money(preview.totalAmount)} />
            <Stat label="Fuel" value={formatGallons(preview.totalGallons)} />
            <Stat label="Skipped" value={normalized.rejected.length.toLocaleString()} tone={normalized.rejected.length ? 'warning' : 'success'} hint="Refunds, bad dates, missing cards" />
          </div>

          {preview.unknownCards.length > 0 && (
            <p role="status" className="mt-3 rounded-xl border border-warning-500/30 bg-warning-500/10 px-4 py-3 text-sm text-text-primary">
              {preview.unknownCards.length} card{preview.unknownCards.length === 1 ? '' : 's'} in this file aren’t registered ({preview.unknownCards.map((c) => `••${c}`).join(', ')}).
              They’ll import and be flagged — register them under Cards and they’ll match automatically.
            </p>
          )}
          {!normalized.hasTimeColumn && (
            <p className="mt-3 text-xs text-text-secondary">This file has no time of day, so noon is assumed and after-hours checks won’t apply.</p>
          )}

          {normalized.rejected.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-text-secondary">Why were {normalized.rejected.length} rows skipped?</summary>
              <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs text-text-secondary">
                {normalized.rejected.slice(0, 50).map((r) => <li key={`${r.line}-${r.reason}`}>Line {r.line}: {r.reason}</li>)}
              </ul>
            </details>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={submit} disabled={importing || preview.count === 0}>{importing ? 'Importing…' : `Import ${preview.count.toLocaleString()} transactions`}</Button>
            <Button variant="ghost" onClick={reset} disabled={importing}>Cancel</Button>
          </div>
        </Section>
      )}

      {result && (
        <Section title="Import complete">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Imported" value={result.inserted.toLocaleString()} tone="success" />
            <Stat label="Matched to a vehicle" value={result.matched.toLocaleString()} hint={`${result.unmatched.toLocaleString()} unmatched`} tone={result.unmatched ? 'warning' : 'success'} />
            <Stat label="Flagged" value={result.flagged.toLocaleString()} tone={result.flagged ? 'warning' : 'success'} />
            <Stat label="Duplicates skipped" value={result.duplicates.toLocaleString()} hint={`${result.rejected.toLocaleString()} rows skipped`} />
          </div>
          {result.errors.length > 0 && (
            <ul className="mt-3 space-y-0.5 text-xs text-text-secondary">{result.errors.map((e) => <li key={`${e.line}-${e.reason}`}>Line {e.line}: {e.reason}</li>)}</ul>
          )}
          {result.flagged > 0 && <div className="mt-3"><Button size="sm" onClick={onViewAnomalies}>Review {result.flagged.toLocaleString()} flagged</Button></div>}
        </Section>
      )}

      {imports.length > 0 && (
        <Section title="Import history">
          <ul className="divide-y divide-border" aria-label="Import history">
            {imports.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-primary">{i.file_name}</p>
                  <p className="text-xs text-text-secondary">
                    {formatDateTime(i.created_at)} · {i.inserted_count.toLocaleString()} imported · {i.duplicate_count.toLocaleString()} duplicates · {i.flagged_count.toLocaleString()} flagged
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setPendingUndo(i)} aria-label={`Undo import ${i.file_name}`}><Trash2 size={14} /> Undo</Button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <ConfirmDialog
        open={pendingUndo !== null}
        title="Undo this import?"
        description="Its transactions, anomalies and the fuel costs posted to vehicles will be removed. Other imports are not affected."
        confirmLabel="Undo import"
        onConfirm={undo}
        onCancel={() => setPendingUndo(null)}
      />
    </div>
  );
}

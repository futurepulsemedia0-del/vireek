import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/contexts/ToastContext';
import { importOrders, undoImport } from '@/lib/workOrderGuardApi';
import {
  FIELD_KEYS, FIELD_LABELS, REQUIRED_FIELDS, parseForwardedEmail, parseWorkOrderCsv, type ColumnMapping, type FieldKey, type ImportResult,
} from '@/lib/workOrderGuardImport';

interface Props { profileId: string; timezone: string; onImported: () => void }

export function ImportPanel({ profileId, timezone, onImported }: Props) {
  const { toast } = useToast();
  const [mode, setMode] = useState<'csv' | 'email'>('csv');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<ColumnMapping | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [lastBatches, setLastBatches] = useState<string[]>([]);

  const result: ImportResult | null = useMemo(() => {
    if (!text.trim()) return null;
    return mode === 'csv' ? parseWorkOrderCsv(text, { timezone, mapping }) : parseForwardedEmail(text, { timezone });
  }, [text, mode, timezone, mapping]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5_000_000) { toast('That file is over 5 MB — split it by month.', 'error'); return; }
    setFileName(f.name); setMapping(undefined); setText(await f.text());
  };

  const run = async () => {
    if (!result || result.orders.length === 0 || busy) return;
    setBusy(true);
    try {
      const s = await importOrders(profileId, mode, fileName || (mode === 'email' ? 'forwarded email' : 'pasted csv'), result.orders);
      setLastBatches(s.batchIds);
      toast(`Imported ${s.created} new and updated ${s.updated} work orders.`, 'success');
      setText(''); setFileName(''); setMapping(undefined);
      onImported();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Import failed.', 'error');
    } finally { setBusy(false); }
  };

  const undo = async () => {
    if (busy || lastBatches.length === 0) return;
    setBusy(true);
    try {
      let n = 0;
      for (const id of lastBatches) n += await undoImport(id);
      setLastBatches([]); toast(`Removed ${n} work orders from that import.`, 'success'); onImported();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not undo.', 'error');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2" role="tablist" aria-label="Import source">
        {(['csv', 'email'] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setText(''); setMapping(undefined); }}
            className={`focus-ring min-h-[40px] rounded-full border px-4 text-sm font-medium ${mode === m ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary'}`}>
            {m === 'csv' ? 'CSV export' : 'Forwarded email'}
          </button>
        ))}
      </div>

      <section className="rounded-2xl border border-border bg-bg-secondary p-4">
        {mode === 'csv' ? (
          <>
            <p className="text-sm text-text-secondary">Export work orders from your portal and upload the CSV. Re-importing the same file updates existing orders — it never duplicates them. <a className="text-accent underline" href="/samples/work-orders-sample.csv" download>Download a sample file</a>.</p>
            <label className="focus-ring mt-3 inline-flex min-h-[48px] cursor-pointer items-center rounded-xl bg-accent px-5 font-semibold text-white">
              Choose CSV file
              <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {fileName && <span className="ml-3 text-sm text-text-secondary">{fileName}</span>}
          </>
        ) : (
          <>
            <p className="text-sm text-text-secondary">Forward the portal's work-order email to yourself, then paste its text here. Vireek reads "Label: value" lines — it does not connect to your mailbox or the portal.</p>
            <textarea value={text} onChange={(e) => setText(e.target.value.slice(0, 200_000))} rows={8} aria-label="Forwarded email text"
              className="focus-ring mt-3 w-full rounded-xl border border-border bg-bg-primary p-3 text-base text-text-primary" placeholder={'Work Order: 12345\nPriority: Emergency\nNTE: $450.00\nDate Received: 9/2/2026 7:15 AM'} />
          </>
        )}
      </section>

      {result && (
        <section className="space-y-3 rounded-2xl border border-border bg-bg-secondary p-4" aria-live="polite">
          <p className="text-sm text-text-primary"><strong>{result.orders.length}</strong> work order(s) ready{result.errors.length > 0 && <>, <strong className="text-amber-500">{result.errors.length}</strong> problem(s) — those rows are skipped</>}.</p>
          {result.missingRequired.length > 0 && <p role="alert" className="text-sm text-red-500">Missing required: {result.missingRequired.map((f) => FIELD_LABELS[f]).join(', ')}.{mode === 'csv' ? ' Pick the right column below.' : ' Add it to the pasted text.'}</p>}
          {result.errors.length > 0 && (
            <ul className="max-h-48 list-disc space-y-1 overflow-auto pl-5 text-xs text-text-secondary">
              {result.errors.slice(0, 30).map((e, i) => <li key={i}>{mode === 'csv' ? `Row ${e.row}: ` : ''}{e.message}</li>)}
              {result.errors.length > 30 && <li>…and {result.errors.length - 30} more</li>}
            </ul>
          )}
          {mode === 'csv' && result.headers.length > 0 && (
            <details open={result.missingRequired.length > 0}>
              <summary className="cursor-pointer text-sm font-medium text-text-primary">Column mapping</summary>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {FIELD_KEYS.map((f: FieldKey) => (
                  <label key={f} className="block text-xs font-medium text-text-secondary">{FIELD_LABELS[f]}{REQUIRED_FIELDS.includes(f) ? ' *' : ''}
                    <select value={result.mapping[f] ?? ''} onChange={(e) => setMapping({ ...result.mapping, [f]: e.target.value || undefined })}
                      className="focus-ring mt-1 block w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">
                      <option value="">— not in file —</option>
                      {result.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </details>
          )}
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void run()} disabled={busy || result.orders.length === 0}>{busy ? 'Importing…' : `Import ${result.orders.length} work order${result.orders.length === 1 ? '' : 's'}`}</Button>
            <Button variant="ghost" onClick={() => { setText(''); setFileName(''); setMapping(undefined); }} disabled={busy}>Clear</Button>
          </div>
        </section>
      )}
      {lastBatches.length > 0 && <Button variant="secondary" size="sm" onClick={() => void undo()} disabled={busy}>Undo last import</Button>}
    </div>
  );
}

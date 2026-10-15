import { useMemo, useRef, useState } from 'react';
import { CheckCircle2, FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { Modal } from './Modal';
import {
  BLOCK_CATEGORY_LABELS,
  DNC_REASON_LABELS,
  MAX_IMPORT_ROWS,
  formatPhone,
  importEntries,
  parseNumberList,
  type BlockCategory,
  type DncReason,
  type ImportResult,
  type ListKind,
} from '@/lib/callBlocklist';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SELECT_CLASS = 'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary';

interface BulkImportDialogProps {
  open: boolean;
  kind: ListKind;
  ownerId: string;
  userId: string;
  onClose: () => void;
  onImported: () => void;
}

export function BulkImportDialog({ open, kind, ownerId, userId, onClose, onImported }: BulkImportDialogProps) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [category, setCategory] = useState<string>(kind === 'blocklist' ? 'spam' : 'manual');
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ImportResult | null>(null);

  const parsed = useMemo(() => parseNumberList(text), [text]);
  const categoryOptions: [string, string][] =
    kind === 'blocklist'
      ? (Object.entries(BLOCK_CATEGORY_LABELS) as [BlockCategory, string][])
      : (['manual', 'national_registry'] as DncReason[]).map((r) => [r, DNC_REASON_LABELS[r]]);

  const reset = () => {
    setText('');
    setResult(null);
    setProgress(0);
  };
  const close = () => {
    if (importing) return;
    reset();
    onClose();
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      toast('That file is larger than 2 MB. Split it into smaller files.', 'error');
      return;
    }
    setText(await file.text());
    setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const run = async () => {
    if (parsed.valid.length === 0 || importing) return;
    setImporting(true);
    setProgress(0);
    try {
      const res = await importEntries(kind, ownerId, userId, parsed.valid, category, (done, total) => setProgress(Math.round((done / total) * 100)));
      setResult(res);
      if (res.added > 0) onImported();
      if (res.failed > 0) toast(`${res.failed} numbers could not be saved. Try importing again.`, 'error');
    } catch {
      toast('Import failed. Nothing further was saved.', 'error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <Modal open={open} title="Import numbers" description={`Paste or upload up to ${MAX_IMPORT_ROWS.toLocaleString()} numbers. Existing entries are never overwritten.`} onClose={close}>
      {result ? (
        <div className="space-y-4" role="status">
          <div className="flex items-start gap-3 rounded-xl bg-success-500/10 p-4">
            <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-success-500" />
            <div className="text-sm text-text-primary">
              <p className="font-semibold">{result.added.toLocaleString()} added</p>
              <p className="text-text-secondary">
                {result.skipped.toLocaleString()} already on the list{result.failed > 0 ? ` · ${result.failed.toLocaleString()} failed` : ''}
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={reset}>Import more</Button>
            <Button type="button" onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <input ref={fileRef} type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" id="import-file" onChange={(e) => void handleFile(e.target.files?.[0])} />
            <label htmlFor="import-file" className="focus-within:ring-2 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-5 text-sm font-medium text-text-secondary transition-colors hover:border-accent hover:text-text-primary">
              <FileUp size={16} /> Upload a .csv or .txt file
            </label>
          </div>

          <Textarea
            label="Or paste numbers"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={'(512) 555-0123, Roofing spam\n+442079460958'}
            helperText="One per line. Add a note after a comma if you like."
          />

          <div>
            <label htmlFor="import-category" className="mb-1 block text-xs font-medium text-text-secondary">{kind === 'blocklist' ? 'Category' : 'Source of these numbers'}</label>
            <select id="import-category" className={SELECT_CLASS} value={category} onChange={(e) => setCategory(e.target.value)}>
              {categoryOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          {text.trim() && (
            <div className="space-y-2 rounded-xl bg-bg-tertiary p-4 text-sm" aria-live="polite">
              <p className="font-semibold text-text-primary">{parsed.valid.length.toLocaleString()} valid numbers ready</p>
              <p className="text-xs text-text-secondary">
                {parsed.duplicates} duplicate{parsed.duplicates === 1 ? '' : 's'} in file · {parsed.invalid.length} invalid
                {parsed.truncated ? ` · only the first ${MAX_IMPORT_ROWS.toLocaleString()} will be imported` : ''}
              </p>
              {parsed.valid.length > 0 && <p className="truncate text-xs text-text-secondary">First: {formatPhone(parsed.valid[0].phone)}</p>}
              {parsed.invalid.length > 0 && (
                <ul className="max-h-24 space-y-0.5 overflow-y-auto text-xs text-danger">
                  {parsed.invalid.slice(0, 5).map((i) => (
                    <li key={i.line}>Line {i.line}: {i.reason}</li>
                  ))}
                  {parsed.invalid.length > 5 && <li>…and {parsed.invalid.length - 5} more</li>}
                </ul>
              )}
            </div>
          )}

          {importing && (
            <div role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} className="h-2 overflow-hidden rounded-full bg-bg-tertiary">
              <div className="h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close} disabled={importing}>Cancel</Button>
            <Button type="button" onClick={() => void run()} disabled={parsed.valid.length === 0 || importing}>
              {importing && <Loader2 size={14} className="animate-spin" />}
              Import {parsed.valid.length > 0 ? parsed.valid.length.toLocaleString() : ''}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

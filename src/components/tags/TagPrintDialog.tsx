import { useEffect, useState } from 'react';
import { Download, Printer, X } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { SHEET_PRESETS, downloadTagSheetPdf, labelsPerSheet, type PrintableTag, type SheetPresetId } from '@/lib/tagLabelSheet';

interface Props {
  tags: PrintableTag[];
  businessName?: string;
  title?: string;
  notice?: string;
  onClose: () => void;
}

export function TagPrintDialog({ tags, businessName, title = 'Print tag labels', notice, onClose }: Props) {
  const { toast } = useToast();
  const [preset, setPreset] = useState<SheetPresetId>('a4_24');
  const [startSlot, setStartSlot] = useState(1);
  const [outline, setOutline] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = SHEET_PRESETS[preset];
  const per = labelsPerSheet(p);
  const pages = Math.max(1, Math.ceil((startSlot - 1 + tags.length) / per));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const download = async () => {
    setBusy(true);
    try {
      await downloadTagSheetPdf(tags, { preset, startSlot: startSlot - 1, businessName, outline });
      toast('Label sheet downloaded', 'success');
    } catch {
      toast('Could not build the PDF. Please try again.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="tag-print-title">
      <div className="w-full max-w-md rounded-2xl border border-border bg-bg-secondary p-5 shadow-card dark:shadow-card-dark">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 id="tag-print-title" className="flex items-center gap-2 text-base font-semibold text-text-primary"><Printer size={16} aria-hidden="true" /> {title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="focus-ring rounded-md p-1 text-text-secondary hover:text-text-primary"><X size={16} /></button>
        </div>
        {notice && <p className="mb-3 rounded-lg bg-warning-500/10 p-3 text-xs text-text-primary">{notice}</p>}
        <p className="mb-3 text-sm text-text-secondary">{tags.length} label{tags.length === 1 ? '' : 's'} · {pages} page{pages === 1 ? '' : 's'}. Print at 100% scale (no “fit to page”). Tamper-evident vinyl is recommended.</p>
        <label className="mb-3 block text-xs font-medium text-text-secondary">Label stock
          <select className={`${field} mt-1`} value={preset} onChange={(e) => { setPreset(e.target.value as SheetPresetId); setStartSlot(1); }}>
            {Object.values(SHEET_PRESETS).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="mb-3 block text-xs font-medium text-text-secondary">Start at label # (reuse a partly used sheet)
          <input type="number" min={1} max={per} value={startSlot} onChange={(e) => setStartSlot(Math.max(1, Math.min(per, Number(e.target.value) || 1)))} className={`${field} mt-1`} />
        </label>
        <label className="mb-4 flex items-center gap-2 text-sm text-text-secondary">
          <input type="checkbox" checked={outline} onChange={(e) => setOutline(e.target.checked)} /> Draw label outlines (plain paper)
        </label>
        <button type="button" onClick={download} disabled={busy || tags.length === 0} className="focus-ring inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
          <Download size={15} aria-hidden="true" /> {busy ? 'Building PDF…' : 'Download PDF'}
        </button>
      </div>
    </div>
  );
}

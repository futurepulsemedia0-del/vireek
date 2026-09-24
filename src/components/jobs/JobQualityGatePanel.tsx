import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldCheck, ShieldAlert, PenTool, Trash2, Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Job } from '@/lib/supabase';
import {
  fetchQualityGateReport,
  fetchChecklistTemplates,
  fetchChecklistCompletions,
  toggleChecklistItem,
  saveCompletionNotes,
  saveCustomerSignature,
  clearCustomerSignature,
  QUALITY_GATE_LABELS,
  type QualityGateReport,
  type ChecklistTemplateItem,
  type QualityGateCategoryKey,
} from '@/lib/jobQualityGate';

const CATEGORY_ORDER: QualityGateCategoryKey[] = [
  'photos',
  'checklist',
  'part_usage',
  'signature',
  'serial_number',
  'notes',
  'safety_evidence',
];

function SignaturePad({ jobId, onSaved }: { jobId: string; onSaved: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [hasStroke, setHasStroke] = useState(false);
  const [signerName, setSignerName] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const getPos = (e: React.MouseEvent | React.TouchEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const point = 'touches' in e ? e.touches[0] : e;
    return { x: point.clientX - rect.left, y: point.clientY - rect.top };
  };

  const start = (e: React.MouseEvent | React.TouchEvent) => {
    drawing.current = true;
    const ctx = canvasRef.current!.getContext('2d')!;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };

  const move = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    const { x, y } = getPos(e);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineTo(x, y);
    ctx.stroke();
    setHasStroke(true);
  };

  const end = () => {
    drawing.current = false;
  };

  const clearPad = () => {
    const canvas = canvasRef.current!;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    setHasStroke(false);
  };

  const save = async () => {
    if (!hasStroke) return;
    setSaving(true);
    try {
      const dataUrl = canvasRef.current!.toDataURL('image/png');
      await saveCustomerSignature(jobId, dataUrl, signerName);
      toast('Signature captured.', 'success');
      onSaved();
    } catch {
      toast('Could not save the signature.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      <canvas
        ref={canvasRef}
        width={360}
        height={120}
        className="w-full cursor-crosshair rounded-lg border border-border bg-white touch-none"
        onMouseDown={start}
        onMouseMove={move}
        onMouseUp={end}
        onMouseLeave={end}
        onTouchStart={start}
        onTouchMove={move}
        onTouchEnd={end}
      />
      <input
        type="text"
        placeholder="Customer name (optional)"
        value={signerName}
        onChange={(e) => setSignerName(e.target.value)}
        className="w-full rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm"
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!hasStroke || saving}
          className="focus-ring flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <PenTool size={13} />} Save signature
        </button>
        <button
          type="button"
          onClick={clearPad}
          className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
        >
          <Trash2 size={13} /> Clear
        </button>
      </div>
    </div>
  );
}

export function JobQualityGatePanel({ job }: { job: Job }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [report, setReport] = useState<QualityGateReport | null>(null);
  const [templates, setTemplates] = useState<ChecklistTemplateItem[]>([]);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState(job.completion_notes ?? '');
  const [savingNotes, setSavingNotes] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [r, tpl, done] = await Promise.all([
        fetchQualityGateReport(job.id),
        job.service_type ? fetchChecklistTemplates(job.service_type) : Promise.resolve([]),
        fetchChecklistCompletions(job.id),
      ]);
      setReport(r);
      setTemplates(tpl);
      setCompleted(done);
    } catch {
      // panel just stays in its last known state
    }
  }, [job.id, job.service_type]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggleItem = async (itemId: string, checked: boolean) => {
    setCompleted((prev) => {
      const next = new Set(prev);
      if (checked) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
    try {
      await toggleChecklistItem(job.id, itemId, checked, null);
      refresh();
    } catch {
      toast('Could not update checklist item.', 'error');
      refresh();
    }
  };

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    try {
      await saveCompletionNotes(job.id, notes);
      toast('Notes saved.', 'success');
      refresh();
    } catch {
      toast('Could not save notes.', 'error');
    } finally {
      setSavingNotes(false);
    }
  };

  if (!report) return null;

  const ready = report.ready_to_close;

  return (
    <div className={`rounded-xl border p-4 ${ready ? 'border-success-500/30 bg-success-500/5' : 'border-warning-500/30 bg-warning-500/5'}`}>
      <button type="button" onClick={() => setExpanded((v) => !v)} className="focus-ring flex w-full items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          {ready ? <ShieldCheck size={16} className="text-success-500" /> : <ShieldAlert size={16} className="text-warning-500" />}
          Quality Gate — {ready ? 'Ready to close' : `${report.gaps.length} item${report.gaps.length === 1 ? '' : 's'} missing`}
        </span>
        <span className="text-xs text-text-secondary">{expanded ? 'Hide' : 'Details'}</span>
      </button>

      {!ready && (
        <p className="mt-1.5 text-xs text-text-secondary">
          This job can't be marked completed or invoiced until: {report.gaps.map((g) => QUALITY_GATE_LABELS[g]).join(', ')}.
        </p>
      )}

      {expanded && (
        <div className="mt-3 space-y-4 border-t border-border/60 pt-3">
          <ul className="space-y-1.5 text-xs">
            {CATEGORY_ORDER.filter((k) => report.categories[k]?.required).map((k) => (
              <li key={k} className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 rounded-full ${report.categories[k].satisfied ? 'bg-success-500' : 'bg-warning-500'}`} />
                <span className={report.categories[k].satisfied ? 'text-text-secondary' : 'text-text-primary font-medium'}>
                  {QUALITY_GATE_LABELS[k]}
                  {k === 'checklist' && report.categories[k].total ? ` (${report.categories[k].done}/${report.categories[k].total})` : ''}
                  {k === 'part_usage' && report.categories[k].total ? ` (${report.categories[k].installed}/${report.categories[k].total})` : ''}
                </span>
              </li>
            ))}
          </ul>

          {templates.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-text-secondary">Checklist</p>
              <div className="space-y-1.5">
                {templates.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-sm text-text-primary">
                    <input
                      type="checkbox"
                      checked={completed.has(t.id)}
                      onChange={(e) => handleToggleItem(t.id, e.target.checked)}
                      className="h-4 w-4 rounded border-border"
                    />
                    {t.item_label}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-xs font-medium text-text-secondary">Completion notes</p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="What was found and done on this visit..."
              className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={handleSaveNotes}
              disabled={savingNotes || notes === (job.completion_notes ?? '')}
              className="focus-ring mt-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {savingNotes ? 'Saving...' : 'Save notes'}
            </button>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-text-secondary">Customer signature</p>
            {job.customer_signature_data_url ? (
              <div className="flex items-center gap-3">
                <img src={job.customer_signature_data_url} alt="Customer signature" className="h-16 rounded border border-border bg-white" />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await clearCustomerSignature(job.id);
                      refresh();
                    } catch {
                      toast('Could not clear signature.', 'error');
                    }
                  }}
                  className="focus-ring flex items-center gap-1 text-xs text-danger hover:underline"
                >
                  <Trash2 size={12} /> Recapture
                </button>
              </div>
            ) : (
              <SignaturePad jobId={job.id} onSaved={refresh} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

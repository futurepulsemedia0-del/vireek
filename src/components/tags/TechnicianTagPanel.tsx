import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, QrCode, ScanLine } from 'lucide-react';
import { BarcodeScanSheet } from '@/components/technician/BarcodeScanSheet';
import { useToast } from '@/contexts/ToastContext';
import { assignTag, formatTagToken, isValidTagToken, normalizeTagToken, resolveTag, tagErrorMessage } from '@/lib/vireekTag';

interface EquipmentLite { id: string; make?: string | null; model?: string | null; equipment_type: string }
type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'pick'; token: string }
  | { kind: 'done'; token: string }
  | { kind: 'msg'; text: string; token?: string };

/** Technician flow: scan a blank tag from the sheet, pick the machine on this job, done. */
export function TechnicianTagPanel({ equipment, onAssigned }: { equipment: EquipmentLite[]; onAssigned?: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const onCode = async (raw: string) => {
    setOpen(false);
    const token = normalizeTagToken(raw);
    if (!isValidTagToken(token)) { setPhase({ kind: 'msg', text: 'That is not a Vireek Tag. Scan the QR on the sticker.' }); return; }
    setPhase({ kind: 'busy' });
    try {
      const r = await resolveTag(token, 'qr');
      if (!r.found) setPhase({ kind: 'msg', text: 'Tag not recognised.' });
      else if (r.state === 'unassigned' && r.can_assign) setPhase({ kind: 'pick', token });
      else if (r.state === 'unassigned') setPhase({ kind: 'msg', text: 'This tag belongs to another company.' });
      else if (r.state === 'active') setPhase({ kind: 'msg', text: 'This tag is already attached to a machine.', token });
      else setPhase({ kind: 'msg', text: 'This tag was retired. Use a new sticker.' });
    } catch (e) {
      setPhase({ kind: 'msg', text: tagErrorMessage(e) });
    }
  };

  const attach = async (token: string, equipmentId: string) => {
    setPhase({ kind: 'busy' });
    try {
      await assignTag(token, equipmentId);
      toast('Tag attached — stick it on the unit', 'success');
      setPhase({ kind: 'done', token });
      onAssigned?.();
    } catch (e) {
      toast(tagErrorMessage(e), 'error');
      setPhase({ kind: 'pick', token });
    }
  };

  return (
    <section className="rounded-lg border border-border bg-bg-secondary p-3" aria-labelledby="tech-tag-title">
      <h2 id="tech-tag-title" className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-text-primary"><QrCode size={15} className="text-accent" aria-hidden="true" /> Vireek Tag</h2>

      {phase.kind === 'idle' || phase.kind === 'msg' ? (
        <>
          <button type="button" onClick={() => setOpen(true)} className="focus-ring inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm font-semibold text-white hover:opacity-90">
            <ScanLine size={15} aria-hidden="true" /> Scan a tag
          </button>
          {phase.kind === 'msg' && (
            <p role="status" className="mt-2 text-xs text-text-secondary">
              {phase.text} {phase.token && <Link className="text-accent underline" to={`/t/${phase.token}`}>Open it</Link>}
            </p>
          )}
        </>
      ) : null}

      {phase.kind === 'busy' && <p className="text-sm text-text-secondary" aria-busy="true">Working…</p>}

      {phase.kind === 'pick' && (
        <div>
          <p className="mb-2 text-xs text-text-secondary">Attach <span className="font-mono">{formatTagToken(phase.token)}</span> to:</p>
          {equipment.length === 0 ? (
            <p className="text-xs text-text-secondary">No equipment on this job yet. Scan the data plate above first, then scan the tag again.</p>
          ) : (
            <ul className="space-y-1.5">
              {equipment.map((e) => (
                <li key={e.id}>
                  <button type="button" onClick={() => void attach(phase.token, e.id)} className="focus-ring w-full rounded-lg border border-border p-3 text-left text-sm text-text-primary hover:border-accent/40">
                    {[e.make, e.model].filter(Boolean).join(' ') || e.equipment_type} <span className="text-xs text-text-secondary">({e.equipment_type})</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setPhase({ kind: 'idle' })} className="focus-ring mt-2 text-xs text-text-secondary underline">Cancel</button>
        </div>
      )}

      {phase.kind === 'done' && (
        <div className="flex items-center justify-between gap-2 text-sm text-text-primary">
          <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={15} className="text-success-500" aria-hidden="true" /> Tag attached.</span>
          <Link className="text-xs text-accent underline" to={`/t/${phase.token}`}>View tag page</Link>
        </div>
      )}

      <BarcodeScanSheet open={open} onClose={() => setOpen(false)} onCode={(c) => void onCode(c)} hint="Point the camera at the Vireek Tag QR" />
    </section>
  );
}

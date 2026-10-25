import { useState } from 'react';
import { Check, Keyboard, ScanLine } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { BarcodeScanSheet } from '@/components/technician/BarcodeScanSheet';
import {
  confirmTransferLine,
  describeStatus,
  isOk,
  opsErrorMessage,
  parseConfirmQty,
  type TransferLine,
  type TransferStage,
} from '@/lib/truckOps';

interface Props {
  line: TransferLine;
  stage: TransferStage;
  /** Called after the server accepted the confirmation so the parent can reload. */
  onConfirmed: () => void;
  /** Larger touch targets for the technician screen. */
  large?: boolean;
}

/**
 * One transfer line: scan the part's barcode to confirm it (the server checks the barcode really is this part),
 * set how many were picked/received, or — if the label is unreadable — confirm by hand with a short reason.
 * Confirming is "set", not "add": doing it twice with the same number changes nothing.
 */
export function TransferLineConfirm({ line, stage, onConfirmed, large = false }: Props) {
  const { toast } = useToast();
  const max = stage === 'pick' ? line.qty_planned : line.qty_picked;
  const confirmedAt = stage === 'pick' ? line.picked_at : line.received_at;
  const confirmedQty = stage === 'pick' ? line.qty_picked : line.qty_received;
  const scanned = stage === 'pick' ? line.pick_scanned : line.receive_scanned;

  const [editing, setEditing] = useState(confirmedAt === null);
  const [qtyText, setQtyText] = useState(String(confirmedAt === null ? max : confirmedQty));
  const [scanOpen, setScanOpen] = useState(false);
  const [manual, setManual] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const btn = large ? 'min-h-[48px] px-4 text-base' : 'min-h-[36px] px-3 text-sm';

  const submit = async (code?: string) => {
    const parsed = parseConfirmQty(qtyText, max);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!code && parsed.value > 0 && reason.trim().length < 3) {
      setError('Scan the barcode, or write a short reason (3+ characters) for confirming by hand.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await confirmTransferLine({
        lineId: line.id,
        stage,
        quantity: parsed.value,
        code,
        overrideReason: code ? undefined : reason.trim() || undefined,
      });
      if (isOk(result)) {
        toast(`${line.part?.name ?? 'Part'}: ${parsed.value} confirmed`, 'success');
        setEditing(false);
        setManual(false);
        onConfirmed();
      } else {
        setError(describeStatus(result));
      }
    } catch (err) {
      setError(opsErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onScan = (code: string) => {
    setScanOpen(false);
    void submit(code);
  };

  return (
    <li className="rounded-xl border border-border bg-bg-primary p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary">{line.part?.name ?? 'Part'}</p>
          <p className="truncate text-xs text-text-secondary">
            {line.part?.part_number ? `${line.part.part_number} · ` : ''}
            {stage === 'pick' ? `Planned ${line.qty_planned}` : `Shipped ${line.qty_picked}`}
          </p>
        </div>
        {confirmedAt !== null && !editing && (
          <span className="flex flex-shrink-0 items-center gap-1 rounded-full bg-success-500/10 px-2.5 py-1 text-xs font-medium text-success-500">
            <Check className="h-3.5 w-3.5" aria-hidden />
            {confirmedQty} {scanned ? 'scanned' : 'by hand'}
          </span>
        )}
      </div>

      {confirmedAt !== null && !editing ? (
        <button type="button" onClick={() => setEditing(true)} className="focus-ring mt-2 text-xs font-medium text-accent hover:underline">
          Change
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2">
            <label htmlFor={`qty-${line.id}-${stage}`} className="text-xs font-medium text-text-secondary">
              {stage === 'pick' ? 'Picked' : 'Received'}
            </label>
            <input
              id={`qty-${line.id}-${stage}`}
              inputMode="numeric"
              value={qtyText}
              onChange={(e) => {
                setQtyText(e.target.value);
                setError(null);
              }}
              className="focus-ring w-20 rounded-lg border border-border bg-bg-secondary px-2 py-1.5 text-center text-sm text-text-primary"
            />
            <span className="text-xs text-text-secondary">of {max}</span>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setScanOpen(true)}
              className={`focus-ring flex items-center gap-1.5 rounded-xl bg-accent font-semibold text-white disabled:opacity-50 ${btn}`}
            >
              <ScanLine className="h-4 w-4" aria-hidden /> Scan to confirm
            </button>
            {qtyText.trim() === '0' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit()}
                className={`focus-ring rounded-xl border border-border font-medium text-text-primary disabled:opacity-50 ${btn}`}
              >
                Confirm none
              </button>
            )}
            <button
              type="button"
              onClick={() => setManual((m) => !m)}
              aria-expanded={manual}
              className={`focus-ring flex items-center gap-1.5 rounded-xl border border-dashed border-border text-text-secondary hover:text-text-primary ${btn}`}
            >
              <Keyboard className="h-4 w-4" aria-hidden /> No barcode?
            </button>
          </div>

          {manual && (
            <div className="space-y-2 rounded-lg bg-bg-tertiary p-2">
              <label htmlFor={`why-${line.id}-${stage}`} className="block text-xs font-medium text-text-secondary">
                Why can't you scan it?
              </label>
              <input
                id={`why-${line.id}-${stage}`}
                value={reason}
                maxLength={300}
                onChange={(e) => {
                  setReason(e.target.value);
                  setError(null);
                }}
                placeholder="e.g. label torn"
                className="focus-ring w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void submit()}
                className={`focus-ring rounded-xl bg-bg-primary font-semibold text-text-primary ring-1 ring-border disabled:opacity-50 ${btn}`}
              >
                Confirm by hand
              </button>
            </div>
          )}

          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      )}

      <BarcodeScanSheet
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onCode={onScan}
        hint={`Scan the barcode of ${line.part?.name ?? 'the part'}`}
      />
    </li>
  );
}

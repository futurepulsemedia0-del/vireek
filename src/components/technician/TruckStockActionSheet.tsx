import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowDownToLine, Minus, PackageMinus, PackagePlus, Plus, Undo2, X } from 'lucide-react';
import {
  availableQty,
  MAX_QUANTITY,
  refillQty,
  stockLevel,
  suggestedRequestQty,
  type NewOp,
  type ReturnKind,
  type TruckItem,
  type TruckJob,
  type TruckVendor,
} from '@/lib/truckStockField';
import { TONE_CLASSES, TRUCK_STATUS_META } from '@/lib/truckStock';

export type ActionMode = 'use' | 'request' | 'return';

interface Props {
  item: TruckItem;
  /** False when the part came from the catalog but is not on this truck's list. */
  onTruck: boolean;
  mode: ActionMode;
  jobs: TruckJob[];
  vendors: TruckVendor[];
  /** Offer "Record & scan next" (set when the sheet was opened from a scan). */
  fromScan: boolean;
  onModeChange: (mode: ActionMode) => void;
  onSubmit: (op: NewOp, options: { scanNext: boolean }) => void;
  onClose: () => void;
}

const MODES: { id: ActionMode; label: string; icon: typeof PackageMinus }[] = [
  { id: 'use', label: 'Use', icon: PackageMinus },
  { id: 'request', label: 'Request', icon: PackagePlus },
  { id: 'return', label: 'Return', icon: Undo2 },
];

const RETURN_OPTIONS: { id: ReturnKind; label: string; help: string }[] = [
  { id: 'unused', label: 'Put back on truck', help: 'Not installed — add it back to this truck.' },
  { id: 'to_warehouse', label: 'Send to warehouse', help: 'Moves it off this truck into the warehouse.' },
  { id: 'core', label: 'Core return to vendor', help: 'The old unit goes back to the vendor for credit.' },
];

const JOB_STATUS: Record<string, string> = { scheduled: 'Scheduled', en_route: 'En route', in_progress: 'In progress', completed: 'Completed' };

function Stepper({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const clamp = (n: number) => Math.min(Math.max(Math.trunc(n) || 1, 1), MAX_QUANTITY);
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => onChange(clamp(value - 1))}
        disabled={value <= 1}
        aria-label="Decrease quantity"
        className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-primary active:scale-95 disabled:opacity-40"
      >
        <Minus className="h-5 w-5" />
      </button>
      <input
        aria-label={label}
        type="number"
        inputMode="numeric"
        min={1}
        max={MAX_QUANTITY}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        onFocus={(e) => e.target.select()}
        className="h-12 w-20 rounded-xl border border-border bg-bg-primary text-center text-xl font-semibold tabular-nums text-text-primary focus:border-accent focus:outline-none"
      />
      <button
        type="button"
        onClick={() => onChange(clamp(value + 1))}
        disabled={value >= MAX_QUANTITY}
        aria-label="Increase quantity"
        className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-bg-secondary text-text-primary active:scale-95 disabled:opacity-40"
      >
        <Plus className="h-5 w-5" />
      </button>
    </div>
  );
}

export function TruckStockActionSheet({ item, onTruck, mode, jobs, vendors, fromScan, onModeChange, onSubmit, onClose }: Props) {
  const avail = availableQty(item);
  const level = stockLevel(item);
  const activeJobs = useMemo(() => jobs.filter((j) => j.job_status !== 'completed'), [jobs]);
  const inProgress = useMemo(() => jobs.filter((j) => j.job_status === 'in_progress'), [jobs]);

  const [qty, setQty] = useState(1);
  const [jobId, setJobId] = useState('');
  const [note, setNote] = useState('');
  const [returnKind, setReturnKind] = useState<ReturnKind>('unused');
  const [vendorId, setVendorId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);

  // Sensible defaults each time the mode (or part) changes.
  useEffect(() => {
    setError(null);
    setNote('');
    if (mode === 'request') setQty(suggestedRequestQty(item));
    else setQty(1);
    setJobId(mode === 'use' && inProgress.length === 1 ? inProgress[0].id : '');
    setReturnKind('unused');
    setVendorId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, item.part_id]);

  useEffect(() => {
    firstRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const overUse = mode === 'use' && qty > Math.max(avail, 0);
  const overReturn = mode === 'return' && returnKind === 'to_warehouse' && qty > Math.max(avail, 0);
  const jobOptions = mode === 'use' ? activeJobs : jobs;

  const submit = (e: FormEvent, scanNext = false) => {
    e.preventDefault();
    if (mode === 'return' && returnKind === 'core' && !vendorId) {
      setError('Pick the vendor this core goes back to.');
      return;
    }
    if (overReturn) {
      setError(`The truck only shows ${Math.max(avail, 0)} of this part.`);
      return;
    }
    try {
      onSubmit(
        {
          kind: mode,
          part_id: item.part_id,
          part_name: item.name,
          quantity: qty,
          job_id: jobId || null,
          note: note || null,
          return_kind: mode === 'return' ? returnKind : null,
          vendor_id: mode === 'return' && returnKind === 'core' ? vendorId : null,
        },
        { scanNext },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this.');
    }
  };

  const submitLabel = mode === 'use' ? 'Record usage' : mode === 'request' ? 'Send request' : 'Record return';

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" role="presentation">
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/50" />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="truck-stock-sheet-title"
        onSubmit={(e) => submit(e)}
        className="relative z-10 flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-3xl border border-border bg-bg-primary shadow-2xl sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0">
            <h2 id="truck-stock-sheet-title" className="truncate text-lg font-semibold text-text-primary">{item.name}</h2>
            <p className="truncate text-xs text-text-secondary">
              {[item.part_number, item.barcode].filter(Boolean).join(' · ') || 'No part number'}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-text-secondary">
              {onTruck ? (
                <>
                  <span>
                    On truck: <strong className="tabular-nums text-text-primary">{avail}</strong>
                    {item.unit_label ? ` ${item.unit_label}` : ''}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[TRUCK_STATUS_META[level].tone]}`}>
                    {TRUCK_STATUS_META[level].label}
                  </span>
                </>
              ) : (
                <span className="text-warning-500">Not on your truck's list</span>
              )}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-text-secondary active:bg-bg-tertiary">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div role="tablist" aria-label="Action" className="mx-5 grid grid-cols-3 gap-1 rounded-2xl bg-bg-tertiary p-1">
          {MODES.map((m, i) => {
            const Icon = m.icon;
            const active = m.id === mode;
            return (
              <button
                key={m.id}
                ref={i === 0 ? firstRef : undefined}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onModeChange(m.id)}
                className={`flex h-11 items-center justify-center gap-1.5 rounded-xl text-sm font-medium ${active ? 'bg-bg-primary text-text-primary shadow-sm' : 'text-text-secondary'}`}
              >
                <Icon className="h-4 w-4" aria-hidden /> {m.label}
              </button>
            );
          })}
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <div>
            <p className="mb-2 text-sm font-medium text-text-primary">Quantity</p>
            <Stepper value={qty} onChange={setQty} label="Quantity" />
            {mode === 'request' && item.requested_qty > 0 && (
              <p className="mt-2 text-xs text-text-secondary">
                {item.requested_qty} already requested. A new request raises it to the larger amount instead of adding to it.
              </p>
            )}
            {mode === 'request' && refillQty(item) > 0 && (
              <p className="mt-2 text-xs text-text-secondary">{refillQty(item)} needed to get back to your truck's target.</p>
            )}
          </div>

          {overUse && (
            <p role="status" className="flex gap-2 rounded-xl bg-warning-500/10 p-3 text-sm text-warning-500">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
              <span>
                The truck shows {Math.max(avail, 0)}. It will still be recorded — you used it — and flagged so the office can fix the count.
              </span>
            </p>
          )}

          {mode === 'return' && (
            <fieldset>
              <legend className="mb-2 text-sm font-medium text-text-primary">What are you doing with it?</legend>
              <div className="space-y-2">
                {RETURN_OPTIONS.map((o) => (
                  <label
                    key={o.id}
                    className={`flex min-h-[3.25rem] cursor-pointer items-start gap-3 rounded-xl border p-3 ${returnKind === o.id ? 'border-accent bg-accent/5' : 'border-border bg-bg-secondary'}`}
                  >
                    <input type="radio" name="return-kind" value={o.id} checked={returnKind === o.id} onChange={() => setReturnKind(o.id)} className="mt-1" />
                    <span>
                      <span className="block text-sm font-medium text-text-primary">{o.label}</span>
                      <span className="block text-xs text-text-secondary">{o.help}</span>
                    </span>
                  </label>
                ))}
              </div>
              {overReturn && <p className="mt-2 text-xs text-danger">The truck only shows {Math.max(avail, 0)} of this part.</p>}
            </fieldset>
          )}

          {mode === 'return' && returnKind === 'core' && (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text-primary">Vendor</span>
              <select
                value={vendorId}
                onChange={(e) => setVendorId(e.target.value)}
                className="h-12 w-full rounded-xl border border-border bg-bg-secondary px-3 text-base text-text-primary focus:border-accent focus:outline-none"
              >
                <option value="">Choose a vendor…</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              {vendors.length === 0 && <span className="mt-1 block text-xs text-text-secondary">The office has not added any vendors yet.</span>}
            </label>
          )}

          {jobOptions.length > 0 && (
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-text-primary">Job <span className="font-normal text-text-secondary">(optional)</span></span>
              <select
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                className="h-12 w-full rounded-xl border border-border bg-bg-secondary px-3 text-base text-text-primary focus:border-accent focus:outline-none"
              >
                <option value="">Not linked to a job</option>
                {jobOptions.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.customer_name} — {JOB_STATUS[j.job_status] ?? j.job_status}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-text-primary">
              {mode === 'return' ? 'Reason' : 'Note'} <span className="font-normal text-text-secondary">(optional)</span>
            </span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              placeholder={mode === 'request' ? 'e.g. needed for tomorrow’s 8am job' : mode === 'return' ? 'e.g. wrong size' : 'e.g. replaced failed unit'}
              className="h-12 w-full rounded-xl border border-border bg-bg-secondary px-3 text-base text-text-primary placeholder:text-text-secondary/60 focus:border-accent focus:outline-none"
            />
          </label>

          {error && (
            <p role="alert" className="rounded-xl bg-danger/10 p-3 text-sm text-danger">{error}</p>
          )}
        </div>

        <div className="flex gap-2 border-t border-border px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          {mode === 'use' && fromScan && (
            <button
              type="button"
              onClick={(e) => submit(e as unknown as FormEvent, true)}
              className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl border border-accent text-sm font-semibold text-accent active:scale-[0.98]"
            >
              <ArrowDownToLine className="h-4 w-4" aria-hidden /> Record &amp; scan next
            </button>
          )}
          <button type="submit" className="h-12 flex-1 rounded-xl bg-accent text-sm font-semibold text-white active:scale-[0.98]">
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

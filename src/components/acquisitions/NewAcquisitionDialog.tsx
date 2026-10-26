import { useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { Field, fieldCls } from '@/components/acquisitions/acquisitionUi';
import { createAcquisition, describeAcquisitionError, type LinkOptions } from '@/lib/acquisitionsApi';
import { EMPTY_DRAFT, SCOPES, SCOPE_HELP, SCOPE_LABELS, todayIso, validateNewAcquisition, type NewAcquisitionDraft, type ScopeKind } from '@/lib/acquisitions';

interface Props {
  open: boolean;
  options: LinkOptions | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}

export function NewAcquisitionDialog({ open, options, onClose, onCreated }: Props) {
  const today = useMemo(() => todayIso(), []);
  const [draft, setDraft] = useState<NewAcquisitionDraft>(() => EMPTY_DRAFT(today));
  const [errors, setErrors] = useState<Partial<Record<keyof NewAcquisitionDraft, string>>>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const ref = useFocusTrap(open);
  useEscapeToClose(open, busy ? () => undefined : onClose);

  useEffect(() => {
    if (open) { setDraft(EMPTY_DRAFT(today)); setErrors({}); setServerError(null); }
  }, [open, today]);

  if (!open) return null;
  const set = <K extends keyof NewAcquisitionDraft>(k: K, v: NewAcquisitionDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const linked = options?.franchiseLocations ?? [];

  const submit = async () => {
    const e = validateNewAcquisition(draft, today);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setBusy(true); setServerError(null);
    try { onCreated(await createAcquisition(draft)); }
    catch (err) { setServerError(describeAcquisitionError(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" role="presentation">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="new-acq-title" className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-border bg-bg-secondary p-5 sm:max-w-xl sm:rounded-2xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 id="new-acq-title" className="text-lg font-bold text-text-primary">New acquisition</h2>
            <p className="mt-0.5 text-sm text-text-secondary">We’ll create the 30/60/90-day plan with nine ready-made workstreams, dependencies and due dates.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
        </div>

        <div className="space-y-4">
          <Input label="Business name" required value={draft.name} maxLength={120} error={errors.name} onChange={(e) => set('name', e.target.value)} />
          <Input label="Legal name (optional)" value={draft.legal_name} maxLength={160} error={errors.legal_name} onChange={(e) => set('legal_name', e.target.value)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Closing date (Day 0)" type="date" required value={draft.close_date} error={errors.close_date} onChange={(e) => set('close_date', e.target.value)} />
            <Input label="Purchase price (optional)" inputMode="decimal" placeholder="1250000" value={draft.purchase_price} error={errors.purchase_price} onChange={(e) => set('purchase_price', e.target.value)} />
          </div>

          <Field label="Where does its data live?">
            <select className={fieldCls} value={draft.scope_kind} onChange={(e) => set('scope_kind', e.target.value as ScopeKind)}>
              {SCOPES.map((s) => <option key={s} value={s}>{SCOPE_LABELS[s]}</option>)}
            </select>
            <span className="mt-1 block text-xs text-text-secondary">{SCOPE_HELP[draft.scope_kind]}</span>
          </Field>

          {draft.scope_kind === 'linked_account' && (
            <Field label="Linked account" error={errors.franchise_location_id}>
              <select className={fieldCls} value={draft.franchise_location_id} onChange={(e) => set('franchise_location_id', e.target.value)}>
                <option value="">Choose…</option>
                {linked.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              {linked.length === 0 && <span className="mt-1 block text-xs text-text-secondary">No active franchise accounts yet. Invite the business from Franchise first (account owners only).</span>}
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Brand (optional)">
              <select className={fieldCls} value={draft.brand_id} onChange={(e) => set('brand_id', e.target.value)}>
                <option value="">None</option>
                {(options?.brands ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Location (optional)">
              <select className={fieldCls} value={draft.location_id} onChange={(e) => set('location_id', e.target.value)}>
                <option value="">None</option>
                {(options?.locations ?? []).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
          </div>
          <Textarea label="Notes (optional)" rows={3} value={draft.notes} maxLength={2000} error={errors.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>

        {serverError && <p role="alert" className="mt-4 rounded-xl bg-danger/10 p-3 text-sm text-danger">{serverError}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Create plan
          </Button>
        </div>
      </div>
    </div>
  );
}

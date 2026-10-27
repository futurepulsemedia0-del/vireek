import { useEffect, useMemo, useState } from 'react';
import { Crosshair, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import {
  hasErrors,
  parseDoorsCsv,
  validateDoorDraft,
  type DoorDraft,
  type DoorDraftErrors,
  type DoorInput,
  type Territory,
} from '@/lib/canvassing';
import { addDoors, type AddDoorsSummary } from '@/lib/canvassingApi';
import { Sheet, selectCls } from './canvassUi';

const EMPTY: DoorDraft = { line1: '', line2: '', city: '', state: '', zip: '' };

interface AddDoorsDialogProps {
  open: boolean;
  isManager: boolean;
  /** Territories the caller may add doors to (managers: all active ones; reps: their own). */
  territories: Territory[];
  defaultTerritoryId: string | null;
  /** Point chosen on the map (kept while the dialog is closed during pick mode). */
  point: { lat: number; lng: number } | null;
  onPointChange: (p: { lat: number; lng: number } | null) => void;
  onRequestPick: () => void;
  onClose: () => void;
  /** Called after a successful add; `doorIds` is only meaningful for a single door. */
  onAdded: (summary: AddDoorsSummary, single: boolean) => void;
}

type Mode = 'single' | 'csv';

function summaryText(s: AddDoorsSummary): string {
  const parts = [`${s.inserted} added`];
  if (s.duplicates) parts.push(`${s.duplicates} already on the map`);
  if (s.invalid) parts.push(`${s.invalid} skipped (invalid)`);
  return parts.join(' · ');
}

export function AddDoorsDialog({ open, isManager, territories, defaultTerritoryId, point, onPointChange, onRequestPick, onClose, onAdded }: AddDoorsDialogProps) {
  const { toast } = useToast();
  const [mode, setMode] = useState<Mode>('single');
  const [draft, setDraft] = useState<DoorDraft>(EMPTY);
  const [errors, setErrors] = useState<DoorDraftErrors>({});
  const [territoryId, setTerritoryId] = useState('');
  const [csv, setCsv] = useState('');
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Fresh form every time the dialog opens from the toolbar (not when it re-opens after picking a point).
  const [wasOpen, setWasOpen] = useState(false);
  useEffect(() => {
    if (open && !wasOpen) {
      setTerritoryId((prev) => prev || (defaultTerritoryId ?? (isManager ? '' : territories[0]?.id ?? '')));
      setFormError(null);
    }
    setWasOpen(open);
  }, [open, wasOpen, defaultTerritoryId, isManager, territories]);

  const parsed = useMemo(() => (csv.trim() ? parseDoorsCsv(csv) : null), [csv]);
  const noTerritories = !isManager && territories.length === 0;

  const reset = () => { setDraft(EMPTY); setErrors({}); setCsv(''); setLocateError(null); setFormError(null); onPointChange(null); };
  const close = () => { reset(); onClose(); };

  const locate = () => {
    if (!('geolocation' in navigator)) { setLocateError('This device cannot share its location.'); return; }
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); onPointChange({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      (err) => {
        setLocating(false);
        setLocateError(err.code === 1 ? 'Location is blocked. Allow it in your browser settings or pick the spot on the map.' : 'Could not get your location. Try again or pick the spot on the map.');
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  };

  const needsTerritory = !isManager;
  const territoryMissing = needsTerritory && !territoryId;

  const submit = async () => {
    if (submitting) return;
    setFormError(null);
    if (territoryMissing) { setFormError('Pick one of your territories.'); return; }
    let doors: DoorInput[];
    if (mode === 'single') {
      const errs = validateDoorDraft(draft);
      setErrors(errs);
      if (hasErrors(errs)) return;
      doors = [{ line1: draft.line1.trim(), line2: draft.line2.trim(), city: draft.city.trim(), state: draft.state.trim(), zip: draft.zip.trim(), lat: point?.lat ?? null, lng: point?.lng ?? null }];
    } else {
      if (!parsed || parsed.error) { setFormError(parsed?.error ?? 'Paste your addresses first.'); return; }
      doors = parsed.doors;
    }
    setSubmitting(true);
    try {
      const summary = await addDoors(doors, territoryId || null);
      if (summary.inserted === 0 && summary.duplicates === 0) {
        setFormError('No door was added — check the address and ZIP code.');
        return;
      }
      toast(summaryText(summary), summary.inserted > 0 ? 'success' : 'info');
      const single = mode === 'single';
      reset();
      onAdded(summary, single);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not add the doors.');
    } finally {
      setSubmitting(false);
    }
  };

  const territorySelect = (
    <label className="block text-sm font-medium text-text-primary">
      Territory{needsTerritory && <span className="ml-0.5 text-danger">*</span>}
      <select value={territoryId} onChange={(e) => setTerritoryId(e.target.value)} className={selectCls}>
        {isManager && <option value="">Match by ZIP code automatically</option>}
        {!isManager && <option value="" disabled>Choose a territory…</option>}
        {territories.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </label>
  );

  return (
    <Sheet
      open={open}
      title="Add doors"
      description="Put addresses on the map so reps can log every knock."
      onClose={close}
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" className="flex-1" onClick={close}>Cancel</Button>
          <Button type="button" size="sm" className="flex-1" onClick={() => void submit()} disabled={submitting || noTerritories}>
            {submitting ? 'Adding…' : mode === 'single' ? 'Add door' : parsed && !parsed.error ? `Import ${parsed.doors.length.toLocaleString()} doors` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {noTerritories ? (
          <p role="status" className="rounded-xl border border-border bg-bg-primary px-4 py-3 text-sm text-text-secondary">
            You don&apos;t have a territory yet. Ask your manager to assign you one, then you can add doors here.
          </p>
        ) : (
          <>
            {isManager && (
              <div role="tablist" aria-label="How to add doors" className="flex gap-1 rounded-xl border border-border bg-bg-primary p-1">
                {(['single', 'csv'] as Mode[]).map((m) => (
                  <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setFormError(null); }}
                    className={`focus-ring flex-1 rounded-lg px-3 py-2 text-sm font-medium ${mode === m ? 'bg-accent text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                    {m === 'single' ? 'One door' : 'Import list'}
                  </button>
                ))}
              </div>
            )}

            {mode === 'single' ? (
              <div className="space-y-3">
                <Input label="Street address" value={draft.line1} onChange={(e) => setDraft({ ...draft, line1: e.target.value })} error={errors.line1} autoComplete="street-address" maxLength={160} required />
                <div className="grid grid-cols-2 gap-3">
                  <Input label="Unit / apt" value={draft.line2} onChange={(e) => setDraft({ ...draft, line2: e.target.value })} error={errors.line2} maxLength={80} />
                  <Input label="ZIP / postal code" value={draft.zip} onChange={(e) => setDraft({ ...draft, zip: e.target.value })} error={errors.zip} inputMode="text" autoComplete="postal-code" maxLength={10} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Input label="City" value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} error={errors.city} maxLength={80} />
                  <Input label="State" value={draft.state} onChange={(e) => setDraft({ ...draft, state: e.target.value })} error={errors.state} maxLength={40} />
                </div>
                <div className="rounded-xl border border-border bg-bg-primary p-3">
                  <p className="text-sm font-medium text-text-primary">Pin on the map <span className="font-normal text-text-secondary">(optional)</span></p>
                  {point ? (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary">
                      <MapPin size={14} aria-hidden="true" /> {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
                      <button type="button" onClick={() => onPointChange(null)} className="focus-ring ml-2 rounded font-medium text-accent hover:underline">Clear</button>
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-text-secondary">Without a pin the door shows in the list but not on the map.</p>
                  )}
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" size="sm" onClick={locate} disabled={locating}><Crosshair size={15} aria-hidden="true" />{locating ? 'Locating…' : 'Use my location'}</Button>
                    <Button type="button" variant="secondary" size="sm" onClick={onRequestPick}><MapPin size={15} aria-hidden="true" />Pick on map</Button>
                  </div>
                  {locateError && <p role="alert" className="mt-2 text-xs text-danger">{locateError}</p>}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Textarea label="Paste your list" value={csv} onChange={(e) => setCsv(e.target.value)} rows={7} placeholder={'address,city,state,zip,lat,lng\n100 Main St,Austin,TX,78701,30.2672,-97.7431'}
                  helperText="First row = column names. Needs an address column; city, state, zip, lat and lng are optional." />
                <label className="block text-xs font-medium text-text-secondary">
                  …or choose a CSV file
                  <input type="file" accept=".csv,.tsv,text/csv,text/plain" className="focus-ring mt-1 block w-full text-sm text-text-secondary file:mr-3 file:rounded-lg file:border file:border-border file:bg-bg-primary file:px-3 file:py-2 file:text-sm file:text-text-primary"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(setCsv).catch(() => setFormError('Could not read that file.')); }} />
                </label>
                {parsed && (
                  <p role="status" className={`text-sm ${parsed.error ? 'text-danger' : 'text-text-secondary'}`}>
                    {parsed.error ?? `${parsed.doors.length.toLocaleString()} valid ${parsed.doors.length === 1 ? 'row' : 'rows'}${parsed.skipped ? ` · ${parsed.skipped} will be skipped` : ''}`}
                  </p>
                )}
              </div>
            )}

            {territorySelect}
            {formError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-2.5 text-sm text-danger">{formError}</p>}
          </>
        )}
      </div>
    </Sheet>
  );
}

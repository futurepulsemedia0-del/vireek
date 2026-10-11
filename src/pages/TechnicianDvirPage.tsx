import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertOctagon, AlertTriangle, ArrowLeft, Camera, CheckCircle2, ClipboardCheck, RefreshCw, Truck, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { SignaturePad, TYPED_SIGNATURE_FONTS, type SignaturePadValue } from '@/components/signatures/SignaturePad';
import {
  INSPECTION_TYPE_LABELS,
  MAX_PHOTOS_PER_ITEM,
  SEVERITY_LABELS,
  STATUS_LABELS,
  emptyAnswers,
  errorMessage,
  evaluateInspection,
  faultTitle,
  fetchChecklist,
  fetchDvirVehicles,
  fetchOpenDvirFaults,
  groupByCategory,
  isOdometerAnomaly,
  parseOdometer,
  photoRequired,
  submitInspection,
  validateInspection,
  vehicleBlocked,
  type AnswerMap,
  type AnswerResult,
  type ChecklistItem,
  type DvirFault,
  type DvirVehicle,
  type InspectionType,
  type SubmitOutcome,
} from '@/lib/dvir';

const RESULT_BUTTONS: Array<{ id: AnswerResult; label: string; active: string }> = [
  { id: 'pass', label: 'Pass', active: 'border-success-500 bg-success-500/10 text-success-500' },
  { id: 'defect', label: 'Defect', active: 'border-danger bg-danger/10 text-danger' },
  { id: 'na', label: 'N/A', active: 'border-accent bg-accent/10 text-accent' },
];

function Thumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <div className="relative h-16 w-16 overflow-hidden rounded-lg border border-border bg-bg-tertiary">
      {url && <img src={url} alt="Defect photo" className="h-full w-full object-cover" />}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove photo"
        className="focus-ring absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white"
      >
        <X size={12} />
      </button>
    </div>
  );
}

interface ItemRowProps {
  item: ChecklistItem;
  value: AnswerMap[string];
  onChange: (next: AnswerMap[string]) => void;
  disabled: boolean;
}

function ItemRow({ item, value, onChange, disabled }: ItemRowProps) {
  const defect = value.result === 'defect';
  const needsPhoto = photoRequired(item);
  const missingPhoto = defect && needsPhoto && value.photos.length === 0;
  return (
    <li className="rounded-xl border border-border bg-bg-secondary p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-text-primary">{item.label}</p>
        {item.severity_if_defect === 'out_of_service' && (
          <span className="shrink-0 rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-danger">
            {SEVERITY_LABELS.out_of_service}
          </span>
        )}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-2" role="group" aria-label={item.label}>
        {RESULT_BUTTONS.map((b) => (
          <button
            key={b.id}
            type="button"
            disabled={disabled}
            aria-pressed={value.result === b.id}
            onClick={() => onChange({ ...value, result: b.id })}
            className={`focus-ring min-h-[44px] rounded-lg border text-sm font-semibold transition-colors disabled:opacity-50 ${
              value.result === b.id ? b.active : 'border-border bg-bg-primary text-text-secondary'
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      {defect && (
        <div className="mt-3 space-y-3">
          <Textarea
            aria-label={`Describe the defect: ${item.label}`}
            placeholder="Describe the defect"
            rows={2}
            maxLength={500}
            value={value.note}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, note: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-2">
            {value.photos.map((f, i) => (
              <Thumb key={`${f.name}-${f.lastModified}-${i}`} file={f} onRemove={() => onChange({ ...value, photos: value.photos.filter((_, j) => j !== i) })} />
            ))}
            {value.photos.length < MAX_PHOTOS_PER_ITEM && (
              <label
                className={`focus-within:ring-2 focus-within:ring-accent flex h-16 w-16 cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed text-[10px] font-medium ${
                  missingPhoto ? 'border-danger text-danger' : 'border-border text-text-secondary'
                }`}
              >
                <Camera size={18} aria-hidden="true" />
                {needsPhoto ? 'Photo*' : 'Photo'}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  multiple
                  className="sr-only"
                  disabled={disabled}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []).slice(0, MAX_PHOTOS_PER_ITEM - value.photos.length);
                    if (files.length) onChange({ ...value, photos: [...value.photos, ...files] });
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function TechnicianDvirPage() {
  const { teamMember, user } = useAuth();
  const { toast } = useToast();

  const [vehicles, setVehicles] = useState<DvirVehicle[]>([]);
  const [faults, setFaults] = useState<DvirFault[]>([]);
  const [loadingBase, setLoadingBase] = useState(true);
  const [baseError, setBaseError] = useState<string | null>(null);

  const [vehicleId, setVehicleId] = useState('');
  const [type, setType] = useState<InspectionType>('pre_trip');
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<AnswerMap>({});

  const [odometerText, setOdometerText] = useState('');
  const [notes, setNotes] = useState('');
  const [declaredUnsafe, setDeclaredUnsafe] = useState(false);
  const [signedName, setSignedName] = useState(teamMember?.member_name ?? '');
  const [signature, setSignature] = useState<SignaturePadValue | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome | null>(null);
  const submissionId = useRef(crypto.randomUUID());

  const loadBase = useCallback(async () => {
    setLoadingBase(true);
    setBaseError(null);
    try {
      const [v, f] = await Promise.all([fetchDvirVehicles(), fetchOpenDvirFaults()]);
      setVehicles(v);
      setFaults(f);
      setVehicleId((prev) => {
        if (prev && v.some((x) => x.id === prev)) return prev;
        const mine = teamMember ? v.find((x) => x.assigned_technician_id === teamMember.id) : undefined;
        return mine?.id ?? (v.length === 1 ? v[0].id : '');
      });
    } catch (e) {
      setBaseError(errorMessage(e, 'Could not load vehicles'));
    } finally {
      setLoadingBase(false);
    }
  }, [teamMember]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  const loadItems = useCallback(async (t: InspectionType) => {
    setLoadingItems(true);
    setItemsError(null);
    try {
      const list = await fetchChecklist(t);
      setItems(list);
      setAnswers((prev) => ({ ...emptyAnswers(list), ...Object.fromEntries(Object.entries(prev).filter(([k]) => list.some((i) => i.item_key === k))) }));
    } catch (e) {
      setItemsError(errorMessage(e, 'Could not load the checklist'));
    } finally {
      setLoadingItems(false);
    }
  }, []);

  useEffect(() => {
    void loadItems(type);
  }, [type, loadItems]);

  const vehicle = vehicles.find((v) => v.id === vehicleId) ?? null;
  const vehicleFaults = useMemo(() => faults.filter((f) => f.vehicle_id === vehicleId), [faults, vehicleId]);
  const blocked = vehicleBlocked(vehicleFaults, vehicleId);
  const evaluation = useMemo(() => evaluateInspection(items, answers, declaredUnsafe), [items, answers, declaredUnsafe]);
  const errors = useMemo(
    () => validateInspection({ items, answers, odometerText, declaredUnsafe, notes, signedName, hasSignature: Boolean(signature) }),
    [items, answers, odometerText, declaredUnsafe, notes, signedName, signature],
  );
  const odo = parseOdometer(odometerText);
  const anomaly = vehicle && odo !== null ? isOdometerAnomaly(odo, vehicle.odometer_miles) : false;
  const groups = useMemo(() => groupByCategory(items), [items]);

  const handleSubmit = async () => {
    setShowErrors(true);
    if (!vehicle || odo === null || !signature || errors.length > 0) {
      toast(errors[0] ?? 'Choose a vehicle first', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const font = TYPED_SIGNATURE_FONTS.find((f) => f.id === signature.typedFont)?.family;
      const result = await submitInspection({
        submissionId: submissionId.current,
        vehicleId: vehicle.id,
        type,
        odometerMiles: odo,
        items,
        answers,
        notes,
        declaredUnsafe,
        signedName,
        signature: { type: signature.type, data: signature.data, typedFont: signature.typedFont },
        signatureFontFamily: font,
      });
      setOutcome(result);
      void fetchOpenDvirFaults().then(setFaults).catch(() => undefined);
    } catch (e) {
      toast(errorMessage(e, 'Could not submit the inspection. Your answers are kept — try again.'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const startNew = () => {
    submissionId.current = crypto.randomUUID();
    setOutcome(null);
    setAnswers(emptyAnswers(items));
    setNotes('');
    setDeclaredUnsafe(false);
    setOdometerText('');
    setSignature(null);
    setShowErrors(false);
    void loadBase();
  };

  const header = (
    <header className="sticky top-0 z-10 border-b border-border bg-bg-primary/95 px-4 py-4 backdrop-blur">
      <div className="mx-auto flex max-w-lg items-center gap-3">
        <Link to="/tech/today" aria-label="Back to today" className="focus-ring -ml-1 rounded-lg p-1 text-text-secondary">
          <ArrowLeft size={20} />
        </Link>
        <div>
          <h1 className="text-lg font-semibold text-text-primary">Vehicle inspection</h1>
          <p className="text-xs text-text-secondary">Daily DVIR · pre-trip &amp; post-trip</p>
        </div>
      </div>
    </header>
  );

  if (outcome) {
    const unsafe = outcome.result_status === 'unsafe';
    const Icon = unsafe ? AlertOctagon : outcome.result_status === 'defects_noted' ? AlertTriangle : CheckCircle2;
    const tone = unsafe ? 'text-danger' : outcome.result_status === 'defects_noted' ? 'text-warning-500' : 'text-success-500';
    return (
      <div className="min-h-screen bg-bg-primary pb-10">
        {header}
        <main className="mx-auto max-w-lg space-y-4 px-4 py-8 text-center" role="status">
          <Icon size={56} className={`mx-auto ${tone}`} aria-hidden="true" />
          <h2 className={`text-xl font-bold ${tone}`}>{STATUS_LABELS[outcome.result_status]}</h2>
          {unsafe ? (
            <p className="text-sm text-text-secondary">
              Do not drive this vehicle. Your manager has been notified and dispatch is blocked until the defect is resolved.
            </p>
          ) : outcome.result_status === 'defects_noted' ? (
            <p className="text-sm text-text-secondary">{outcome.defect_count} defect(s) recorded. The vehicle is safe to operate.</p>
          ) : (
            <p className="text-sm text-text-secondary">Inspection saved. Drive safe.</p>
          )}
          {outcome.odometer_anomaly && (
            <p className="rounded-xl bg-warning-500/10 p-3 text-xs text-warning-500">
              The odometer is lower than the last recorded reading. This was flagged for review.
            </p>
          )}
          <div className="flex flex-col gap-2 pt-2">
            <Link to="/tech/today">
              <Button className="w-full">Back to today</Button>
            </Link>
            <Button variant="secondary" onClick={startNew}>
              Inspect another vehicle
            </Button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-primary pb-28">
      {header}
      <main className="mx-auto max-w-lg space-y-5 px-4 py-4">
        {loadingBase && (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {!loadingBase && baseError && (
          <div role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
            {baseError}
            <Button variant="secondary" size="sm" className="mt-3" onClick={() => void loadBase()}>
              <RefreshCw size={14} /> Retry
            </Button>
          </div>
        )}

        {!loadingBase && !baseError && vehicles.length === 0 && (
          <EmptyState icon={Truck} title="No vehicles yet" description="Ask your manager to add a vehicle in Fleet Economics, then come back to inspect it." />
        )}

        {!loadingBase && !baseError && vehicles.length > 0 && (
          <>
            <section className="space-y-3">
              <div>
                <label htmlFor="dvir-vehicle" className="mb-1.5 block text-sm font-medium text-text-primary">
                  Vehicle
                </label>
                <select
                  id="dvir-vehicle"
                  value={vehicleId}
                  onChange={(e) => setVehicleId(e.target.value)}
                  className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-4 py-3 text-base text-text-primary"
                >
                  <option value="">Select a vehicle…</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                      {v.license_plate ? ` · ${v.license_plate}` : ''}
                      {teamMember && v.assigned_technician_id === teamMember.id ? ' (yours)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Inspection type">
                {(Object.keys(INSPECTION_TYPE_LABELS) as InspectionType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={type === t}
                    onClick={() => setType(t)}
                    className={`focus-ring min-h-[44px] rounded-xl border text-sm font-semibold ${
                      type === t ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg-secondary text-text-secondary'
                    }`}
                  >
                    {INSPECTION_TYPE_LABELS[t]}
                  </button>
                ))}
              </div>

              <Input
                label="Odometer (miles)"
                inputMode="decimal"
                placeholder={vehicle ? `Last recorded: ${Math.round(vehicle.odometer_miles).toLocaleString()}` : 'e.g. 48,210'}
                value={odometerText}
                onChange={(e) => setOdometerText(e.target.value)}
                error={showErrors && odo === null ? 'Enter the odometer reading' : undefined}
                helperText={anomaly ? 'Lower than the last recorded reading — it will be flagged for review.' : undefined}
              />
            </section>

            {blocked && (
              <div role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-danger">
                  <AlertOctagon size={16} aria-hidden="true" /> This vehicle is out of service
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-text-secondary">
                  {vehicleFaults.map((f) => (
                    <li key={f.id}>{faultTitle(f)}</li>
                  ))}
                </ul>
              </div>
            )}

            {loadingItems && (
              <div className="space-y-3" aria-busy="true">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            )}

            {!loadingItems && itemsError && (
              <div role="alert" className="rounded-xl border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
                {itemsError}
                <Button variant="secondary" size="sm" className="mt-3" onClick={() => void loadItems(type)}>
                  <RefreshCw size={14} /> Retry
                </Button>
              </div>
            )}

            {!loadingItems && !itemsError && items.length === 0 && (
              <EmptyState icon={ClipboardCheck} title="No checklist items yet" description="Your manager can configure the checklist in Fleet DVIR." />
            )}

            {!loadingItems &&
              groups.map((g) => (
                <section key={g.category} aria-labelledby={`cat-${g.category}`}>
                  <h2 id={`cat-${g.category}`} className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                    {g.category}
                  </h2>
                  <ul className="space-y-2">
                    {g.items.map((item) => (
                      <ItemRow
                        key={item.item_key}
                        item={item}
                        value={answers[item.item_key] ?? { result: null, note: '', photos: [] }}
                        disabled={submitting}
                        onChange={(next) => setAnswers((prev) => ({ ...prev, [item.item_key]: next }))}
                      />
                    ))}
                  </ul>
                </section>
              ))}

            {!loadingItems && items.length > 0 && (
              <section className="space-y-4">
                <label className="flex items-start gap-3 rounded-xl border border-border bg-bg-secondary p-3">
                  <input
                    type="checkbox"
                    checked={declaredUnsafe}
                    disabled={submitting}
                    onChange={(e) => setDeclaredUnsafe(e.target.checked)}
                    className="focus-ring mt-0.5 h-5 w-5 accent-[rgb(var(--danger))]"
                  />
                  <span className="text-sm text-text-primary">
                    I consider this vehicle unsafe to drive
                    <span className="block text-xs text-text-secondary">Blocks dispatch for this vehicle and alerts your manager.</span>
                  </span>
                </label>

                <Textarea
                  label="Notes"
                  rows={3}
                  maxLength={2000}
                  placeholder={declaredUnsafe ? 'Explain why the vehicle is unsafe (required)' : 'Anything else to report (optional)'}
                  value={notes}
                  disabled={submitting}
                  onChange={(e) => setNotes(e.target.value)}
                  error={showErrors && declaredUnsafe && notes.trim().length < 3 ? 'Explain why the vehicle is unsafe' : undefined}
                />

                <Input
                  label="Full name"
                  autoComplete="name"
                  value={signedName}
                  disabled={submitting}
                  onChange={(e) => setSignedName(e.target.value)}
                  helperText={`I certify this inspection is accurate. ${user?.email ?? ''}`.trim()}
                />
                <SignaturePad defaultName={signedName} onChange={setSignature} />
              </section>
            )}
          </>
        )}
      </main>

      {!loadingBase && vehicles.length > 0 && items.length > 0 && !loadingItems && (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-bg-primary/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto max-w-lg">
            {showErrors && errors.length > 0 && (
              <p role="alert" className="mb-2 text-xs text-danger">
                {errors[0]}
                {errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}
              </p>
            )}
            <Button
              className="w-full"
              disabled={submitting || !vehicle}
              onClick={() => void handleSubmit()}
              variant={evaluation.status === 'unsafe' ? 'secondary' : 'primary'}
            >
              {submitting
                ? 'Submitting…'
                : evaluation.status === 'unsafe'
                  ? 'Submit — mark vehicle unsafe'
                  : evaluation.status === 'defects_noted'
                    ? `Submit with ${evaluation.defects} defect${evaluation.defects === 1 ? '' : 's'}`
                    : 'Submit inspection'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

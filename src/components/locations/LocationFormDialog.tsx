import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { HoursEditor } from '@/components/locations/HoursEditor';
import { useToast } from '@/contexts/ToastContext';
import { useFocusTrap, useEscapeToClose } from '@/lib/a11y/focusTrap';
import { createLocation, fetchLocationMembers, saveLocationMembers, updateLocation } from '@/lib/locationsApi';
import {
  AFTER_HOURS_LABELS,
  CURRENCIES,
  draftFromLocation,
  draftToPayload,
  emptyDraft,
  timezoneOptions,
  validateDraft,
  type AfterHoursMode,
  type Brand,
  type BusinessLocation,
  type LocationDraft,
  type LocationErrors,
  type TeamMemberLite,
} from '@/lib/locations';

const SELECT =
  'focus-ring min-h-[48px] w-full rounded-xl border border-border bg-bg-primary px-3.5 py-3 text-base text-text-primary';

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-text-secondary">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function SelectField({
  label,
  value,
  onChange,
  error,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-primary">
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} className={`${SELECT} ${error ? 'border-danger' : ''}`}>
        {children}
      </select>
      {error && (
        <p role="alert" className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export interface LocationFormDialogProps {
  /** null = create a new location. */
  location: BusinessLocation | null;
  brands: Brand[];
  /** null = the team list could not be loaded (assignment section degrades gracefully). */
  team: TeamMemberLite[] | null;
  allLocations: BusinessLocation[];
  onClose: () => void;
  onSaved: (location: BusinessLocation) => void;
}

export function LocationFormDialog({ location, brands, team, allLocations, onClose, onSaved }: LocationFormDialogProps) {
  const { toast } = useToast();
  const isEdit = location !== null;
  const initialDraft = useMemo(() => (location ? draftFromLocation(location) : emptyDraft()), [location]);
  const [draft, setDraft] = useState<LocationDraft>(initialDraft);
  const [errors, setErrors] = useState<LocationErrors>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [managerIds, setManagerIds] = useState<string[]>([]);
  const [initialMembers, setInitialMembers] = useState<{ m: string[]; g: string[] }>({ m: [], g: [] });
  const [membersLoading, setMembersLoading] = useState(isEdit && team !== null);
  const [membersError, setMembersError] = useState(false);

  const panelRef = useFocusTrap(true);
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const timezones = useMemo(() => {
    const all = timezoneOptions();
    return all.includes(initialDraft.timezone) ? all : [initialDraft.timezone, ...all];
  }, [initialDraft.timezone]);

  const currencyOptions = useMemo<string[]>(
    () => (CURRENCIES.some((c) => c === initialDraft.currency) ? [...CURRENCIES] : [initialDraft.currency, ...CURRENCIES]),
    [initialDraft.currency],
  );

  useEffect(() => {
    if (!location || team === null) return;
    let cancelled = false;
    setMembersLoading(true);
    setMembersError(false);
    fetchLocationMembers(location.id)
      .then((r) => {
        if (cancelled) return;
        setMemberIds(r.memberIds);
        setManagerIds(r.managerIds);
        setInitialMembers({ m: r.memberIds, g: r.managerIds });
      })
      .catch(() => {
        if (!cancelled) setMembersError(true);
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [location, team]);

  const membersDirty =
    JSON.stringify([...memberIds].sort()) !== JSON.stringify([...initialMembers.m].sort()) ||
    JSON.stringify([...managerIds].sort()) !== JSON.stringify([...initialMembers.g].sort());
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft) || membersDirty;

  const requestClose = () => {
    if (saving || confirmDiscard) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  useEscapeToClose(true, requestClose);

  const set = <K extends keyof LocationDraft>(key: K, value: LocationDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const toggleMember = (id: string, on: boolean) => {
    setMemberIds((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));
    if (!on) setManagerIds((prev) => prev.filter((x) => x !== id));
  };
  const toggleManager = (id: string, on: boolean) => setManagerIds((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const found = validateDraft(draft, allLocations, location?.id ?? null);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [role="alert"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      return;
    }
    setSaving(true);
    try {
      const payload = draftToPayload(draft);
      const saved = location ? await updateLocation(location.id, payload) : await createLocation(payload);
      let result = saved;
      if (team !== null && !membersError && membersDirty) {
        try {
          await saveLocationMembers(saved.id, memberIds, managerIds);
          result = { ...saved, member_count: memberIds.length };
        } catch (err) {
          toast(`${err instanceof Error ? err.message : 'Could not save the team.'} The location itself was saved.`, 'error');
        }
      }
      toast(location ? 'Location saved.' : 'Location created.', 'success');
      onSaved(result);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save the location.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-2xl border border-border bg-bg-secondary shadow-card-hover sm:max-w-2xl sm:rounded-2xl dark:shadow-card-hover-dark"
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <h2 id={titleId} className="text-base font-semibold text-text-primary">
              {isEdit ? `Edit ${location.name}` : 'Add location'}
            </h2>
            <button type="button" onClick={requestClose} aria-label="Close" className="focus-ring rounded-lg p-1.5 text-text-secondary hover:text-text-primary">
              <X size={18} />
            </button>
          </div>

          <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
            <div ref={bodyRef} className="min-h-0 flex-1 space-y-7 overflow-y-auto px-5 py-5">
              <Section title="Basics">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label="Location name" required value={draft.name} maxLength={80} onChange={(e) => set('name', e.target.value)} error={errors.name} placeholder="Downtown branch" />
                  <Input label="Code" value={draft.code} maxLength={20} onChange={(e) => set('code', e.target.value)} error={errors.code} helperText="Optional short ID, e.g. DT-01" />
                  <SelectField label="Brand" value={draft.brand_id} onChange={(v) => set('brand_id', v)}>
                    <option value="">No brand</option>
                    {brands.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField label="Status" value={draft.status} onChange={(v) => set('status', v === 'paused' ? 'paused' : 'active')}>
                    <option value="active">Active</option>
                    <option value="paused">Paused (not taking new work)</option>
                  </SelectField>
                </div>
              </Section>

              <Section title="Contact & address">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label="Phone" type="tel" inputMode="tel" value={draft.phone} onChange={(e) => set('phone', e.target.value)} error={errors.phone} placeholder="+1 555 010 2000" />
                  <Input label="Email" type="email" value={draft.email} onChange={(e) => set('email', e.target.value)} error={errors.email} placeholder="downtown@yourbrand.com" />
                  <div className="sm:col-span-2">
                    <Input label="Address" value={draft.address_line1} onChange={(e) => set('address_line1', e.target.value)} placeholder="Street address" />
                  </div>
                  <div className="sm:col-span-2">
                    <Input label="Address line 2" value={draft.address_line2} onChange={(e) => set('address_line2', e.target.value)} placeholder="Suite, unit, building" />
                  </div>
                  <Input label="City" value={draft.city} onChange={(e) => set('city', e.target.value)} />
                  <div className="grid grid-cols-2 gap-4">
                    <Input label="State / region" value={draft.state} onChange={(e) => set('state', e.target.value)} />
                    <Input label="Postal code" value={draft.postal_code} onChange={(e) => set('postal_code', e.target.value)} />
                  </div>
                  <Input label="Country code" value={draft.country} maxLength={2} onChange={(e) => set('country', e.target.value.toUpperCase())} error={errors.country} helperText="2 letters, e.g. US" />
                </div>
              </Section>

              <Section title="Operations" hint="Used for scheduling, quotes and invoices at this location.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField label="Timezone" value={draft.timezone} onChange={(v) => set('timezone', v)} error={errors.timezone}>
                    {timezones.map((tz) => (
                      <option key={tz} value={tz}>
                        {tz.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField label="Currency" value={draft.currency} onChange={(v) => set('currency', v)} error={errors.currency}>
                    {currencyOptions.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </SelectField>
                  <Input label="Sales tax rate (%)" type="number" inputMode="decimal" step="0.001" min={0} max={30} value={draft.tax_rate_percent} onChange={(e) => set('tax_rate_percent', e.target.value)} error={errors.tax_rate_percent} />
                  <Input label="Service radius (miles)" type="number" inputMode="numeric" min={0} max={500} value={draft.service_radius_miles} onChange={(e) => set('service_radius_miles', e.target.value)} error={errors.service_radius_miles} helperText="Leave empty for no limit" />
                </div>
              </Section>

              <Section title="Opening hours" hint="Times are in this location's timezone.">
                <HoursEditor value={draft.business_hours} onChange={(h) => set('business_hours', h)} error={errors.business_hours} />
              </Section>

              <Section title="Bookings & call handling">
                <label className="flex items-start gap-3 rounded-xl border border-border bg-bg-primary px-3.5 py-3">
                  <input type="checkbox" checked={draft.booking_enabled} onChange={(e) => set('booking_enabled', e.target.checked)} className="mt-0.5 h-4 w-4 accent-accent" />
                  <span>
                    <span className="block text-sm font-medium text-text-primary">Accept online bookings</span>
                    <span className="block text-xs text-text-secondary">Customers can request appointments for this location.</span>
                  </span>
                </label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField label="After-hours calls" value={draft.after_hours_mode} onChange={(v) => set('after_hours_mode', v as AfterHoursMode)}>
                    {(Object.keys(AFTER_HOURS_LABELS) as AfterHoursMode[]).map((m) => (
                      <option key={m} value={m}>
                        {AFTER_HOURS_LABELS[m]}
                      </option>
                    ))}
                  </SelectField>
                  <Input
                    label="Forwarding number"
                    type="tel"
                    inputMode="tel"
                    required={draft.after_hours_mode === 'forward'}
                    value={draft.forwarding_number}
                    onChange={(e) => set('forwarding_number', e.target.value)}
                    error={errors.forwarding_number}
                    helperText={draft.after_hours_mode === 'forward' ? undefined : 'Only used when forwarding'}
                  />
                </div>
              </Section>

              <Section title="Team at this location" hint="Who works here, and who manages it.">
                {team === null ? (
                  <p className="rounded-xl border border-border bg-bg-primary px-3.5 py-3 text-sm text-text-secondary">The team list is not available to your account.</p>
                ) : membersLoading ? (
                  <div className="space-y-2" aria-busy="true">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-11 animate-pulse rounded-xl bg-bg-tertiary" />
                    ))}
                  </div>
                ) : membersError ? (
                  <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-sm text-danger">Could not load the team for this location. Close and reopen to retry.</p>
                ) : team.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-3.5 py-3 text-sm text-text-secondary">No team members yet. Invite people from the Team page, then assign them here.</p>
                ) : (
                  <ul className="space-y-2">
                    {team.map((m) => {
                      const on = memberIds.includes(m.id);
                      return (
                        <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-bg-primary px-3.5 py-2.5">
                          <label className="flex min-w-0 flex-1 items-center gap-3">
                            <input type="checkbox" checked={on} onChange={(e) => toggleMember(m.id, e.target.checked)} className="h-4 w-4 accent-accent" />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium text-text-primary">{m.name}</span>
                              <span className="block truncate text-[11px] capitalize text-text-secondary">{m.role}</span>
                            </span>
                          </label>
                          {on && (
                            <label className="flex items-center gap-2 text-xs text-text-secondary">
                              <input type="checkbox" checked={managerIds.includes(m.id)} onChange={(e) => toggleManager(m.id, e.target.checked)} className="h-4 w-4 accent-accent" />
                              Manager
                            </label>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Section>

              <Textarea label="Internal notes" rows={3} value={draft.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Gate codes, parking, anything the team should know" />
            </div>

            <div className="border-t border-border bg-bg-secondary px-5 py-4">
              {formError && (
                <p role="alert" className="mb-3 rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
                  {formError}
                </p>
              )}
              <div className="flex gap-3">
                <Button type="button" variant="secondary" onClick={requestClose} disabled={saving} className="flex-1 sm:flex-none">
                  Cancel
                </Button>
                <Button type="submit" disabled={saving || (isEdit && !dirty)} className="flex-1 sm:flex-none">
                  {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create location'}
                </Button>
              </div>
            </div>
          </form>
        </motion.div>
      </div>

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard your changes?"
        description="You have unsaved changes to this location. If you close now they will be lost."
        confirmLabel="Discard changes"
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </>
  );
}

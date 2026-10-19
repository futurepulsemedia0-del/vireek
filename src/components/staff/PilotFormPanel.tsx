import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { Section, SelectField } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { searchTenants } from '@/lib/featureFlagsApi';
import { tenantLabel, type TenantHit } from '@/lib/featureFlags';
import { createPilot, updatePilot } from '@/lib/pilotManagementApi';
import {
  BASELINE_SOURCES, BASELINE_SOURCE_LABEL, EMPTY_PILOT_FORM, PILOT_STATUSES, PILOT_STATUS_LABEL, parsePilotForm, pilotLabel, pilotToForm,
  type FieldErrors, type Pilot, type PilotFormValues,
} from '@/lib/pilotManagement';

interface Props {
  /** null = create a new pilot. */
  pilot: Pilot | null;
  onSaved: () => void;
  onCancel: () => void;
}

export function PilotFormPanel({ pilot, onSaved, onCancel }: Props) {
  const { toast } = useToast();
  const mode = pilot ? 'edit' : 'create';
  const [form, setForm] = useState<PilotFormValues>(() => (pilot ? pilotToForm(pilot) : EMPTY_PILOT_FORM));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TenantHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [picked, setPicked] = useState<TenantHit | null>(null);

  // Debounced tenant search (create mode). A newer keystroke cancels the older result.
  useEffect(() => {
    const q = query.trim();
    if (mode === 'edit' || picked || q.length < 2) { setHits([]); setSearching(false); setSearchError(''); return; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await searchTenants(q);
        if (!cancelled) { setHits(result); setSearchError(''); }
      } catch (e) {
        if (!cancelled) setSearchError(e instanceof Error ? e.message : 'Search failed.');
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, picked, mode]);

  const set = <K extends keyof PilotFormValues>(k: K, v: PilotFormValues[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((prev) => ({ ...prev, [k]: '' }));
  };

  const pick = (t: TenantHit) => { setPicked(t); setHits([]); set('tenant_id', t.id); };
  const unpick = () => { setPicked(null); set('tenant_id', ''); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const parsed = parsePilotForm(form, mode);
    if (!parsed.ok) { setErrors(parsed.errors); return; }
    setSaving(true);
    try {
      if (pilot) {
        const { tenant_id: _t, ...patch } = parsed.value;
        void _t;
        await updatePilot(pilot.id, patch);
        toast('Pilot updated.', 'success');
      } else {
        await createPilot(parsed.value);
        toast('Pilot created.', 'success');
      }
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the pilot.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title={pilot ? `Edit pilot: ${pilotLabel(pilot)}` : 'New pilot'}>
      <form onSubmit={submit} noValidate className="space-y-5">
        {/* Customer */}
        {pilot ? (
          <p className="text-sm text-text-secondary">Customer: <span className="font-medium text-text-primary">{pilotLabel(pilot)}</span> (cannot be changed)</p>
        ) : picked ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary px-4 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text-primary">{tenantLabel(picked)}</p>
              <p className="truncate text-xs text-text-secondary">{picked.email}{picked.plan ? ` · ${picked.plan}` : ''}</p>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={unpick} aria-label="Choose a different customer"><X size={16} /></Button>
          </div>
        ) : (
          <div>
            <Input label="Customer account" required placeholder="Company, name or email (2+ characters)" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" error={errors.tenant_id || searchError || undefined} />
            <div aria-live="polite" className="mt-2">
              {searching && <p className="text-xs text-text-secondary">Searching…</p>}
              {!searching && query.trim().length >= 2 && !searchError && hits.length === 0 && <p className="text-xs text-text-secondary">No accounts match “{query.trim()}”.</p>}
              {hits.length > 0 && (
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                  {hits.map((h) => (
                    <li key={h.id}>
                      <button type="button" onClick={() => pick(h)} className="focus-ring w-full px-4 py-2.5 text-start hover:bg-bg-tertiary">
                        <span className="block truncate text-sm font-medium text-text-primary">{tenantLabel(h)}</span>
                        <span className="block truncate text-xs text-text-secondary">{h.email}{h.plan ? ` · ${h.plan}` : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label="Pilot start date" required type="date" value={form.started_on} onChange={(e) => set('started_on', e.target.value)} error={errors.started_on || undefined} helperText="Week 1 starts on this day." />
          <SelectField label="Status" value={form.status} onChange={(e) => set('status', e.target.value as PilotFormValues['status'])} error={errors.status || undefined}>
            {PILOT_STATUSES.map((s) => <option key={s} value={s}>{PILOT_STATUS_LABEL[s]}</option>)}
          </SelectField>
        </div>

        {/* Baseline */}
        <fieldset className="space-y-4 rounded-xl border border-border p-4">
          <legend className="px-1 text-sm font-semibold text-text-primary">Baseline: how the business ran before Vireek</legend>
          <p className="text-xs text-text-secondary">Leave a field empty if you do not know it. Empty is shown as “no data”, never as zero.</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input label="Calls per week" inputMode="numeric" value={form.baseline_weekly_calls} onChange={(e) => set('baseline_weekly_calls', e.target.value)} error={errors.baseline_weekly_calls || undefined} />
            <Input label="Missed calls (%)" inputMode="decimal" value={form.baseline_missed_call_pct} onChange={(e) => set('baseline_missed_call_pct', e.target.value)} error={errors.baseline_missed_call_pct || undefined} />
            <Input label="Booking rate (%)" inputMode="decimal" value={form.baseline_booking_rate_pct} onChange={(e) => set('baseline_booking_rate_pct', e.target.value)} error={errors.baseline_booking_rate_pct || undefined} />
            <Input label="Average job value (USD)" inputMode="decimal" value={form.baseline_avg_job_value} onChange={(e) => set('baseline_avg_job_value', e.target.value)} error={errors.baseline_avg_job_value || undefined} />
            <Input label="Revenue per week (USD)" inputMode="decimal" value={form.baseline_weekly_revenue} onChange={(e) => set('baseline_weekly_revenue', e.target.value)} error={errors.baseline_weekly_revenue || undefined} />
            <SelectField label="Where did these numbers come from?" value={form.baseline_source} onChange={(e) => set('baseline_source', e.target.value as PilotFormValues['baseline_source'])} error={errors.baseline_source || undefined}>
              {BASELINE_SOURCES.map((s) => <option key={s} value={s}>{BASELINE_SOURCE_LABEL[s]}</option>)}
            </SelectField>
          </div>
          <Textarea label="Baseline notes" rows={2} maxLength={1000} value={form.baseline_notes} onChange={(e) => set('baseline_notes', e.target.value)} error={errors.baseline_notes || undefined} helperText="How you got these numbers. A case study is only as credible as its baseline." />
        </fieldset>

        <Textarea label="Internal notes" rows={2} maxLength={2000} value={form.notes} onChange={(e) => set('notes', e.target.value)} error={errors.notes || undefined} />

        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : pilot ? 'Save changes' : 'Create pilot'}</Button>
        </div>
      </form>
    </Section>
  );
}

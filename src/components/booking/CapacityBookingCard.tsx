import { useCallback, useEffect, useMemo, useState } from 'react';
import { Gauge, Eye, EyeOff, TriangleAlert as AlertTriangle } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import {
  DEFAULT_POLICY,
  loadCapacityPolicy,
  previewCapacity,
  saveCapacityPolicy,
  validatePolicy,
  type CapacityPolicy,
  type CapacityPreview,
} from '@/lib/capacityBookingApi';

/**
 * Settings + live "why was this slot offered or hidden?" preview for capacity-based smart booking.
 * Drop-in card for /dashboard/booking-settings. Self-contained: it loads and saves its own policy.
 */

const numValue = (n: number) => (Number.isNaN(n) ? '' : String(n));
const parseNum = (v: string) => (v.trim() === '' ? NaN : Number(v));

const STATUS_STYLE: Record<string, string> = {
  low: 'bg-success-500/10 text-success-500',
  optimal: 'bg-accent/10 text-accent',
  full: 'bg-danger/10 text-danger',
  no_capacity: 'bg-bg-tertiary text-text-secondary',
};

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-bg-tertiary'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

export function CapacityBookingCard({ services = [] }: { services?: string[] }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saved, setSaved] = useState<CapacityPolicy>(DEFAULT_POLICY);
  const [draft, setDraft] = useState<CapacityPolicy>(DEFAULT_POLICY);
  const [saving, setSaving] = useState(false);
  const [service, setService] = useState('');
  const [emergency, setEmergency] = useState(false);
  const [preview, setPreview] = useState<CapacityPreview | null>(null);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const p = await loadCapacityPolicy();
      setSaved(p); setDraft(p); setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const errors = useMemo(() => validatePolicy(draft), [draft]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<CapacityPolicy>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    if (Object.keys(errors).length > 0) { toast('Fix the highlighted fields to save.', 'error'); return; }
    setSaving(true);
    const r = await saveCapacityPolicy(draft);
    setSaving(false);
    if (r.ok) { setSaved(draft); toast('Smart booking settings saved.', 'success'); }
    else toast(r.reason === 'owner_only' ? 'Only the account owner can change smart booking.' : 'Could not save. Please try again.', 'error');
  };

  const runPreview = async () => {
    setPreviewState('loading');
    try {
      setPreview(await previewCapacity({ serviceType: service || undefined, emergency, days: 3 }));
      setPreviewState('idle');
    } catch {
      setPreviewState('error');
    }
  };

  const fmt = (iso: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const fmtDay = (key: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${key}T12:00:00Z`));

  const slotsByDay = useMemo(() => {
    const out = new Map<string, CapacityPreview['slots']>();
    if (!preview) return out;
    for (const s of preview.slots) {
      const k = new Intl.DateTimeFormat('en-CA', { timeZone: preview.timezone }).format(new Date(s.start));
      (out.get(k) ?? out.set(k, []).get(k)!).push(s);
    }
    return out;
  }, [preview]);

  return (
    <section className="rounded-2xl border border-border bg-bg-secondary p-5 sm:p-6" aria-labelledby="capacity-booking-title">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent"><Gauge size={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 id="capacity-booking-title" className="text-sm font-semibold text-text-primary">Smart capacity booking</h2>
          <p className="text-xs text-text-secondary">Only offer times a qualified technician can really take — skills, zones, time off, drive time, predicted duration and buffers. One engine for your booking page, AI phone agent, SMS and connected agents.</p>
        </div>
        {status === 'ready' && <Switch checked={draft.enabled} onChange={(enabled) => set({ enabled })} label="Enable smart capacity booking" />}
      </div>

      {status === 'loading' && <div className="h-24 animate-pulse rounded-xl bg-bg-tertiary" aria-busy="true" aria-label="Loading smart booking settings" />}
      {status === 'error' && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-border p-4 text-sm text-text-secondary">
          <span className="flex items-center gap-2"><AlertTriangle size={16} /> Couldn't load smart booking settings.</span>
          <Button size="sm" variant="secondary" onClick={() => void load()}>Retry</Button>
        </div>
      )}

      {status === 'ready' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input label="Time between start times (min)" type="number" inputMode="numeric" value={numValue(draft.slot_step_minutes)} error={errors.slot_step_minutes}
              onChange={(e) => set({ slot_step_minutes: parseNum(e.target.value) })} />
            <Input label="Assumed travel between jobs (min)" type="number" inputMode="numeric" value={numValue(draft.default_travel_minutes)} error={errors.default_travel_minutes}
              helperText="Used when a job has no coordinates." onChange={(e) => set({ default_travel_minutes: parseNum(e.target.value) })} />
            <Input label="Max start times shown per day" type="number" inputMode="numeric" value={numValue(draft.max_slots_per_day)} error={errors.max_slots_per_day}
              onChange={(e) => set({ max_slots_per_day: parseNum(e.target.value) })} />
          </div>

          <fieldset className="rounded-xl border border-border p-4">
            <legend className="px-1 text-xs font-medium text-text-secondary">Controlled overbooking</legend>
            <p className="mb-3 text-xs text-text-secondary">Sell a few extra jobs per technician only when your own history shows enough cancellations and no-shows (needs 30+ recent jobs). Technicians never overlap in time. Emergency reserve is taken from your Capacity & Demand settings.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input label="Extra jobs per technician per day" type="number" inputMode="numeric" value={numValue(draft.overbook_jobs_per_tech)} error={errors.overbook_jobs_per_tech}
                helperText="0 = off" onChange={(e) => set({ overbook_jobs_per_tech: parseNum(e.target.value) })} />
              <Input label="Only when cancel/no-show rate ≥ (%)" type="number" inputMode="numeric" value={numValue(draft.overbook_min_cancel_rate_pct)} error={errors.overbook_min_cancel_rate_pct}
                onChange={(e) => set({ overbook_min_cancel_rate_pct: parseNum(e.target.value) })} />
            </div>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void save()} disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save smart booking'}</Button>
            {!draft.enabled && <span className="text-xs text-text-secondary">Off: every channel keeps the standard booking behaviour.</span>}
          </div>

          <div className="border-t border-border pt-5">
            <h3 className="mb-1 text-sm font-semibold text-text-primary">Why was a time offered or hidden?</h3>
            <p className="mb-3 text-xs text-text-secondary">Preview the next 3 days for a service. Works even while smart booking is off, using your saved settings.</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[200px] flex-1">
                <label htmlFor="cap-preview-service" className="mb-1.5 block text-xs font-medium text-text-secondary">Service</label>
                <select id="cap-preview-service" value={service} onChange={(e) => setService(e.target.value)} className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary">
                  <option value="">Any service</option>
                  {services.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 pb-2.5 text-xs text-text-secondary">
                <input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} className="focus-ring h-4 w-4 rounded border-border" /> Emergency request
              </label>
              <Button variant="secondary" onClick={() => void runPreview()} disabled={previewState === 'loading' || dirty}>{previewState === 'loading' ? 'Checking…' : 'Preview'}</Button>
            </div>
            {dirty && <p className="mt-2 text-xs text-text-secondary">Save your changes first — the preview uses saved settings.</p>}
            {previewState === 'error' && <p role="alert" className="mt-3 text-xs text-danger">Couldn't run the preview. Check your connection and try again.</p>}

            {preview && (
              <div className="mt-4 space-y-4" aria-live="polite">
                <p className="text-xs text-text-secondary">
                  Predicted visit: <strong className="text-text-primary">{preview.duration_minutes} min</strong>
                  {preview.cancel_rate != null ? ` · recent cancel/no-show rate ${Math.round(preview.cancel_rate * 100)}%` : ' · not enough history for overbooking'}
                  {preview.overbooking_allowance_per_tech > 0 ? ` · overbooking allowance +${preview.overbooking_allowance_per_tech}/tech` : ''}
                </p>
                <button type="button" onClick={() => setShowHidden((v) => !v)} className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-1 text-xs font-medium text-accent">
                  {showHidden ? <EyeOff size={14} /> : <Eye size={14} />} {showHidden ? 'Hide' : 'Show'} unavailable times
                </button>
                {preview.days.length === 0 && <p className="text-sm text-text-secondary">No open business days in the preview range. Check your business hours.</p>}
                {preview.days.map((d) => {
                  const list = (slotsByDay.get(d.date) ?? []).filter((s) => showHidden || s.offered);
                  return (
                    <div key={d.date} className="rounded-xl border border-border p-3">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">{fmtDay(d.date)}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[d.demand.status] ?? STATUS_STYLE.no_capacity}`}>{d.demand.status.replace('_', ' ')}</span>
                        <span className="text-xs text-text-secondary">{d.demand.load}/{d.demand.capacity} jobs · {d.offered} offered</span>
                      </div>
                      {list.length === 0 ? (
                        <p className="text-xs text-text-secondary">{d.reason ? 'Hidden all day — turn on “unavailable times” to see why.' : 'No times to show.'}</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {list.map((s) => (
                            <li key={s.start} className="flex gap-2 text-xs">
                              <span className={`w-16 shrink-0 font-medium ${s.offered ? 'text-success-500' : 'text-text-secondary'}`}>{fmt(s.start, preview.timezone)}</span>
                              <span className="text-text-secondary">{s.offered ? <><strong className="text-text-primary">Offered</strong>{s.overbooked ? ' (overbooked)' : ''} — {s.explanation}</> : <><strong className="text-text-primary">Hidden</strong> — {s.explanation}</>}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

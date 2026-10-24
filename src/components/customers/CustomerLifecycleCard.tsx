import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarHeart } from 'lucide-react';
import { useToast } from '@/contexts/ToastContext';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Skeleton } from '@/components/Skeleton';
import { supabase } from '@/lib/supabase';
import {
  CONSENT_SOURCES,
  MONTH_NAMES,
  TOUCH_META,
  TOUCH_TYPES,
  emptyProfileForm,
  maxDayOfMonth,
  missingDataWarnings,
  profileToForm,
  toggleTouch,
  validateProfileForm,
  zonedNow,
  type ConsentSource,
  type ProfileForm,
} from '@/lib/lifecycle';
import { getProfile, saveProfile } from '@/lib/lifecycleApi';

const selectClass =
  'focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-3 text-base text-text-primary focus-visible:border-accent';

/**
 * Customer detail card: birthday, home-purchase date, and the customer's opt-in for lifecycle messages.
 * Nothing is ever sent without a consent recorded here (touch + channel + how it was given).
 */
export function CustomerLifecycleCard({ customerId }: { customerId: string }) {
  const { toast } = useToast();
  const [form, setForm] = useState<ProfileForm>(emptyProfileForm());
  const [saved, setSaved] = useState<ProfileForm>(emptyProfileForm());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hasInstallDates, setHasInstallDates] = useState(false);
  const [touched, setTouched] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [profile, eq] = await Promise.all([
        getProfile(customerId),
        supabase.from('equipment').select('id', { count: 'exact', head: true }).eq('customer_id', customerId).eq('status', 'active').not('install_date', 'is', null),
      ]);
      const f = profileToForm(profile);
      setForm(f);
      setSaved(f);
      setHasInstallDates((eq.count ?? 0) > 0);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const today = useMemo(() => zonedNow(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone).date, []);
  const errors = useMemo(() => validateProfileForm(form, today), [form, today]);
  const warnings = useMemo(() => missingDataWarnings(form, hasInstallDates), [form, hasInstallDates]);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const set = (patch: Partial<ProfileForm>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    try {
      await saveProfile(customerId, form);
      setSaved(form);
      setTouched(false);
      toast('Lifecycle preferences saved.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const day = Number(form.birthDay) || 0;
  const maxDay = form.birthMonth ? maxDayOfMonth(Number(form.birthMonth)) : 31;

  return (
    <section className="rounded-xl border border-border bg-bg-secondary p-5" aria-labelledby="lifecycle-card-title">
      <div className="mb-1 flex items-center gap-2">
        <CalendarHeart className="h-5 w-5 text-accent" aria-hidden="true" />
        <h2 id="lifecycle-card-title" className="font-semibold text-text-primary">
          Lifecycle messages
        </h2>
      </div>
      <p className="mb-4 text-sm text-text-secondary">
        Birthday and anniversary greetings — sent only if the customer agreed. Only the birth month and day are stored, never the year.
      </p>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-2/3" />
        </div>
      ) : loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 text-sm text-text-primary">
          <span>Couldn&apos;t load lifecycle preferences.</span>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <fieldset>
              <legend className="mb-1.5 block text-sm font-medium text-text-primary">Birthday (month &amp; day)</legend>
              <div className="flex gap-2">
                <select aria-label="Birth month" className={selectClass} value={form.birthMonth} onChange={(e) => set({ birthMonth: e.target.value, birthDay: e.target.value ? form.birthDay : '' })}>
                  <option value="">Month</option>
                  {MONTH_NAMES.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </select>
                <select aria-label="Birth day" className={selectClass} value={form.birthDay} onChange={(e) => set({ birthDay: e.target.value })} disabled={!form.birthMonth}>
                  <option value="">Day</option>
                  {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              {touched && errors.birthday && (
                <p role="alert" className="mt-1.5 text-xs text-danger">
                  {errors.birthday}
                </p>
              )}
              {day === 29 && form.birthMonth === '2' && <p className="mt-1.5 text-xs text-text-secondary">Sent on Feb 28 in years without a Feb 29.</p>}
            </fieldset>
            <Input
              label="Home-purchase date"
              type="date"
              max={today}
              value={form.homePurchaseDate}
              onChange={(e) => set({ homePurchaseDate: e.target.value })}
              error={touched ? errors.homePurchaseDate : undefined}
            />
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-text-primary">Customer agreed to receive</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {TOUCH_TYPES.map((t) => (
                <label key={t} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 text-sm hover:border-accent/40">
                  <input type="checkbox" className="mt-0.5" checked={form.touches.includes(t)} onChange={() => set({ touches: toggleTouch(form.touches, t) })} />
                  <span>
                    <span className="font-medium text-text-primary">{TOUCH_META[t].label}</span>
                    <span className="block text-xs text-text-secondary">{TOUCH_META[t].dataSource}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {form.touches.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <fieldset>
                <legend className="mb-2 text-sm font-medium text-text-primary">Channels the customer agreed to</legend>
                <label className="mb-1.5 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.email} onChange={(e) => set({ email: e.target.checked })} /> Email
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.sms} onChange={(e) => set({ sms: e.target.checked })} /> Text message (SMS)
                </label>
                {touched && errors.channels && (
                  <p role="alert" className="mt-1.5 text-xs text-danger">
                    {errors.channels}
                  </p>
                )}
              </fieldset>
              <div>
                <label htmlFor="lifecycle-source" className="mb-1.5 block text-sm font-medium text-text-primary">
                  How was consent given?
                </label>
                <select id="lifecycle-source" className={selectClass} value={form.source} onChange={(e) => set({ source: e.target.value as ConsentSource | '' })}>
                  <option value="">Select…</option>
                  {CONSENT_SOURCES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {touched && errors.source && (
                  <p role="alert" className="mt-1.5 text-xs text-danger">
                    {errors.source}
                  </p>
                )}
              </div>
            </div>
          )}

          {warnings.length > 0 && (
            <ul className="space-y-1 text-xs text-warning-500" aria-label="Missing data">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          <div className="flex justify-end">
            <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

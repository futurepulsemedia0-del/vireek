import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/contexts/ToastContext';
import { rescanTransactions, saveSettings } from '@/lib/fuelCardsApi';
import { DEFAULT_SETTINGS, parseSettingsForm, settingsToForm, type FuelSettings, type SettingsFormValues } from '@/lib/fuelCards';
import type { FieldErrors } from '@/lib/vehicleManagement';
import { Section } from '@/components/vehicles/shared';

interface Props {
  settings: FuelSettings | null;
  onChanged: () => Promise<unknown> | void;
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function FuelSettingsPanel({ settings, onChanged }: Props) {
  const { toast } = useToast();
  const initial = () => settingsToForm(settings ?? { ...DEFAULT_SETTINGS, timezone: browserZone() });
  const [form, setForm] = useState<SettingsFormValues>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => { setForm(initial()); setErrors({}); }, [settings]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof Omit<SettingsFormValues, 'post_to_expenses'>) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    const result = parseSettingsForm(form);
    if (!result.ok) { setErrors(result.errors); return; }
    setSaving(true);
    try {
      await saveSettings(result.value);
      const scan = await rescanTransactions(90);
      toast(`Settings saved. Re-checked ${scan.scanned.toLocaleString()} recent transactions.`, 'success');
      setErrors({});
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const rescan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const scan = await rescanTransactions(90);
      toast(`Re-checked ${scan.scanned.toLocaleString()} transactions.`, 'success');
      await onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not re-scan transactions.', 'error');
    } finally {
      setScanning(false);
    }
  };

  const num = (key: keyof SettingsFormValues, label: string, helper?: string, step = 'any') => (
    <Input
      label={label} type="number" inputMode="decimal" step={step}
      value={String(form[key])} onChange={set(key as keyof Omit<SettingsFormValues, 'post_to_expenses'>)}
      error={errors[key as string]} helperText={helper}
    />
  );

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Section title="Anomaly thresholds">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {num('max_gallons', 'Max gallons per purchase', 'Used when a card has no tank capacity.')}
          {num('max_txns', 'Max purchases per card per day', undefined, '1')}
          {num('swipe_minutes', 'Repeat-purchase window (minutes)', 'Flags a second purchase on the same card within this time.', '1')}
          {num('price_pct', 'Price tolerance (%)', 'Flags prices above your 30-day median by more than this.')}
          {num('hours_start', 'Business hours start (0–23)', undefined, '1')}
          {num('hours_end', 'Business hours end (1–24)', undefined, '1')}
          {num('mpg_min', 'Lowest plausible MPG')}
          {num('mpg_max', 'Highest plausible MPG')}
          <Input label="Time zone" value={form.timezone} onChange={set('timezone')} error={errors.timezone} placeholder="America/Chicago" helperText="Used for business hours and daily limits." />
        </div>
      </Section>

      <Section title="Fleet costs">
        <label className="flex items-start gap-3 text-sm text-text-primary">
          <input
            type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-accent"
            checked={form.post_to_expenses} onChange={(e) => setForm((f) => ({ ...f, post_to_expenses: e.target.checked }))}
          />
          <span>
            Add matched purchases to each vehicle’s Expenses as fuel
            <span className="mt-0.5 block text-xs text-text-secondary">Keeps Fleet Economics up to date. Turn off if you also log fuel by hand, to avoid counting it twice.</span>
          </span>
        </label>
      </Section>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save and re-check'}</Button>
        <Button type="button" variant="secondary" onClick={rescan} disabled={scanning || saving}><RefreshCw size={16} className={scanning ? 'animate-spin' : ''} /> Re-scan last 90 days</Button>
      </div>
    </form>
  );
}

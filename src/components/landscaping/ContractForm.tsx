import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Pill, SelectField } from '@/components/tradePacks/shared';
import {
  DEFAULT_CHECKLIST,
  DEFAULT_WEATHER_POLICY,
  RULE_LABELS,
  previewVisits,
  validateSchedule,
  validateWeatherPolicy,
  type ChecklistTaskTemplate,
  type HolidayPolicy,
  type SeasonRule,
  type WeatherRuleKind,
  type WeatherSkipRule,
} from '@/lib/tradePacks/landscaping/index';
import { contractSchedule, type ContractInput, type Crew, type Property } from '@/lib/landscapingApi';
import { MONTHS, WEEKDAYS, centsToDollars, dayLabel, dollarsToCents, todayISO } from './ui';

const defaultTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago';
  } catch {
    return 'America/Chicago';
  }
};

export const blankContract = (): ContractInput => ({
  customer_id: null,
  property_id: null,
  title: '',
  start_date: todayISO(),
  end_date: null,
  seasons: [{ fromMonth: 4, toMonth: 10, intervalWeeks: 1 }],
  holiday_policy: 'shift_next',
  holiday_set: 'us_core',
  extra_holidays: [],
  workdays: [1, 2, 3, 4, 5],
  preferred_time: '09:00',
  timezone: defaultTz(),
  duration_minutes: 45,
  default_crew_id: null,
  billing_mode: 'per_visit',
  visit_price_cents: 0,
  monthly_fee_cents: 0,
  tax_percent: 0,
  weather_policy: DEFAULT_WEATHER_POLICY,
  checklist: DEFAULT_CHECKLIST,
  require_photos: true,
  notes: null,
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'task';

interface Props {
  value: ContractInput;
  customers: Array<{ id: string; name: string }>;
  properties: Property[];
  crews: Crew[];
  lockedStart?: boolean;
  lockedBilling?: boolean;
  busy: boolean;
  onCancel: () => void;
  onSave: (v: ContractInput) => void;
}

export function ContractForm({ value, customers, properties, crews, lockedStart, lockedBilling, busy, onCancel, onSave }: Props) {
  const [v, setV] = useState<ContractInput>(value);
  const set = <K extends keyof ContractInput>(k: K, x: ContractInput[K]) => setV((p) => ({ ...p, [k]: x }));
  const [newTask, setNewTask] = useState('');
  const [alertWords, setAlertWords] = useState(() => (v.weather_policy.rules.find((r) => r.kind === 'alert_keyword')?.keywords ?? []).join(', '));

  const schedule = useMemo(() => contractSchedule({ ...v, id: 'preview', status: 'draft', pauses: [] }), [v]);
  const problems = useMemo(() => {
    const e = validateSchedule(schedule);
    e.push(...validateWeatherPolicy(v.weather_policy));
    if (!v.customer_id) e.push('Choose a customer');
    if (v.title.trim().length < 1) e.push('Give the contract a title');
    if (v.billing_mode === 'monthly_flat' && v.monthly_fee_cents <= 0) e.push('Enter the monthly fee');
    if (v.billing_mode === 'per_visit' && v.visit_price_cents <= 0) e.push('Enter the price per visit');
    return e;
  }, [schedule, v]);
  const preview = useMemo(() => {
    try {
      return validateSchedule(schedule).length ? [] : previewVisits(schedule, v.start_date > todayISO() ? v.start_date : todayISO(), 6);
    } catch {
      return [];
    }
  }, [schedule, v.start_date]);

  const customerProps = properties.filter((p) => p.customer_id === v.customer_id);
  const rules = v.weather_policy.rules;
  const ruleOf = (k: WeatherRuleKind) => rules.find((r) => r.kind === k);
  const setRule = (k: WeatherRuleKind, on: boolean, threshold?: number) => {
    const rest = rules.filter((r) => r.kind !== k);
    const next: WeatherSkipRule[] = on ? [...rest, k === 'alert_keyword' ? { kind: k, keywords: alertWords.split(',').map((w) => w.trim()).filter((w) => w.length >= 3) } : { kind: k, threshold: threshold ?? 0 }] : rest;
    set('weather_policy', { ...v.weather_policy, rules: next });
  };
  const updateSeason = (i: number, patch: Partial<SeasonRule>) => set('seasons', v.seasons.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  return (
    <div className="space-y-4" role="form" aria-label="Maintenance contract">
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Title" value={v.title} onChange={(e) => set('title', e.target.value)} maxLength={120} required />
        <SelectField label="Customer" value={v.customer_id ?? ''} onChange={(x) => setV((p) => ({ ...p, customer_id: x || null, property_id: null }))} required>
          <option value="">Select…</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <SelectField label="Property" value={v.property_id ?? ''} onChange={(x) => set('property_id', x || null)} helperText="Measurements and map position come from the property.">
          <option value="">None</option>
          {customerProps.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </SelectField>
        <SelectField label="Default crew" value={v.default_crew_id ?? ''} onChange={(x) => set('default_crew_id', x || null)}>
          <option value="">Unassigned</option>
          {crews.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
        <Input label="First visit week starts" type="date" value={v.start_date} disabled={lockedStart} onChange={(e) => set('start_date', e.target.value)} helperText={lockedStart ? 'Locked once visits exist.' : 'Visits repeat on this weekday.'} />
        <Input label="End date (optional)" type="date" value={v.end_date ?? ''} onChange={(e) => set('end_date', e.target.value || null)} />
        <Input label="Start time" type="time" value={v.preferred_time} min="05:00" max="20:59" onChange={(e) => set('preferred_time', e.target.value)} helperText="05:00–20:59, in the contract timezone." />
        <Input label="Timezone" value={v.timezone} onChange={(e) => set('timezone', e.target.value)} helperText="IANA name, e.g. America/Chicago" />
        <Input label="Minutes per visit" type="number" min={10} max={480} value={v.duration_minutes} onChange={(e) => set('duration_minutes', Math.round(Number(e.target.value)) || 0)} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text-primary">Seasons</legend>
        <p className="text-xs text-text-secondary">Visits only happen inside a season. Weekly = every 1 week, biweekly = every 2. A season may wrap the year-end (Nov → Mar).</p>
        {v.seasons.map((s, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <SelectField label="From" value={String(s.fromMonth)} onChange={(x) => updateSeason(i, { fromMonth: Number(x) })}>{MONTHS.map((m, k) => <option key={m} value={k + 1}>{m}</option>)}</SelectField>
            <SelectField label="To" value={String(s.toMonth)} onChange={(x) => updateSeason(i, { toMonth: Number(x) })}>{MONTHS.map((m, k) => <option key={m} value={k + 1}>{m}</option>)}</SelectField>
            <SelectField label="Every" value={String(s.intervalWeeks)} onChange={(x) => updateSeason(i, { intervalWeeks: Number(x) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n === 1 ? 'week' : `${n} weeks`}</option>)}</SelectField>
            <Button size="sm" variant="ghost" aria-label="Remove season" disabled={v.seasons.length <= 1} onClick={() => set('seasons', v.seasons.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        {v.seasons.length < 4 && <Button size="sm" variant="secondary" onClick={() => set('seasons', [...v.seasons, { fromMonth: 11, toMonth: 3, intervalWeeks: 2 }])}><Plus className="mr-1 h-4 w-4" />Add season</Button>}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="When a visit falls on a holiday" value={v.holiday_policy} onChange={(x) => set('holiday_policy', x as HolidayPolicy)}>
          <option value="shift_next">Move to the next working day</option>
          <option value="shift_prev">Move to the previous working day</option>
          <option value="skip">Skip that visit</option>
          <option value="ignore">Work anyway</option>
        </SelectField>
        <SelectField label="Holiday calendar" value={v.holiday_set} onChange={(x) => set('holiday_set', x as 'none' | 'us_core')} helperText="Scheduling convenience only — confirm local rules yourself.">
          <option value="us_core">US core (New Year's, Memorial, July 4, Labor, Thanksgiving, Christmas)</option>
          <option value="none">None</option>
        </SelectField>
      </div>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-text-primary">Working days (used when moving a holiday visit)</legend>
        <div className="flex flex-wrap gap-2">
          {WEEKDAYS.map((d, i) => (
            <label key={d} className="flex min-h-[44px] items-center gap-1 rounded-lg border border-border px-2 text-sm">
              <input type="checkbox" checked={v.workdays.includes(i)} onChange={(e) => set('workdays', e.target.checked ? [...v.workdays, i].sort() : v.workdays.filter((x) => x !== i))} />{d}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text-primary">Skip-weather rules</legend>
        <p className="text-xs text-text-secondary">Only applied when a forecast provider is connected. An unknown forecast never cancels a visit.</p>
        {(['rain_prob_pct', 'wind_kph', 'freeze_c', 'heat_c'] as WeatherRuleKind[]).map((k) => (
          <div key={k} className="flex flex-wrap items-center gap-3">
            <label className="flex min-h-[44px] items-center gap-2 text-sm"><input type="checkbox" checked={!!ruleOf(k)} onChange={(e) => setRule(k, e.target.checked, k === 'rain_prob_pct' ? 70 : k === 'wind_kph' ? 60 : k === 'freeze_c' ? 0 : 38)} />{RULE_LABELS[k]}</label>
            {ruleOf(k) && <input aria-label={RULE_LABELS[k]} type="number" className="focus-ring w-24 rounded-lg border border-border bg-bg-primary px-2 py-1 text-sm" value={ruleOf(k)?.threshold ?? 0} onChange={(e) => setRule(k, true, Number(e.target.value))} />}
          </div>
        ))}
        <label className="flex min-h-[44px] items-center gap-2 text-sm"><input type="checkbox" checked={!!ruleOf('alert_keyword')} onChange={(e) => setRule('alert_keyword', e.target.checked)} />{RULE_LABELS.alert_keyword}</label>
        {ruleOf('alert_keyword') && <Input label="Alert words (comma separated)" value={alertWords} onChange={(e) => setAlertWords(e.target.value)} onBlur={() => setRule('alert_keyword', true)} />}
        <SelectField label="After a weather skip" value={v.weather_policy.makeup} onChange={(x) => set('weather_policy', { ...v.weather_policy, makeup: x as 'next_workday' | 'none' })}>
          <option value="next_workday">Schedule a make-up visit on the next working day</option>
          <option value="none">No make-up visit</option>
        </SelectField>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="Billing" value={v.billing_mode} disabled={lockedBilling} onChange={(x) => set('billing_mode', x as 'per_visit' | 'monthly_flat')} helperText={lockedBilling ? 'Locked once invoices exist.' : undefined}>
          <option value="per_visit">Per completed visit</option>
          <option value="monthly_flat">Flat monthly fee (prorated for pauses)</option>
        </SelectField>
        <Input label="Price per visit ($)" type="number" min={0} step="0.01" value={centsToDollars(v.visit_price_cents)} onChange={(e) => set('visit_price_cents', dollarsToCents(e.target.value))} />
        <Input label="Monthly fee ($)" type="number" min={0} step="0.01" value={centsToDollars(v.monthly_fee_cents)} disabled={v.billing_mode !== 'monthly_flat'} onChange={(e) => set('monthly_fee_cents', dollarsToCents(e.target.value))} />
        <Input label="Tax (%)" type="number" min={0} max={100} step="0.01" value={v.tax_percent} onChange={(e) => set('tax_percent', Math.min(100, Math.max(0, Number(e.target.value) || 0)))} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text-primary">Visit checklist</legend>
        <ul className="space-y-1">
          {v.checklist.map((t, i) => (
            <li key={t.key} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>{t.label}</span>
              <span className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={t.required} onChange={(e) => set('checklist', v.checklist.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />required</label>
                <Button size="xs" variant="ghost" aria-label={`Remove ${t.label}`} onClick={() => set('checklist', v.checklist.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-end gap-2">
          <Input label="Add a task" value={newTask} maxLength={120} onChange={(e) => setNewTask(e.target.value)} />
          <Button size="sm" variant="secondary" disabled={!newTask.trim() || v.checklist.length >= 40} onClick={() => { let key = slug(newTask); while (v.checklist.some((t) => t.key === key)) key = `${key.slice(0, 36)}_${Math.random().toString(36).slice(2, 5)}`; set('checklist', [...v.checklist, { key, label: newTask.trim(), required: false } as ChecklistTaskTemplate]); setNewTask(''); }}>Add</Button>
        </div>
        <label className="flex min-h-[44px] items-center gap-2 text-sm"><input type="checkbox" checked={v.require_photos} onChange={(e) => set('require_photos', e.target.checked)} />Require before AND after photos to complete a visit</label>
      </fieldset>

      <div className="rounded-xl bg-bg-primary p-3">
        <p className="text-sm font-medium text-text-primary">Next visits</p>
        {preview.length === 0 ? <p className="text-xs text-text-secondary">Fix the highlighted problems to see a preview.</p> : (
          <ul className="mt-1 flex flex-wrap gap-2">{preview.map((p) => <li key={p.n}><Pill tone={p.shifted ? 'warning' : 'neutral'}>{dayLabel(p.date)}{p.shifted ? ` (moved from ${dayLabel(p.originalDate)} — ${p.holidayName})` : ''}</Pill></li>)}</ul>
        )}
      </div>

      {problems.length > 0 && <ul role="alert" className="list-disc space-y-0.5 pl-5 text-sm text-danger">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button loading={busy} disabled={problems.length > 0} onClick={() => onSave(v)}>Save contract</Button>
      </div>
    </div>
  );
}

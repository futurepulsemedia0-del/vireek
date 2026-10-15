import { Plus, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import {
  MAX_DEPARTMENTS,
  MAX_GREETING_LENGTH,
  isValidTimezone,
  newId,
  removeDepartment,
  type CallRoutingConfig,
  type RingStrategy,
  type RoutingContext,
  type RoutingDepartment,
} from '@/lib/callRouting';

interface FlowSettingsProps {
  config: CallRoutingConfig;
  ctx: RoutingContext;
  onChange: (config: CallRoutingConfig) => void;
}

function timezoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : [];
  } catch {
    return [];
  }
}

export function FlowSettings({ config, ctx, onChange }: FlowSettingsProps) {
  const updateDepartment = (id: string, patch: Partial<RoutingDepartment>) =>
    onChange({ ...config, departments: config.departments.map((d) => (d.id === id ? { ...d, ...patch } : d)) });
  const toggleMember = (d: RoutingDepartment, memberId: string) =>
    updateDepartment(d.id, { memberIds: d.memberIds.includes(memberId) ? d.memberIds.filter((m) => m !== memberId) : [...d.memberIds, memberId] });
  const zones = timezoneOptions();

  return (
    <Card className="space-y-6 p-5 hover:translate-y-0">
      <div>
        <h2 className="text-sm font-semibold text-text-primary">Flow settings</h2>
        <p className="text-xs text-text-secondary">Time zone, departments and the voicemail greeting.</p>
      </div>

      <div>
        <Input
          label="Business time zone"
          list="call-routing-timezones"
          value={config.timezone}
          onChange={(e) => onChange({ ...config, timezone: e.target.value })}
          error={isValidTimezone(config.timezone) ? undefined : 'Use an IANA time zone, e.g. America/Chicago'}
          helperText="Hours and holidays are evaluated in this zone."
        />
        <datalist id="call-routing-timezones">
          {zones.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Departments</h3>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={config.departments.length >= MAX_DEPARTMENTS}
            onClick={() => onChange({ ...config, departments: [...config.departments, { id: newId('dept'), name: '', memberIds: [], ringStrategy: 'simultaneous' }] })}
          >
            <Plus size={14} /> Add
          </Button>
        </div>
        {config.departments.length === 0 && <p className="text-xs text-text-secondary">Departments group people (Billing, Dispatch, Sales) so a rule can ring them together.</p>}
        {config.departments.map((d, i) => (
          <div key={d.id} className="space-y-3 rounded-xl border border-border p-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Input label={`Department ${i + 1} name`} value={d.name} maxLength={60} onChange={(e) => updateDepartment(d.id, { name: e.target.value })} />
              </div>
              <Button type="button" variant="ghost" size="sm" aria-label={`Delete ${d.name || 'department'}`} onClick={() => onChange(removeDepartment(config, d.id))}>
                <Trash2 size={14} />
              </Button>
            </div>
            <div>
              <label htmlFor={`${d.id}-strategy`} className="mb-1 block text-xs font-medium text-text-secondary">
                How to ring
              </label>
              <select
                id={`${d.id}-strategy`}
                className="focus-ring w-full rounded-xl border border-border bg-bg-primary px-3 py-2.5 text-sm text-text-primary"
                value={d.ringStrategy}
                onChange={(e) => updateDepartment(d.id, { ringStrategy: e.target.value as RingStrategy })}
              >
                <option value="simultaneous">Everyone at once</option>
                <option value="sequential">One after another</option>
              </select>
            </div>
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-text-secondary">Members</legend>
              {ctx.members.length === 0 ? (
                <p className="text-xs text-text-secondary">Add team members first to build a department.</p>
              ) : (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {ctx.members.map((m) => (
                    <label key={m.id} className="flex items-center gap-2 text-sm text-text-primary">
                      <input type="checkbox" className="focus-ring h-4 w-4 rounded border-border" checked={d.memberIds.includes(m.id)} onChange={() => toggleMember(d, m.id)} />
                      <span className="truncate">{m.name}</span>
                      {!m.phone && <span className="text-[11px] text-warning-500">no phone</span>}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Voicemail</h3>
        <Textarea
          label="Greeting"
          rows={3}
          maxLength={MAX_GREETING_LENGTH}
          value={config.voicemail.greeting}
          onChange={(e) => onChange({ ...config, voicemail: { ...config.voicemail, greeting: e.target.value } })}
          helperText={`${config.voicemail.greeting.length}/${MAX_GREETING_LENGTH}`}
        />
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input
            type="checkbox"
            className="focus-ring h-4 w-4 rounded border-border"
            checked={config.voicemail.transcribe}
            onChange={(e) => onChange({ ...config, voicemail: { ...config.voicemail, transcribe: e.target.checked } })}
          />
          Transcribe voicemails
        </label>
      </div>
    </Card>
  );
}

import { useState } from 'react';
import { Loader2, Plus, Send } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import {
  ApiError,
  INTERVAL_OPTIONS,
  MODELS,
  MODEL_KEYS,
  REVERSE_KINDS,
  REVERSE_META,
  saveDestination,
  type Destination,
  type ModelKey,
  type ReverseDestinationKind,
} from '@/lib/dataPlatform';
import { DestinationCard } from './DestinationCard';
import { Field, SELECT, Toggle } from './ui';
import type { DestinationData } from './useDestinationData';

type Form = {
  id?: string;
  kind: ReverseDestinationKind;
  name: string;
  config: Record<string, string>;
  secret: string;
  model: ModelKey;
  param: string;
  interval: number;
  autoSync: boolean;
};

const modelsFor = (kind: ReverseDestinationKind) => MODEL_KEYS.filter((k) => (MODELS[k].destinations as readonly string[]).includes(kind));

const blank = (kind: ReverseDestinationKind = 'sheets'): Form => {
  const model = modelsFor(kind)[0];
  return {
    kind,
    name: '',
    config: kind === 'sheets' ? { spreadsheet_id: '', tab: 'Vireek' } : { list_id: '', tag: 'vireek' },
    secret: '',
    model,
    param: String(MODELS[model].param?.default ?? ''),
    interval: 1440,
    autoSync: true,
  };
};

function fromDestination(d: Destination): Form {
  const kind = d.kind as ReverseDestinationKind;
  const base = blank(kind);
  const model = (typeof d.settings.model === 'string' && d.settings.model in MODELS ? d.settings.model : base.model) as ModelKey;
  const config = { ...base.config };
  for (const [k, v] of Object.entries(d.config)) if (typeof v === 'string') config[k] = v;
  return {
    ...base,
    id: d.id,
    name: d.name,
    config,
    model,
    param: d.settings.param !== undefined ? String(d.settings.param) : String(MODELS[model].param?.default ?? ''),
    interval: d.interval_minutes,
    autoSync: d.auto_sync,
  };
}

function summaryOf(d: Destination): string {
  const model = MODELS[d.settings.model as ModelKey];
  const where = d.kind === 'sheets' ? `tab “${String(d.config.tab ?? '')}”` : d.kind === 'mailchimp' ? `audience ${String(d.config.list_id ?? '')}` : `list ${String(d.config.list_id ?? '')}`;
  return `${model?.label ?? 'Unknown model'} → ${where}`;
}

export function ReverseEtlTab({ data }: { data: DestinationData }) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const list = data.destinations.filter((d) => d.role === 'reverse');
  const editing = !!form?.id;

  const open = (f: Form) => {
    setErrors({});
    setFormError(null);
    setForm(f);
  };
  const setConfig = (k: string, v: string) => setForm((f) => (f ? { ...f, config: { ...f.config, [k]: v } } : f));

  const changeKind = (kind: ReverseDestinationKind) => setForm((f) => (f ? { ...blank(kind), name: f.name } : f));
  const changeModel = (model: ModelKey) => setForm((f) => (f ? { ...f, model, param: String(MODELS[model].param?.default ?? '') } : f));

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!form) return;
    setSaving(true);
    setErrors({});
    setFormError(null);
    const secret = form.secret.trim();
    const credentials = secret ? (form.kind === 'sheets' ? { service_account_json: secret } : { api_key: secret }) : undefined;
    const def = MODELS[form.model];
    try {
      await saveDestination({
        id: form.id,
        role: 'reverse',
        kind: form.kind,
        name: form.name,
        config: form.config,
        credentials,
        settings: { model: form.model, ...(def.param ? { param: Number(form.param) } : {}) },
        auto_sync: form.autoSync,
        interval_minutes: form.interval,
      });
      toast(editing ? 'Destination updated.' : 'Destination connected. Run “Test” then “Send now”.', 'success');
      setForm(null);
      await data.reload({ silent: true });
    } catch (err) {
      const api = err instanceof ApiError ? err : null;
      setErrors(api?.fieldErrors ?? {});
      setFormError(api?.message ?? 'Could not save the destination.');
    } finally {
      setSaving(false);
    }
  };

  if (form) {
    const e = errors;
    const def = MODELS[form.model];
    const keep = editing ? 'Leave empty to keep the saved credentials.' : undefined;
    const audience = def.kind === 'audience';
    return (
      <form onSubmit={submit} className="space-y-6" noValidate>
        <Card className="space-y-5 p-5 sm:p-6">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">{editing ? `Edit ${form.name}` : 'Send data to a tool'}</h2>
            <p className="mt-1 text-sm text-text-secondary">{REVERSE_META[form.kind].blurb}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Destination">
              <select className={SELECT} value={form.kind} disabled={editing} onChange={(ev) => changeKind(ev.target.value as ReverseDestinationKind)}>
                {REVERSE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {REVERSE_META[k].label}
                  </option>
                ))}
              </select>
            </Field>
            <Input label="Name" value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} error={e.name} placeholder="Win-back list" maxLength={80} required />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="What to send" error={e.model}>
              <select className={SELECT} value={form.model} onChange={(ev) => changeModel(ev.target.value as ModelKey)}>
                {modelsFor(form.kind).map((k) => (
                  <option key={k} value={k}>
                    {MODELS[k].label}
                  </option>
                ))}
              </select>
            </Field>
            {def.param ? (
              <Input label={def.param.label} type="number" inputMode="numeric" min={def.param.min} max={def.param.max} value={form.param} onChange={(ev) => setForm({ ...form, param: ev.target.value })} />
            ) : (
              <div />
            )}
            <p className="text-sm text-text-secondary sm:col-span-2">{def.description}</p>
          </div>

          {form.kind === 'sheets' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Google Sheet URL or id" value={form.config.spreadsheet_id} onChange={(ev) => setConfig('spreadsheet_id', ev.target.value)} error={e.spreadsheet_id} />
              <Input label="Tab name" value={form.config.tab} onChange={(ev) => setConfig('tab', ev.target.value)} error={e.tab} helperText="Created if missing. Its contents are replaced on every run." />
              <div className="sm:col-span-2">
                <Textarea label="Service account JSON key" rows={5} value={form.secret} onChange={(ev) => setForm({ ...form, secret: ev.target.value })} error={e.service_account_json} helperText={keep ?? 'Share the sheet with the service account’s client_email as Editor. Stored encrypted.'} spellCheck={false} autoComplete="off" />
              </div>
            </div>
          )}

          {form.kind !== 'sheets' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label={form.kind === 'mailchimp' ? 'Audience id' : 'List id'} value={form.config.list_id} onChange={(ev) => setConfig('list_id', ev.target.value)} error={e.list_id} />
              {form.kind === 'mailchimp' && <Input label="Tag" value={form.config.tag} onChange={(ev) => setConfig('tag', ev.target.value)} error={e.tag} helperText="Added to every contact Vireek sends." />}
              <div className="sm:col-span-2">
                <Input label="API key" type="password" value={form.secret} onChange={(ev) => setForm({ ...form, secret: ev.target.value })} error={e.api_key} helperText={keep ?? 'Stored encrypted and never shown again.'} autoComplete="off" />
              </div>
            </div>
          )}

          {audience && form.kind !== 'sheets' && (
            <p className="rounded-xl border border-border bg-bg-tertiary/50 px-4 py-3 text-sm text-text-secondary">
              Only customers who opted in to marketing and have an email address are sent. Anyone who unsubscribed in your email tool stays unsubscribed.
            </p>
          )}

          <div className="grid items-end gap-4 sm:grid-cols-2">
            <Field label="Schedule">
              <select className={SELECT} value={form.interval} onChange={(ev) => setForm({ ...form, interval: Number(ev.target.value) })}>
                {INTERVAL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
            <Toggle checked={form.autoSync} onChange={(v) => setForm({ ...form, autoSync: v })} label="Send automatically" />
          </div>
        </Card>

        {formError && (
          <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            {formError}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 size={18} className="animate-spin" />}
            {editing ? 'Save changes' : 'Connect'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setForm(null)} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-secondary">Push metrics and customer lists back into the tools your team already uses. Marketing audiences always respect consent.</p>
        {list.length > 0 && (
          <Button size="sm" onClick={() => open(blank())}>
            <Plus size={16} />
            Add destination
          </Button>
        )}
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={Send}
          title="Nothing is being sent yet"
          description="Keep a Google Sheet of your metrics up to date, or sync win-back and VIP lists to Mailchimp or Klaviyo."
          action={{ label: 'Set up a destination', onClick: () => open(blank()) }}
        />
      ) : (
        list.map((d) => (
          <DestinationCard
            key={d.id}
            dest={d}
            runs={data.runs.filter((r) => r.destination_id === d.id)}
            syncState={[]}
            now={data.now}
            summary={summaryOf(d)}
            onEdit={() => open(fromDestination(d))}
            onChanged={() => void data.reload({ silent: true })}
          />
        ))
      )}
    </div>
  );
}

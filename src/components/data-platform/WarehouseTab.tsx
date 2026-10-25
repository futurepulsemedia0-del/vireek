import { useState } from 'react';
import { Database, Loader2, Plus } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/contexts/ToastContext';
import {
  ApiError,
  DATASETS,
  DATASET_KEYS,
  DEFAULT_DATASETS,
  INTERVAL_OPTIONS,
  PII_MODES,
  PII_MODE_META,
  WAREHOUSE_KINDS,
  WAREHOUSE_META,
  saveDestination,
  tableRef,
  type DatasetKey,
  type Destination,
  type PiiMode,
  type WarehouseKind,
} from '@/lib/dataPlatform';
import { DestinationCard } from './DestinationCard';
import { Field, SELECT, Toggle } from './ui';
import type { DestinationData } from './useDestinationData';

type Form = {
  id?: string;
  kind: WarehouseKind;
  name: string;
  config: Record<string, string>;
  creds: Record<string, string>;
  datasets: DatasetKey[];
  piiMode: PiiMode;
  interval: number;
  autoSync: boolean;
};

const DEFAULT_CONFIG: Record<WarehouseKind, Record<string, string>> = {
  bigquery: { project_id: '', dataset: 'vireek', location: 'US' },
  snowflake: { account: '', username: '', warehouse: '', database: '', schema: 'VIREEK', role: '' },
  postgres: { host: '', port: '5432', database: '', username: '', schema: 'vireek', ssl: 'require' },
};

const blank = (kind: WarehouseKind = 'bigquery'): Form => ({
  kind,
  name: '',
  config: { ...DEFAULT_CONFIG[kind] },
  creds: { auth: 'pat' },
  datasets: [...DEFAULT_DATASETS],
  piiMode: 'hashed',
  interval: 360,
  autoSync: true,
});

function fromDestination(d: Destination): Form {
  const kind = d.kind as WarehouseKind;
  const config: Record<string, string> = { ...DEFAULT_CONFIG[kind] };
  for (const [k, v] of Object.entries(d.config)) if (v !== null && v !== undefined) config[k] = String(v);
  const ds = Array.isArray(d.settings.datasets) ? (d.settings.datasets as DatasetKey[]).filter((k) => DATASET_KEYS.includes(k)) : [...DEFAULT_DATASETS];
  const pii = d.settings.pii_mode;
  return {
    id: d.id,
    kind,
    name: d.name,
    config,
    creds: { auth: 'pat' },
    datasets: ds.length ? ds : [...DEFAULT_DATASETS],
    piiMode: pii === 'full' || pii === 'omit' ? pii : 'hashed',
    interval: d.interval_minutes,
    autoSync: d.auto_sync,
  };
}

function locationOf(d: Destination): string {
  const cfg = { kind: d.kind, ...d.config } as Parameters<typeof tableRef>[0];
  try {
    return tableRef(cfg, 'customers').replace(/customers$/i, '*');
  } catch {
    return '';
  }
}

export function WarehouseTab({ data }: { data: DestinationData }) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const warehouses = data.destinations.filter((d) => d.role === 'warehouse');
  const editing = !!form?.id;

  const setConfig = (k: string, v: string) => setForm((f) => (f ? { ...f, config: { ...f.config, [k]: v } } : f));
  const setCred = (k: string, v: string) => setForm((f) => (f ? { ...f, creds: { ...f.creds, [k]: v } } : f));
  const toggleDataset = (k: DatasetKey) =>
    setForm((f) => (f ? { ...f, datasets: f.datasets.includes(k) ? f.datasets.filter((x) => x !== k) : [...f.datasets, k] } : f));

  const open = (f: Form) => {
    setErrors({});
    setFormError(null);
    setForm(f);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    if (!form.datasets.length) {
      setFormError('Choose at least one table to sync.');
      return;
    }
    setSaving(true);
    setErrors({});
    setFormError(null);
    const typed = Object.fromEntries(Object.entries(form.creds).filter(([k, v]) => k === 'auth' || v.trim() !== ''));
    const hasSecret = Object.keys(typed).some((k) => k !== 'auth');
    try {
      await saveDestination({
        id: form.id,
        role: 'warehouse',
        kind: form.kind,
        name: form.name,
        config: form.config,
        // Left blank while editing = keep the stored credentials.
        credentials: hasSecret ? typed : undefined,
        settings: { datasets: form.datasets, pii_mode: form.piiMode },
        auto_sync: form.autoSync,
        interval_minutes: form.interval,
      });
      toast(editing ? 'Destination updated.' : 'Destination connected. Run “Test” then “Sync now”.', 'success');
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
    const c = form.config;
    const e = errors;
    const keep = editing ? 'Leave empty to keep the saved credentials.' : undefined;
    return (
      <form onSubmit={submit} className="space-y-6" noValidate>
        <Card className="space-y-5 p-5 sm:p-6">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">{editing ? `Edit ${form.name}` : 'Connect a warehouse'}</h2>
            <p className="mt-1 text-sm text-text-secondary">{WAREHOUSE_META[form.kind].blurb}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Type">
              <select
                className={SELECT}
                value={form.kind}
                disabled={editing}
                onChange={(ev) => setForm({ ...blank(ev.target.value as WarehouseKind), name: form.name })}
              >
                {WAREHOUSE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {WAREHOUSE_META[k].label}
                  </option>
                ))}
              </select>
            </Field>
            <Input label="Name" value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} error={e.name} placeholder="Production warehouse" maxLength={80} required />
          </div>

          {form.kind === 'bigquery' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Project id" value={c.project_id} onChange={(ev) => setConfig('project_id', ev.target.value)} error={e.project_id} placeholder="my-company-analytics" />
              <Input label="Dataset" value={c.dataset} onChange={(ev) => setConfig('dataset', ev.target.value)} error={e.dataset} helperText="Created automatically if missing." />
              <Input label="Location" value={c.location} onChange={(ev) => setConfig('location', ev.target.value)} error={e.location} helperText="US, EU, europe-west1…" />
              <div className="sm:col-span-2">
                <Textarea label="Service account JSON key" rows={5} value={form.creds.service_account_json ?? ''} onChange={(ev) => setCred('service_account_json', ev.target.value)} error={e.service_account_json} helperText={keep ?? 'Needs BigQuery Data Editor and BigQuery Job User. Stored encrypted, never shown again.'} spellCheck={false} autoComplete="off" />
              </div>
            </div>
          )}

          {form.kind === 'snowflake' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Account identifier" value={c.account} onChange={(ev) => setConfig('account', ev.target.value)} error={e.account} placeholder="myorg-myaccount" />
              <Input label="User" value={c.username} onChange={(ev) => setConfig('username', ev.target.value)} error={e.username} />
              <Input label="Warehouse" value={c.warehouse} onChange={(ev) => setConfig('warehouse', ev.target.value)} error={e.warehouse} />
              <Input label="Database" value={c.database} onChange={(ev) => setConfig('database', ev.target.value)} error={e.database} />
              <Input label="Schema" value={c.schema} onChange={(ev) => setConfig('schema', ev.target.value)} error={e.schema} />
              <Input label="Role (optional)" value={c.role} onChange={(ev) => setConfig('role', ev.target.value)} error={e.role} />
              <Field label="Authentication">
                <select className={SELECT} value={form.creds.auth} onChange={(ev) => setForm({ ...form, creds: { auth: ev.target.value } })}>
                  <option value="pat">Programmatic access token</option>
                  <option value="keypair">Key pair (private key)</option>
                </select>
              </Field>
              <div className="sm:col-span-2">
                {form.creds.auth === 'keypair' ? (
                  <Textarea label="Private key (PKCS#8, unencrypted)" rows={5} value={form.creds.private_key ?? ''} onChange={(ev) => setCred('private_key', ev.target.value)} error={e.private_key} helperText={keep ?? 'The matching public key must be assigned to the user.'} spellCheck={false} autoComplete="off" />
                ) : (
                  <Input label="Access token" type="password" value={form.creds.token ?? ''} onChange={(ev) => setCred('token', ev.target.value)} error={e.token} helperText={keep} autoComplete="off" />
                )}
              </div>
            </div>
          )}

          {form.kind === 'postgres' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Host" value={c.host} onChange={(ev) => setConfig('host', ev.target.value)} error={e.host} placeholder="db.example.com" />
              <Input label="Port" inputMode="numeric" value={c.port} onChange={(ev) => setConfig('port', ev.target.value)} error={e.port} />
              <Input label="Database" value={c.database} onChange={(ev) => setConfig('database', ev.target.value)} error={e.database} />
              <Input label="User" value={c.username} onChange={(ev) => setConfig('username', ev.target.value)} error={e.username} />
              <Input label="Schema" value={c.schema} onChange={(ev) => setConfig('schema', ev.target.value)} error={e.schema} helperText="Created automatically if missing." />
              <Field label="TLS">
                <select className={SELECT} value={c.ssl} onChange={(ev) => setConfig('ssl', ev.target.value)}>
                  <option value="require">Require (encrypted)</option>
                  <option value="verify-full">Verify certificate</option>
                </select>
              </Field>
              <div className="sm:col-span-2">
                <Input label="Password" type="password" value={form.creds.password ?? ''} onChange={(ev) => setCred('password', ev.target.value)} error={e.password} helperText={keep} autoComplete="new-password" />
              </div>
            </div>
          )}
        </Card>

        <Card className="space-y-5 p-5 sm:p-6">
          <div>
            <h3 className="text-base font-semibold text-text-primary">What to sync</h3>
            <p className="mt-1 text-sm text-text-secondary">Only the tables you tick are created. Each table is loaded incrementally and upserted by id.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {DATASET_KEYS.map((k) => (
              <label key={k} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-bg-tertiary/60">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={form.datasets.includes(k)} onChange={() => toggleDataset(k)} />
                <span>
                  <span className="block text-sm font-semibold text-text-primary">{DATASETS[k].label}</span>
                  <span className="block text-xs text-text-secondary">{DATASETS[k].description}</span>
                </span>
              </label>
            ))}
          </div>

          <fieldset>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Personal data</legend>
            <div className="space-y-2">
              {PII_MODES.map((m) => (
                <label key={m} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-bg-tertiary/60">
                  <input type="radio" name="pii" className="mt-1 h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={form.piiMode === m} onChange={() => setForm({ ...form, piiMode: m })} />
                  <span>
                    <span className="block text-sm font-semibold text-text-primary">{PII_MODE_META[m].label}</span>
                    <span className="block text-xs text-text-secondary">{PII_MODE_META[m].description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

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
            <Toggle checked={form.autoSync} onChange={(v) => setForm({ ...form, autoSync: v })} label="Sync automatically" />
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
        <p className="max-w-2xl text-sm text-text-secondary">
          Keep a copy of your core tables in your own warehouse. Loads are incremental (only changed rows), idempotent and documented in the Schema tab.
        </p>
        {warehouses.length > 0 && (
          <Button size="sm" onClick={() => open(blank())}>
            <Plus size={16} />
            Add warehouse
          </Button>
        )}
      </div>

      {warehouses.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No warehouse connected"
          description="Send your customers, leads, calls, jobs, quotes and job costs to BigQuery, Snowflake or your own Postgres."
          action={{ label: 'Connect a warehouse', onClick: () => open(blank()) }}
        />
      ) : (
        warehouses.map((d) => (
          <DestinationCard
            key={d.id}
            dest={d}
            runs={data.runs.filter((r) => r.destination_id === d.id)}
            syncState={data.syncState.filter((s) => s.destination_id === d.id)}
            now={data.now}
            summary={`${locationOf(d)} · ${PII_MODE_META[(d.settings.pii_mode as PiiMode) ?? 'hashed']?.label ?? ''}`}
            onEdit={() => open(fromDestination(d))}
            onChanged={() => void data.reload({ silent: true })}
          />
        ))
      )}
    </div>
  );
}

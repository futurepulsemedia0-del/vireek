import { useState } from 'react';
import { CloudUpload, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { INTERVAL_OPTIONS, timeAgo } from '@/lib/dataPlatform';
import {
  ApiError, DATASETS, DATASET_KEYS, DEFAULT_DATASETS, EXPORT_META, PII_MODES, PII_MODE_META, ROWS_PER_FILE_OPTIONS, deleteTarget, describeExportStats, isTargetRunning,
  probeSftpHost, runTarget, saveTarget, testTarget, type DatasetKey, type ExportKind, type ExportTargetRow, type PiiMode, type TestCheck,
} from '@/lib/biConnectors';
import { Badge, Field, SELECT, STATUS_STYLE, Toggle } from '@/components/data-platform/ui';
import type { BiData } from './useBiData';

const INTERVALS = INTERVAL_OPTIONS.filter((o) => [60, 360, 1440].includes(o.value)).concat([{ value: 10080, label: 'Weekly' }]);

type Form = {
  id?: string; kind: ExportKind; name: string;
  bucket: string; region: string; endpoint: string; prefix: string; sse: boolean; accessKey: string; secretKey: string; sessionToken: string;
  host: string; port: string; username: string; remotePath: string; hostKey: string; password: string; privateKey: string; passphrase: string;
  datasets: DatasetKey[]; pii: PiiMode; format: 'csv' | 'ndjson'; compress: boolean; mode: 'incremental' | 'snapshot'; rows: string;
  interval: string; auto: boolean;
};

const blank = (kind: ExportKind): Form => ({
  kind, name: '', bucket: '', region: 'us-east-1', endpoint: '', prefix: 'vireek/', sse: true, accessKey: '', secretKey: '', sessionToken: '',
  host: '', port: '22', username: '', remotePath: '/vireek/', hostKey: '', password: '', privateKey: '', passphrase: '',
  datasets: [...DEFAULT_DATASETS], pii: 'hashed', format: 'csv', compress: true, mode: 'incremental', rows: '20000', interval: '1440', auto: true,
});

function fromTarget(t: ExportTargetRow): Form {
  const c = t.config as Record<string, unknown>;
  const s = t.settings as Record<string, unknown>;
  const f = blank(t.kind);
  return {
    ...f, id: t.id, name: t.name, interval: String(t.interval_minutes), auto: t.auto_sync,
    bucket: String(c.bucket ?? ''), region: String(c.region ?? 'us-east-1'), endpoint: String(c.endpoint ?? ''), prefix: String(c.prefix ?? ''), sse: c.sse === true,
    host: String(c.host ?? ''), port: String(c.port ?? 22), username: String(c.username ?? ''), remotePath: String(c.remote_path ?? ''), hostKey: String(c.host_key_sha256 ?? ''),
    datasets: Array.isArray(s.datasets) ? (s.datasets as DatasetKey[]) : f.datasets, pii: (s.pii_mode as PiiMode) ?? 'hashed', format: s.format === 'ndjson' ? 'ndjson' : 'csv',
    compress: s.compress !== false, mode: s.mode === 'snapshot' ? 'snapshot' : 'incremental', rows: String(s.rows_per_file ?? 20000),
  };
}

function toPayload(f: Form) {
  const creds = f.kind === 's3'
    ? { access_key_id: f.accessKey, secret_access_key: f.secretKey, ...(f.sessionToken ? { session_token: f.sessionToken } : {}) }
    : { ...(f.password ? { password: f.password } : {}), ...(f.privateKey ? { private_key: f.privateKey } : {}), ...(f.passphrase ? { passphrase: f.passphrase } : {}) };
  return {
    id: f.id, kind: f.kind, name: f.name.trim(),
    config: f.kind === 's3'
      ? { bucket: f.bucket, region: f.region, endpoint: f.endpoint, prefix: f.prefix, sse: f.sse }
      : { host: f.host, port: f.port, username: f.username, remote_path: f.remotePath, host_key_sha256: f.hostKey },
    credentials: Object.values(creds).some(Boolean) ? creds : undefined,
    settings: { datasets: f.datasets, pii_mode: f.pii, format: f.format, compress: f.compress, mode: f.mode, rows_per_file: Number(f.rows) },
    auto_sync: f.auto, interval_minutes: Number(f.interval),
  };
}

export function ExportsTab({ data, isOwner }: { data: BiData; isOwner: boolean }) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, TestCheck[]>>({});
  const [confirm, setConfirm] = useState<ExportTargetRow | null>(null);
  const toggle = (list: DatasetKey[], v: DatasetKey) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const editing = !!form?.id;
  const set = (patch: Partial<Form>) => form && setForm({ ...form, ...patch });

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!form) return;
    setErrors({});
    setFormError(null);
    if (!form.name.trim()) return setErrors({ name: 'Give the target a name.' });
    if (!form.datasets.length) return setErrors({ datasets: 'Choose at least one dataset.' });
    setSaving(true);
    try {
      await saveTarget(toPayload(form));
      toast(editing ? 'Target updated.' : 'Target created. The first export starts within 15 minutes, or use “Export now”.', 'success');
      setForm(null);
      await data.reload({ silent: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setFormError(Object.keys(err.fieldErrors).length ? null : err.message);
      } else setFormError('Could not save the target.');
    } finally {
      setSaving(false);
    }
  };

  const detect = async () => {
    if (!form) return;
    setProbing(true);
    setErrors((e) => ({ ...e, hostKey: '' }));
    try {
      set({ hostKey: (await probeSftpHost(form.host, form.port)).fingerprint });
    } catch (err) {
      setErrors((e) => ({ ...e, hostKey: err instanceof Error ? err.message : 'Could not read the host key.' }));
    } finally {
      setProbing(false);
    }
  };

  const act = async (t: ExportTargetRow, kind: 'test' | 'run' | 'full') => {
    setBusy(`${kind}:${t.id}`);
    try {
      if (kind === 'test') {
        const r = await testTarget(t.id);
        setChecks((c) => ({ ...c, [t.id]: r.checks }));
      } else {
        await runTarget(t.id, kind === 'full');
        toast(kind === 'full' ? 'Full export started.' : 'Export started.', 'success');
        await data.reload({ silent: true });
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async () => {
    if (!confirm) return;
    try {
      await deleteTarget(confirm.id);
      toast('Target deleted. Files already in your storage are untouched.', 'success');
      await data.reload({ silent: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the target.', 'error');
    } finally {
      setConfirm(null);
    }
  };

  if (form) {
    const s3 = form.kind === 's3';
    return (
      <form onSubmit={submit} className="space-y-6" noValidate>
        <Card className="space-y-5 p-5 sm:p-6">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">{editing ? `Edit ${form.name}` : `New ${EXPORT_META[form.kind].label} export`}</h2>
            <p className="mt-1 text-sm text-text-secondary">Credentials are encrypted, never shown again, and used only to write files. Leave them empty to keep the saved ones.</p>
          </div>
          {formError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{formError}</p>}
          <Input label="Name" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} required error={errors.name} placeholder="Data lake" />

          {s3 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Bucket" value={form.bucket} onChange={(e) => set({ bucket: e.target.value })} error={errors.bucket} placeholder="my-company-data" />
              <Input label="Region" value={form.region} onChange={(e) => set({ region: e.target.value })} error={errors.region} helperText="us-east-1, eu-central-1… (“auto” for Cloudflare R2)" />
              <Input label="Folder prefix" value={form.prefix} onChange={(e) => set({ prefix: e.target.value })} error={errors.prefix} helperText="Files are written under this folder." />
              <Input label="Custom endpoint (optional)" value={form.endpoint} onChange={(e) => set({ endpoint: e.target.value })} error={errors.endpoint} placeholder="https://<account>.r2.cloudflarestorage.com" />
              <Input label={editing ? 'Access key id (leave empty to keep)' : 'Access key id'} value={form.accessKey} onChange={(e) => set({ accessKey: e.target.value })} error={errors.access_key_id} autoComplete="off" />
              <Input label={editing ? 'Secret access key (leave empty to keep)' : 'Secret access key'} type="password" value={form.secretKey} onChange={(e) => set({ secretKey: e.target.value })} error={errors.secret_access_key} autoComplete="new-password" />
              <Input label="Session token (optional)" type="password" value={form.sessionToken} onChange={(e) => set({ sessionToken: e.target.value })} error={errors.session_token} autoComplete="off" />
              <div className="self-end pb-2"><Toggle checked={form.sse} onChange={(v) => set({ sse: v })} label="Encrypt at rest (AES-256)" /></div>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Host" value={form.host} onChange={(e) => set({ host: e.target.value })} error={errors.host} placeholder="sftp.example.com" />
              <Input label="Port" type="number" value={form.port} onChange={(e) => set({ port: e.target.value })} error={errors.port} />
              <Input label="Username" value={form.username} onChange={(e) => set({ username: e.target.value })} error={errors.username} autoComplete="off" />
              <Input label="Remote folder" value={form.remotePath} onChange={(e) => set({ remotePath: e.target.value })} error={errors.remote_path} />
              <div className="sm:col-span-2">
                <Input label="Host key fingerprint" value={form.hostKey} onChange={(e) => set({ hostKey: e.target.value })} error={errors.host_key_sha256 || errors.hostKey} placeholder="SHA256:…" helperText="Detect it, then confirm it matches what your provider publishes. Connections with any other key are refused." />
                <Button type="button" variant="secondary" size="sm" className="mt-2" disabled={probing || !form.host} onClick={detect}>{probing ? 'Detecting…' : 'Detect host key'}</Button>
              </div>
              <Input label={editing ? 'Password (leave empty to keep)' : 'Password'} type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} error={errors.password} autoComplete="new-password" />
              <Input label="…or private key (PEM)" value={form.privateKey} onChange={(e) => set({ privateKey: e.target.value })} error={errors.private_key} helperText="Paste the whole key. Preferred over a password." />
              <Input label="Key passphrase (optional)" type="password" value={form.passphrase} onChange={(e) => set({ passphrase: e.target.value })} autoComplete="off" />
            </div>
          )}

          <fieldset>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Datasets</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {DATASET_KEYS.map((k) => (
                <label key={k} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-bg-tertiary/60">
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={form.datasets.includes(k)} onChange={() => set({ datasets: toggle(form.datasets, k) })} />
                  <span><span className="block text-sm font-semibold text-text-primary">{DATASETS[k].label}</span><span className="block text-xs text-text-secondary">{DATASETS[k].description}</span></span>
                </label>
              ))}
            </div>
            {errors.datasets && <span role="alert" className="mt-1 block text-xs text-danger">{errors.datasets}</span>}
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Personal data" hint={PII_MODE_META[form.pii].description}>
              <select className={SELECT} value={form.pii} onChange={(e) => set({ pii: e.target.value as PiiMode })}>
                {PII_MODES.map((m) => <option key={m} value={m} disabled={m === 'full' && !isOwner}>{PII_MODE_META[m].label}{m === 'full' && !isOwner ? ' (owner only)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Format"><select className={SELECT} value={form.format} onChange={(e) => set({ format: e.target.value as 'csv' | 'ndjson' })}><option value="csv">CSV</option><option value="ndjson">NDJSON (JSON lines)</option></select></Field>
            <Field label="Rows per file"><select className={SELECT} value={form.rows} onChange={(e) => set({ rows: e.target.value })}>{ROWS_PER_FILE_OPTIONS.map((n) => <option key={n} value={n}>{n.toLocaleString()}</option>)}</select></Field>
            <Field label="Contents" hint={form.mode === 'incremental' ? 'Only rows changed since the last export. Best for large accounts.' : 'Every row, every run. Fails if too large for the time limit.'}>
              <select className={SELECT} value={form.mode} onChange={(e) => set({ mode: e.target.value as 'incremental' | 'snapshot' })}><option value="incremental">Changes only (incremental)</option><option value="snapshot">Full snapshot each run</option></select>
            </Field>
            <Field label="Schedule"><select className={SELECT} value={form.interval} onChange={(e) => set({ interval: e.target.value })}>{INTERVALS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
            <div className="flex flex-col justify-end gap-3 pb-2"><Toggle checked={form.compress} onChange={(v) => set({ compress: v })} label="Compress with gzip" /><Toggle checked={form.auto} onChange={(v) => set({ auto: v })} label="Run on schedule" /></div>
          </div>
          <div className="flex flex-wrap justify-end gap-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setForm(null); setErrors({}); setFormError(null); }}>Cancel</Button>
            <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Create target'}</Button>
          </div>
        </Card>
      </form>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-secondary">Drop your Vireek data into your own bucket or SFTP server on a schedule. Files are partitioned by date and listed in a manifest, so BigQuery, Snowflake, Athena and Spark can load them directly.</p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => { setChecks({}); setForm(blank('s3')); }}><Plus size={16} />S3</Button>
          <Button size="sm" variant="secondary" onClick={() => { setChecks({}); setForm(blank('sftp')); }}><Plus size={16} />SFTP</Button>
        </div>
      </div>

      {data.targets.length === 0 ? (
        <EmptyState icon={CloudUpload} title="No export targets yet" description="Add an S3 bucket or an SFTP server and Vireek will deliver fresh files on your schedule." action={{ label: 'Add an S3 bucket', onClick: () => setForm(blank('s3')) }} secondaryAction={{ label: 'Add SFTP', onClick: () => setForm(blank('sftp')) }} />
      ) : (
        <ul className="space-y-4" aria-label="Export targets">
          {data.targets.map((t) => {
            const running = isTargetRunning(t, data.now);
            const last = data.runs.find((r) => r.target_id === t.id);
            const history = data.runs.filter((r) => r.target_id === t.id).slice(0, 5);
            return (
              <li key={t.id}>
                <Card className="space-y-4 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-base font-semibold text-text-primary">{t.name}</h3>
                        <Badge cls={running ? STATUS_STYLE.running : t.status === 'error' ? STATUS_STYLE.failed : STATUS_STYLE.success}>
                          {running ? <><Loader2 size={12} className="animate-spin" />Exporting</> : t.status === 'error' ? 'Needs attention' : 'Connected'}
                        </Badge>
                        <Badge cls={STATUS_STYLE.neutral}>{EXPORT_META[t.kind].label}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-text-secondary">
                        {t.kind === 's3' ? `${String(t.config.bucket)}/${String(t.config.prefix ?? '')}` : `${String(t.config.host)}:${String(t.config.remote_path ?? '')}`} ·{' '}
                        {t.auto_sync ? INTERVALS.find((o) => o.value === t.interval_minutes)?.label.toLowerCase() : 'manual only'} · last success {timeAgo(t.last_success_at, data.now)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" size="sm" disabled={running || busy === `run:${t.id}`} onClick={() => act(t, 'run')}><Play size={14} />Export now</Button>
                      <Button variant="ghost" size="sm" disabled={running || busy === `full:${t.id}`} onClick={() => act(t, 'full')}>Full export</Button>
                      <Button variant="ghost" size="sm" disabled={busy === `test:${t.id}`} onClick={() => act(t, 'test')}>{busy === `test:${t.id}` ? 'Testing…' : 'Test'}</Button>
                      <Button variant="ghost" size="sm" aria-label={`Edit ${t.name}`} onClick={() => { setChecks({}); setForm(fromTarget(t)); }}><Pencil size={14} /></Button>
                      <Button variant="ghost" size="sm" aria-label={`Delete ${t.name}`} onClick={() => setConfirm(t)}><Trash2 size={14} /></Button>
                    </div>
                  </div>
                  {t.status === 'error' && t.last_error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{t.last_error}</p>}
                  {checks[t.id] && (
                    <ul className="space-y-1.5" aria-label="Connection test results">
                      {checks[t.id].map((c) => <li key={c.name} className={`text-sm ${c.ok ? 'text-success-500' : 'text-danger'}`}>{c.ok ? '✓' : '✕'} {c.name}: {c.detail}</li>)}
                    </ul>
                  )}
                  {last && <p className="text-xs text-text-secondary">Last run: {last.status}{describeExportStats(last.stats) ? ` · ${describeExportStats(last.stats)}` : ''} · {timeAgo(last.started_at, data.now)}</p>}
                  {history.length > 1 && (
                    <details className="text-sm"><summary className="focus-ring cursor-pointer rounded text-text-secondary">Run history</summary>
                      <ul className="mt-2 space-y-1">{history.map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                          <Badge cls={STATUS_STYLE[r.status === 'running' ? 'running' : r.status]}>{r.status}</Badge>{r.mode} · {r.trigger} · {timeAgo(r.started_at, data.now)}{r.error ? ` · ${r.error}` : ''}
                        </li>))}</ul>
                    </details>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog open={!!confirm} title={`Delete “${confirm?.name ?? ''}”?`} description="Scheduled exports stop and the saved credentials are erased. Files already written to your storage are not touched." confirmLabel="Yes, delete it" onConfirm={doDelete} onCancel={() => setConfirm(null)} />
    </div>
  );
}

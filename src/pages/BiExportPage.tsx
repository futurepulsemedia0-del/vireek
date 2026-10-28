import { useCallback, useEffect, useRef, useState } from 'react';
import { BarChart3, Loader2, Plus, Play, Trash2, Pencil, ShieldCheck, KeyRound } from 'lucide-react';
import { DashboardLayout } from '@/components/DashboardNav';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/contexts/ToastContext';
import { useRealtimeSubscription } from '@/lib/realtime';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { Badge, CodeBlock, CopyButton, ErrorBanner, Field, NoAccess, SELECT, Skeleton, STATUS_STYLE, Toggle } from '@/components/data-platform/ui';
import {
  BI_INTERVAL_OPTIONS, BI_MODES, BI_MODE_META, BI_PII_MODES, BI_PII_MODE_META, BI_PROVIDERS, BI_PROVIDER_META, BiApiError, DATASETS, DATASET_KEYS,
  VERIFY_SNIPPET, biPiiViewName, biViewName, canExportPii, createReader, deleteSchedule, deleteTarget, hasPii, intervalLabel, isRunning,
  listBiRuns, listReaders, listSchedules, listTargets, powerBiQuery, revokeReader, rotateSigningSecret, runScheduleNow, saveSchedule, saveTarget,
  testTarget, timeAgo, useBiOwnerId, useCanManageBi,
  type BiMode, type BiProvider, type BiReader, type BiRun, type BiSchedule, type BiTarget, type DatasetKey, type NewReader, type PiiMode,
} from '@/lib/biExport';

type TargetForm = { id?: string; name: string; provider: BiProvider; bucket: string; region: string; prefix: string; access_key_id: string; secret: string };
type ScheduleForm = { id?: string; name: string; target_id: string; datasets: DatasetKey[]; mode: BiMode; pii_mode: PiiMode; interval_minutes: number; enabled: boolean };

const blankTarget = (): TargetForm => ({ name: '', provider: 's3', bucket: '', region: 'eu-central-1', prefix: 'vireek', access_key_id: '', secret: '' });
const blankSchedule = (target_id: string): ScheduleForm => ({ name: '', target_id, datasets: ['customers', 'leads', 'calls', 'jobs'], mode: 'incremental', pii_mode: 'omit', interval_minutes: 1440, enabled: true });

const runStyle = (s: BiRun['status']) => (s === 'success' ? STATUS_STYLE.success : s === 'running' ? STATUS_STYLE.running : s === 'partial' ? STATUS_STYLE.partial : STATUS_STYLE.failed);

export function BiExportPage() {
  const { loading: authLoading, profileLoading } = useAuth();
  const canManage = useCanManageBi();
  const ownerId = useBiOwnerId();
  const { toast } = useToast();
  const [tab, setTab] = useState<'delivery' | 'sql'>('delivery');
  const [targets, setTargets] = useState<BiTarget[]>([]);
  const [schedules, setSchedules] = useState<BiSchedule[]>([]);
  const [runs, setRuns] = useState<BiRun[]>([]);
  const [readers, setReaders] = useState<BiReader[]>([]);
  const [piiOk, setPiiOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [tForm, setTForm] = useState<TargetForm | null>(null);
  const [sForm, setSForm] = useState<ScheduleForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [secretShown, setSecretShown] = useState<string | null>(null);
  const [reader, setReader] = useState<NewReader | null>(null);
  const [readerLabel, setReaderLabel] = useState('');
  const [readerPii, setReaderPii] = useState(false);
  const alive = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  const pending = authLoading || profileLoading;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const reload = useCallback(async (silent = false) => {
    if (!ownerId || !canManage) return;
    if (!silent) setLoading(true);
    try {
      const [t, s, r, rd, p] = await Promise.all([listTargets(ownerId), listSchedules(ownerId), listBiRuns(ownerId), listReaders(ownerId), canExportPii()]);
      if (!alive.current) return;
      setTargets(t); setSchedules(s); setRuns(r); setReaders(rd); setPiiOk(p); setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Could not load BI export.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [ownerId, canManage]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const bump = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload(true), 600);
  }, [reload]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const live = !!ownerId && canManage;
  const filter = live ? `user_id=eq.${ownerId}` : undefined;
  useRealtimeSubscription({ channelName: `bi-runs-${ownerId}`, table: 'bi_export_runs', event: '*', filter, enabled: live, onChange: bump });
  useRealtimeSubscription({ channelName: `bi-schedules-${ownerId}`, table: 'bi_export_schedules', event: '*', filter, enabled: live, onChange: bump });

  const header = (
    <div className="mb-6 flex items-center gap-3">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent"><BarChart3 size={22} /></span>
      <div>
        <h1 className="text-2xl font-bold text-text-primary">BI Export</h1>
        <p className="text-sm text-text-secondary">Signed files to your own bucket on a schedule, and read-only SQL views for Power BI.</p>
      </div>
    </div>
  );

  if (pending) return <DashboardLayout activeLabel="BI Export">{header}<Skeleton className="h-72 w-full rounded-2xl" /></DashboardLayout>;
  if (!canManage) return <DashboardLayout activeLabel="BI Export">{header}<NoAccess what="Ask the account owner for the “export data” permission to open BI Export." /></DashboardLayout>;

  const targetName = (id: string) => targets.find((t) => t.id === id)?.name ?? 'Deleted destination';
  const fail = (e: unknown, fallback: string) => {
    const api = e instanceof BiApiError ? e : null;
    setErrors(api?.fieldErrors ?? {});
    setFormError(api?.message ?? fallback);
  };

  const submitTarget = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!tForm) return;
    setSaving(true); setErrors({}); setFormError(null);
    try {
      const res = await saveTarget({ id: tForm.id, name: tForm.name, provider: tForm.provider, bucket: tForm.bucket, region: tForm.region, prefix: tForm.prefix, access_key_id: tForm.access_key_id, secret_access_key: tForm.secret || undefined });
      if (res.signing_secret) setSecretShown(res.signing_secret);
      toast(tForm.id ? 'Destination updated. Run “Test” to verify it.' : 'Destination saved. Run “Test” to verify it.', 'success');
      setTForm(null);
      await reload(true);
    } catch (e) { fail(e, 'Could not save the destination.'); } finally { setSaving(false); }
  };

  const submitSchedule = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!sForm) return;
    setSaving(true); setErrors({}); setFormError(null);
    try {
      await saveSchedule(sForm);
      toast(sForm.id ? 'Schedule updated.' : 'Schedule created. The first delivery starts within 15 minutes.', 'success');
      setSForm(null);
      await reload(true);
    } catch (e) { fail(e, 'Could not save the schedule.'); } finally { setSaving(false); }
  };

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } catch (e) { toast(e instanceof Error ? e.message : 'Something went wrong.', 'error'); } finally { setBusy(null); }
  };

  if (tForm) {
    const e = errors;
    const editing = !!tForm.id;
    return (
      <DashboardLayout activeLabel="BI Export">
        {header}
        <form onSubmit={submitTarget} noValidate className="space-y-6">
          <Card className="space-y-5 p-5 sm:p-6">
            <div>
              <h2 className="text-lg font-semibold text-text-primary">{editing ? `Edit ${tForm.name}` : 'Add a bucket'}</h2>
              <p className="mt-1 text-sm text-text-secondary">{BI_PROVIDER_META[tForm.provider].blurb}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider">
                <select className={SELECT} value={tForm.provider} onChange={(ev) => setTForm({ ...tForm, provider: ev.target.value as BiProvider })}>
                  {BI_PROVIDERS.map((p) => <option key={p} value={p}>{BI_PROVIDER_META[p].label}</option>)}
                </select>
              </Field>
              <Input label="Name" value={tForm.name} onChange={(ev) => setTForm({ ...tForm, name: ev.target.value })} error={e.name} placeholder="Analytics bucket" maxLength={80} required />
              <Input label="Bucket" value={tForm.bucket} onChange={(ev) => setTForm({ ...tForm, bucket: ev.target.value })} error={e.bucket} placeholder="my-company-analytics" />
              {tForm.provider === 's3' && <Input label="Region" value={tForm.region} onChange={(ev) => setTForm({ ...tForm, region: ev.target.value })} error={e.region} placeholder="eu-central-1" />}
              <Input label="Folder prefix" value={tForm.prefix} onChange={(ev) => setTForm({ ...tForm, prefix: ev.target.value })} error={e.prefix} helperText="Files are written under this folder." />
              <Input label={tForm.provider === 's3' ? 'Access key id' : 'HMAC access id'} value={tForm.access_key_id} onChange={(ev) => setTForm({ ...tForm, access_key_id: ev.target.value })} error={e.access_key_id} autoComplete="off" />
              <div className="sm:col-span-2">
                <Input label={tForm.provider === 's3' ? 'Secret access key' : 'HMAC secret'} type="password" value={tForm.secret} onChange={(ev) => setTForm({ ...tForm, secret: ev.target.value })} error={e.secret_access_key} helperText={editing ? 'Leave empty to keep the saved secret.' : 'Stored encrypted. Never shown again.'} autoComplete="new-password" />
              </div>
            </div>
          </Card>
          {formError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{formError}</p>}
          <div className="flex gap-3">
            <Button type="submit" disabled={saving}>{saving && <Loader2 size={18} className="animate-spin" />}{editing ? 'Save changes' : 'Save bucket'}</Button>
            <Button type="button" variant="ghost" onClick={() => setTForm(null)} disabled={saving}>Cancel</Button>
          </div>
        </form>
      </DashboardLayout>
    );
  }

  if (sForm) {
    const e = errors;
    const editing = !!sForm.id;
    const toggle = (k: DatasetKey) => setSForm({ ...sForm, datasets: sForm.datasets.includes(k) ? sForm.datasets.filter((x) => x !== k) : [...sForm.datasets, k] });
    return (
      <DashboardLayout activeLabel="BI Export">
        {header}
        <form onSubmit={submitSchedule} noValidate className="space-y-6">
          <Card className="space-y-5 p-5 sm:p-6">
            <h2 className="text-lg font-semibold text-text-primary">{editing ? `Edit ${sForm.name}` : 'New delivery schedule'}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Name" value={sForm.name} onChange={(ev) => setSForm({ ...sForm, name: ev.target.value })} error={e.name} placeholder="Nightly to Power BI lake" maxLength={80} required />
              <Field label="Destination" error={e.target_id}>
                <select className={SELECT} value={sForm.target_id} onChange={(ev) => setSForm({ ...sForm, target_id: ev.target.value })}>
                  {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
              <Field label="Mode">
                <select className={SELECT} value={sForm.mode} onChange={(ev) => setSForm({ ...sForm, mode: ev.target.value as BiMode })}>
                  {BI_MODES.map((m) => <option key={m} value={m}>{BI_MODE_META[m].label}</option>)}
                </select>
              </Field>
              <Field label="Frequency" error={e.interval_minutes}>
                <select className={SELECT} value={sForm.interval_minutes} onChange={(ev) => setSForm({ ...sForm, interval_minutes: Number(ev.target.value) })}>
                  {BI_INTERVAL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </Field>
            </div>
            <p className="text-xs text-text-secondary">{BI_MODE_META[sForm.mode].description}</p>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Tables</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {DATASET_KEYS.map((k) => (
                  <label key={k} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-bg-tertiary/60">
                    <input type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={sForm.datasets.includes(k)} onChange={() => toggle(k)} />
                    <span>
                      <span className="block text-sm font-semibold text-text-primary">{DATASETS[k].label}</span>
                      <span className="block text-xs text-text-secondary">{DATASETS[k].description}</span>
                    </span>
                  </label>
                ))}
              </div>
              {e.datasets && <p role="alert" className="mt-1 text-xs text-danger">{e.datasets}</p>}
            </div>
            <fieldset>
              <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Personal data</legend>
              <div className="space-y-2">
                {BI_PII_MODES.map((m) => {
                  const locked = m !== 'omit' && !piiOk;
                  return (
                    <label key={m} className={`flex items-start gap-3 rounded-xl border border-border p-3 ${locked ? 'opacity-50' : 'cursor-pointer hover:bg-bg-tertiary/60'}`}>
                      <input type="radio" name="pii" className="mt-1 h-4 w-4 accent-[rgb(var(--accent-primary))]" disabled={locked} checked={sForm.pii_mode === m} onChange={() => setSForm({ ...sForm, pii_mode: m })} />
                      <span>
                        <span className="block text-sm font-semibold text-text-primary">{BI_PII_MODE_META[m].label}</span>
                        <span className="block text-xs text-text-secondary">{locked ? 'You need the “export personal data” permission (ask the account owner).' : BI_PII_MODE_META[m].description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <Toggle checked={sForm.enabled} onChange={(v) => setSForm({ ...sForm, enabled: v })} label="Run automatically" />
          </Card>
          {formError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{formError}</p>}
          <div className="flex gap-3">
            <Button type="submit" disabled={saving}>{saving && <Loader2 size={18} className="animate-spin" />}{editing ? 'Save changes' : 'Create schedule'}</Button>
            <Button type="button" variant="ghost" onClick={() => setSForm(null)} disabled={saving}>Cancel</Button>
          </div>
        </form>
      </DashboardLayout>
    );
  }

  const tabs = (
    <div className="mb-5 flex gap-2" role="tablist">
      {([['delivery', 'Delivery to your bucket'], ['sql', 'Power BI & SQL']] as const).map(([id, label]) => (
        <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`focus-ring rounded-xl px-4 py-2 text-sm font-semibold ${tab === id ? 'bg-accent text-white' : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'}`}>{label}</button>
      ))}
    </div>
  );

  return (
    <DashboardLayout activeLabel="BI Export">
      {header}
      {tabs}
      {error && <div className="mb-4"><ErrorBanner message={error} onRetry={() => void reload()} /></div>}
      {secretShown && (
        <Card className="mb-5 space-y-3 border-warning-500/40 p-5">
          <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary"><KeyRound size={18} />Signing secret (shown once)</h3>
          <p className="text-sm text-text-secondary">Every delivery includes a manifest signed with this secret so you can prove files are complete and unmodified. Store it in your secrets manager.</p>
          <CodeBlock code={secretShown} />
          <Button size="sm" variant="ghost" onClick={() => setSecretShown(null)}>I saved it</Button>
        </Card>
      )}

      {loading ? <Skeleton className="h-60 w-full rounded-2xl" /> : tab === 'delivery' ? (
        <div className="space-y-8">
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text-primary">Buckets</h2>
              {targets.length > 0 && <Button size="sm" onClick={() => { setErrors({}); setFormError(null); setTForm(blankTarget()); }}><Plus size={16} />Add bucket</Button>}
            </div>
            {targets.length === 0 ? (
              <EmptyState icon={BarChart3} title="No bucket yet" description="Connect an Amazon S3 or Google Cloud Storage bucket you own. Vireek only needs permission to write files." action={{ label: 'Add a bucket', onClick: () => setTForm(blankTarget()) }} />
            ) : targets.map((t) => (
              <Card key={t.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="font-semibold text-text-primary">{t.name}</p>
                  <p className="text-xs text-text-secondary">{BI_PROVIDER_META[t.provider].label} · {t.bucket}{t.prefix ? `/${t.prefix}` : ''}{t.provider === 's3' ? ` · ${t.region}` : ''}</p>
                  {t.last_error && <p className="mt-1 text-xs text-danger">{t.last_error}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge cls={t.status === 'connected' ? STATUS_STYLE.success : t.status === 'error' ? STATUS_STYLE.failed : STATUS_STYLE.neutral}>{t.status === 'untested' ? 'Not tested' : t.status === 'connected' ? 'Connected' : 'Error'}</Badge>
                  <Button size="sm" variant="ghost" disabled={busy === `t${t.id}`} onClick={() => void act(`t${t.id}`, async () => { const r = await testTarget(t.id); toast(r.ok ? 'Connection works.' : r.error ?? 'Test failed.', r.ok ? 'success' : 'error'); await reload(true); })}>
                    {busy === `t${t.id}` ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}Test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setErrors({}); setFormError(null); setTForm({ id: t.id, name: t.name, provider: t.provider, bucket: t.bucket, region: t.region, prefix: t.prefix, access_key_id: t.access_key_id, secret: '' }); }}><Pencil size={16} /></Button>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${t.name}`} onClick={() => { if (window.confirm(`Delete ${t.name} and its schedules?`)) void act(`d${t.id}`, async () => { await deleteTarget(t.id); await reload(true); }); }}><Trash2 size={16} /></Button>
                </div>
              </Card>
            ))}
          </section>

          {targets.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-text-primary">Schedules</h2>
                <Button size="sm" onClick={() => { setErrors({}); setFormError(null); setSForm(blankSchedule(targets[0].id)); }}><Plus size={16} />New schedule</Button>
              </div>
              {schedules.length === 0 ? <p className="text-sm text-text-secondary">No schedule yet. Create one to start delivering files.</p> : schedules.map((s) => {
                const running = isRunning(s, now);
                return (
                  <Card key={s.id} className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-semibold text-text-primary">{s.name}</p>
                        <p className="text-xs text-text-secondary">{targetName(s.target_id)} · {BI_MODE_META[s.mode].label} · {intervalLabel(s.interval_minutes)} · {s.datasets.map((d) => DATASETS[d]?.label ?? d).join(', ')}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge cls={s.pii_mode === 'omit' ? STATUS_STYLE.neutral : STATUS_STYLE.partial}>{BI_PII_MODE_META[s.pii_mode].label}</Badge>
                        <Badge cls={running ? STATUS_STYLE.running : s.enabled ? STATUS_STYLE.success : STATUS_STYLE.neutral}>{running ? 'Running' : s.enabled ? 'Active' : 'Paused'}</Badge>
                        <Button size="sm" variant="ghost" disabled={running || busy === `r${s.id}`} onClick={() => void act(`r${s.id}`, async () => { await runScheduleNow(s.id); toast('Delivery started.', 'success'); await reload(true); })}><Play size={16} />Run now</Button>
                        <Button size="sm" variant="ghost" onClick={() => { setErrors({}); setFormError(null); setSForm({ id: s.id, name: s.name, target_id: s.target_id, datasets: s.datasets, mode: s.mode, pii_mode: s.pii_mode, interval_minutes: s.interval_minutes, enabled: s.enabled }); }}><Pencil size={16} /></Button>
                        <Button size="sm" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => { if (window.confirm(`Delete ${s.name}?`)) void act(`x${s.id}`, async () => { await deleteSchedule(s.id); await reload(true); }); }}><Trash2 size={16} /></Button>
                      </div>
                    </div>
                    <p className="text-xs text-text-secondary">Last success {timeAgo(s.last_success_at, now)} · next run {s.enabled ? new Date(s.next_run_at).toLocaleString() : 'paused'}</p>
                    {s.last_error && <p className="text-xs text-danger">{s.last_error}</p>}
                  </Card>
                );
              })}
            </section>
          )}

          <section className="space-y-3">
            <h2 className="text-lg font-semibold text-text-primary">Recent deliveries</h2>
            {runs.length === 0 ? <p className="text-sm text-text-secondary">Nothing delivered yet.</p> : (
              <Card className="divide-y divide-border">
                {runs.map((r) => {
                  const ds = Object.entries(r.stats.datasets ?? {});
                  return (
                    <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                      <div>
                        <p className="font-medium text-text-primary">{r.schedule_name || 'Deleted schedule'} <span className="text-xs text-text-secondary">· {r.trigger}</span></p>
                        <p className="text-xs text-text-secondary">{ds.length ? ds.map(([k, v]) => `${DATASETS[k as DatasetKey]?.label ?? k}: ${v.rows.toLocaleString()} rows`).join(' · ') : r.error ?? '—'}</p>
                        {r.error && ds.length > 0 && <p className="text-xs text-danger">{r.error}</p>}
                      </div>
                      <div className="flex items-center gap-3"><span className="text-xs text-text-secondary">{timeAgo(r.started_at, now)}</span><Badge cls={runStyle(r.status)}>{r.status}</Badge></div>
                    </div>
                  );
                })}
              </Card>
            )}
          </section>

          <Card className="space-y-3 p-5">
            <h3 className="text-base font-semibold text-text-primary">Verify what you receive</h3>
            <p className="text-sm text-text-secondary">Each table lands as <code>table/mode/dt=DATE/run=ID/part-0001.csv</code> followed by <code>manifest.json</code> (written last, so a folder without a manifest is incomplete). <code>table/mode/_latest.json</code> always points at the newest complete run.</p>
            <CodeBlock code={VERIFY_SNIPPET} />
            <Button size="sm" variant="ghost" disabled={busy === 'rot'} onClick={() => { if (window.confirm('Rotate the signing secret? Older manifests keep verifying with the old secret only.')) void act('rot', async () => { const r = await rotateSigningSecret(); setSecretShown(r.signing_secret); }); }}>Rotate signing secret</Button>
          </Card>
        </div>
      ) : (
        <div className="space-y-8">
          <Card className="space-y-3 p-5">
            <h2 className="text-lg font-semibold text-text-primary">Read-only logins</h2>
            <p className="text-sm text-text-secondary">A dedicated Postgres login that can only read your own rows through the views below. Revoke it any time. Personal columns are visible only if you tick the option and hold the permission.</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-64"><Input label="Label" value={readerLabel} onChange={(ev) => setReaderLabel(ev.target.value)} placeholder="Power BI gateway" maxLength={80} /></div>
              <Toggle checked={readerPii} onChange={setReaderPii} disabled={!piiOk} label="Allow personal data" />
              <Button size="sm" disabled={busy === 'cr'} onClick={() => void act('cr', async () => { setReader(await createReader(readerLabel, readerPii && piiOk)); setReaderLabel(''); await reload(true); })}>
                {busy === 'cr' ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}Create login
              </Button>
            </div>
            {reader && (
              <div className="space-y-3 rounded-xl border border-warning-500/40 p-4">
                <p className="text-sm font-semibold text-text-primary">Copy these now. The password is shown once.</p>
                <CodeBlock code={`Host: ${reader.host}\nPort: ${reader.port}\nDatabase: ${reader.database}\nUser: ${reader.role_name}\nPassword: ${reader.password}\n\nIf you connect through the Supabase pooler use this user instead: ${reader.pooler_user}`} />
                <CodeBlock code={powerBiQuery(reader.host, 'bi_jobs')} />
                <Button size="sm" variant="ghost" onClick={() => setReader(null)}>Done</Button>
              </div>
            )}
            {readers.map((r) => (
              <div key={r.role_name} className="flex items-center justify-between rounded-xl border border-border p-3 text-sm">
                <span><span className="font-mono">{r.role_name}</span> {r.label && `· ${r.label}`} · created {timeAgo(r.created_at, now)} {r.include_pii && <Badge cls={STATUS_STYLE.partial}>personal data</Badge>}</span>
                <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('Revoke this login? Connected tools stop working immediately.')) void act(`v${r.role_name}`, async () => { await revokeReader(r.role_name); await reload(true); }); }}><Trash2 size={16} />Revoke</Button>
              </div>
            ))}
          </Card>

          <Card className="space-y-3 p-5">
            <h2 className="text-lg font-semibold text-text-primary">View catalogue (contract v1)</h2>
            <p className="text-sm text-text-secondary">Stable names and columns. Views never contain personal columns; join <code>bi_pii_*</code> on <code>id</code> when permitted.</p>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="text-xs uppercase text-text-secondary"><th className="py-2 pr-4">View</th><th className="py-2 pr-4">Contents</th><th className="py-2">Personal view</th></tr></thead>
                <tbody>
                  {DATASET_KEYS.map((k) => (
                    <tr key={k} className="border-t border-border">
                      <td className="py-2 pr-4 font-mono text-xs">{biViewName(k)}</td>
                      <td className="py-2 pr-4 text-text-secondary">{DATASETS[k].description}</td>
                      <td className="py-2 font-mono text-xs">{hasPii(k) ? biPiiViewName(k) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div><CopyButton text={DATASET_KEYS.map((k) => biViewName(k)).join('\n')} label="Copy view names" /></div>
          </Card>
        </div>
      )}
    </DashboardLayout>
  );
}

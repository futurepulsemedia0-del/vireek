import { useState } from 'react';
import { KeyRound, Plus, ShieldCheck, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import { timeAgo } from '@/lib/dataPlatform';
import {
  ApiError, DATASETS, DATASET_KEYS, EXPIRY_OPTIONS, PII_MODES, PII_MODE_META, createToken, entitySetName, gatewayBase, revokeToken, tokenState,
  type BiToken, type DatasetKey, type PiiMode,
} from '@/lib/biConnectors';
import { Badge, CodeBlock, Field, SELECT, STATUS_STYLE } from '@/components/data-platform/ui';
import type { BiData } from './useBiData';

interface Props { data: BiData; isOwner: boolean }

const STATE_STYLE = { active: STATUS_STYLE.success, expired: STATUS_STYLE.partial, revoked: STATUS_STYLE.neutral } as const;

type Form = { name: string; datasets: DatasetKey[]; pii: PiiMode; rate: string; expiry: string };
const blank = (): Form => ({ name: '', datasets: ['jobs', 'customers', 'metrics_daily'], pii: 'hashed', rate: '60', expiry: '180' });

export function AccessTab({ data, isOwner }: Props) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<BiToken | null>(null);
  const base = gatewayBase();
  const toggle = (list: DatasetKey[], v: DatasetKey) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const nameOf = (id: string) => data.tokens.find((t) => t.id === id)?.name ?? 'Revoked token';

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!form) return;
    setErrors({});
    setFormError(null);
    if (!form.name.trim()) return setErrors({ name: 'Give the token a name, e.g. “Power BI – finance”.' });
    if (!form.datasets.length) return setErrors({ datasets: 'Choose at least one dataset.' });
    setSaving(true);
    try {
      const r = await createToken({
        name: form.name.trim(), datasets: form.datasets, pii_mode: form.pii, rate_limit_per_minute: Number(form.rate),
        expires_in_days: form.expiry === 'never' ? null : Number(form.expiry),
      });
      setSecret({ name: r.token.name, value: r.secret });
      setForm(null);
      await data.reload({ silent: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setFormError(Object.keys(err.fieldErrors).length ? null : err.message);
      } else setFormError('Could not create the token.');
    } finally {
      setSaving(false);
    }
  };

  const doRevoke = async () => {
    if (!confirm) return;
    try {
      await revokeToken(confirm.id);
      toast('Token revoked. Tools using it stopped working immediately.', 'success');
      await data.reload({ silent: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not revoke the token.', 'error');
    } finally {
      setConfirm(null);
    }
  };

  if (form) {
    return (
      <form onSubmit={submit} className="space-y-6" noValidate>
        <Card className="space-y-5 p-5 sm:p-6">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Create a read-only token</h2>
            <p className="mt-1 text-sm text-text-secondary">A token can only read the datasets you tick. It can never change anything in Vireek.</p>
          </div>
          {formError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{formError}</p>}
          <Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} required error={errors.name} placeholder="Power BI – finance" />
          <fieldset>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Datasets</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {DATASET_KEYS.map((k) => (
                <label key={k} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-bg-tertiary/60">
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={form.datasets.includes(k)} onChange={() => setForm({ ...form, datasets: toggle(form.datasets, k) })} />
                  <span>
                    <span className="block text-sm font-semibold text-text-primary">{DATASETS[k].label}</span>
                    <span className="block text-xs text-text-secondary">{DATASETS[k].description}</span>
                  </span>
                </label>
              ))}
            </div>
            {errors.datasets && <span role="alert" className="mt-1 block text-xs text-danger">{errors.datasets}</span>}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Personal data" error={errors.pii_mode} hint={PII_MODE_META[form.pii].description}>
              <select className={SELECT} value={form.pii} onChange={(e) => setForm({ ...form, pii: e.target.value as PiiMode })}>
                {PII_MODES.map((m) => <option key={m} value={m} disabled={m === 'full' && !isOwner}>{PII_MODE_META[m].label}{m === 'full' && !isOwner ? ' (owner only)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Expires" error={errors.expires_in_days}>
              <select className={SELECT} value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value })}>
                {EXPIRY_OPTIONS.map((o) => <option key={String(o.value)} value={o.value === null ? 'never' : String(o.value)}>{o.label}</option>)}
              </select>
            </Field>
            <Input label="Requests per minute" type="number" min={1} max={600} value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} error={errors.rate_limit_per_minute} />
          </div>
          <div className="flex flex-wrap justify-end gap-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => { setForm(null); setErrors({}); setFormError(null); }}>Cancel</Button>
            <Button type="submit" size="sm" disabled={saving}>{saving ? 'Creating…' : 'Create token'}</Button>
          </div>
        </Card>
      </form>
    );
  }

  return (
    <div className="space-y-6">
      {secret && (
        <Card className="space-y-3 border-warning-500/40 p-5 sm:p-6" role="status">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-text-primary">Copy your token now: “{secret.name}”</h2>
              <p className="mt-1 text-sm text-text-secondary">It is shown only once. Vireek stores a one-way hash, so it cannot be recovered. If you lose it, revoke it and create a new one.</p>
            </div>
            <button type="button" aria-label="Close" onClick={() => setSecret(null)} className="focus-ring rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary"><X size={18} /></button>
          </div>
          <CodeBlock code={secret.value} />
        </Card>
      )}

      <Card className="space-y-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-text-primary"><ShieldCheck size={18} className="text-accent" />Live read-only access</h2>
            <p className="mt-1 max-w-2xl text-sm text-text-secondary">Connect Power BI, Excel or Tableau straight to your Vireek data. Each token is scoped, rate-limited, expiring and revocable; every request is logged.</p>
          </div>
          <Button size="sm" onClick={() => { setSecret(null); setForm(blank()); }}><Plus size={16} />New token</Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">OData feed (Power BI, Excel, Tableau)</p><CodeBlock code={`${base}/odata/`} /></div>
          <div><p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">REST JSON / CSV (Airbyte, scripts)</p><CodeBlock code={`${base}/v1/${DATASET_KEYS[0]}?limit=1000`} /></div>
        </div>
      </Card>

      {data.tokens.length === 0 ? (
        <EmptyState icon={KeyRound} title="No tokens yet" description="Create a token, then paste it as the password in Power BI’s OData connector. See the Connection guides tab for exact steps." action={{ label: 'Create a token', onClick: () => setForm(blank()) }} />
      ) : (
        <ul className="space-y-3" aria-label="BI access tokens">
          {data.tokens.map((t) => {
            const st = tokenState(t, data.now);
            return (
              <li key={t.id}>
                <Card className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base font-semibold text-text-primary">{t.name}</h3>
                      <Badge cls={STATE_STYLE[st]}>{st === 'active' ? 'Active' : st === 'expired' ? 'Expired' : 'Revoked'}</Badge>
                      <code className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-secondary">{t.token_hint}</code>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      {t.datasets.map((d) => DATASETS[d]?.label ?? d).join(', ')} · {PII_MODE_META[t.pii_mode].label.replace(' (recommended)', '')} · {t.rate_limit_per_minute}/min ·{' '}
                      {t.expires_at ? `expires ${new Date(t.expires_at).toLocaleDateString()}` : 'never expires'} · last used {timeAgo(t.last_used_at, data.now)}
                    </p>
                    <p className="mt-0.5 text-xs text-text-secondary">Entity sets: {t.datasets.map(entitySetName).join(', ')}</p>
                  </div>
                  {st === 'active' && <Button variant="secondary" size="sm" onClick={() => setConfirm(t)}>Revoke</Button>}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {data.requests.length > 0 && (
        <Card className="space-y-3 p-5 sm:p-6">
          <h2 className="text-base font-semibold text-text-primary">Recent requests</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-text-secondary"><tr><th className="py-2 pr-4">When</th><th className="py-2 pr-4">Token</th><th className="py-2 pr-4">Dataset</th><th className="py-2 pr-4">Rows</th><th className="py-2">Status</th></tr></thead>
              <tbody>
                {data.requests.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="py-2 pr-4 text-text-secondary">{timeAgo(r.at, data.now)}</td>
                    <td className="py-2 pr-4 text-text-primary">{nameOf(r.token_id)}</td>
                    <td className="py-2 pr-4 text-text-primary">{r.dataset || '—'}</td>
                    <td className="py-2 pr-4 text-text-secondary">{r.rows ?? '—'}</td>
                    <td className="py-2"><Badge cls={r.status && r.status < 400 ? STATUS_STYLE.success : STATUS_STYLE.failed}>{r.status ?? '…'}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <ConfirmDialog open={!!confirm} title={`Revoke “${confirm?.name ?? ''}”?`} description="Every report or tool using this token will stop working immediately. This can’t be undone." confirmLabel="Yes, revoke it" onConfirm={doRevoke} onCancel={() => setConfirm(null)} />
    </div>
  );
}

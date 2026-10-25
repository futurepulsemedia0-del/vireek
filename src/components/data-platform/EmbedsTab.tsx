import { useState } from 'react';
import { KeyRound, Loader2, Pencil, Plus, RotateCw, Trash2, Code2, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { useToast } from '@/contexts/ToastContext';
import {
  ApiError,
  DIMENSIONS,
  DIMENSION_LABELS,
  METRICS,
  METRIC_IDS,
  browserTimeZone,
  createEmbed,
  embedSnippets,
  revokeEmbed,
  rotateEmbedSecret,
  timeAgo,
  updateEmbed,
  type Dimension,
  type EmbedConfig,
  type EmbedRow,
  type Granularity,
  type MetricId,
} from '@/lib/dataPlatform';
import { Badge, CodeBlock, CopyButton, Field, SELECT, STATUS_STYLE } from './ui';
import type { DestinationData } from './useDestinationData';

type Form = {
  id?: string;
  name: string;
  title: string;
  metrics: MetricId[];
  defaultDays: string;
  maxDays: string;
  granularity: Granularity;
  groupBy: Dimension[];
  locked: Record<Dimension, string>;
  mode: 'auto' | 'light' | 'dark';
  accent: string;
  rate: string;
};

const emptyLocked = (): Record<Dimension, string> => Object.fromEntries(DIMENSIONS.map((d) => [d, ''])) as Record<Dimension, string>;

const blank = (): Form => ({
  name: '',
  title: '',
  metrics: ['revenue', 'close_rate', 'gross_margin', 'response_time'],
  defaultDays: '30',
  maxDays: '90',
  granularity: 'day',
  groupBy: [],
  locked: emptyLocked(),
  mode: 'auto',
  accent: '#2563eb',
  rate: '60',
});

function fromEmbed(e: EmbedRow): Form {
  const locked = emptyLocked();
  for (const d of DIMENSIONS) locked[d] = (e.config.locked_filters?.[d] ?? []).join(', ');
  return {
    id: e.id,
    name: e.name,
    title: e.config.title,
    metrics: e.config.metrics,
    defaultDays: String(e.config.default_range_days),
    maxDays: String(e.config.max_range_days),
    granularity: e.config.granularity,
    groupBy: e.config.allowed_group_by,
    locked,
    mode: e.config.theme.mode,
    accent: e.config.theme.accent,
    rate: String(e.rate_limit_per_minute),
  };
}

function toConfig(f: Form): Partial<EmbedConfig> {
  const locked_filters: Partial<Record<Dimension, string[]>> = {};
  for (const d of DIMENSIONS) {
    const values = f.locked[d].split(',').map((v) => v.trim()).filter(Boolean);
    if (values.length) locked_filters[d] = values;
  }
  return {
    title: f.title,
    metrics: f.metrics,
    default_range_days: Number(f.defaultDays),
    max_range_days: Number(f.maxDays),
    granularity: f.granularity,
    allowed_group_by: f.groupBy,
    locked_filters,
    tz: browserTimeZone(),
    theme: { mode: f.mode, accent: f.accent },
  };
}

const functionsBase = () => `${String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '')}/functions/v1`;

export function EmbedsTab({ data }: { data: DestinationData }) {
  const { toast } = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [secret, setSecret] = useState<{ embedId: string; value: string } | null>(null);
  const [snippetsFor, setSnippetsFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'revoke' | 'rotate'; embed: EmbedRow } | null>(null);

  const editing = !!form?.id;
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!form) return;
    if (!form.name.trim()) return setFormError('Give the embed a name.');
    if (!form.metrics.length) return setFormError('Choose at least one metric to share.');
    setSaving(true);
    setFormError(null);
    try {
      if (form.id) {
        await updateEmbed(form.id, { name: form.name, config: toConfig(form), rate_limit_per_minute: Number(form.rate) });
        toast('Embed updated. Existing tokens pick up the change immediately.', 'success');
      } else {
        const r = await createEmbed(form.name, toConfig(form), Number(form.rate));
        setSecret({ embedId: r.embed.id, value: r.signing_secret });
        setSnippetsFor(r.embed.id);
      }
      setForm(null);
      await data.reload({ silent: true });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Could not save the embed.');
    } finally {
      setSaving(false);
    }
  };

  const doConfirm = async () => {
    if (!confirm) return;
    const { kind, embed } = confirm;
    try {
      if (kind === 'revoke') {
        await revokeEmbed(embed.id);
        toast('Embed revoked. All of its tokens stopped working.', 'success');
      } else {
        const r = await rotateEmbedSecret(embed.id);
        setSecret({ embedId: embed.id, value: r.signing_secret });
        setSnippetsFor(embed.id);
      }
      await data.reload({ silent: true });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Something went wrong.', 'error');
    } finally {
      setConfirm(null);
    }
  };

  if (form) {
    return (
      <form onSubmit={submit} className="space-y-6" noValidate>
        <Card className="space-y-5 p-5 sm:p-6">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">{editing ? `Edit ${form.name}` : 'Create an embed'}</h2>
            <p className="mt-1 text-sm text-text-secondary">Share a read-only analytics view with a partner. Viewers can never see more than what you tick here.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Name (internal)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} required />
            <Input label="Title shown to viewers" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={80} placeholder="Performance" />
          </div>

          <fieldset>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Metrics</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {METRIC_IDS.map((m) => (
                <label key={m} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 hover:bg-bg-tertiary/60">
                  <input type="checkbox" className="mt-1 h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={form.metrics.includes(m)} onChange={() => setForm({ ...form, metrics: toggle(form.metrics, m) })} />
                  <span>
                    <span className="block text-sm font-semibold text-text-primary">{METRICS[m].label}</span>
                    <span className="block text-xs text-text-secondary">{METRICS[m].description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-3">
            <Input label="Default range (days)" type="number" min={1} max={400} value={form.defaultDays} onChange={(e) => setForm({ ...form, defaultDays: e.target.value })} />
            <Input label="Longest range (days)" type="number" min={7} max={400} value={form.maxDays} onChange={(e) => setForm({ ...form, maxDays: e.target.value })} helperText="Viewers can't look back further." />
            <Field label="Chart granularity">
              <select className={SELECT} value={form.granularity} onChange={(e) => setForm({ ...form, granularity: e.target.value as Granularity })}>
                <option value="day">Daily</option>
                <option value="week">Weekly</option>
                <option value="month">Monthly</option>
                <option value="none">Totals only</option>
              </select>
            </Field>
          </div>

          <fieldset>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Breakdowns viewers may use</legend>
            <div className="flex flex-wrap gap-4">
              {DIMENSIONS.map((d) => (
                <label key={d} className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
                  <input type="checkbox" className="h-4 w-4 accent-[rgb(var(--accent-primary))]" checked={form.groupBy.includes(d)} onChange={() => setForm({ ...form, groupBy: toggle(form.groupBy, d) })} />
                  {DIMENSION_LABELS[d]}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">Locked filters (optional)</legend>
            <p className="mb-3 text-xs text-text-secondary">Always applied, even if the token asks for more. Separate several values with commas. Only metrics that can be broken down by these fields can be shared with a lock.</p>
            <div className="grid gap-4 sm:grid-cols-3">
              {DIMENSIONS.map((d) => (
                <Input key={d} label={DIMENSION_LABELS[d]} value={form.locked[d]} onChange={(e) => setForm({ ...form, locked: { ...form.locked, [d]: e.target.value } })} placeholder="e.g. Plumbing, HVAC" />
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Theme">
              <select className={SELECT} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as Form['mode'] })}>
                <option value="auto">Match the viewer</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </Field>
            <Field label="Accent colour">
              <input type="color" value={form.accent} onChange={(e) => setForm({ ...form, accent: e.target.value })} className="focus-ring h-11 w-full cursor-pointer rounded-xl border border-border bg-bg-primary p-1" aria-label="Accent colour" />
            </Field>
            <Input label="Requests per minute" type="number" min={1} max={600} value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} helperText="Per embed, across all viewers." />
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
            {editing ? 'Save changes' : 'Create embed'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setForm(null)} disabled={saving}>
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const visible = data.embeds;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-secondary">
          Signed embedded analytics for your partners. Your server mints a short-lived token per viewer; the browser never sees a long-lived secret.
        </p>
        {visible.length > 0 && (
          <Button size="sm" onClick={() => { setFormError(null); setForm(blank()); }}>
            <Plus size={16} />
            New embed
          </Button>
        )}
      </div>

      {secret && (
        <Card className="space-y-3 border-warning-500/40 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary">
                <KeyRound size={18} /> Signing secret — copy it now
              </h3>
              <p className="mt-1 text-sm text-text-secondary">It is shown only once. Store it on your server (for example as <code>VIREEK_EMBED_SECRET</code>). If you lose it, rotate it.</p>
            </div>
            <button type="button" onClick={() => setSecret(null)} className="focus-ring rounded-lg p-1 text-text-secondary hover:bg-bg-tertiary" aria-label="Dismiss">
              <X size={18} />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary">{secret.value}</code>
            <CopyButton text={secret.value} />
          </div>
        </Card>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={Code2}
          title="No embeds yet"
          description="Create an embed, pick the metrics a partner may see, then sign a token on your server and drop the link in an iframe."
          action={{ label: 'Create an embed', onClick: () => { setFormError(null); setForm(blank()); } }}
        />
      ) : (
        visible.map((e) => (
          <Card key={e.id} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="truncate text-base font-semibold text-text-primary">{e.name}</h3>
                  <Badge cls={e.status === 'active' ? STATUS_STYLE.success : STATUS_STYLE.neutral}>{e.status === 'active' ? 'Active' : 'Revoked'}</Badge>
                </div>
                <p className="mt-1 text-sm text-text-secondary">
                  {e.config.metrics.map((m) => METRICS[m]?.label ?? m).join(', ')} · up to {e.config.max_range_days} days · {e.rate_limit_per_minute}/min · last used {timeAgo(e.last_used_at, data.now)}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-text-secondary">ID {e.id}</p>
              </div>
              {e.status === 'active' && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setSnippetsFor(snippetsFor === e.id ? null : e.id)}>
                    <Code2 size={16} />
                    Integrate
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => { setFormError(null); setForm(fromEmbed(e)); }} aria-label={`Edit ${e.name}`}>
                    <Pencil size={16} />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'rotate', embed: e })} aria-label={`Rotate secret of ${e.name}`}>
                    <RotateCw size={16} />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm({ kind: 'revoke', embed: e })} aria-label={`Revoke ${e.name}`}>
                    <Trash2 size={16} className="text-danger" />
                  </Button>
                </div>
              )}
            </div>

            {snippetsFor === e.id && e.status === 'active' && (() => {
              const s = embedSnippets(functionsBase(), origin, e.id);
              return (
                <div className="mt-4 space-y-4">
                  <div>
                    <h4 className="mb-1.5 text-sm font-semibold text-text-primary">1. Sign a token on your server (Node.js)</h4>
                    <CodeBlock code={s.node} />
                  </div>
                  <div>
                    <h4 className="mb-1.5 text-sm font-semibold text-text-primary">…or in Python</h4>
                    <CodeBlock code={s.python} />
                  </div>
                  <div>
                    <h4 className="mb-1.5 text-sm font-semibold text-text-primary">2. Show it</h4>
                    <CodeBlock code={s.html} />
                  </div>
                </div>
              );
            })()}
          </Card>
        ))
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === 'revoke' ? `Revoke ${confirm.embed.name}?` : `Rotate the secret of ${confirm?.embed.name ?? ''}?`}
        description={
          confirm?.kind === 'revoke'
            ? 'Every token for this embed stops working immediately. This cannot be undone.'
            : 'A new signing secret is created and the old one stops working. Tokens signed with the old secret fail until your server uses the new one.'
        }
        confirmLabel={confirm?.kind === 'revoke' ? 'Revoke embed' : 'Rotate secret'}
        onConfirm={doConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

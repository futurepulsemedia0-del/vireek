import { useMemo, useState } from 'react';
import { Flag, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { FlagDetailPanel } from '@/components/staff/FlagDetailPanel';
import { ErrorState, Pill, Section, formatDateTime, useLoader } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { createFlag, deleteFlag, listFlags, updateFlag } from '@/lib/featureFlagsApi';
import {
  EMPTY_FLAG_FORM, describeFlag, describeReach, flagToForm, parseFlagForm, suggestFlagKey,
  type FeatureFlag, type FieldErrors, type FlagFormValues,
} from '@/lib/featureFlags';
import { useSEO } from '@/lib/seo';

function SEO() {
  useSEO({
    title: 'Feature Flags — Staff',
    description: 'Internal: per-tenant feature flags and staged rollouts.',
    canonical: 'https://vireek.com/staff/feature-flags',
  });
  return null;
}

type FormState = null | { mode: 'create' } | { mode: 'edit'; flag: FeatureFlag };

export function FeatureFlagsAdminPage() {
  const { toast } = useToast();
  const flags = useLoader(listFlags, 'flags');

  const [formState, setFormState] = useState<FormState>(null);
  const [form, setForm] = useState<FlagFormValues>(EMPTY_FLAG_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [keyTouched, setKeyTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingOff, setPendingOff] = useState<FeatureFlag | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FeatureFlag | null>(null);
  const [search, setSearch] = useState('');

  const rows = flags.data ?? [];
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rows.filter((f) => f.name.toLowerCase().includes(q) || f.key.includes(q)) : rows;
  }, [rows, search]);

  const openCreate = () => { setForm(EMPTY_FLAG_FORM); setErrors({}); setKeyTouched(false); setFormState({ mode: 'create' }); };
  const openEdit = (flag: FeatureFlag) => { setForm(flagToForm(flag)); setErrors({}); setKeyTouched(true); setFormState({ mode: 'edit', flag }); };
  const closeForm = () => { setFormState(null); setErrors({}); };

  const setField = <K extends keyof FlagFormValues>(k: K, v: FlagFormValues[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((prev) => ({ ...prev, [k]: '' }));
  };

  const onName = (name: string) => {
    setForm((f) => ({ ...f, name, key: formState?.mode === 'create' && !keyTouched ? suggestFlagKey(name) : f.key }));
    if (errors.name) setErrors((prev) => ({ ...prev, name: '' }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving || !formState) return;
    const parsed = parseFlagForm(form);
    if (!parsed.ok) { setErrors(parsed.errors); return; }
    setSaving(true);
    try {
      if (formState.mode === 'create') {
        await createFlag(parsed.value);
        toast('Flag created.', 'success');
      } else {
        const { key: _key, ...patch } = parsed.value; // the key is immutable
        void _key;
        await updateFlag(formState.flag.id, patch);
        toast('Flag updated.', 'success');
      }
      closeForm();
      await flags.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the flag.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const setEnabled = async (flag: FeatureFlag, enabled: boolean) => {
    setBusyId(flag.id);
    try {
      await updateFlag(flag.id, { enabled });
      toast(`${flag.name}: master switch ${enabled ? 'on' : 'off'}.`, 'success');
      await flags.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not update the flag.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const onToggle = (flag: FeatureFlag) => {
    // Turning a live flag off changes what customers see right now: confirm first.
    if (flag.enabled && flag.reach_tenants > 0) setPendingOff(flag);
    else void setEnabled(flag, !flag.enabled);
  };

  const onDelete = async () => {
    const target = pendingDelete;
    setPendingDelete(null);
    if (!target) return;
    try {
      await deleteFlag(target.id);
      toast(`${target.key} deleted.`, 'success');
      if (selectedId === target.id) setSelectedId(null);
      await flags.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not delete the flag.', 'error');
    }
  };

  const pct = Number(form.rollout_pct);
  const sliderValue = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0;

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-6 pb-20 pt-28">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Flag className="text-accent" size={22} />
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">Feature Flags</h1>
            </div>
            <Button size="sm" onClick={openCreate} disabled={formState?.mode === 'create'}><Plus size={16} /> New flag</Button>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-text-secondary">
            Roll features out to a percentage of tenants, or force them on or off for individual tenants. Flags are evaluated on the server and read by the app with <code className="text-xs">useFeatureFlag(key)</code>.
          </p>

          {formState && (
            <div className="mt-6">
              <Section title={formState.mode === 'create' ? 'New flag' : `Edit ${formState.flag.key}`}>
                <form onSubmit={submit} noValidate className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Input label="Name" required value={form.name} onChange={(e) => onName(e.target.value)} error={errors.name || undefined} maxLength={80} placeholder="New dashboard" />
                    <Input
                      label="Key"
                      required
                      value={form.key}
                      onChange={(e) => { setKeyTouched(true); setField('key', e.target.value); }}
                      error={errors.key || undefined}
                      disabled={formState.mode === 'edit'}
                      maxLength={64}
                      autoCapitalize="none"
                      spellCheck={false}
                      helperText={formState.mode === 'edit' ? 'Keys cannot be changed: code refers to them.' : 'Used in code. Lowercase letters, digits and underscores.'}
                    />
                  </div>
                  <Textarea label="Description" rows={2} value={form.description} onChange={(e) => setField('description', e.target.value)} error={errors.description || undefined} maxLength={500} />

                  <div>
                    <label htmlFor="flag-rollout" className="mb-1.5 block text-sm font-medium text-text-primary">Rollout: {sliderValue}% of tenants</label>
                    <div className="flex items-center gap-4">
                      <input id="flag-rollout" type="range" min={0} max={100} step={1} value={sliderValue} onChange={(e) => setField('rollout_pct', e.target.value)} className="focus-ring h-2 w-full cursor-pointer accent-accent" aria-describedby="flag-rollout-help" />
                      <div className="w-24 shrink-0">
                        <Input aria-label="Rollout percentage" type="number" inputMode="numeric" min={0} max={100} value={form.rollout_pct} onChange={(e) => setField('rollout_pct', e.target.value)} error={errors.rollout_pct || undefined} />
                      </div>
                    </div>
                    <p id="flag-rollout-help" className="mt-1.5 text-xs text-text-secondary">Tenants are bucketed by a stable hash: raising the percentage only adds tenants, and nobody flips back and forth.</p>
                  </div>

                  <label className="flex items-start gap-2 text-sm text-text-primary">
                    <input type="checkbox" checked={form.enabled} onChange={(e) => setField('enabled', e.target.checked)} className="mt-1" />
                    <span>Master switch on <span className="text-text-secondary">— when off, the flag is off for every tenant and overrides are ignored.</span></span>
                  </label>

                  <div className="flex justify-end gap-3">
                    <Button type="button" variant="ghost" size="sm" onClick={closeForm} disabled={saving}>Cancel</Button>
                    <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : formState.mode === 'create' ? 'Create flag' : 'Save changes'}</Button>
                  </div>
                </form>
              </Section>
            </div>
          )}

          <div className="mt-6">
            {flags.loading && !flags.data ? (
              <SkeletonCardList count={3} rows={2} />
            ) : flags.error && !flags.data ? (
              <ErrorState message={flags.error} onRetry={flags.reload} />
            ) : rows.length === 0 ? (
              formState ? null : <EmptyState icon={Flag} title="No feature flags" description="Create a flag to ship a feature to a few tenants first, then widen the rollout." action={{ label: 'New flag', onClick: openCreate }} />
            ) : (
              <>
                {flags.error && (
                  <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
                    <span>Couldn't refresh: {flags.error}</span>
                    <Button size="sm" variant="ghost" onClick={flags.reload}>Retry</Button>
                  </div>
                )}
                <div className="mb-4 max-w-sm">
                  <Input label="Search" icon={Search} placeholder="Name or key" value={search} onChange={(e) => setSearch(e.target.value)} />
                </div>

                {visible.length === 0 ? (
                  <EmptyState icon={Search} title="No flags match" description="Try a different name or key." action={{ label: 'Clear search', onClick: () => setSearch('') }} />
                ) : (
                  <ul className="space-y-3">
                    {visible.map((f) => {
                      const d = describeFlag(f);
                      const open = selectedId === f.id;
                      const busy = busyId === f.id;
                      return (
                        <li key={f.id} className="rounded-2xl border border-border bg-bg-secondary p-4 sm:p-5">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h2 className="break-words text-base font-semibold text-text-primary">{f.name}</h2>
                                <Pill tone={d.tone}>{d.label}</Pill>
                              </div>
                              <p className="mt-0.5 break-all font-mono text-xs text-text-secondary">{f.key}</p>
                              {f.description && <p className="mt-1.5 break-words text-sm text-text-secondary">{f.description}</p>}
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={f.enabled}
                              aria-label={`Master switch for ${f.name}`}
                              disabled={busy}
                              onClick={() => onToggle(f)}
                              className={`focus-ring relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${f.enabled ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}
                            >
                              <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${f.enabled ? 'translate-x-6 rtl:-translate-x-6' : 'translate-x-1 rtl:-translate-x-1'}`} />
                            </button>
                          </div>

                          <div className="mt-4">
                            <div role="progressbar" aria-label={`Rollout target for ${f.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={f.rollout_pct} className="h-2 overflow-hidden rounded-full bg-bg-tertiary">
                              <div className={`h-full rounded-full bg-accent transition-all ${f.enabled ? '' : 'opacity-30'}`} style={{ width: `${f.rollout_pct}%` }} />
                            </div>
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-text-secondary">
                              <span>{f.enabled ? `Target ${f.rollout_pct}%` : 'Switched off'} · reaching {describeReach(f)}</span>
                              <span>{f.on_overrides} forced on · {f.off_overrides} forced off · updated {formatDateTime(f.updated_at)}</span>
                            </div>
                          </div>

                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button size="sm" variant="secondary" onClick={() => openEdit(f)}><Pencil size={16} /> Edit</Button>
                            <Button size="sm" variant="ghost" onClick={() => setSelectedId(open ? null : f.id)} aria-expanded={open}>{open ? 'Hide tenants & history' : 'Tenants & history'}</Button>
                            <Button size="sm" variant="ghost" onClick={() => setPendingDelete(f)} aria-label={`Delete ${f.name}`}><Trash2 size={16} /></Button>
                          </div>

                          {open && <FlagDetailPanel flag={f} onChanged={flags.reload} />}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      </main>

      <ConfirmDialog
        open={pendingOff !== null}
        title={`Turn off ${pendingOff?.name ?? 'this flag'}?`}
        description={pendingOff ? `It is currently on for ${describeReach(pendingOff)}. Turning the master switch off disables it for all of them immediately, including tenants forced on.` : ''}
        confirmLabel="Turn off"
        onCancel={() => setPendingOff(null)}
        onConfirm={async () => {
          const target = pendingOff;
          setPendingOff(null);
          if (target) await setEnabled(target, false);
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete ${pendingDelete?.name ?? 'this flag'}?`}
        description="Its tenant overrides are removed too, and any code reading this key will see it as off. History is kept."
        confirmPhrase={pendingDelete?.key}
        confirmLabel="Delete flag"
        onCancel={() => setPendingDelete(null)}
        onConfirm={onDelete}
      />
    </>
  );
}

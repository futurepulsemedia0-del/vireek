import { FormEvent, useEffect, useMemo, useState } from 'react';
import { KeyRound, Search } from 'lucide-react';
import { Header } from '@/components/Header';
import { Button } from '@/components/ui/Button';
import { Input, Textarea, fieldBase, fieldBorder } from '@/components/ui/Input';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { ErrorState, Pill, Section, formatDateTime, useLoader } from '@/components/vehicles/shared';
import { useToast } from '@/contexts/ToastContext';
import { searchTenants } from '@/lib/featureFlagsApi';
import { tenantLabel, type TenantHit } from '@/lib/featureFlags';
import { listAccountEntitlements, listEntitlementAudit, setEntitlement } from '@/lib/entitlementsApi';
import {
  EMPTY_ENTITLEMENT_FORM, ENTITLEMENT_SOURCES, ENTITLEMENT_STATES, FIXED_MODULE_IDS, describeAuditEntry, describeEntitlement,
  moduleLabel, parseEntitlementForm, type EntitlementFormValues, type EntitlementPayload, type FieldErrors, type StaffEntitlement,
} from '@/lib/entitlements';
import { useSEO } from '@/lib/seo';

function SEO() {
  useSEO({ title: 'Module entitlements — Staff', description: 'Internal: grant or revoke modules per account.', canonical: 'https://vireek.com/staff/entitlements' });
  return null;
}

const toLocalInput = (iso: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function EntitlementsAdminPage() {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TenantHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [tenant, setTenant] = useState<TenantHit | null>(null);

  const [form, setForm] = useState<EntitlementFormValues>(EMPTY_ENTITLEMENT_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<EntitlementPayload | null>(null);

  const tenantId = tenant?.id ?? null;
  const rows = useLoader(() => (tenantId ? listAccountEntitlements(tenantId) : Promise.resolve([] as StaffEntitlement[])), `rows:${tenantId}`);
  const audit = useLoader(() => (tenantId ? listEntitlementAudit(tenantId) : Promise.resolve([])), `audit:${tenantId}`);

  // Debounced tenant search (the RPC needs 2+ characters).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setHits([]); setSearchError(null); return; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchTenants(q)
        .then((r) => { if (!cancelled) { setHits(r); setSearchError(null); } })
        .catch((e: unknown) => { if (!cancelled) setSearchError(e instanceof Error ? e.message : 'Search failed.'); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  const byModule = useMemo(() => new Map((rows.data ?? []).map((r) => [r.module_id, r])), [rows.data]);
  const moduleIds = useMemo(() => {
    const extra = (rows.data ?? []).map((r) => r.module_id).filter((id) => !(FIXED_MODULE_IDS as readonly string[]).includes(id));
    return [...FIXED_MODULE_IDS, ...extra];
  }, [rows.data]);

  function pick(t: TenantHit) {
    setTenant(t);
    setForm(EMPTY_ENTITLEMENT_FORM);
    setErrors({});
  }

  function prefill(moduleId: string, state: EntitlementFormValues['state']) {
    const cur = byModule.get(moduleId);
    setForm({
      module_id: moduleId,
      state,
      source: cur?.source ?? 'manual',
      expires_local: state === 'off' ? '' : toLocalInput(cur?.expires_at ?? null),
      reason: '',
    });
    setErrors({});
    document.getElementById('ent-reason')?.focus();
  }

  async function commit(p: EntitlementPayload) {
    if (!tenantId) return;
    setSaving(true);
    try {
      await setEntitlement(tenantId, p);
      toast(`${moduleLabel(p.module_id)} set to ${p.state}.`, 'success');
      setForm((f) => ({ ...f, reason: '' }));
      await Promise.all([rows.reload(), audit.reload()]);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the change.', 'error');
    } finally {
      setSaving(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const r = parseEntitlementForm(form, Date.now());
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors({});
    // Turning a module off, or touching core, always asks first.
    if (r.value.state === 'off' || r.value.module_id === 'core') setPending(r.value);
    else void commit(r.value);
  }

  const set = <K extends keyof EntitlementFormValues>(k: K, v: EntitlementFormValues[K]) => setForm((f) => ({ ...f, [k]: v }));
  const selectCls = `${fieldBase} ${fieldBorder(false)}`;

  return (
    <>
      <SEO />
      <Header />
      <main className="min-h-screen bg-bg-primary px-4 pb-20 pt-28 sm:px-6">
        <div className="mx-auto max-w-5xl space-y-6">
          <div>
            <div className="flex items-center gap-2">
              <KeyRound className="text-accent" size={22} aria-hidden="true" />
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">Module entitlements</h1>
            </div>
            <p className="mt-2 max-w-2xl text-sm text-text-secondary">
              Grant or revoke modules per account. Default is off. Every change needs a reason and is saved in an append-only history.
              Release switches live in <a className="underline" href="/staff/feature-flags">Feature flags</a>.
            </p>
          </div>

          <Section title="Find an account">
            <Input id="ent-search" label="Email, company or name" icon={Search} value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" spellCheck={false} helperText="Type at least 2 characters." />
            <div aria-live="polite" className="mt-3">
              {searching && <p className="text-sm text-text-secondary">Searching…</p>}
              {searchError && <p role="alert" className="text-sm text-danger">{searchError}</p>}
              {!searching && !searchError && query.trim().length >= 2 && hits.length === 0 && <p className="text-sm text-text-secondary">No matching accounts.</p>}
              {hits.length > 0 && (
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {hits.map((h) => (
                    <li key={h.id}>
                      <button type="button" onClick={() => pick(h)} aria-pressed={tenantId === h.id}
                        className="focus-ring flex min-h-11 w-full flex-wrap items-center justify-between gap-2 px-4 py-2 text-left hover:bg-bg-primary">
                        <span className="text-sm font-medium text-text-primary">{tenantLabel(h)}</span>
                        <span className="text-xs text-text-secondary">{h.email}{h.plan ? ` · ${h.plan}` : ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Section>

          {!tenant && <EmptyState icon={KeyRound} title="Pick an account" description="Search above to see and change which modules it has." compact />}

          {tenant && (
            <>
              <Section title={`Modules · ${tenantLabel(tenant)}`}>
                {rows.loading && !rows.data ? <SkeletonCardList count={3} /> : rows.error ? <ErrorState message={rows.error} onRetry={rows.reload} /> : (
                  <ul className="divide-y divide-border">
                    {moduleIds.map((id) => {
                      const r = byModule.get(id);
                      const d = r ? describeEntitlement(r, Date.now()) : { label: 'Off', tone: 'neutral' as const };
                      return (
                        <li key={id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-text-primary">{moduleLabel(id)}</span>
                              <Pill tone={d.tone}>{d.label}</Pill>
                              {r && <span className="text-xs text-text-secondary">{r.source}{r.expires_at ? ` · until ${formatDateTime(r.expires_at)}` : ''}</span>}
                            </div>
                            {r?.reason && <p className="mt-1 text-xs text-text-secondary">{r.reason}{r.updated_by_email ? ` — ${r.updated_by_email}` : ''}</p>}
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" variant="secondary" onClick={() => prefill(id, 'on')}>Edit</Button>
                            <Button size="sm" variant="ghost" onClick={() => prefill(id, 'off')} disabled={!r || r.state === 'off'} disabledReason="Already off">Revoke</Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Section>

              <Section title="Grant, change or revoke">
                <form onSubmit={submit} noValidate className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <Input id="ent-module" label="Module" required list="ent-modules" value={form.module_id} onChange={(e) => set('module_id', e.target.value)} error={errors.module_id || undefined}
                        autoCapitalize="none" spellCheck={false} helperText="Pick one, or type packs:<slug>." />
                      <datalist id="ent-modules">{FIXED_MODULE_IDS.map((m) => <option key={m} value={m} />)}</datalist>
                    </div>
                    <div>
                      <label htmlFor="ent-state" className="mb-1.5 block text-sm font-medium text-text-primary">State</label>
                      <select id="ent-state" className={selectCls} value={form.state} onChange={(e) => set('state', e.target.value as EntitlementFormValues['state'])}>
                        {ENTITLEMENT_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      {errors.state && <p role="alert" className="mt-1 text-xs text-danger">{errors.state}</p>}
                    </div>
                    <div>
                      <label htmlFor="ent-source" className="mb-1.5 block text-sm font-medium text-text-primary">Source</label>
                      <select id="ent-source" className={selectCls} value={form.source} onChange={(e) => set('source', e.target.value as EntitlementFormValues['source'])}>
                        {ENTITLEMENT_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      {errors.source && <p role="alert" className="mt-1 text-xs text-danger">{errors.source}</p>}
                    </div>
                    <Input id="ent-expires" type="datetime-local" label={form.state === 'trial' ? 'Expires (required for a trial)' : 'Expires (optional)'} value={form.expires_local}
                      onChange={(e) => set('expires_local', e.target.value)} disabled={form.state === 'off'} error={errors.expires_local || undefined} />
                  </div>
                  <Textarea id="ent-reason" label="Reason (saved in the audit log)" required value={form.reason} onChange={(e) => set('reason', e.target.value)} error={errors.reason || undefined} maxLength={300} rows={2} />
                  <Button type="submit" loading={saving} loadingLabel="Saving…">Save</Button>
                </form>
              </Section>

              <Section title="History">
                {audit.loading && !audit.data ? <SkeletonCardList count={2} /> : audit.error ? <ErrorState message={audit.error} onRetry={audit.reload} /> :
                  (audit.data ?? []).length === 0 ? <EmptyState title="No changes yet" description="Grants and revokes for this account will appear here." compact /> : (
                    <ul className="divide-y divide-border">
                      {(audit.data ?? []).map((a) => (
                        <li key={a.id} className="py-2.5">
                          <p className="text-sm text-text-primary">{describeAuditEntry(a)}</p>
                          <p className="text-xs text-text-secondary">{formatDateTime(a.created_at)} · {a.actor_email ?? 'system'}{a.reason ? ` · ${a.reason}` : ''}</p>
                        </li>
                      ))}
                    </ul>
                  )}
              </Section>
            </>
          )}
        </div>
      </main>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.state === 'off' ? `Turn off ${pending ? moduleLabel(pending.module_id) : ''}?` : 'Change core?'}
        description={pending?.state === 'off'
          ? 'The account loses access to this module right away. Its data is kept.'
          : 'Core is included with every account. Double-check this change.'}
        confirmLabel={pending?.state === 'off' ? 'Turn off' : 'Apply'}
        onCancel={() => setPending(null)}
        onConfirm={async () => { const p = pending; setPending(null); if (p) await commit(p); }}
      />
    </>
  );
}

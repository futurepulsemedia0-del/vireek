import { useEffect, useState } from 'react';
import { Users, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { listAudit, listOverrides, searchTenants, setOverride } from '@/lib/featureFlagsApi';
import { describeAuditEntry, parseOverrideNote, tenantLabel, type FeatureFlag, type OverrideState, type TenantHit } from '@/lib/featureFlags';
import { ErrorState, Pill, Section, SelectField, formatDateTime, useLoader } from '@/components/vehicles/shared';

interface Props {
  flag: FeatureFlag;
  /** Reload the flag list (override counts and real reach change after an edit). */
  onChanged: () => void;
}

export function FlagDetailPanel({ flag, onChanged }: Props) {
  const { toast } = useToast();
  const overrides = useLoader(() => listOverrides(flag.id), flag.id);
  const audit = useLoader(() => listAudit(flag.key), `${flag.key}:${flag.updated_at}`);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<TenantHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [picked, setPicked] = useState<TenantHit | null>(null);
  const [state, setState] = useState<OverrideState>('on');
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // Debounced tenant search; a newer keystroke cancels the previous request's result.
  useEffect(() => {
    const q = query.trim();
    if (picked || q.length < 2) { setHits([]); setSearching(false); setSearchError(''); return; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const result = await searchTenants(q);
        if (!cancelled) { setHits(result); setSearchError(''); }
      } catch (e) {
        if (!cancelled) setSearchError(e instanceof Error ? e.message : 'Search failed.');
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, picked]);

  const refresh = () => { void overrides.reload(); void audit.reload(); onChanged(); };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!picked || saving) return;
    const parsed = parseOverrideNote(note);
    if (!parsed.ok) { setNoteError(parsed.errors.note); return; }
    setSaving(true);
    try {
      await setOverride(flag.id, picked.id, state, parsed.value);
      toast(`${tenantLabel(picked)}: forced ${state}.`, 'success');
      setPicked(null); setQuery(''); setNote(''); setNoteError('');
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save the override.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (tenantId: string, label: string) => {
    setRemoving(tenantId);
    try {
      await setOverride(flag.id, tenantId, 'inherit', null);
      toast(`Override removed for ${label}.`, 'success');
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove the override.', 'error');
    } finally {
      setRemoving(null);
    }
  };

  const rows = overrides.data ?? [];

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      <Section title="Tenant overrides">
        <p className="mb-4 text-xs text-text-secondary">
          Force this flag on or off for one tenant, regardless of the rollout. The master switch still wins: with it off, nobody gets the flag.
        </p>

        <form onSubmit={save} noValidate className="mb-5 space-y-3">
          {picked ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-bg-primary px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text-primary">{tenantLabel(picked)}</p>
                <p className="truncate text-xs text-text-secondary">{picked.email}{picked.plan ? ` · ${picked.plan}` : ''}</p>
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPicked(null)} aria-label="Choose a different tenant"><X size={16} /></Button>
            </div>
          ) : (
            <div>
              <Input label="Find a tenant" placeholder="Company, name or email (2+ characters)" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" error={searchError || undefined} />
              <div aria-live="polite" className="mt-2">
                {searching && <p className="text-xs text-text-secondary">Searching…</p>}
                {!searching && query.trim().length >= 2 && !searchError && hits.length === 0 && <p className="text-xs text-text-secondary">No tenants match “{query.trim()}”.</p>}
                {hits.length > 0 && (
                  <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
                    {hits.map((h) => (
                      <li key={h.id}>
                        <button type="button" onClick={() => { setPicked(h); setHits([]); }} className="focus-ring w-full px-4 py-2.5 text-start hover:bg-bg-tertiary">
                          <span className="block truncate text-sm font-medium text-text-primary">{tenantLabel(h)}</span>
                          <span className="block truncate text-xs text-text-secondary">{h.email}{h.plan ? ` · ${h.plan}` : ''}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {picked && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:items-end">
              <SelectField label="Force" value={state} onChange={(e) => setState(e.target.value as OverrideState)} disabled={saving}>
                <option value="on">On</option>
                <option value="off">Off</option>
              </SelectField>
              <Input label="Note (optional)" value={note} onChange={(e) => { setNote(e.target.value); setNoteError(''); }} error={noteError || undefined} maxLength={300} placeholder="Why? e.g. design partner" disabled={saving} />
              <Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save override'}</Button>
            </div>
          )}
        </form>

        {overrides.loading && !overrides.data ? (
          <SkeletonCardList count={2} rows={1} />
        ) : overrides.error && !overrides.data ? (
          <ErrorState message={overrides.error} onRetry={overrides.reload} />
        ) : rows.length === 0 ? (
          <EmptyState icon={Users} title="No tenant overrides" description="Every tenant follows the rollout percentage." />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((o) => {
              const label = tenantLabel(o);
              return (
                <li key={o.tenant_id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">{label}</p>
                    <p className="truncate text-xs text-text-secondary">{o.email} · {formatDateTime(o.updated_at)}</p>
                    {o.note && <p className="mt-1 break-words text-xs text-text-secondary">{o.note}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={o.state === 'on' ? 'success' : 'neutral'}>Forced {o.state}</Pill>
                    <Button size="sm" variant="ghost" disabled={removing === o.tenant_id} onClick={() => remove(o.tenant_id, label)} aria-label={`Remove override for ${label}`}>
                      {removing === o.tenant_id ? 'Removing…' : 'Remove'}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="History">
        {audit.loading && !audit.data ? (
          <SkeletonCardList count={2} rows={1} />
        ) : audit.error && !audit.data ? (
          <ErrorState message={audit.error} onRetry={audit.reload} />
        ) : (audit.data ?? []).length === 0 ? (
          <EmptyState icon={Users} title="No history recorded" description="Changes to this flag and its overrides appear here." />
        ) : (
          <ul className="divide-y divide-border">
            {(audit.data ?? []).map((a) => (
              <li key={a.id} className="py-2.5 first:pt-0 last:pb-0">
                <p className="text-sm text-text-primary">{describeAuditEntry(a)}</p>
                <p className="text-xs text-text-secondary">{a.actor_email ?? 'System'} · {formatDateTime(a.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

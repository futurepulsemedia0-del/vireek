import { useState } from 'react';
import { Check, Loader2, Sparkles, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { Dialog, LoadError, SelectField, StatusPill, useLoader } from '@/components/commissions/shared';
import { useToast } from '@/contexts/ToastContext';
import {
  PROVIDER_META,
  getMapping,
  listGustoEmployees,
  matchGustoEmployees,
  payrollErrorMessage,
  setEmployeeLink,
  setEmployeeLinks,
  validateExternalId,
  type MappingRow,
  type PayrollConnection,
  type PayrollProvider,
  type SuggestedLink,
} from '@/lib/payrollConnectors';

interface Props {
  connections: PayrollConnection[];
  provider: PayrollProvider | null;
  onProviderChange: (p: PayrollProvider) => void;
  onGoToConnections: () => void;
}

export function MappingTab({ connections, provider, onProviderChange, onGoToConnections }: Props) {
  if (connections.length === 0) {
    return <EmptyState icon={Users} title="Set up a provider first" description="Employee mapping links each Vireek employee to their ID in your payroll provider." action={{ label: 'Go to Connections', onClick: onGoToConnections }} />;
  }
  const active = connections.find((c) => c.provider === provider) ?? connections[0];
  return <MappingTable key={active.id} connection={active} connections={connections} onProviderChange={onProviderChange} />;
}

function MappingTable({ connection, connections, onProviderChange }: { connection: PayrollConnection; connections: PayrollConnection[]; onProviderChange: (p: PayrollProvider) => void }) {
  const { toast } = useToast();
  const provider = connection.provider;
  const meta = PROVIDER_META[provider];
  const rows = useLoader<MappingRow[]>(() => getMapping(connection.id), [connection.id]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [matching, setMatching] = useState(false);
  const [suggestions, setSuggestions] = useState<{ list: SuggestedLink[]; names: Record<string, string> } | null>(null);
  const [applying, setApplying] = useState(false);

  const list = rows.data ?? [];
  const mapped = list.filter((r) => r.external_id).length;
  const canMatch = provider === 'gusto' && connection.mode === 'api' && !!connection.external_company_id;

  async function commit(row: MappingRow) {
    const raw = drafts[row.employee_id];
    if (raw === undefined || raw.trim() === (row.external_id ?? '')) return;
    const v = validateExternalId(provider, raw);
    if (!v.ok) {
      setRowError((e) => ({ ...e, [row.employee_id]: v.error }));
      return;
    }
    setRowError((e) => ({ ...e, [row.employee_id]: '' }));
    setSaving(row.employee_id);
    try {
      await setEmployeeLink(connection.id, row.employee_id, v.value);
      setDrafts((d) => {
        const { [row.employee_id]: _gone, ...rest } = d;
        void _gone;
        return rest;
      });
      rows.reload();
    } catch (e) {
      setRowError((x) => ({ ...x, [row.employee_id]: payrollErrorMessage(e, 'Could not save.') }));
    } finally {
      setSaving(null);
    }
  }

  async function autoMatch() {
    setMatching(true);
    try {
      const { employees } = await listGustoEmployees(connection.id);
      const found = matchGustoEmployees(list.map((r) => ({ employee_id: r.employee_id, name: r.name, email: r.email, external_id: r.external_id })), employees);
      if (found.length === 0) {
        toast('No new confident matches. Match the rest by hand with the Gusto employee ID.', 'info');
        return;
      }
      setSuggestions({ list: found, names: Object.fromEntries(list.map((r) => [r.employee_id, r.name])) });
    } catch (e) {
      toast(payrollErrorMessage(e, 'Could not load Gusto employees.'), 'error');
    } finally {
      setMatching(false);
    }
  }

  async function applySuggestions() {
    if (!suggestions) return;
    setApplying(true);
    try {
      const n = await setEmployeeLinks(connection.id, suggestions.list);
      toast(`${n} employee${n === 1 ? '' : 's'} linked.`, 'success');
      setSuggestions(null);
      rows.reload();
    } catch (e) {
      toast(payrollErrorMessage(e, 'Could not apply the matches.'), 'error');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="w-full sm:max-w-xs">
          <SelectField label="Provider" value={provider} onChange={(v) => onProviderChange(v as PayrollProvider)}>
            {connections.map((c) => <option key={c.id} value={c.provider}>{PROVIDER_META[c.provider].label}</option>)}
          </SelectField>
        </div>
        <div className="flex items-center gap-3">
          {!rows.loading && !rows.error && <span className="text-sm text-text-secondary" aria-live="polite">{mapped} of {list.length} mapped</span>}
          {canMatch && (
            <Button variant="secondary" size="sm" onClick={autoMatch} disabled={matching || rows.loading}>
              {matching ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
              Auto-match from Gusto
            </Button>
          )}
        </div>
      </div>

      {rows.loading ? (
        <SkeletonCardList count={4} rows={1} />
      ) : rows.error ? (
        <LoadError message={rows.error} onRetry={rows.reload} />
      ) : list.length === 0 ? (
        <EmptyState icon={Users} title="No employees to map yet" description="Add employees in Payroll first. Each one then gets a provider ID here." />
      ) : (
        <Card className="overflow-hidden p-0 hover:translate-y-0">
          <ul className="divide-y divide-border">
            {list.map((r) => {
              const draft = drafts[r.employee_id];
              const value = draft ?? r.external_id ?? '';
              return (
                <li key={r.employee_id} className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_minmax(0,18rem)] sm:items-start">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {r.name}
                      {!r.active && <span className="ml-2"><StatusPill tone="neutral">Inactive</StatusPill></span>}
                    </p>
                    <p className="truncate text-xs text-text-secondary">
                      {r.email ?? 'No email on file'}
                      {r.label && r.match_source !== 'manual' ? ` · matched by ${r.match_source} to ${r.label}` : ''}
                    </p>
                  </div>
                  <div className="flex items-start gap-2">
                    <Input
                      aria-label={`${meta.idLabel} for ${r.name}`}
                      value={value}
                      placeholder={meta.idPlaceholder}
                      maxLength={80}
                      error={rowError[r.employee_id] || undefined}
                      onChange={(e) => setDrafts((d) => ({ ...d, [r.employee_id]: e.target.value }))}
                      onBlur={() => void commit(r)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void commit(r); }}
                    />
                    <span className="flex h-12 w-5 items-center" aria-live="polite">
                      {saving === r.employee_id ? <Loader2 size={16} className="animate-spin text-text-secondary" aria-label="Saving" /> : r.external_id && draft === undefined ? <Check size={16} className="text-success-500" aria-label="Saved" /> : null}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Dialog
        open={!!suggestions}
        title={`Link ${suggestions?.list.length ?? 0} employee${suggestions?.list.length === 1 ? '' : 's'}?`}
        description="Matched by email first, then by an exact, unique name. Anything ambiguous is left for you."
        onClose={() => setSuggestions(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setSuggestions(null)}>Cancel</Button>
            <Button onClick={applySuggestions} disabled={applying}>
              {applying && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Link them
            </Button>
          </>
        }
      >
        <ul className="max-h-72 space-y-2 overflow-y-auto text-sm">
          {suggestions?.list.map((s) => (
            <li key={s.employee_id} className="flex items-start justify-between gap-3">
              <span className="text-text-primary">{suggestions.names[s.employee_id]}</span>
              <span className="text-right text-xs text-text-secondary">{s.label} <StatusPill tone={s.match_source === 'email' ? 'success' : 'warning'}>{s.match_source}</StatusPill></span>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

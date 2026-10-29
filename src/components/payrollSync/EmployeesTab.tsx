import { useMemo, useState } from 'react';
import { RefreshCw, Users } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonCardList } from '@/components/Skeleton';
import { useToast } from '@/contexts/ToastContext';
import { errorMessage } from '@/lib/commissions';
import { fetchEmployees } from '@/lib/payroll';
import { LoadError, SelectField, StatusPill, useLoader } from '@/components/commissions/shared';
import { confirmLink, fetchLinks, loadProviderEmployees, removeLink, type PayrollConnection, type ProviderEmployee } from '@/lib/payrollSync';

export function EmployeesTab({ ownerId, connection }: { ownerId: string; connection: PayrollConnection }) {
  const { toast } = useToast();
  const [provider, setProvider] = useState<ProviderEmployee[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});

  const emps = useLoader(() => fetchEmployees(), [ownerId]);
  const links = useLoader(() => fetchLinks(ownerId, connection.id), [ownerId, connection.id]);
  const linkOf = useMemo(() => new Map((links.data ?? []).map((l) => [l.employee_id, l])), [links.data]);
  const takenExternal = useMemo(() => new Set((links.data ?? []).filter((l) => l.confirmed).map((l) => l.external_employee_id)), [links.data]);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await loadProviderEmployees(connection.id);
      setProvider(r.employees);
      toast(r.suggested > 0 ? `Found ${r.suggested} likely match${r.suggested === 1 ? '' : 'es'}. Review and confirm them below.` : 'Employee list refreshed.', 'success');
      links.reload();
    } catch (e) {
      toast(errorMessage(e, 'Could not load employees.'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const act = async (id: string, fn: () => Promise<void>, ok: string) => {
    setBusyId(id);
    try {
      await fn();
      toast(ok, 'success');
      links.reload();
    } catch (e) {
      toast(errorMessage(e, 'Action failed.'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (emps.error) return <LoadError message={emps.error} onRetry={emps.reload} />;
  if (links.error) return <LoadError message={links.error} onRetry={links.reload} />;
  if (emps.loading || links.loading) return <SkeletonCardList count={3} rows={1} />;
  const list = (emps.data ?? []).filter((e) => e.active);

  return (
    <div className="space-y-4">
      <Card className="flex flex-col gap-3 p-4 hover:translate-y-0 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-text-secondary">Link each Vireek employee to the same person in {connection.company_name ?? 'your payroll provider'}. Name matches are only suggestions; nothing is sent until you confirm the link.</p>
        <Button variant="secondary" size="sm" disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} /> {loading ? 'Loading…' : 'Refresh from provider'}</Button>
      </Card>
      {list.length === 0 ? (
        <EmptyState icon={Users} title="No active employees" description="Add employees on the Payroll page first." />
      ) : (
        <div className="space-y-2">
          {list.map((e) => {
            const link = linkOf.get(e.id);
            const busy = busyId === e.id;
            const options = (provider ?? []).filter((p) => !takenExternal.has(p.id) || p.id === link?.external_employee_id);
            const selected = pick[e.id] ?? link?.external_employee_id ?? '';
            const chosen = (provider ?? []).find((p) => p.id === selected);
            return (
              <Card key={e.id} className="flex flex-col gap-3 p-4 hover:translate-y-0 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-text-primary">{e.full_name}</p>
                  <p className="text-xs text-text-secondary">
                    {e.employment_type === '1099' ? '1099 contractor (not synced)' : e.pay_type === 'hourly' ? 'Hourly: hours, overtime and commission' : 'Salaried: commission only'}
                  </p>
                </div>
                <div className="flex flex-col gap-2 lg:w-[28rem] lg:flex-row lg:items-end">
                  {provider ? (
                    <div className="flex-1">
                      <SelectField label="Provider employee" value={selected} onChange={(v) => setPick({ ...pick, [e.id]: v })}>
                        <option value="">Not linked</option>
                        {link && !options.some((o) => o.id === link.external_employee_id) && <option value={link.external_employee_id}>{link.external_name ?? link.external_employee_id}</option>}
                        {options.map((o) => <option key={o.id} value={o.id}>{o.name}{o.email ? ` (${o.email})` : ''}</option>)}
                      </SelectField>
                    </div>
                  ) : (
                    <p className="flex-1 text-sm text-text-secondary">{link ? link.external_name ?? link.external_employee_id : 'Not linked'}</p>
                  )}
                  {link ? <StatusPill tone={link.confirmed ? 'success' : 'warning'}>{link.confirmed ? 'Linked' : 'Suggested'}</StatusPill> : <StatusPill tone="neutral">Not linked</StatusPill>}
                  {selected && (!link || !link.confirmed || link.external_employee_id !== selected) && (
                    <Button size="sm" disabled={busy} onClick={() => void act(e.id, () => confirmLink(connection.id, e.id, selected, chosen?.name ?? link?.external_name ?? null), 'Link confirmed.')}>Confirm</Button>
                  )}
                  {link && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(e.id, () => removeLink(link.id), 'Link removed.')}>Remove</Button>}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

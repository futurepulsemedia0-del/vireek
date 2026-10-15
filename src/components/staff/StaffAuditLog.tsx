import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ScrollText } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/Skeleton';
import { AUDIT_ACTION_LABELS, fetchStaffAudit, type StaffAuditEntry } from '@/lib/staffCustomers';

const TONE: Record<string, string> = {
  impersonation_start: 'bg-warning-500/10 text-warning-500',
  impersonation_end: 'bg-bg-tertiary text-text-secondary',
  impersonation_denied: 'bg-danger/10 text-danger',
  account_view: 'bg-accent/10 text-accent',
  explorer_list: 'bg-bg-tertiary text-text-secondary',
};

export function StaffAuditLog({ accountNames }: { accountNames: Map<string, string> }) {
  const [entries, setEntries] = useState<StaffAuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setEntries(await fetchStaffAudit(100));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Card className="divide-y divide-border p-0 hover:translate-y-0" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2 p-4"><Skeleton className="h-4 w-56" /><Skeleton className="h-3 w-32" /></div>
        ))}
      </Card>
    );
  }
  if (error) return <EmptyState icon={AlertTriangle} title="Couldn't load the audit log" description="Check your connection and try again." action={{ label: 'Retry', onClick: () => void load() }} />;
  if (entries.length === 0) return <EmptyState icon={ScrollText} title="The audit log is empty" description="Every staff access to customer data is recorded here, permanently." />;

  return (
    <Card className="overflow-hidden p-0 hover:translate-y-0">
      <ul className="divide-y divide-border">
        {entries.map((e) => (
          <li key={e.id} className="space-y-1 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${TONE[e.action] ?? 'bg-bg-tertiary text-text-secondary'}`}>{AUDIT_ACTION_LABELS[e.action] ?? e.action}</span>
              <span className="text-xs text-text-primary">{e.staffEmail ?? 'unknown staff'}</span>
              {e.targetAccountId && <span className="truncate text-xs text-text-secondary">→ {accountNames.get(e.targetAccountId) ?? e.targetAccountId}</span>}
            </div>
            {e.reason && <p className="break-words text-xs text-text-secondary">“{e.reason}”</p>}
            <time className="block text-[11px] text-text-secondary" dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time>
          </li>
        ))}
      </ul>
    </Card>
  );
}

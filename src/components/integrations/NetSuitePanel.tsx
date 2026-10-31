import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { NS_VERIFICATION, getConnection, timeAgo, useCanManageNetSuite, useNsOwnerId, type NsConnection } from '@/lib/netsuite';

/** Status + shortcut for the NetSuite sync, shown inside the NetSuite card on Integrations. */
export function NetSuitePanel() {
  const canManage = useCanManageNetSuite();
  const ownerId = useNsOwnerId();
  const [conn, setConn] = useState<NsConnection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!canManage || !ownerId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    getConnection(ownerId)
      .then((c) => !cancelled && setConn(c))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [canManage, ownerId]);

  if (!canManage) return null;
  const connected = !!conn && conn.status !== 'disconnected';
  return (
    <div className="mt-4 rounded-xl border border-border bg-bg-primary p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-warning-500">{NS_VERIFICATION.label}</p>
      <p className="mt-1 text-sm text-text-secondary">
        {loading ? <Loader2 size={14} className="inline animate-spin" /> : !connected ? 'Not connected. Sync of customers, items, invoices and payments with NetSuite.' : conn.status === 'error' ? 'Needs to be reconnected.' : `${conn.company_name ?? `Account ${conn.account_id}`} · last synced ${timeAgo(conn.last_synced_at)}`}
      </p>
      <Link to="/dashboard/netsuite" className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
        {connected ? 'Open NetSuite sync' : 'Set up NetSuite sync'} <ArrowRight size={14} />
      </Link>
    </div>
  );
}

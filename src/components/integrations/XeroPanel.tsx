import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { getConnection, timeAgo, useCanManageXero, useXeroOwnerId, type XeroConnection } from '@/lib/xero';

/** Status + shortcut for the Xero sync, shown inside the Xero card on Integrations. */
export function XeroPanel() {
  const canManage = useCanManageXero();
  const ownerId = useXeroOwnerId();
  const [conn, setConn] = useState<XeroConnection | null>(null);
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
      <p className="text-sm text-text-secondary">
        {loading ? <Loader2 size={14} className="inline animate-spin" /> : !connected ? 'Not connected. Sync of contacts, invoices, payments, items, accounts and tax rates, including multi-currency invoices.' : conn.status === 'error' ? 'Needs to be reconnected.' : `${conn.organisation_name ?? 'Connected'} · last synced ${timeAgo(conn.last_synced_at)}`}
      </p>
      <Link to="/dashboard/xero" className="mt-2 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
        {connected ? 'Open Xero sync' : 'Set up Xero sync'} <ArrowRight size={14} />
      </Link>
    </div>
  );
}
